// src/models/overview/labModel.js
// ─────────────────────────────────────────────────────────────────────────────
// The Laboratory section:
//   metrics  Tests billed · Revenue · Avg per patient · Avg per test
//   blocks   Test-wise revenue (every lab subtype, largest first)
//   deltas   optional, against the preceding period of equal length
//
// ⚠️ OPD LAB ONLY — THERE IS NO IPD LAB DATA
// ──────────────────────────────────────────
// Lab billing lives entirely in patient_itemreceipt, which is the OPD billing
// table. The prototype's "Avg per IPD patient" card and its "IPD" table row
// have no source and are NOT implemented — an IPD lab figure here would be
// invented. They return when IPD lab items are recorded somewhere.
//
// WHAT COUNTS AS A LAB ROW
// ────────────────────────
// Exactly what getLabRevenue counts: the normalised `consultation` matched
// against the master consultationMasterData list, payment_mode restricted to
// the four getLocationSummary uses, is_deleted != 1. The definition is imported
// rather than copied, so the section can never disagree with the Lab slice of
// the home screen's billing bar.
//
// "TESTS" MEANS BILLED ROWS
// ─────────────────────────
// One patient_itemreceipt row is one billed line. If a branch bills a panel as
// a single line, that panel counts as one — so this is items billed, not
// individual analytes. The UI labels it "Tests billed" because that is the
// business's word for it; `distinctTests` is returned alongside so the screen
// can say how many DIFFERENT tests those rows covered.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../../databaseUtils");
const { getLabConsultationNames } = require("../targetComparisonNewModel");
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

// Identical to getLabRevenue's filters — see the header.
const MODES = "('Cash', 'Card', 'Online', 'UPI')";
const NORM_COL = "REPLACE(LOWER(COALESCE(consultation, '')), ' ', '')";

/**
 * Every lab subtype in the window, grouped by the raw consultation name.
 *
 * Grouped on the NORMALISED name so "CBC" and "C B C" merge, but MAX(raw) is
 * carried through for display — the normalised form is lowercase and stripped
 * of spaces, which reads badly on screen.
 */
const bySubtypeSql = (labCount) => `
  SELECT ${NORM_COL}                      AS normName,
         MAX(consultation)                AS label,
         COUNT(*)                         AS tests,
         COUNT(DISTINCT patient_id)       AS patients,
         COALESCE(SUM(total), 0)          AS amount
    FROM patient_itemreceipt
   WHERE item_date BETWEEN ? AND ?
     AND is_deleted != 1
     AND payment_mode IN ${MODES}
     AND ${NORM_COL} IN (${Array(labCount).fill("?").join(", ")})
   GROUP BY ${NORM_COL}
   ORDER BY amount DESC
`;

// Totals computed independently rather than by summing the groups — if the two
// disagree, the grouping is wrong and that should be visible, not smoothed over.
const totalsSql = (labCount) => `
  SELECT COUNT(*)                    AS tests,
         COUNT(DISTINCT patient_id)  AS patients,
         COALESCE(SUM(total), 0)     AS amount
    FROM patient_itemreceipt
   WHERE item_date BETWEEN ? AND ?
     AND is_deleted != 1
     AND payment_mode IN ${MODES}
     AND ${NORM_COL} IN (${Array(labCount).fill("?").join(", ")})
`;

async function gather(run, from, to, labNames, detailed) {
  if (!labNames.length) {
    return { tests: 0, patients: 0, revenue: 0, subtypes: [] };
  }

  const [totalRows, groupRows] = await Promise.all([
    run(totalsSql(labNames.length), [from, to, ...labNames]),
    detailed
      ? run(bySubtypeSql(labNames.length), [from, to, ...labNames])
      : Promise.resolve(null),
  ]);

  const t = totalRows?.[0] || {};
  const tests = n0(t.tests);
  const patients = n0(t.patients);
  const revenue = Math.round(n0(t.amount));

  const base = {
    tests,
    patients,
    revenue,
    avgPerPatient: patients > 0 ? Math.round(revenue / patients) : null,
    avgPerTest: tests > 0 ? Math.round(revenue / tests) : null,
  };

  if (!detailed) return base;

  const subtypes = (groupRows || []).map((r) => {
    const amount = Math.round(n0(r.amount));
    const cnt = n0(r.tests);
    return {
      key: r.normName,
      // Title Case the stored name — these are entered by hand and arrive as
      // "CBC", "cbc" and "Cbc" across branches.
      label:
        String(r.label || "")
          .trim()
          .replace(/\s+/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase()) || "Unnamed test",
      tests: cnt,
      patients: n0(r.patients),
      amount,
      avg: cnt > 0 ? Math.round(amount / cnt) : null,
    };
  });

  return { ...base, subtypes, distinctTests: subtypes.length };
}

/**
 * getLabSection({ location, from, to, compare, preset })
 */
async function getLabSection({ location, from, to, compare, preset }) {
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

  // Master-DB lookup. If it fails there is no honest way to identify a lab row,
  // so the section reports zero rather than guessing at a name list.
  const labNames = await getLabConsultationNames().catch((e) => {
    console.error("overview/lab: lab name lookup failed:", e.message);
    return [];
  });

  const current = await gather(run, from, to, labNames, true);

  let prev = null;
  let prevRange = null;
  if (compare === "prev") {
    prevRange = previousPeriod(from, to, preset);
    // Totals only for the comparison window — nothing shows a per-subtype delta.
    prev = await gather(run, prevRange.from, prevRange.to, labNames, false);
  }

  // Null rather than 0 when there is no base — "+100%" against a zero
  // yesterday is noise dressed as signal.
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
      // Tells the screen to say so rather than silently showing zeros.
      labNamesAvailable: labNames.length > 0,
      generatedAt: new Date().toISOString(),
    },
    tests: current.tests,
    patients: current.patients,
    distinctTests: current.distinctTests,
    revenue: current.revenue,
    avgPerPatient: current.avgPerPatient,
    avgPerTest: current.avgPerTest,
    subtypes: current.subtypes,
    prev: prev
      ? {
          tests: prev.tests,
          patients: prev.patients,
          revenue: prev.revenue,
          avgPerPatient: prev.avgPerPatient,
        }
      : null,
    deltas: prev
      ? {
          tests: delta(current.tests, prev.tests),
          patients: delta(current.patients, prev.patients),
          revenue: delta(current.revenue, prev.revenue),
          avgPerPatient: delta(current.avgPerPatient, prev.avgPerPatient),
        }
      : null,
  };
}

module.exports = { getLabSection };
