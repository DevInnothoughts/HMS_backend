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
async function getCallLeads(location) {
  const { connection } = getConnectionByLocation(DB_KEY);
  if (!connection) {
    const err = new Error(`Invalid location: ${location}`);
    err.status = 404;
    throw err;
  }

  const aliases = LOCATION_ALIASES[location] || [];
  const aliasClause = aliases.length
    ? ` OR LOWER(call_location) IN (${aliases.map(() => "LOWER(?)").join(", ")})`
    : "";

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
      AND (call_location LIKE CONCAT('%', ?, '%')${aliasClause})
    ORDER BY id DESC
    LIMIT 100
  `;

  const params = [location, ...aliases];

  return new Promise((resolve, reject) => {
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

module.exports = {
  getCallLeads,
  updateStatusCall,
  getUnmappedCallLocations,
  LOCATION_ALIASES,
  inferTreatment,
};
