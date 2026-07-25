/**
 * lostLeadsModel.js
 * ---------------------------------------------------------------------------
 * "Lost Leads" report — where the funnel leaks, per channel.
 *
 * For a channel (web | bot | ivr | helpline) and a date range, every lead is
 * placed in one of two buckets (a lead can only be in one):
 *
 *   Sheet 1  "Enquiry - No Appointment"  enquiry logged, appointment never booked
 *   Sheet 2  "Appointment - Not Visited" appointment booked, patient never came in
 *
 * ── Definitions ─────────────────────────────────────────────────────────────
 * Booked  : a row exists in the branch clinic DB `appointment` table for that
 *           phone (is_deleted != 1). For web/bot a lead whose status was already
 *           synced to 'Appointment' also counts as booked, so sync lag can't
 *           push a real booking into Sheet 1.
 * Visited : that phone has an appointment row with confirm_time != 0 AND
 *           patient_type = 'New' — the same test getIpdCount / leadsStatsModel
 *           uses for "actualVisitCount", so the numbers here reconcile with the
 *           Leads Stats dashboard.
 *
 * ── Visit grace window ──────────────────────────────────────────────────────
 * A lead created on the last day of the range may legitimately visit a week
 * later. Checking visits only inside [from, to] would report those as lost. The
 * clinic-side lookup therefore runs over [from, to + VISIT_GRACE_DAYS], capped
 * at today. Raise VISIT_GRACE_DAYS if your booking-to-visit lag is longer.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   const { getLostLeads } = require("./lostLeadsModel");
 *   const data = await getLostLeads({
 *     channel: "web",                       // "web" | "bot" | "ivr"
 *     from: "2026-06-01",
 *     to: "2026-06-30",
 *     locations: ["DP Road", "Baner"],      // branches the caller may see
 *   });
 *   // → { channel, from, to, notConverted: [...], notVisited: [...],
 *   //     summary: [...], branchesProcessed, branchesRequested, failed: [...] }
 *
 * Location strings must match the branch keys used by getConnectionByLocation.
 * ---------------------------------------------------------------------------
 */

const util = require("util");
const { getConnectionByLocation } = require("../../databaseUtils");

const VISIT_GRACE_DAYS = 30; // days after `to` in which a visit still counts
const PHONE_CHUNK = 400; // phones per clinic-DB lookup query

const CHANNELS = {
  web: "Web Lead",
  bot: "Bot Lead",
  ivr: "IVR",
  helpline: "Helpline",
};

// Clinic-owned handsets. Traffic to/from these is internal IVR routing, not a
// patient enquiry. Kept in step with the list in helplineCallModel.js.
const EXCLUDED_NUMBERS = [
  "+917411951943",
  "+918123922650",
  "+917411804875",
  "+918147647685",
  "+917411951965",
  "+917411805024",
  "+917411951962",
  "+918971928968",
  "+918123919853",
  "+918147647677",
  "+917411951963",
  "+918792498991",
  "+919164045999",
  "+918855865060",
  "+918888188885",
];

/* ── branch aliases + WHERE builders ──────────────────────────────────────── */
/**
 * Kept in sync with leadsStatsModel by copy rather than by require, so this
 * report can't break when that file's exports change. If you add a branch
 * alias there, mirror it here.
 */
