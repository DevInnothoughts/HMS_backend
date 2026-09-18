// src/models/overview/opdModel.js
// ─────────────────────────────────────────────────────────────────────────────
// Everything the redesigned Outpatient section shows:
//   metrics  New patients · Male/Female · Revenue · Avg per patient
//   blocks   gender split bar · visit-type mix chips
//   deltas   optional, against the immediately preceding period of equal length
//
// FILTERS ARE COPIED, NOT INVENTED
// ────────────────────────────────
// The visit-type counts reproduce dashboardModel / dailyOPDModel exactly:
//     appointment: patient_type = ? AND is_deleted != 1 AND executivechk = 2
//     C+P:         patient_itemreceipt: consultation = 'PROCTOSCOPY'
//                  AND is_deleted != 1
// If those change there, they must change here. The whole point of this section
// is that tapping "OPD Report" shows the same numbers the cards above it do.
//
// C+P IS NOT A VISIT TYPE
// ───────────────────────
// New / Follow / Postoperative come from `appointment` — one row per visit.
// C+P comes from `patient_itemreceipt` — one row per BILLED PROCTOSCOPY, and a
// patient billed twice counts twice. So:
//   • "Patients seen" = new + follow + postop, NOT including C+P
//   • the gender split covers NEW appointments only — it will not sum to
//     `seen`, and it is not meant to
// The prototype's mock summed all four to 48 and matched the gender total to
// it. That cannot be reproduced honestly, so `seen` here excludes C+P and the
// mix chip for C+P is labelled as a procedure count.
//
// REVENUE
// ───────
// Reuses collectionModel.getCollection so the OPD number here is the same one
// the home screen's stacked bar shows — lab already netted out, cached for 60s.
// A second definition of "OPD revenue" is the fastest way to two disagreeing
// screens.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../../databaseUtils");
const { tallySex } = require("../utils/sex");
const { getCollection } = require("./collectionModel");
const { getLabConsultationNames } = require("../targetComparisonNewModel");
const makeRunner =
  (connection) =>
  (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) =>
        err ? reject(err) : resolve(rows),
      ),
    );

const n0 = (v) => Number(v) || 0;

/* ── date helpers ───────────────────────────────────────────────────────────
 * Plain YYYY-MM-DD arithmetic in UTC. appointment_timestamp and item_date are
 * compared as dates by every existing model, so no timezone shifting here —
 * introducing any would move the boundaries relative to those models.
 */
const parseYmd = (s) => {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
};
const toYmd = (dt) => dt.toISOString().slice(0, 10);
const addDays = (s, days) => {
  const dt = parseYmd(s);
  dt.setUTCDate(dt.getUTCDate() + days);
  return toYmd(dt);
};
const daysBetween = (from, to) =>
  Math.round((parseYmd(to) - parseYmd(from)) / 86400000);

/**
 * The comparison window: the same number of days, ending the day before `from`.
 * A single-day range therefore compares against yesterday, which is what the
 * design's "vs yesterday" wording assumes.
 */
const previousPeriod = (from, to) => {
  const span = daysBetween(from, to); // 0 for a single day
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -span), to: prevTo };
};

/* ── SQL ──────────────────────────────────────────────────────────────────── */

// One grouped query instead of three separate counts. Same filters as
// dashboardModel's three, just not run three times.
const VISIT_MIX_SQL = `
  SELECT patient_type, COUNT(*) AS cnt
  FROM appointment
  WHERE appointment_timestamp >= ? AND appointment_timestamp <= ?
    AND is_deleted != 1
    AND executivechk = 2
    AND patient_type IN ('New', 'Follow', 'Postoperative')
  GROUP BY patient_type
`;

// dashboardModel's proctoscopyCountQuery, unchanged.
// Note the exact string match: a row spelled 'PROCTOSCOPY + CONSULTATION' is
// NOT counted. That is the existing behaviour on the dashboard card, so it
// stays — but it is why this number can look low.
const PROCTO_SQL = `
  SELECT COUNT(consultation) AS procto
  FROM patient_itemreceipt
  WHERE item_date >= ? AND item_date <= ?
    AND consultation = 'PROCTOSCOPY'
    AND is_deleted != 1
`;

// Gender across NEW patients only. The mix and the revenue cards still cover
// all three appointment types; this one is deliberately narrower, because the
// question it answers is who is walking in for the first time.
//
// LEFT JOIN, so a visit whose patient row is missing still appears — as Other,
// not as a vanished visit that makes the split disagree with the New count.
const GENDER_SQL = `
  SELECT p.sex AS sex, COUNT(*) AS cnt
  FROM appointment ap
  LEFT JOIN patient p ON p.patient_id = ap.patient_id
  WHERE ap.appointment_timestamp >= ? AND ap.appointment_timestamp <= ?
    AND ap.is_deleted != 1
    AND ap.executivechk = 2
    AND ap.patient_type = 'New'
  GROUP BY p.sex
`;

