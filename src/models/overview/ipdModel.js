// src/models/overview/ipdModel.js
// ─────────────────────────────────────────────────────────────────────────────
// The redesigned Inpatient section:
//   metrics  Admissions · Male/Female · Revenue · Avg per patient
//   tables   Patient type (invoice.status) · Surgery-wise (diagnosis.speciality)
//   deltas   optional, against the preceding period of equal length
//
// The insurance claim funnel is NOT implemented. Its six stages (Raised,
// Pre-auth, Queried, Approved, Settled, Rejected) have no confirmed source —
// insurance_invoice carries payment rows, not a stage machine — so it is left
// out rather than approximated. Approximating it would put six authoritative
// numbers on screen with nothing behind them.
//
// ── DEFINITIONS, ALL BORROWED ───────────────────────────────────────────────
// "IPD case" = one patient with at least one non-deleted invoice in the range.
// A patient billed twice is ONE case. This is exactly how surgeryRevenueReportModel
// and DoctorPerformanceModel define a surgery, so the surgery table here matches
// those reports rather than inventing a third count.
//
// "Surgery type" = that patient's LATEST diagnosis.speciality up to `to`.
// Cases with no diagnosis on record group as "Unspecified" so the rows always
// sum back to the total — a silently dropped remainder is worse than an
// honest bucket.
//
// "Patient type" = invoice.status, the same column IPDDueList and
// consolidatedDataModel filter on: Cashless, NonInsurance, Reimbursement, PDC,
// Charity.
//
// ── WHY TWO COUNTS ARE REPORTED ─────────────────────────────────────────────
// The home screen's IPD tile shows dashboardModel's ipd_count, which counts
// INVOICE ROWS. The tables here count PATIENTS. They differ whenever a patient
// has two invoices in the window. Both are returned — `invoices` and `cases` —
// and the screen shows the difference rather than letting two screens disagree
// with no explanation.
//
// Revenue is SUM(invoice.totalamt), the same figure getLocationSummary's
// ipdInvoice total produces, so it equals the IPD slice of the home screen's
// collection bar.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../../databaseUtils");
const { tallySex } = require("../utils/sex");
const { previousPeriod } = require("./opdModel");

const makeRunner =
  (connection) =>
  (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) =>
        err ? reject(err) : resolve(rows),
      ),
    );

const n0 = (v) => Number(v) || 0;

// invoice.status → what the business calls it. Anything not on this list keeps
// its raw value rather than being dropped or lumped into "Other" — an unknown
// status is a data question, and hiding it prevents the question being asked.
const STATUS_LABEL = {
  Cashless: "Cashless",
  NonInsurance: "Non-insurance",
  Reimbursement: "Reimbursement",
  PDC: "PDC",
  Charity: "Charity",
};

// Display order, matching the prototype. Unlisted statuses sort after these.
const STATUS_ORDER = [
  "Cashless",
  "NonInsurance",
  "Reimbursement",
  "PDC",
  "Charity",
];

/* ── SQL ──────────────────────────────────────────────────────────────────── */

// One row per patient per status. A patient with two invoices of the SAME
// status is one row; with two different statuses, two rows — rare, and the
// footer note surfaces it because the type rows will then exceed the case count.
const BY_STATUS_SQL = `
  SELECT COALESCE(NULLIF(TRIM(i.status), ''), 'Unspecified') AS status,
         COUNT(DISTINCT i.patient_id) AS patients,
         COUNT(*)                     AS invoices,
         SUM(COALESCE(i.totalamt, 0)) AS amount,
         SUM(COALESCE(i.totaldue, 0)) AS due
  FROM invoice i
  WHERE i.creation_date >= ? AND i.creation_date <= ?
    AND i.is_deleted != 1
  GROUP BY COALESCE(NULLIF(TRIM(i.status), ''), 'Unspecified')
`;

// Totals, computed independently rather than by summing the rows above — if
// the two disagree, something is wrong with the grouping and it should be
// visible, not smoothed over.
const TOTALS_SQL = `
  SELECT COUNT(DISTINCT i.patient_id) AS cases,
         COUNT(*)                     AS invoices,
         SUM(COALESCE(i.totalamt, 0)) AS amount,
         SUM(COALESCE(i.totaldue, 0)) AS due
  FROM invoice i
  WHERE i.creation_date >= ? AND i.creation_date <= ?
    AND i.is_deleted != 1
`;

// Revenue per patient, so surgery type and gender can be attributed by joining
// in JS. Kept separate from the diagnosis lookup because a patient's diagnosis
// may predate the window.
const PER_PATIENT_SQL = `
  SELECT i.patient_id,
         SUM(COALESCE(i.totalamt, 0)) AS amount,
         p.sex AS sex
  FROM invoice i
  LEFT JOIN patient p ON p.patient_id = i.patient_id
  WHERE i.creation_date >= ? AND i.creation_date <= ?
    AND i.is_deleted != 1
  GROUP BY i.patient_id, p.sex
`;

// Latest diagnosis per patient. Ordered ascending so the LAST row per patient
// wins — the same "latest diagnosis" rule DoctorPerformanceModel applies.
// Not restricted to the window: a patient operated in August may have been
// diagnosed in June, and restricting it would push most cases to Unspecified.
const DIAGNOSIS_SQL = `
  SELECT d.patient_id, d.speciality, d.date_diagnosis
  FROM diagnosis d
  WHERE d.patient_id IN (?)
    AND d.date_diagnosis <= ?
  ORDER BY d.patient_id, d.date_diagnosis
`;

