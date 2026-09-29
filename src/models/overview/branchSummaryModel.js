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

// ═════════════════════════════════════════════════════════════════════════════
// V2 — two figures per branch
//
//   GET /overview/branchSummaryV2?from=&to=&locations=a,b,c
//     → { meta, totals, branches: [{ location, newPatients, totalRevenue,
//                                    revenuePerNewPatient,
//                                    growth: { mom: { newPatients,
//                                                     revenuePerNewPatient },
//                                              yoy: { … } },   (% change)
//                                    prev: { mom, yoy },       (raw figures)
//                                    opd, ipd, pharmacy, error? }] }
//
// Added alongside V1 rather than replacing it, so an older app build still on
// /branchSummary keeps working through the rollout.
//
// ⚠️ REVENUE IS EVERY PATIENT, NOT JUST NEW ONES
// ──────────────────────────────────────────────
// totalRevenue = OPD + LAB + IPD + PHARMACY for the whole branch in the range,
// whatever the patient type (New, Old, follow-up, walk-in). Only the
// denominator is new patients. So "revenue per new patient" reads as "how much
// the branch earned for every new patient it brought in" — the follow-ups a
// new patient generates later are what make the figure meaningful.
//
// ⚠️ LAB IS INSIDE OPD
// ────────────────────
// patient_itemreceipt includes lab. V1 netted it out only to keep the avg OPD
// bill honest; for a TOTAL it has to stay in.
//
// ⚠️ FIGURES COME FROM periodFiguresModel, NOT getLocationSummary
// ───────────────────────────────────────────────────────────────
// Same sources and predicates as getLocationSummary, read once grouped by day
// so the MoM and YoY ranges come from the same pass. One difference: each day
// is counted whole (to 23:59:59), where getLocationSummary drops rows after
// midnight on the last day for some DATETIME columns — so a figure here can be
// slightly higher than the DSR for the same range.
//
// ⚠️ NEW PATIENTS — SAME TEST AS V1
// ─────────────────────────────────
// Confirmed, non-deleted appointments with patient_type = 'New'. Identical to
// V1's newPatients so the two versions never disagree on the count.
// ═════════════════════════════════════════════════════════════════════════════

const { readPeriodFigures, comparisonRanges } = require("./periodFiguresModel");

const perNew = (revenue, newPatients) =>
  // Null, not zero, with no new patients — "₹0 per new patient" reads as a
  // real (and alarming) figure; "no new patients" is a different statement.
  newPatients > 0 ? Math.round(revenue / newPatients) : null;

/** % change, or null when there is nothing to compare against. */
const pctChange = (cur, prev) =>
  cur == null || prev == null || prev === 0
    ? null
    : Math.round(((cur - prev) / prev) * 1000) / 10;

/**
 * Growth of both figures against the MoM and YoY ranges. Revenue per new
 * patient is compared as a ratio (each side's own revenue ÷ its own new
 * patients), not by comparing revenue.
 */
const growthOf = (cur, mom, yoy) => {
  const g = (prev) => ({
    newPatients: pctChange(cur.newPatients, prev.newPatients),
    revenuePerNewPatient: pctChange(
      perNew(cur.totalRevenue, cur.newPatients),
      perNew(prev.totalRevenue, prev.newPatients),
    ),
  });
  return { mom: g(mom), yoy: g(yoy) };
};

/**
 * ⚠️ GROWTH: MoM AND YoY
 * The selected range is compared with the same range one month earlier (MoM)
 * and one year earlier (YoY) — see comparisonRanges. All three ranges come from
 * ONE grouped read per source (periodFiguresModel), so adding growth did not
 * add a getLocationSummary call per range. The current figures come from that
 * same read, so a figure and its growth always share one definition.
 */
async function readBranchV2(location, from, to) {
  const ranges = comparisonRanges(from, to);
  const f = await readPeriodFigures(location, ranges);
  const cur = f.cur;

  return {
    location,
    newPatients: cur.newPatients,
    totalRevenue: cur.totalRevenue,
    revenuePerNewPatient: perNew(cur.totalRevenue, cur.newPatients),
    growth: growthOf(cur, f.mom, f.yoy),
    // Raw comparison figures, so cities and the estate can pool them.
    prev: {
      mom: { newPatients: f.mom.newPatients, totalRevenue: f.mom.totalRevenue },
      yoy: { newPatients: f.yoy.newPatients, totalRevenue: f.yoy.totalRevenue },
    },
    // Not shown on the screen; returned so a figure can be reconciled.
    opd: cur.opd,
    ipd: cur.ipd,
    pharmacy: cur.pharmacy,
  };
}

/**
 * getBranchSummaryV2({ from, to, locations })
 *
 * Same batching, retry and failed-branch rules as V1: a branch that cannot be
 * read comes back with `error` and is excluded from the totals.
 */
async function getBranchSummaryV2({ from, to, locations }) {
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

  const results = [];
  for (let i = 0; i < wanted.length; i += BATCH) {
    const slice = wanted.slice(i, i + BATCH);
    const settled = await Promise.all(
      slice.map(async (loc) => {
        try {
          return await withRetry(() => readBranchV2(loc, from, to), loc);
        } catch (err) {
          console.error(`branchSummaryV2: ${loc} failed:`, err.message);
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
    totalRevenue: sum("totalRevenue"),
    opd: sum("opd"),
    ipd: sum("ipd"),
    pharmacy: sum("pharmacy"),
  };
  // Pooled, never an average of branch ratios.
  totals.revenuePerNewPatient = perNew(totals.totalRevenue, totals.newPatients);
  // Pooled comparison figures → estate-wide growth.
  const prevSum = (k, f) => ok.reduce((a, r) => a + n0(r.prev?.[k]?.[f]), 0);
  totals.prev = {
    mom: {
      newPatients: prevSum("mom", "newPatients"),
      totalRevenue: prevSum("mom", "totalRevenue"),
    },
    yoy: {
      newPatients: prevSum("yoy", "newPatients"),
      totalRevenue: prevSum("yoy", "totalRevenue"),
    },
  };
  totals.growth = growthOf(totals, totals.prev.mom, totals.prev.yoy);

  return {
    meta: {
      from,
      to,
      // The comparison ranges growth was measured against.
      compare: comparisonRanges(from, to),
      requested: wanted.length,
      generatedAt: new Date().toISOString(),
    },
    totals,
    branches: results.sort((a, b) => n0(b.newPatients) - n0(a.newPatients)),
  };
}

module.exports = { getBranchSummary, getBranchSummaryV2 };
