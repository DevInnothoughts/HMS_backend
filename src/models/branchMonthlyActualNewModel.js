// branchMonthlyActualModel.js
// ─────────────────────────────────────────────────────────────────────────────
// LAST-YEAR actuals, served from the MASTER database instead of the live branch
// DBs. Requirement 1: last year's monthly numbers are now stored centrally, so
// the comparison reads the relevant months from here rather than re-querying
// each branch's own database for a period a year ago.
//
// Table `branch_monthly_actual` (one row per branch per calendar month) mirrors
// Monthly_Numbers.csv exactly:
//   branch_name, period_month (DATE, 1st of month),
//   new_patients, sx, avg_ipd, ipd_revenue, pharmacy, lab, opd, total
//
// Master DB reached the usual way: getConnectionByLocation("lead").
//
// getMonthlyActuals(location, from, to)
//   Returns the SUMMED components for every month whose 1st falls in [from, to],
//   in the same RAW shape the comparison model's getLocationRaw() produces, so
//   the two are interchangeable downstream:
//     { newPatients, ipdInvoiceTotal, ipdInvoiceCount, pharmacyTotal,
//       opdTotal, labTotal, _months, _found }
//
// SUMMING RULES
//   Sum-type columns (new_patients, sx, ipd_revenue, pharmacy, lab, opd) are
//   added across months. avg_ipd is a per-case average (a rate) and is NEVER
//   summed — the correct period figure is total IPD revenue / total SX, which
//   the comparison model already derives from the summed components downstream.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../databaseUtils");

const MASTER_DB_KEY = "lead";

const makeRunner =
  (connection) =>
  (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) =>
        err ? reject(err) : resolve(rows),
      ),
    );

const num = (v) => Number(v) || 0;

/**
 * getMonthlyActuals(location, from, to)
 * Sums the stored monthly rows whose period_month is within [from, to].
 * `from`/`to` are 'YYYY-MM-DD'; we match on the month value with
 * period_month BETWEEN date(from-first-of-month) AND to, which for the app's
 * whole-month/quarter/year ranges selects exactly the intended months.
 */
async function getMonthlyActuals(location, from, to) {
  const { connection } = getConnectionByLocation(MASTER_DB_KEY);
  if (!connection) throw new Error(`No connection for "${MASTER_DB_KEY}" DB`);
  const run = makeRunner(connection);

  // Normalise `from` to the 1st of its month so a range that starts on, say,
  // the 1st still includes that month's row (period_month is stored as the 1st).
  const fromMonth = `${String(from).slice(0, 7)}-01`;

  const rows = await run(
    `SELECT
        COALESCE(SUM(new_patients), 0) AS newPatients,
        COALESCE(SUM(sx), 0)           AS sx,
        COALESCE(SUM(ipd_revenue), 0)  AS ipdRevenue,
        COALESCE(SUM(pharmacy), 0)     AS pharmacy,
        COALESCE(SUM(lab), 0)          AS lab,
        COALESCE(SUM(opd), 0)          AS opd,
        COUNT(*)                       AS monthsFound
       FROM branch_monthly_actual
      WHERE branch_name = ?
        AND period_month BETWEEN ? AND ?`,
    [location, fromMonth, to],
  );

  const r = rows[0] || {};
  return {
    // Same RAW shape as getLocationRaw() in the comparison model.
    newPatients: num(r.newPatients),
    ipdInvoiceTotal: num(r.ipdRevenue), // IPD revenue (sum)
    ipdInvoiceCount: num(r.sx), // No. of SX  (sum)
    pharmacyTotal: num(r.pharmacy),
    opdTotal: num(r.opd),
    labTotal: num(r.lab),
    _months: [fromMonth, to],
    _found: num(r.monthsFound), // 0 → no stored data for this branch/period
  };
}

module.exports = { getMonthlyActuals };