/* ── core ─────────────────────────────────────────────────────────────────── */

async function gather(run, from, to, detailed) {
  const [statusRows, totalRows, perPatient] = await Promise.all([
    detailed ? run(BY_STATUS_SQL, [from, to]) : Promise.resolve(null),
    run(TOTALS_SQL, [from, to]),
    detailed ? run(PER_PATIENT_SQL, [from, to]) : Promise.resolve(null),
  ]);

  const totals = totalRows?.[0] || {};
  const cases = n0(totals.cases);
  const revenue = Math.round(n0(totals.amount));

  const base = {
    cases,
    invoices: n0(totals.invoices),
    revenue,
    due: Math.round(n0(totals.due)),
    avgPerPatient: cases > 0 ? Math.round(revenue / cases) : null,
  };

  if (!detailed) return base;

  // ── Patient type ──────────────────────────────────────────────────────────
  const byStatus = statusRows
    .map((r) => {
      const patients = n0(r.patients);
      const amount = Math.round(n0(r.amount));
      return {
        key: r.status,
        label: STATUS_LABEL[r.status] || r.status,
        patients,
        invoices: n0(r.invoices),
        amount,
        due: Math.round(n0(r.due)),
        // Charity bills at zero, so an average of 0 is a real answer here —
        // it must not be nulled out as "no data".
        avg: patients > 0 ? Math.round(amount / patients) : null,
      };
    })
    .sort((a, b) => {
      const ai = STATUS_ORDER.indexOf(a.key);
      const bi = STATUS_ORDER.indexOf(b.key);
      if (ai !== -1 || bi !== -1)
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return b.patients - a.patients;
    });

  // ── Gender ────────────────────────────────────────────────────────────────
  const gender = tallySex(
    perPatient.reduce((acc, r) => {
      const hit = acc.find((x) => x.sex === r.sex);
      if (hit) hit.cnt += 1;
      else acc.push({ sex: r.sex, cnt: 1 });
      return acc;
    }, []),
  );

  return { ...base, byStatus, perPatient, gender };
}

/**
 * Surgery-wise rows. Needs a second round trip because the patient list comes
 * from the first, so it is not folded into gather().
 */
async function surgeryRows(run, perPatient, to) {
  if (!perPatient?.length) return [];

  const ids = perPatient.map((r) => r.patient_id);
  const diagRows = await run(DIAGNOSIS_SQL, [ids, to]).catch((e) => {
    console.error("overview/ipd: diagnosis lookup failed:", e.message);
    return [];
  });

  // Rows are date-ascending, so the last write per patient is the latest.
  const latest = {};
  for (const d of diagRows) {
    const spec = String(d.speciality || "").trim();
    latest[d.patient_id] = spec || "Unspecified";
  }

  const bucket = {};
  for (const p of perPatient) {
    // Case-insensitive grouping so "Piles" and "piles" merge — the same
    // normalisation DoctorPerformanceModel applies.
    const raw = latest[p.patient_id] || "Unspecified";
    const key = raw.toLowerCase();
    if (!bucket[key]) bucket[key] = { label: raw, patients: 0, amount: 0 };
    bucket[key].patients += 1;
    bucket[key].amount += n0(p.amount);
  }

  return Object.entries(bucket)
    .map(([key, v]) => ({
      key,
      label: v.label.charAt(0).toUpperCase() + v.label.slice(1),
      patients: v.patients,
      amount: Math.round(v.amount),
      avg: v.patients > 0 ? Math.round(v.amount / v.patients) : null,
    }))
    .sort((a, b) => b.patients - a.patients || b.amount - a.amount);
}

/**
 * getIpdSection({ location, from, to, compare, preset })
 */
async function getIpdSection({ location, from, to, compare, preset }) {
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

  const current = await gather(run, from, to, true);
  const surgeries = await surgeryRows(run, current.perPatient, to);

  let prev = null;
  let prevRange = null;
  if (compare === "prev") {
    prevRange = previousPeriod(from, to, preset);
    // Only the totals for the comparison window — nothing in the design shows
    // a delta on a table row or on gender.
    prev = await gather(run, prevRange.from, prevRange.to, false);
  }

  // Null rather than 0 when there is nothing to compare against: "+100%"
  // against a zero yesterday is noise dressed as signal.
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
    counts: {
      cases: current.cases,
      invoices: current.invoices,
    },
    gender: current.gender,
    revenue: current.revenue,
    due: current.due,
    avgPerPatient: current.avgPerPatient,
    byStatus: current.byStatus,
    surgeries,
    prev: prev
      ? {
          cases: prev.cases,
          revenue: prev.revenue,
          avgPerPatient: prev.avgPerPatient,
        }
      : null,
    deltas: prev
      ? {
          cases: delta(current.cases, prev.cases),
          revenue: delta(current.revenue, prev.revenue),
          avgPerPatient: delta(current.avgPerPatient, prev.avgPerPatient),
        }
      : null,
  };
}

module.exports = { getIpdSection };