const LOCATION_ALIASES = {
  "DP Road": ["DP Road", "Tilak Road", "Dhole Patil Road"],
  "Salunke Vihar": ["Salunke Vihar", "Salunkhe Vihar", "Wanowrie"],
  Hinjewadi: ["Hinjewadi", "Hinjawadi"],
  "JP Nagar": ["JP Nagar"], // + exact 'Bengaluru', handled in buildAreaWhere
  Sarjapura: ["Sarjapura", "Sarjapur"],
  "Rajaji Nagar": ["Rajaji Nagar", "Rajajinagar"],
  Belgavi: ["Belgavi", "Belagavi"],
  "Sahakar Nagar": ["Sahakar Nagar", "Sahakarnagar"],
  "Gurgaon Sector 14": [
    "Gurgaon Sector 14",
    "Gurugram - Sector 14",
    "Gurgaon Sector - 14",
  ],
  "Gurgaon Sector 49": [
    "Gurgaon Sector 49",
    "Gurugram - Sector 49",
    "Gurgaon Sector - 49",
  ],
  Thane: ["Thane", "Kapurbawdi"],
  HSR: ["HSR", "HSR Layout"],
  Hyderabad: ["Hyderabad", "Jubilee Hills"],
  Chinchwad: ["Chinchwad", "Pimpri-Chinchwad"],
  Andheri: ["Andheri", "Andheri West", "Andheri East"],
  Baner: ["Baner", "Baner Road"],
  Chakan: ["Chakan"],
  Dighi: ["Dighi"],
  Indiranagar: ["Indiranagar", "Indira Nagar"],
  Kalaburagi: ["Kalaburagi", "Gulbarga"],
  Latur: ["Latur"],
  Ludhiana: ["Ludhiana"],
  Lucknow: ["Lucknow"],
  Mysore: ["Mysore", "Mysuru"],
  Nashik: ["Nashik", "Nasik"],
  "Navi Mumbai": ["Navi Mumbai", "Navi-Mumbai"],
  Secunderabad: ["Secunderabad"],
  Surat: ["Surat"],
  Undri: ["Undri"],
  Vashi: ["Vashi"],
  Katraj: ["Katraj"],
  Ahmedabad: ["Ahmedabad"],
  Mohali: ["Mohali"],
  Aurangabad: ["Aurangabad"],
  Whitefield: ["Whitefield"],
  Hadapsar: ["Hadapsar"],
  Kalyan: ["Kalyan"],
  Bopal: ["Bopal"],
  "Electronic City": ["Electronic City", "Electronics City"],
};

const ALL_LOCATIONS = Object.keys(LOCATION_ALIASES);

// Web leads: `appointments`.`selected_area`
function buildAreaWhere(location) {
  const aliases = LOCATION_ALIASES[location] || [location];
  const conditions = aliases.map(
    () => `selected_area LIKE CONCAT('%', ?, '%')`,
  );
  const params = [...aliases];

  if (location === "JP Nagar") {
    conditions.push(`selected_area = ?`);
    params.push("Bengaluru");
  }

  return { whereClause: `(${conditions.join(" OR ")})`, params };
}

// Bot leads: `chatbot_leads`.`branch` / `chat_whatsapp_branch`
function buildBranchWhere(location) {
  if (location === "Vashi") {
    // Vashi also absorbs rows with both branch fields blank.
    return {
      whereClause: `(branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%') OR (branch = '' AND chat_whatsapp_branch = ''))`,
      params: [location, location],
    };
  }

  const aliases = LOCATION_ALIASES[location] || [location];
  const conditions = [];
  const params = [];

  aliases.forEach((alias) => {
    conditions.push(
      `(branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%'))`,
    );
    params.push(alias, alias);
  });

  return { whereClause: `(${conditions.join(" OR ")})`, params };
}

/* ── small helpers ────────────────────────────────────────────────────────── */

// Strip Indian dialling prefixes — matches how leads are stored against
// clinic `appointment`.`patient_phone` elsewhere in this codebase.
const normPhone = (p) =>
  String(p || "")
    .replace(/^(\+91|91|0)/, "")
    .trim();

const pad2 = (n) => String(n).padStart(2, "0");

const istDate = (d = new Date()) => {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${pad2(ist.getUTCMonth() + 1)}-${pad2(
    ist.getUTCDate(),
  )}`;
};

const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00+05:30`);
  d.setDate(d.getDate() + n);
  return istDate(d);
};

// Whole days between two dates; null when either side is missing/unparseable.
const daysBetween = (fromVal, toYmd) => {
  if (!fromVal) return null;
  const a = new Date(fromVal);
  if (isNaN(a)) return null;
  const b = new Date(`${toYmd}T23:59:59+05:30`);
  return Math.max(0, Math.floor((b - a) / 86400000));
};

const fmtDate = (v) => {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
};

