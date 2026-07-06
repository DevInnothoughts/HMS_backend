// branchTargetModel.js
// ─────────────────────────────────────────────────────────────────────────────
// Master-database access for branch-wise, financial-year target percentages.
//
// targetComparisonModel.js calls getTargetMap(fy) once per request and uses the
// returned percentages to derive each parameter's target
// (target = lastYear * (1 + target_pct/100)). If the table/row/connection is
// unavailable, getTargetMap returns {} and the caller falls back to its
// prototype defaults — so the feature keeps working before the table is filled.
//
// The master DB is reached through the project's existing connection factory:
//   getConnectionByLocation("lead")
//
// Table lives in the master DB (see branch_target.sql). One row per (branch, FY);
// all parameter percentages are stored together in a JSON column. Convention:
//   • branch_name = the location name exactly as the app sends it (e.g. "Baner")
//   • branch_name = 'ALL' holds the consolidated ("All Branches") targets
//   • fy          = financial year like "2025-26" (April–March)
//   • targets     = JSON object keyed by the 9 UI keys (newPatients, conversion,
//                   sx, avgIpd, ipdRevenue, pharmacy, lab, opd, total). A partial
//                   object is fine — missing keys fall back to defaults.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../databaseUtils");

// Connection key for the master DB in the shared connection factory.
const MASTER_DB_KEY = "lead";

const makeRunner =
  (connection) =>
  (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) =>
        err ? reject(err) : resolve(rows),
      ),
    );

// Financial year of a date, April–March.
//   "2025-04-01" → "2025-26"   "2026-02-10" → "2025-26"   "2025-03-31" → "2024-25"
function financialYearOf(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr).trim());
  let year;
  let month;
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
  } else {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) throw new Error(`Invalid date: ${dateStr}`);
    year = d.getFullYear();
    month = d.getMonth() + 1;
  }
  const startYear = month >= 4 ? year : year - 1; // fiscal year starts in April
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

// JSON column may arrive as a parsed object (mysql2) or a string (mysql).
function parseTargets(val) {
  if (!val) return {};
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch (_) {
    return {};
  }
}

/**
 * getTargetMap(fy)
 * Returns { [branch_name]: { [param_key]: target_pct } } for one financial year.
 * On any failure returns {} (caller falls back to default percentages).
 */
async function getTargetMap(fy) {
  try {
    const { connection } = getConnectionByLocation(MASTER_DB_KEY);
    if (!connection) throw new Error(`No connection for "${MASTER_DB_KEY}" DB`);
    const run = makeRunner(connection);

    const rows = await run(
      `SELECT branch_name, targets
         FROM branch_target
        WHERE fy = ?`,
      [fy],
    );

    const map = {};
    for (const r of rows) {
      const obj = parseTargets(r.targets);
      const pcts = {};
      for (const [key, val] of Object.entries(obj)) {
        const n = Number(val);
        if (!Number.isNaN(n)) pcts[key] = n;
      }
      map[r.branch_name] = pcts;
    }
    return map;
  } catch (e) {
    console.error(
      `branch_target lookup failed for FY ${fy} (using defaults):`,
      {
        code: e?.code,
        errno: e?.errno,
        message: e?.sqlMessage || e?.message,
      },
    );
    return {};
  }
}

module.exports = {
  getTargetMap,
  financialYearOf,
};