// Revenue attributed to a visit type.
//
// patient_itemreceipt carries no patient_type. The link is the same one
// dashboardModel's proctoscopy query uses — same patient, same day. That join
// is imperfect and the UI says so: a receipt with no appointment on the same
// date (walk-in billing, or a receipt raised the day after) is not attributed,
// so the segments can sum to LESS than the Revenue card.
//
// Two filters copied from getLocationSummary / getLabRevenue, not invented:
//   • payment_mode IN ('Cash','Card','Online','UPI') — the card counts only
//     these, so attributing more would make the parts exceed the whole
//   • the normalised lab names are EXCLUDED, because the card is net of lab
const revenueByTypeSql = (labCount) => `
  SELECT ap.patient_type AS patient_type,
         SUM(COALESCE(pir.total, 0)) AS amount
  FROM patient_itemreceipt pir
  JOIN appointment ap
    ON ap.patient_id = pir.patient_id
   AND DATE(ap.appointment_timestamp) = pir.item_date
  WHERE pir.item_date BETWEEN ? AND ?
    AND pir.is_deleted != 1
    AND pir.payment_mode IN ('Cash', 'Card', 'Online', 'UPI')
    AND ap.is_deleted != 1
    AND ap.executivechk = 2
    AND ap.patient_type IN ('New', 'Follow', 'Postoperative')
    ${
      labCount
        ? `AND REPLACE(LOWER(COALESCE(pir.consultation, '')), ' ', '') NOT IN (${Array(labCount).fill("?").join(", ")})`
        : ""
    }
  GROUP BY ap.patient_type
`;

/* ── core ─────────────────────────────────────────────────────────────────── */
// `detailed` gates the two extra queries the comparison window doesn't need:
// nothing in the design shows a gender or revenue-split delta.
async function gather(run, location, from, to, detailed) {
  const [mixRows, proctoRows, sexRows, revRows, collection] = await Promise.all(
    [
      run(VISIT_MIX_SQL, [from, to]),
      run(PROCTO_SQL, [from, to]),
      detailed ? run(GENDER_SQL, [from, to]) : Promise.resolve(null),
      detailed
        ? getLabConsultationNames()
            .then((labNames) =>
              run(revenueByTypeSql(labNames.length), [from, to, ...labNames]),
            )
            // A master-DB failure shouldn't take the section down. Returning null
            // drops the split bar; it does NOT fall back to an unfiltered query,
            // which would silently fold lab revenue into the OPD segments.
            .catch((e) => {
              console.error(`overview/opd: lab names failed:`, e.message);
              return null;
            })
        : Promise.resolve(null),
      // A collection failure must not take the counts down with it — the section
      // still has three of its four cards without revenue.
      getCollection(location, from, to).catch((e) => {
        console.error(
          `overview/opd: collection failed for ${location}:`,
          e.message,
        );
        return null;
      }),
    ],
  );

  const byType = {};
  for (const r of mixRows) byType[r.patient_type] = n0(r.cnt);

  const counts = {
    new: n0(byType.New),
    follow: n0(byType.Follow),
    postop: n0(byType.Postoperative),
    procto: n0(proctoRows?.[0]?.procto),
  };
  counts.seen = counts.new + counts.follow + counts.postop; // C+P excluded — see header

  const revenue =
    collection?.byDept?.find((d) => d.key === "opd")?.amount ?? null;

  let revenueByType = null;
  if (revRows) {
    const rev = {};
    for (const r of revRows) rev[r.patient_type] = Math.round(n0(r.amount));
    revenueByType = {
      new: n0(rev.New),
      follow: n0(rev.Follow),
      postop: n0(rev.Postoperative),
    };
    revenueByType.attributed =
      revenueByType.new + revenueByType.follow + revenueByType.postop;
  }

  return {
    counts,
    gender: sexRows ? tallySex(sexRows) : null,
    revenueByType,
    revenue,
    avgPerPatient:
      revenue != null && counts.seen > 0
        ? Math.round(revenue / counts.seen)
        : null,
  };
}

/**
 * getOpdSection({ location, from, to, compare })
 * `compare === 'prev'` adds a `prev` block and the percentage deltas.
 */
async function getOpdSection({ location, from, to, compare }) {
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

  const current = await gather(run, location, from, to, true);

  let prev = null;
  let prevRange = null;
  if (compare === "prev") {
    prevRange = previousPeriod(from, to);
    // Gender and the revenue split are not fetched for the comparison window:
    // nothing in the design shows a delta on either.
    prev = await gather(run, location, prevRange.from, prevRange.to, false);
  }

  // Null rather than 0 when there is no base to compare against: "+100%"
  // against a zero yesterday is noise dressed as a signal.
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
    counts: current.counts,
    gender: current.gender,
    revenueByType: current.revenueByType,
    revenue: current.revenue,
    avgPerPatient: current.avgPerPatient,
    prev: prev
      ? {
          counts: prev.counts,
          revenue: prev.revenue,
          avgPerPatient: prev.avgPerPatient,
        }
      : null,
    deltas: prev
      ? {
          newPatients: delta(current.counts.new, prev.counts.new),
          seen: delta(current.counts.seen, prev.counts.seen),
          revenue: delta(current.revenue, prev.revenue),
          avgPerPatient: delta(current.avgPerPatient, prev.avgPerPatient),
        }
      : null,
  };
}

module.exports = { getOpdSection, previousPeriod };