// Run a callback against a pooled connection, always releasing it.
function withPooled(pool, fn) {
  return new Promise((resolve, reject) => {
    pool.getConnection(async (err, conn) => {
      if (err) return reject(err);
      try {
        const result = await fn(util.promisify(conn.query).bind(conn));
        conn.release();
        resolve(result);
      } catch (e) {
        conn.release();
        reject(e);
      }
    });
  });
}

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/* ── clinic-side index: phone → { booked, visited, apptDate } ─────────────── */
/**
 * One chunked pass over the branch clinic DB. Returns a Map keyed by
 * normalised phone. Absent key = never appeared in `appointment` at all.
 */
async function buildVisitIndex(clinicDB, phones, fromDate, toDate) {
  const index = new Map();
  if (!phones.length) return index;

  const clinicQuery = util.promisify(clinicDB.query).bind(clinicDB);
  const start = `${fromDate} 00:00:00`;
  const end = `${toDate} 23:59:59`;

  for (const part of chunk(phones, PHONE_CHUNK)) {
    const placeholders = part.map(() => "?").join(",");
    const rows = await clinicQuery(
      `SELECT patient_phone, patient_id, appointment_timestamp,
              confirm_time, patient_type
         FROM appointment
        WHERE patient_phone IN (${placeholders})
          AND appointment_timestamp BETWEEN ? AND ?
          AND is_deleted != 1`,
      [...part, start, end],
    );

    for (const r of rows) {
      const key = normPhone(r.patient_phone);
      const prev = index.get(key) || {
        booked: false,
        visited: false,
        apptDate: null,
        patientId: null,
      };

      prev.booked = true;
      if (
        !prev.apptDate ||
        new Date(r.appointment_timestamp) < new Date(prev.apptDate)
      ) {
        prev.apptDate = r.appointment_timestamp;
      }
      // The visit test used across the codebase for "actually walked in".
      if (String(r.confirm_time) !== "0" && r.patient_type === "New") {
        prev.visited = true;
        prev.patientId = r.patient_id;
      }
      index.set(key, prev);
    }
  }

  return index;
}

/* ── channel fetchers: return deduped raw leads for one branch ────────────── */

async function fetchWebLeads(location, from, to) {
  const { connection: leadDB } = getConnectionByLocation("lead");
  if (!leadDB)
    throw Object.assign(new Error("Lead DB unavailable"), { status: 404 });

  const { whereClause, params } = buildAreaWhere(location);

  const rows = await withPooled(leadDB, (q) =>
    q(
      `SELECT *
         FROM appointments
        WHERE ${whereClause}
          AND date BETWEEN ? AND ?
        ORDER BY appointment_id DESC`,
      [...params, `${from}T00:00:00+05:30`, `${to}T23:59:59+05:30`],
    ),
  );

  return dedupeByPhone(
    rows.map((r) => ({
      leadId: r.appointment_id,
      leadDate: r.date,
      name: r.name || "",
      phone: r.phoneno,
      email: r.email || r.emailid || "",
      condition: r.disease || r.condition || "",
      message: r.message || r.query || "",
      status: r.status || "",
      note: r.note || "",
    })),
  );
}

async function fetchBotLeads(location, from, to) {
  const { connection: leadDB } = getConnectionByLocation("lead");
  if (!leadDB)
    throw Object.assign(new Error("Lead DB unavailable"), { status: 404 });

  const { whereClause, params } = buildBranchWhere(location);

  const rows = await withPooled(leadDB, (q) =>
    q(
      `SELECT id AS appointment_id, datetime AS date, name, branch,
              contact AS phoneno, email, disease, chat_whatsapp_branch,
              query AS message, status, note
         FROM chatbot_leads
        WHERE ${whereClause}
          AND DATE(datetime) BETWEEN ? AND ?
        ORDER BY id DESC`,
      [...params, from, to],
    ),
  );

  return dedupeByPhone(
    rows.map((r) => ({
      leadId: r.appointment_id,
      leadDate: r.date,
      name: r.name || "",
      phone: r.phoneno,
      email: r.email || "",
      condition: r.disease || "",
      message: r.message || "",
      status: r.status || "",
      note: r.note || "",
    })),
  );
}

