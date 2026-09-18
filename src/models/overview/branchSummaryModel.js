// src/models/overview/branchSummaryModel.js
// ─────────────────────────────────────────────────────────────────────────────
// Every branch on one screen — the mobile version of hhc-dashboard.html.
//
//   GET /overview/branchSummary?from=&to=
//     → { meta, totals, branches: [{ location, newPatients, male, female,
//                                    totalOPD, opdRevenue, avgOPDBill,
//                                    ipdCount, ipdRevenue, avgIPDBill,
//                                    pharmacy, conversion, error? }] }
//
// ⚠️ MONEY COMES FROM getLocationSummary, UNCHANGED
// ─────────────────────────────────────────────────
// Reusing it means this screen agrees with the billing summary, the home bar
// and the DSR. A second definition of "OPD revenue" would be a third number
// for the same question.
//
// ⚠️ OPD REVENUE IS NET OF LAB
// ────────────────────────────
// getLocationSummary().opd.total INCLUDES lab, because lab is billed through
// patient_itemreceipt like every other OPD line. Left in, the avg OPD bill is
// inflated by every blood test. collectionModel nets it out for the same
// reason; so does this.
//
// ⚠️ CONVERSION IS IPD CASES ÷ NEW PATIENTS
// ─────────────────────────────────────────
// Not "of all patients" — a follow-up patient was already converted or not.
// This is the same test the reference report uses, and it can exceed 100%:
// invoices count per case, and a patient admitted twice counts twice while the
// denominator counts them once.
//
// ⚠️ GENDER IS NEW PATIENTS ONLY
// ──────────────────────────────
// The M:F ratio answers "who is walking in for the first time". Counting
// follow-ups would weight it by whoever returns most often.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../../databaseUtils");
const { getLocationSummary } = require("../reportMailModel");
const {
  getLabRevenue,
  getLabConsultationNames,
} = require("../targetComparisonNewModel");

// Each branch is its own database with a pool capped at 5 connections, so
// firing forty at once just queues them behind each other and risks timeouts
// on the slowest.
const BATCH = 2;

const n0 = (v) => Number(v) || 0;
const round0 = (v) => Math.round(n0(v));

const runOn = (connection, sql, params = []) =>
  new Promise((resolve, reject) =>
    connection.query(sql, params, (err, rows) =>
      err ? reject(err) : resolve(rows),
    ),
  );

/**
 * Visits, new visits and the gender split, in ONE query.
 *
 * One pass means the four numbers can never disagree about which appointments
 * count — a separate gender query would be a second place to keep the
 * confirmed/not-deleted predicate in step.
 *
 * LEFT JOIN on patient: a visit whose patient row is missing still counts as a
 * visit, it just adds nothing to male or female. An INNER JOIN would make the
 * totals disagree with every other screen.
 */
const COUNTS_SQL = `
  SELECT
    COUNT(*)                                                   AS visits,
    COUNT(CASE WHEN ap.patient_type = 'New' THEN 1 END)        AS newPatients,
    COUNT(CASE WHEN ap.patient_type = 'New'
                AND p.sex = 'Male'   THEN 1 END)               AS male,
    COUNT(CASE WHEN ap.patient_type = 'New'
                AND p.sex = 'Female' THEN 1 END)               AS female
  FROM appointment ap
  LEFT JOIN patient p ON p.patient_id = ap.patient_id
  WHERE ap.appointment_timestamp >= ? AND ap.appointment_timestamp <= ?
    AND ap.is_deleted != 1
    AND ap.confirm_time != 0
`;

// Invoices, not patients — an IPD case is an invoice, the same test the
// surgery and calling-list reports use.
const IPD_SQL = `
  SELECT COUNT(*) AS cases
  FROM invoice
  WHERE creation_date >= ? AND creation_date <= ?
    AND is_deleted != 1
`;

/**
 * ER_CON_COUNT_ERROR means the SERVER is full right now — not that anything is
 * wrong with this branch. A moment later there is usually room, so it is worth
 * retrying rather than reporting a branch as unreadable.
 *
 * Backoff is generous on purpose: retrying fast just competes for the same
 * exhausted pool and makes it worse.
 */
const TRANSIENT = new Set([
  "ER_CON_COUNT_ERROR",
  "PROTOCOL_CONNECTION_LOST",
  "ETIMEDOUT",
  "ECONNRESET",
]);

const withRetry = async (fn, label, attempts = 3) => {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!TRANSIENT.has(err?.code) || i === attempts) throw err;
      const wait = 400 * i * i; // 400ms, 1.6s, …
      console.warn(
        `branchSummary: ${label} busy (${err.code}), retry ${i} in ${wait}ms`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
};

