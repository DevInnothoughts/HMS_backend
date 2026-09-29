/* eslint-disable prettier/prettier */
/**
 * callLeadsModel.js
 *
 * Call leads are captured by the "request a call" widget on the Healing Hands
 * website and land in `call_leads` (database: hhc_appointments).
 *
 * Requires the columns added by call_leads_migration.sql — without `status`
 * and `note` the actions on the screen have nowhere to write.
 */

const util = require("util");
const { getConnectionByLocation } = require("../../databaseUtils");

/**
 * VERIFY THIS KEY.
 *
 * `call_leads` lives in hhc_appointments, not the `lead` database used by
 * leadManagementModel. Set this to whichever key in databaseUtils.js points at
 * hhc_appointments for the branch. If getConnectionByLocation is per-branch
 * rather than per-database here, pass the branch through instead.
 */
const DB_KEY = "lead";

/* ------------------------------------------------------------------ */
/* Location mapping                                                    */
/* ------------------------------------------------------------------ */

/**
 * The website writes its own location names into call_location. They do not
 * match the branch names the app stores in AsyncStorage.
 *
 * Most values contain the branch name and are caught by the substring fallback
 * in the query. The entries below are the ones that are not — a plain
 * LIKE '%branch%' filter would silently hide those leads from every branch.
 *
 * Keys are APP branch names. Values are call_location values as written by
 * the website. Aliases are matched exactly (case-insensitive).
 *
 * Confirmed by Team HHC, Sept 2026.
 */
const LOCATION_ALIASES = {
  "Salunke Vihar": ["Wanowrie"],

  // Both the generic "Gurugram" page and the Sector 14 page route to Sector 14.
  // Sector 49 has its own page and stays separate — the exact match on the
  // alias means "Sector 49, Gurugram" never falls into Sector 14.
  "Gurgaon Sector 14": ["Sector 14, Gurugram", "Gurugram"],
  "Gurgaon Sector 49": ["Sector 49, Gurugram"],

  "Rajaji Nagar": ["Rajajinagar - Bengaluru"],

  // DP Road covers the Pune Station Road and Kothrud landing pages, matching
  // how the IVR cloud function groups 'Pune station 1/2/3' under DP Road.
  "DP Road": ["Pune Station Road", "Kothrud"],

  Hyderabad: ["Jubilee Hills"],

  // Kalyan, Hadapsar, Electronic City and RR Nagar are branches in their own
  // right, and their call_location values already contain the branch name
  // ("Loni Kalbhor (Hadapsar)", "Electronic City - Bengaluru",
  // "RR Nagar - Bengaluru"), so the substring fallback handles them. Listed
  // here anyway so the mapping is explicit rather than incidental.
  Kalyan: ["Kalyan"],
  Hadapsar: ["Loni Kalbhor (Hadapsar)"],
  "Electronic City": ["Electronic City - Bengaluru"],
  "RR Nagar": ["RR Nagar - Bengaluru"],

  // --- STILL UNRESOLVED ---
  // "Mumbai" (3 rows in the sample) — you have both Andheri and Kemps Corner
  // in the city and this page names neither. Until it is assigned, those leads
  // appear only in GET /leadManagement/call/unmapped.
};

/* ------------------------------------------------------------------ */
/* Treatment inference                                                 */
/* ------------------------------------------------------------------ */

const TREATMENT_RULES = [
  ["pilonidal", "Pilonidal sinus"],
  ["hernia", "Hernia"],
  ["fissure", "Fissure"],
  ["lipoma", "Lipoma"],
  ["varicose", "Varicose veins"],
  ["gallstone", "Gallstones"],
  ["circumcision", "Circumcision"],
  ["laser", "Laser treatment"],
];

/**
 * The landing page tells you what the caller was reading about, which is the
 * single most useful thing to know before dialling. Derived from pageUrl so no
 * extra column is needed. Covers ~92% of sample rows.
 */
function inferTreatment(pageUrl) {
  if (!pageUrl) return null;
  const url = String(pageUrl).toLowerCase();

  const hasPiles = url.includes("piles");
  const hasFistula = url.includes("fistula");
  if (hasPiles && hasFistula) return "Piles / Fistula";
  if (hasPiles) return "Piles";
  if (hasFistula) return "Fistula";

  for (const [needle, label] of TREATMENT_RULES) {
    if (url.includes(needle)) return label;
  }
  return null;
}