async function fetchIvrLeads(location, from, to) {
  const { connection: ivrDB } = getConnectionByLocation(location);
  if (!ivrDB)
    throw Object.assign(new Error(`Invalid location: ${location}`), {
      status: 404,
    });

  // call_date is stored as 'YYYY-DD-MM', hence the STR_TO_DATE mask.
  const rows = await withPooled(ivrDB, (q) =>
    q(
      `SELECT ivr_id, call_date, call_time, call_duration, call_status,
              caller_no, circle_name, destination_name, destination_no, note
         FROM IVRdata
        WHERE STR_TO_DATE(call_date, '%Y-%d-%m') BETWEEN ? AND ?
          AND destination_no != ''
        ORDER BY ivr_id DESC`,
      [from, to],
    ),
  );

  return dedupeByPhone(
    rows.map((r) => ({
      leadId: r.ivr_id,
      leadDate: r.call_date,
      callTime: r.call_time,
      duration: r.call_duration,
      callStatus: r.call_status,
      name: "",
      phone: r.caller_no,
      email: "",
      condition: "",
      message: "",
      circle: r.circle_name || "",
      destination: r.destination_name || r.destination_no || "",
      status: "",
      note: r.note || "",
    })),
  );
}

async function fetchHelplineLeads(location, from, to) {
  const { connection: clinicDB } = getConnectionByLocation(location);
  if (!clinicDB)
    throw Object.assign(new Error(`Invalid location: ${location}`), {
      status: 404,
    });

  // `timestamp` is epoch millis (stored as a string in some branches, hence the
  // Number() below), so the range is built from IST day boundaries.
  const startMs = new Date(`${from}T00:00:00+05:30`).getTime();
  const endMs = new Date(`${to}T23:59:59+05:30`).getTime();

  const excludePlaceholders = EXCLUDED_NUMBERS.map(() => "?").join(",");

  const rows = await withPooled(clinicDB, (q) =>
    q(
      `SELECT phoneNumber, timestamp, type, duration, note
         FROM phonecalllogs
        WHERE timestamp BETWEEN ? AND ?
          AND phoneNumber NOT IN (${excludePlaceholders})
        ORDER BY timestamp DESC`,
      [startMs, endMs, ...EXCLUDED_NUMBERS],
    ),
  );

  // One caller can appear many times across MISSED / INCOMING / OUTGOING rows.
  // Roll them up so the report shows one line per person, with the call history
  // summarised — a missed call that was never returned is the sharpest signal
  // in this whole report.
  const byPhone = new Map();

  for (const r of rows) {
    const key = normPhone(r.phoneNumber);
    if (!key) continue;

    const ts = Number(r.timestamp) || 0;
    const type = String(r.type || "").toUpperCase();

    const agg = byPhone.get(key) || {
      leadId: key,
      phone: r.phoneNumber,
      callCount: 0,
      missedCount: 0,
      answeredCount: 0,
      outgoingCount: 0,
      totalDuration: 0,
      firstCall: ts,
      lastCall: ts,
      notes: [],
      name: "",
      email: "",
      condition: "",
      message: "",
      status: "",
    };

    // UNKNOWN is treated as MISSED throughout this codebase.
    if (type === "MISSED" || type === "UNKNOWN") agg.missedCount += 1;
    else if (type === "INCOMING") agg.answeredCount += 1;
    else if (type === "OUTGOING") agg.outgoingCount += 1;

    if (type !== "OUTGOING") agg.callCount += 1; // inbound attempts only
    agg.totalDuration += Number(r.duration) || 0;
    if (ts && ts < agg.firstCall) agg.firstCall = ts;
    if (ts && ts > agg.lastCall) agg.lastCall = ts;
    if (r.note && String(r.note).trim()) agg.notes.push(String(r.note).trim());

    byPhone.set(key, agg);
  }

  // A number we only ever dialled out to never enquired — not a lead.
  return [...byPhone.entries()]
    .filter(([, agg]) => agg.callCount > 0)
    .map(([key, agg]) => ({
      ...agg,
      leadDate: agg.firstCall,
      note: [...new Set(agg.notes)].join(" | ").slice(0, 500),
      _phone: key,
    }))
    .sort((a, b) => b.lastCall - a.lastCall);
}