async function readBranch(location, from, to, labNames) {
  const { connection } = getConnectionByLocation(location);
  if (!connection) throw new Error("Invalid location");

  const fromDt = `${from} 00:00:00`;
  const toDt = `${to} 23:59:59`;

  // getLocationSummary is by far the heaviest — it opens ~10 connections on
  // its own. Letting it finish before the counts start keeps this branch's
  // peak demand to one query set at a time.
  const summary = await getLocationSummary(location, from, to);
  const labRaw = await getLabRevenue(location, from, to).catch(() => 0);
  const countRows = await runOn(connection, COUNTS_SQL, [fromDt, toDt]);
  const ipdRows = await runOn(connection, IPD_SQL, [fromDt, toDt]);

  const c = countRows?.[0] || {};
  const visits = n0(c.visits);
  const newPatients = n0(c.newPatients);
  const ipdCount = n0(ipdRows?.[0]?.cases);

  const lab = round0(labRaw);
  const opdRevenue = Math.max(0, round0(summary?.opd?.total) - lab); // see header
  const ipdRevenue = round0(summary?.ipdInvoice?.total);
  const pharmacy = round0(summary?.pharmacy?.total);

  return {
    location,
    newPatients,
    male: n0(c.male),
    female: n0(c.female),
    totalOPD: visits,
    opdRevenue,
    lab,
    // Null, not zero, when there is no denominator — an average of ₹0 reads as
    // a real figure and "no patients" is a different statement.
    avgOPDBill: visits > 0 ? Math.round(opdRevenue / visits) : null,
    ipdCount,
    ipdRevenue,
    avgIPDBill: ipdCount > 0 ? Math.round(ipdRevenue / ipdCount) : null,
    pharmacy,
    conversion: newPatients > 0 ? (ipdCount / newPatients) * 100 : null,
    grandTotal: opdRevenue + lab + ipdRevenue + pharmacy,
  };
}

/**
 * getBranchSummary({ from, to, locations })
 *
 * `locations` is the set the caller may see. A branch that fails is returned
 * with an `error` and EXCLUDED from the totals — a branch showing zero because
 * its database was unreachable is a lie; a branch named with a reason is a
 * fact.
 */
async function getBranchSummary({ from, to, locations }) {
  if (!from || !to) {
    const err = new Error("from and to are required (YYYY-MM-DD)");
    err.status = 400;
    throw err;
  }
  const wanted = Array.isArray(locations) ? locations.filter(Boolean) : [];
  if (!wanted.length) {
    const err = new Error("No locations provided");
    err.status = 400;
    throw err;
  }

  // Master-DB lookup, once for every branch rather than once per branch.
  const labNames = await getLabConsultationNames().catch(() => []);

  const results = [];
  for (let i = 0; i < wanted.length; i += BATCH) {
    const slice = wanted.slice(i, i + BATCH);
    const settled = await Promise.all(
      slice.map(async (loc) => {
        try {
          return await withRetry(
            () => readBranch(loc, from, to, labNames),
            loc,
          );
        } catch (err) {
          console.error(`branchSummary: ${loc} failed:`, err.message);
          return { location: loc, error: err.message };
        }
      }),
    );
    results.push(...settled);
  }

  const ok = results.filter((r) => !r.error);
  const sum = (f) => ok.reduce((a, r) => a + n0(r[f]), 0);

  const totals = {
    branches: ok.length,
    newPatients: sum("newPatients"),
    male: sum("male"),
    female: sum("female"),
    totalOPD: sum("totalOPD"),
    opdRevenue: sum("opdRevenue"),
    lab: sum("lab"),
    ipdCount: sum("ipdCount"),
    ipdRevenue: sum("ipdRevenue"),
    pharmacy: sum("pharmacy"),
    grandTotal: sum("grandTotal"),
  };

  // Group averages are recomputed from the pooled figures, NOT averaged across
  // branches — averaging would weight a 4-patient branch the same as a
  // 400-patient one.
  totals.avgOPDBill =
    totals.totalOPD > 0
      ? Math.round(totals.opdRevenue / totals.totalOPD)
      : null;
  totals.avgIPDBill =
    totals.ipdCount > 0
      ? Math.round(totals.ipdRevenue / totals.ipdCount)
      : null;
  totals.conversion =
    totals.newPatients > 0
      ? (totals.ipdCount / totals.newPatients) * 100
      : null;

  return {
    meta: {
      from,
      to,
      requested: wanted.length,
      generatedAt: new Date().toISOString(),
    },
    totals,
    branches: results.sort((a, b) => n0(b.grandTotal) - n0(a.grandTotal)),
  };
}

module.exports = { getBranchSummary };
