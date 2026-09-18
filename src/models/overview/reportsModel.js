// src/models/overview/reportsModel.js
// ─────────────────────────────────────────────────────────────────────────────
// The Reports section's summary cards:
//   Revenue · Patients · Avg per patient · Avg per new patient
//
// ⚠️ REVENUE IS getLocationSummary's grandTotal, UNCHANGED
// ────────────────────────────────────────────────────────
//   grandTotal = OPD collection + IPD BILLED (invoice) + Pharmacy collection
//
// IPD *cash* collection is deliberately NOT part of it — the billed invoice
// amount is used instead. Every revenue figure in this app is built that way
// (summary report, monthly revenue report, the home billing bar), so changing
// it here would make this section the only screen that disagrees.
//
// ⚠️ THE PATIENT COUNT IS APPOINTMENTS, NOT PEOPLE
// ────────────────────────────────────────────────
// As specified: non-deleted, CONFIRMED appointments in the range. So a patient
// who came twice in the period counts twice, and the average is per VISIT
// rather than per person.
//
// That is the right denominator for "what does a visit earn us", which is what
// this card answers. It is the wrong one for "what does a patient spend with
// us over time" — if that question comes up it needs COUNT(DISTINCT
// patient_id) and a different label, not a quiet change here. The response
// returns `uniquePatients` alongside so the difference is visible rather than
// arguable.
//
// confirm_time != 0 is the confirmation test used across this codebase. A
// booking nobody turned up for is not a visit and must not dilute the average.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../../databaseUtils");
const { getLocationSummary } = require("../reportMailModel");
const { previousPeriod } = require("./opdModel");

const n0 = (v) => Number(v) || 0;
const round0 = (v) => Math.round(n0(v));

const makeRunner =
  (connection) =>
  (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) =>
        err ? reject(err) : resolve(rows),
      ),
    );

/**
 * Visits and new visits in one pass.
 *
 * One query, two counts, so the two can never disagree about which rows are
 * confirmed — a separate "new" query would be a second place to keep the
 * predicate in step.
 */
const COUNTS_SQL = `
  SELECT
    COUNT(*)                                                   AS visits,
    COUNT(CASE WHEN patient_type = 'New' THEN 1 END)           AS newVisits,
    COUNT(DISTINCT patient_id)                                 AS uniquePatients,
    COUNT(DISTINCT CASE WHEN patient_type = 'New'
                        THEN patient_id END)                   AS uniqueNew
  FROM appointment
  WHERE appointment_timestamp >= ? AND appointment_timestamp <= ?
    AND is_deleted != 1
    AND confirm_time != 0
`;

async function gather(run, location, from, to) {
  const [summary, countRows] = await Promise.all([
    getLocationSummary(location, from, to),
    run(COUNTS_SQL, [`${from} 00:00:00`, `${to} 23:59:59`]).catch((e) => {
      console.error(
        `overview/reports: counts failed for ${location}:`,
        e.message,
      );
      return null;
    }),
  ]);

  const c = countRows?.[0] || {};
  const visits = n0(c.visits);
  const newVisits = n0(c.newVisits);
  const revenue = round0(summary?.grandTotal);

  return {
    revenue,
    visits,
    newVisits,
    uniquePatients: n0(c.uniquePatients),
    uniqueNew: n0(c.uniqueNew),
    // Null rather than 0 when there is no denominator — an average of ₹0 reads
    // as a real figure, and "no patients" is a different statement.
    avgPerPatient: visits > 0 ? Math.round(revenue / visits) : null,
    // ⚠️ The NUMERATOR is total revenue, not new-patient revenue — there is no
    // way to attribute pharmacy or IPD billing to a visit type. So this is
    // "revenue per new patient acquired", a cost-of-acquisition style figure,
    // NOT "what a new patient spent". It will always exceed avg per patient.
    // Labelled accordingly on screen.
    avgPerNewPatient: newVisits > 0 ? Math.round(revenue / newVisits) : null,
    breakdown: {
      opd: round0(summary?.opd?.total),
      ipd: round0(summary?.ipdInvoice?.total),
      pharmacy: round0(summary?.pharmacy?.total),
    },
  };
}

/**
 * getReportsSection({ location, from, to, compare, preset })
 */
async function getReportsSection({ location, from, to, compare, preset }) {
  if (!location) {
    const err = new Error("location is required");
    err.status = 400;
    throw err;
  }
  if (!from || !to) {
    const err = new Error("from and to are required (YYYY-MM-DD)");
    err.status = 400;
    throw err;
  }

  const { connection } = getConnectionByLocation(location);
  if (!connection) {
    const err = new Error(`Invalid location: ${location}`);
    err.status = 404;
    throw err;
  }
  const run = makeRunner(connection);

  const current = await gather(run, location, from, to);

  let prev = null;
  let prevRange = null;
  if (compare === "prev") {
    prevRange = previousPeriod(from, to, preset);
    prev = await gather(run, location, prevRange.from, prevRange.to);
  }

  const delta = (cur, before) => {
    if (cur == null || before == null || before === 0) return null;
    return Math.round(((cur - before) / before) * 100);
  };

  return {
    meta: {
      location,
      from,
      to,
      compare: prevRange,
      singleDay: from === to,
      generatedAt: new Date().toISOString(),
    },
    ...current,
    prev: prev
      ? {
          revenue: prev.revenue,
          visits: prev.visits,
          avgPerPatient: prev.avgPerPatient,
        }
      : null,
    deltas: prev
      ? {
          revenue: delta(current.revenue, prev.revenue),
          visits: delta(current.visits, prev.visits),
          avgPerPatient: delta(current.avgPerPatient, prev.avgPerPatient),
          avgPerNewPatient: delta(
            current.avgPerNewPatient,
            prev.avgPerNewPatient,
          ),
        }
      : null,
  };
}

module.exports = { getReportsSection };