// Keep the first (most recent) row per phone — one person calling five times
// is one lost lead, not five.
function dedupeByPhone(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = normPhone(r.phone);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...r, _phone: key });
  }
  return out;
}

/* ── per-branch classification ────────────────────────────────────────────── */

async function getLostLeadsForLocation(channel, location, from, to) {
  const { connection: clinicDB } = getConnectionByLocation(location);
  if (!clinicDB)
    throw Object.assign(new Error(`Invalid location: ${location}`), {
      status: 404,
    });

  const leads =
    channel === "web"
      ? await fetchWebLeads(location, from, to)
      : channel === "bot"
        ? await fetchBotLeads(location, from, to)
        : channel === "helpline"
          ? await fetchHelplineLeads(location, from, to)
          : await fetchIvrLeads(location, from, to);

  // Look for visits a bit past the range end, but never into the future.
  const today = istDate();
  const graceEnd = addDays(to, VISIT_GRACE_DAYS);
  const visitTo = graceEnd > today ? today : graceEnd;

  const index = await buildVisitIndex(
    clinicDB,
    leads.map((l) => l._phone),
    from,
    visitTo,
  );

  const notConverted = [];
  const notVisited = [];

  for (const lead of leads) {
    const hit = index.get(lead._phone) || { booked: false, visited: false };
    // A synced 'Appointment' status also counts as booked (web/bot only).
    const booked = hit.booked || lead.status === "Appointment";

    if (!booked) {
      notConverted.push(buildRow(channel, location, lead, null, "enquiry", to));
    } else if (!hit.visited) {
      notVisited.push(
        buildRow(channel, location, lead, hit, "appointment", to),
      );
    }
    // booked && visited → converted, not a lost lead.
  }

  return {
    location,
    totalLeads: leads.length,
    notConverted,
    notVisited,
    converted: leads.length - notConverted.length - notVisited.length,
  };
}

/* ── row shaping (these keys become the Excel column headers) ─────────────── */

function buildRow(channel, location, lead, hit, bucket, to) {
  if (channel === "helpline") {
    const base = {
      Branch: location,
      "Caller No": lead.phone || "",
      "First Call": fmtDate(lead.firstCall),
      "Last Call": fmtDate(lead.lastCall),
      "Inbound Calls": lead.callCount,
      Missed: lead.missedCount,
      Answered: lead.answeredCount,
      // The actionable column: a missed enquiry nobody rang back.
      "Called Back": lead.outgoingCount > 0 ? "Yes" : "No",
      "Talk Time (s)": lead.totalDuration,
      Note: lead.note || "",
    };
    return bucket === "enquiry"
      ? {
          ...base,
          "Days Since Last Call": daysBetween(lead.lastCall, to) ?? "",
        }
      : {
          ...base,
          "Appointment Date": fmtDate(hit?.apptDate),
          "Days Since Appointment": daysBetween(hit?.apptDate, to) ?? "",
        };
  }

  if (channel === "ivr") {
    const base = {
      Branch: location,
      "Call Date": lead.leadDate || "",
      "Call Time": lead.callTime || "",
      "Caller No": lead.phone || "",
      "Call Status": lead.callStatus || "",
      "Duration (s)": lead.duration ?? "",
      "Received On": lead.destination || "",
      Note: lead.note || "",
    };
    return bucket === "enquiry"
      ? { ...base, "Days Since Call": daysBetween(lead.leadDate, to) ?? "" }
      : {
          ...base,
          "Appointment Date": fmtDate(hit?.apptDate),
          "Days Since Appointment": daysBetween(hit?.apptDate, to) ?? "",
        };
  }

  const base = {
    Branch: location,
    Channel: CHANNELS[channel],
    "Lead Date": fmtDate(lead.leadDate),
    Name: lead.name || "",
    Phone: lead.phone || "",
    Email: lead.email || "",
    Condition: lead.condition || "",
    Enquiry: String(lead.message || "").slice(0, 500),
    "Lead Status": lead.status || "—",
    Note: lead.note || "",
  };

  return bucket === "enquiry"
    ? { ...base, "Days Since Enquiry": daysBetween(lead.leadDate, to) ?? "" }
    : {
        ...base,
        "Appointment Date": fmtDate(hit?.apptDate),
        "Days Since Appointment": daysBetween(hit?.apptDate, to) ?? "",
      };
}