/** google / gads / null -> something readable on a card. */
function readableSource(utmSource) {
  if (!utmSource) return "Direct / organic";
  const s = String(utmSource).toLowerCase();
  if (s === "google" || s === "gads") return "Google Ads";
  return utmSource;
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

/**
 * Leads for one branch.
 *
 * Aliases are matched exactly; everything else falls back to a substring
 * match on the branch name, which covers the 21 locations that already
 * contain it ("HSR Layout - Bengaluru" for HSR, "Pimpri & Chinchwad" for
 * Chinchwad, and so on).
 */
/** WHERE fragment + params that pick this branch's rows out of call_leads. */
function locationClause(location) {
  const aliases = LOCATION_ALIASES[location] || [];
  const aliasClause = aliases.length
    ? ` OR LOWER(call_location) IN (${aliases.map(() => "LOWER(?)").join(", ")})`
    : "";
  return {
    sql: `(call_location LIKE CONCAT('%', ?, '%')${aliasClause})`,
    params: [location, ...aliases],
  };
}

/**
 * With `from` and `to` (YYYY-MM-DD) every lead created in that range is
 * returned. Without them, the 100 most recent — the original behaviour, kept
 * for the sync job and any caller that does not send a range.
 */
async function getCallLeads(location, { withVisits = true, from, to } = {}) {
  const { connection } = getConnectionByLocation(DB_KEY);
  if (!connection) {
    const err = new Error(`Invalid location: ${location}`);
    err.status = 404;
    throw err;
  }

  const loc = locationClause(location);
  const ranged = !!(from && to);

  const query = `
    SELECT
      id            AS appointment_id,
      created_at    AS date,
      phoneno,
      call_location AS branch,
      utm_source,
      pageUrl,
      status,
      note
    FROM call_leads
    WHERE phoneno IS NOT NULL
      AND phoneno <> ''
      AND ${loc.sql}
      ${ranged ? "AND created_at BETWEEN ? AND ?" : ""}
    ORDER BY id DESC
    ${ranged ? "" : "LIMIT 100"}
  `;

  const params = ranged
    ? [...loc.params, `${from} 00:00:00`, `${to} 23:59:59`]
    : loc.params;

  const rows = await new Promise((resolve, reject) => {
    connection.getConnection(function (err, tempCon) {
      // Guard the release — calling .release() on an undefined connection
      // throws inside the callback and the promise never settles.
      if (err) {
        if (tempCon) tempCon.release();
        return reject(err);
      }

      tempCon.query(query, params, function (error, rows) {
        tempCon.release();
        if (error) return reject(error);

        rows.forEach((row) => {
          row.selected_area = location;
          row.disease = inferTreatment(row.pageUrl);
          row.source = readableSource(row.utm_source);
          // The website form captures no name. The card falls back to the
          // phone number; a name is set once someone records an enquiry.
          row.name = null;
        });

        resolve(rows);
      });
    });
  });

  if (withVisits) await attachVisitFlags(location, rows);
  return rows;
}

/**
 * Adds `visited` and `ipd` (booleans) to each call lead, so the Web Call Leads
 * screen can offer the same Visited / IPD filters as Web Leads.
 *
 * Same definitions as getDatewiseLeads (web leads):
 *   visited — an appointment in the branch DB for that phone with
 *             confirm_time != 0 and patient_type = 'New'
 *   ipd     — that visited patient has an invoice
 *
 * Differences, because call leads have no date range and a different status
 * history:
 *   - the visit must be ON OR AFTER the day the lead came in (web leads use
 *     the screen's from/to range instead)
 *   - every lead is checked, not only those already marked 'Appointment' —
 *     a caller can turn up without the status ever being updated
 *
 * The response stays a plain array (flags added to each row), so anything
 * already reading GET /leadManagement/call keeps working.
 *
 * A failure here is logged and the leads are returned without flags rather
 * than failing the whole list.
 */
async function attachVisitFlags(location, rows) {
  rows.forEach((row) => {
    row.visited = false;
    row.ipd = false;
  });

  const phone10 = (p) =>
    String(p || "")
      .replace(/\D/g, "")
      .slice(-10);
  const phones = [
    ...new Set(
      rows.map((r) => phone10(r.phoneno)).filter((p) => p.length === 10),
    ),
  ];
  if (phones.length === 0) return rows;

  const { connection: clinicDB } = getConnectionByLocation(location);
  if (!clinicDB) return rows;

  try {
    const clinicQuery = util.promisify(clinicDB.query).bind(clinicDB);

    // patient_phone is stored as ten digits (the web-lead code matches it
    // exactly), so a plain IN keeps the index usable.
    const visits = await clinicQuery(
      `
        SELECT patient_id, patient_phone, appointment_timestamp
        FROM appointment
        WHERE patient_phone IN (?)
          AND confirm_time != 0
          AND patient_type = 'New'
      `,
      [phones],
    );
    if (visits.length === 0) return rows;

    const ipdIds = new Set();
    const patientIds = [...new Set(visits.map((v) => v.patient_id))];
    if (patientIds.length > 0) {
      const invoices = await clinicQuery(
        `SELECT DISTINCT patient_id FROM invoice WHERE patient_id IN (?)`,
        [patientIds],
      );
      invoices.forEach((i) => ipdIds.add(i.patient_id));
    }

    // phone → visits, so each lead only looks at its own number.
    const byPhone = new Map();
    for (const v of visits) {
      const k = phone10(v.patient_phone);
      if (!byPhone.has(k)) byPhone.set(k, []);
      byPhone.get(k).push(v);
    }

    const dayStart = (d) => {
      const x = new Date(d);
      if (Number.isNaN(x.getTime())) return null;
      x.setHours(0, 0, 0, 0);
      return x;
    };

    for (const row of rows) {
      const leadDay = dayStart(row.date);
      const mine = (byPhone.get(phone10(row.phoneno)) || []).filter((v) => {
        const visitDay = dayStart(v.appointment_timestamp);
        return !leadDay || !visitDay || visitDay >= leadDay;
      });
      if (mine.length > 0) {
        row.visited = true;
        row.ipd = mine.some((v) => ipdIds.has(v.patient_id));
      }
    }
  } catch (err) {
    console.error(`callLeads visit flags (${location}):`, err.message);
  }

  return rows;
}

/** Mirrors updateStatus / updateStatusBot. */
async function updateStatusCall(id, status, note) {
  const { connection } = getConnectionByLocation(DB_KEY);
  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  return new Promise((resolve, reject) => {
    connection.getConnection(function (err, tempCon) {
      if (err) {
        if (tempCon) tempCon.release();
        return reject(err);
      }

      const query = `
        UPDATE call_leads
        SET status = ?, note = ?
        WHERE id = ?
      `;

      tempCon.query(query, [status, note, id], function (error, rows) {
        tempCon.release();
        if (error) return reject(error);
        resolve(rows);
      });
    });
  });
}

/**
 * Diagnostic: call_location values that no branch can see.
 *
 * Every row returned here is a real lead sitting in the table that nobody will
 * ever be shown, because its location neither contains a branch name nor has
 * an alias above. Check this after go-live and whenever the website adds a
 * location page.
 */
async function getUnmappedCallLocations(knownBranches = []) {
  const { connection } = getConnectionByLocation(DB_KEY);
  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const query = `
    SELECT call_location, COUNT(*) AS leads, MAX(created_at) AS latest
    FROM call_leads
    WHERE phoneno IS NOT NULL AND phoneno <> ''
    GROUP BY call_location
    ORDER BY leads DESC
  `;

  const aliased = new Set(
    Object.values(LOCATION_ALIASES)
      .flat()
      .map((v) => v.toLowerCase()),
  );

  return new Promise((resolve, reject) => {
    connection.getConnection(function (err, tempCon) {
      if (err) {
        if (tempCon) tempCon.release();
        return reject(err);
      }

      tempCon.query(query, function (error, rows) {
        tempCon.release();
        if (error) return reject(error);

        const unmapped = rows.filter((row) => {
          const loc = String(row.call_location || "").toLowerCase();
          if (!loc) return true;
          if (aliased.has(loc)) return false;
          return !knownBranches.some((b) => loc.includes(b.toLowerCase()));
        });

        resolve(unmapped);
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

/**
 * Marks call leads as converted once the caller has an appointment at the
 * branch. Same job as syncAppointments (web) and syncBotAppointments (bot) in
 * leadManagementModel.js:
 *
 *   1. take this branch's call leads (getCallLeads — same location matching
 *      the screen uses, so the sync sees exactly the rows the branch sees)
 *   2. skip any already at 'Appointment'
 *   3. look for an appointment in the branch DB for that phone, on or after
 *      the day the lead came in
 *   4. if found, set status = 'Appointment' and write the note
 *
 * Two deliberate differences from the web/bot versions:
 *
 *  - PHONE: compared on the last ten digits. The bot version strips a leading
 *    /^(\+91|91|0)/, which also eats the "91" of a plain ten-digit number that
 *    happens to start with 91 (9123456789 → 23456789) and never matches.
 *
 *  - DATE: appointment_timestamp is a DATE column and created_at is a
 *    DATETIME. Comparing them directly drops a same-day booking
 *    ('2026-09-26' < '2026-09-26 14:05'), so the lead's date is cut to DATE().
 */
async function syncCallAppointments(location) {
  const { connection: leadsDB } = getConnectionByLocation(DB_KEY);
  const { connection: clinicDB } = getConnectionByLocation(location);
  if (!leadsDB || !clinicDB) {
    const err = new Error(`Invalid location: ${location}`);
    err.status = 404;
    throw err;
  }

  try {
    console.log("🔄Call Lead Sync started at", new Date().toLocaleString());

    const leads = await getCallLeads(location, { withVisits: false });

    if (leads.length === 0) {
      console.log("✅ No unsynced Call leads found.");
      return;
    }

    const clinicQuery = util.promisify(clinicDB.query).bind(clinicDB);
    const leadsQuery = util.promisify(leadsDB.query).bind(leadsDB);

    for (const lead of leads) {
      // getCallLeads aliases id → appointment_id and created_at → date.
      const { appointment_id, phoneno, date, status } = lead;

      if (!phoneno || status === "Appointment") continue;

      const phone10 = String(phoneno).replace(/\D/g, "").slice(-10);
      if (phone10.length !== 10) continue;

      const rows = await clinicQuery(
        `
          SELECT patient_phone, appointment_timestamp
          FROM appointment
          WHERE
            RIGHT(patient_phone, 10) = ?
            AND appointment_timestamp >= DATE(?)
          ORDER BY appointment_timestamp ASC
          LIMIT 1
        `,
        [phone10, date],
      );

      if (rows && rows.length > 0) {
        const match = rows[0];
        const appointmentDate = new Date(
          match.appointment_timestamp,
        ).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
        const note = `Appointment booked on ${appointmentDate} and synchronised successfully.`;

        await leadsQuery(
          `
          UPDATE call_leads
          SET status = 'Appointment', note = ?
          WHERE id = ?
        `,
          [note, appointment_id],
        );
        console.log(
          `✅Call Lead Synced ${location}: ${phoneno} → status updated.`,
        );
      }
    }

    console.log("🔁Call Lead Sync completed at", new Date().toLocaleString());
  } catch (err) {
    console.error("❌ Error during Call Lead sync:", err.message);
  }
}

/**
 * Funnel counts for the Leads & Calls dashboard ("Web call" row), in the
 * shape leadsStatsModel returns for web / chatbot / IVR:
 *   { total, appointment, actualVisitCount, ipd }
 *
 * - total is EVERY call_leads row created in [from, to] (matches the screen);
 *   the other stages are one per phone (last ten digits)
 * - appointment: any of that phone's rows has status 'Appointment'
 * - visited / ipd: attachVisitFlags — a confirmed new-patient visit on or
 *   after the lead's day, and an invoice for that patient
 */
/** call_leads rows for one branch created in [from, to]. */
async function fetchCallLeadsInRange(location, from, to) {
  const { connection } = getConnectionByLocation(DB_KEY);
  if (!connection) {
    const err = new Error(`Invalid location: ${location}`);
    err.status = 404;
    throw err;
  }

  const loc = locationClause(location);
  const query = `
    SELECT id AS appointment_id, created_at AS date, phoneno, status
    FROM call_leads
    WHERE phoneno IS NOT NULL
      AND phoneno <> ''
      AND ${loc.sql}
      AND created_at BETWEEN ? AND ?
    ORDER BY id DESC
  `;
  const params = [...loc.params, `${from} 00:00:00`, `${to} 23:59:59`];

  return new Promise((resolve, reject) => {
    connection.getConnection(function (err, tempCon) {
      if (err) {
        if (tempCon) tempCon.release();
        return reject(err);
      }
      tempCon.query(query, params, function (error, result) {
        tempCon.release();
        if (error) return reject(error);
        resolve(result);
      });
    });
  });
}

async function getCallLeadStats(location, from, to) {
  const rows = await fetchCallLeadsInRange(location, from, to);

  const phone10 = (p) =>
    String(p || "")
      .replace(/\D/g, "")
      .slice(-10);
  const byPhone = new Map();
  for (const r of rows) {
    const k = phone10(r.phoneno) || `id-${r.appointment_id}`;
    const seen = byPhone.get(k);
    if (!seen) byPhone.set(k, { ...r });
    else if (r.status === "Appointment") seen.status = "Appointment";
  }
  const leads = [...byPhone.values()];

  await attachVisitFlags(location, leads);

  return {
    // Every request, matching the Web Call Leads screen's count. Booked /
    // visited / IPD stay one per phone — a person books once however many
    // times they asked for a call.
    total: rows.length,
    appointment: leads.filter((l) => l.status === "Appointment").length,
    actualVisitCount: leads.filter((l) => l.visited).length,
    ipd: leads.filter((l) => l.ipd).length,
  };
}

/**
 * Lead COUNT only (Home screen): EVERY call-back request in the range, the
 * same rows the Web Call Leads screen lists — a number that asked twice is
 * two requests.
 */
async function getCallLeadCount(location, from, to) {
  const rows = await fetchCallLeadsInRange(location, from, to);
  return rows.length;
}

module.exports = {
  getCallLeads,
  getCallLeadStats,
  getCallLeadCount,
  updateStatusCall,
  getUnmappedCallLocations,
  syncCallAppointments,
  LOCATION_ALIASES,
  inferTreatment,
};