/* ── public entry point ───────────────────────────────────────────────────── */

/**
 * @param {object}   opts
 * @param {string}   opts.channel    "web" | "bot" | "ivr"
 * @param {string}   opts.from       YYYY-MM-DD
 * @param {string}   opts.to         YYYY-MM-DD
 * @param {string[]} opts.locations  branches to include (defaults to all)
 */
async function getLostLeads({ channel, from, to, locations }) {
  if (!CHANNELS[channel]) {
    throw Object.assign(
      new Error(`channel must be one of: ${Object.keys(CHANNELS).join(", ")}`),
      { status: 400 },
    );
  }
  if (!from || !to) {
    throw Object.assign(new Error("from and to are required (YYYY-MM-DD)"), {
      status: 400,
    });
  }
  if (from > to) {
    throw Object.assign(new Error("`from` cannot be after `to`"), {
      status: 400,
    });
  }

  const branches =
    Array.isArray(locations) && locations.length ? locations : ALL_LOCATIONS;

  // One branch failing (DB down, bad alias) shouldn't sink the whole report.
  const settled = await Promise.all(
    branches.map(async (loc) => {
      try {
        return {
          ok: true,
          ...(await getLostLeadsForLocation(channel, loc, from, to)),
        };
      } catch (e) {
        console.error(`Lost leads failed for ${loc}:`, e.message);
        return { ok: false, location: loc, error: e.message };
      }
    }),
  );

  const good = settled.filter((r) => r.ok);
  const failed = settled
    .filter((r) => !r.ok)
    .map(({ location, error }) => ({ location, error }));

  const notConverted = good.flatMap((r) => r.notConverted);
  const notVisited = good.flatMap((r) => r.notVisited);

  const summary = good
    .map((r) => ({
      Branch: r.location,
      "Total Leads": r.totalLeads,
      "No Appointment": r.notConverted.length,
      "Appointment Not Visited": r.notVisited.length,
      Converted: r.converted,
      "Lost %":
        r.totalLeads === 0
          ? 0
          : Math.round(
              ((r.notConverted.length + r.notVisited.length) / r.totalLeads) *
                100,
            ),
    }))
    .sort((a, b) => b["Total Leads"] - a["Total Leads"]);

  const totals = summary.reduce(
    (acc, r) => ({
      Branch: "TOTAL",
      "Total Leads": acc["Total Leads"] + r["Total Leads"],
      "No Appointment": acc["No Appointment"] + r["No Appointment"],
      "Appointment Not Visited":
        acc["Appointment Not Visited"] + r["Appointment Not Visited"],
      Converted: acc.Converted + r.Converted,
      "Lost %": 0,
    }),
    {
      Branch: "TOTAL",
      "Total Leads": 0,
      "No Appointment": 0,
      "Appointment Not Visited": 0,
      Converted: 0,
      "Lost %": 0,
    },
  );
  totals["Lost %"] =
    totals["Total Leads"] === 0
      ? 0
      : Math.round(
          ((totals["No Appointment"] + totals["Appointment Not Visited"]) /
            totals["Total Leads"]) *
            100,
        );
  if (summary.length) summary.push(totals);

  return {
    channel,
    channelLabel: CHANNELS[channel],
    from,
    to,
    graceDays: VISIT_GRACE_DAYS,
    branchesRequested: branches.length,
    branchesProcessed: good.length,
    notConverted,
    notVisited,
    summary,
    failed,
  };
}

module.exports = { getLostLeads, VISIT_GRACE_DAYS };
