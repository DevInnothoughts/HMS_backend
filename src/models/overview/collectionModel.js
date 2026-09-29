// src/models/overview/collectionModel.js
// ─────────────────────────────────────────────────────────────────────────────
// The home screen's BILLING block: what was billed in the period, split four
// ways, with an average per patient beside each.
//
// (The block is titled "Billing", not "Collection" — the figures are billed
// amounts from getLocationSummary, not cash received. IPD *collection* is
// deliberately excluded, as it always has been.)
//
// TWO THINGS THAT ARE EASY TO GET WRONG
// ─────────────────────────────────────
// 1. getLocationSummary().opd.total INCLUDES lab revenue — lab is billed
//    through patient_itemreceipt like every other OPD line. The OPD slice must
//    have lab netted OUT or the four slices exceed the total.
//    targetComparisonNewModel does the same subtraction for the same reason.
//
// 2. The total is opd + ipdInvoice + pharmacy — IPD collection (ipd_payment) is
//    excluded, because the summary path counts the BILLED IPD amount. Changing
//    that silently moves every revenue number in the app.
//
// THE DIVISORS ARE NOT ALL THE SAME KIND OF THING
// ───────────────────────────────────────────────
//   OPD      distinct patients billed
//   IPD      distinct patients invoiced
//   Lab      distinct patients billed for a lab item
//   Pharmacy INVOICE COUNT, not patients
//
// Pharmacy counts invoices because a walk-in buyer often has no patient record
// at all — evital_pharmacy_invoice has no patient_id to group by — so "average
// per patient" is not a number that exists there. The response labels each
// department's basis so the UI can say which it is rather than implying all
// four are per-patient.
//
// Every count query is wrapped: a branch missing `pharmacybill` or the eVital
// table returns a null count, which drops that average rather than failing the
// whole block.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../../databaseUtils");
const { getLocationSummary } = require("../reportMailModel");
const {
  getLabRevenue,
  getLabConsultationNames,
} = require("../targetComparisonNewModel");
const { countedSql } = require("../utils/interbranch");

const round0 = (n) => Math.round(Number(n) || 0);
const n0 = (v) => Number(v) || 0;

const makeRunner =
  (connection) =>
  (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) =>
        err ? reject(err) : resolve(rows),
      ),
    );

// Payment modes exactly as getLocationSummary's OPD queries filter them — the
// count must cover the same rows the amount does, or the average is wrong.
const OPD_MODES = "('Cash', 'Card', 'Online', 'UPI')";
const NORM_COL = "REPLACE(LOWER(COALESCE(consultation, '')), ' ', '')";

/**
 * Distinct OPD and lab patients, split by the same normalised lab-name list
 * getLabRevenue uses. One query, two counts, so the two can never disagree
 * about which rows are lab.
 */
async function getOpdLabPatients(run, from, to, labNames) {
  if (!labNames.length) {
    const [row] = await run(
      `SELECT COUNT(DISTINCT patient_id) AS opdPatients
         FROM patient_itemreceipt
        WHERE item_date BETWEEN ? AND ?
          AND is_deleted != 1
          AND payment_mode IN ${OPD_MODES}`,
      [from, to],
    );
    return { opdPatients: n0(row?.opdPatients), labPatients: 0 };
  }

  const placeholders = labNames.map(() => "?").join(", ");
  const [row] = await run(
    `SELECT
       COUNT(DISTINCT CASE WHEN ${NORM_COL} NOT IN (${placeholders})
                           THEN patient_id END) AS opdPatients,
       COUNT(DISTINCT CASE WHEN ${NORM_COL} IN (${placeholders})
                           THEN patient_id END) AS labPatients
     FROM patient_itemreceipt
     WHERE item_date BETWEEN ? AND ?
       AND is_deleted != 1
       AND payment_mode IN ${OPD_MODES}`,
    [...labNames, ...labNames, from, to],
  );
  return {
    opdPatients: n0(row?.opdPatients),
    labPatients: n0(row?.labPatients),
  };
}

/**
 * IPD billed amount AND distinct patients, with the interbranch rule applied
 * (utils/interbranch.js): an operating-branch copy of an interbranch invoice
 * belongs to the source branch, so it is left out of both.
 *
 * The amount used to be getLocationSummary().ipdInvoice.total, which counts
 * every invoice. That function also feeds the report mail, so it is left
 * alone and the IPD slice is computed here instead.
 */
async function getIpdBilling(run, from, to) {
  const [row] = await run(
    `SELECT COUNT(DISTINCT CASE WHEN ${countedSql("i")} THEN i.patient_id END) AS cnt,
            COALESCE(SUM(CASE WHEN ${countedSql("i")} THEN i.totalamt ELSE 0 END), 0) AS amount,
            SUM(CASE WHEN ${countedSql("i")} THEN 0 ELSE 1 END)                AS ib_cnt,
            COALESCE(SUM(CASE WHEN ${countedSql("i")} THEN 0 ELSE i.totalamt END), 0) AS ib_amount
       FROM invoice i
      WHERE i.creation_date >= ? AND i.creation_date <= ?
        AND i.is_deleted != 1`,
    [`${from} 00:00:00`, `${to} 23:59:59`],
  );
  return {
    patients: n0(row?.cnt),
    amount: n0(row?.amount),
    // Excluded interbranch invoices (operated here for another branch).
    interbranchCount: n0(row?.ib_cnt),
    interbranchAmount: n0(row?.ib_amount),
  };
}

/**
 * Pharmacy INVOICE count, across both systems getLocationSummary adds together.
 *
 * ⚠️ The eVital count includes invoices whose payment mode falls in the "Other"
 * bucket, which getLocationSummary excludes from pharmacy.total. So the average
 * is very slightly understated when Other is non-empty. Counting them would
 * mean re-parsing every invoice_details JSON blob in Node just to exclude a
 * handful of rows; the trade is documented rather than hidden.
 */
async function getPharmacyInvoices(run, from, to) {
  const fromDt = `${from} 00:00:00`;
  const toDt = `${to} 23:59:59`;

  const [hms, evital] = await Promise.all([
    run(
      `SELECT COUNT(*) AS cnt
         FROM pharmacybill
        WHERE created_at BETWEEN ? AND ?
          AND is_deleted != 1`,
      [fromDt, toDt],
    ).catch(() => null),
    run(
      `SELECT COUNT(*) AS cnt
         FROM evital_pharmacy_invoice
        WHERE STR_TO_DATE(
                JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.bill_date')),
                '%Y-%m-%d %H:%i:%s'
              ) BETWEEN ? AND ?`,
      [fromDt, toDt],
    ).catch(() => null),
  ]);

  // Both missing means neither system is present on this branch — return null
  // so the average is dropped rather than shown as zero.
  if (!hms && !evital) return null;
  return n0(hms?.[0]?.cnt) + n0(evital?.[0]?.cnt);
}

// 60s cache. /Dashboard is already the heaviest call in the app and the home
// screen now makes two; this collapses the pull-to-refresh burst after a shift
// change without ever showing yesterday's numbers.
const CACHE_MS = 60 * 1000;
const cache = new Map();
const cacheKey = (location, from, to) => `${location}|${from}|${to}`;

function readCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

/**
 * getCollection(location, from, to)
 * → { meta, total, byDept: [{ key, label, amount, pct, count, countBasis, avg }] }
 *
 * byDept is ordered largest-first so the stacked bar and its legend read in the
 * same order without the app sorting anything.
 */
async function getCollection(location, from, to) {
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

  const key = cacheKey(location, from, to);
  const cached = readCache(key);
  if (cached) return cached;

  const { connection } = getConnectionByLocation(location);
  if (!connection) {
    const err = new Error(`Invalid location: ${location}`);
    err.status = 404;
    throw err;
  }
  const run = makeRunner(connection);

  const labNames = await getLabConsultationNames().catch((e) => {
    console.error("overview/collection: lab names failed:", e.message);
    return [];
  });

  const [summary, labRaw, opdLab, ipdBilling, pharmacyInvoices] =
    await Promise.all([
      getLocationSummary(location, from, to),
      getLabRevenue(location, from, to).catch((e) => {
        console.error(
          `overview: lab revenue failed for ${location}:`,
          e.message,
        );
        return 0;
      }),
      getOpdLabPatients(run, from, to, labNames).catch((e) => {
        console.error(
          `overview: OPD/lab patients failed for ${location}:`,
          e.message,
        );
        return { opdPatients: null, labPatients: null };
      }),
      getIpdBilling(run, from, to).catch((e) => {
        console.error(
          `overview: IPD billing failed for ${location}:`,
          e.message,
        );
        return null;
      }),
      getPharmacyInvoices(run, from, to).catch((e) => {
        console.error(
          `overview: pharmacy invoices failed for ${location}:`,
          e.message,
        );
        return null;
      }),
    ]);

  const lab = round0(labRaw);
  const opdGross = round0(summary?.opd?.total);
  const opd = Math.max(0, opdGross - lab); // see note 1 above
  // Interbranch-aware. Falls back to the summary figure only if the query
  // itself failed, so the block still renders.
  const ipd = round0(
    ipdBilling ? ipdBilling.amount : summary?.ipdInvoice?.total,
  );
  const ipdPatients = ipdBilling ? ipdBilling.patients : null;
  const pharmacy = round0(summary?.pharmacy?.total);

  // No longer === summary.grandTotal: IPD here excludes interbranch
  // operating-branch copies (see getIpdBilling).
  const total = opd + ipd + pharmacy + lab;
  const pctOf = (n) => (total > 0 ? Math.round((n / total) * 100) : 0);

  // Null rather than 0 when there is no divisor — an average of ₹0 reads as a
  // real figure, and "no count available" is a different statement.
  const avgOf = (amount, count) =>
    count != null && count > 0 ? Math.round(amount / count) : null;

  const byDept = [
    {
      key: "ipd",
      label: "IPD",
      amount: ipd,
      pct: pctOf(ipd),
      count: ipdPatients,
      countBasis: "patients",
      avg: avgOf(ipd, ipdPatients),
      // Shown under the IPD row so the lower figure explains itself.
      interbranch: ipdBilling
        ? {
            count: ipdBilling.interbranchCount,
            amount: round0(ipdBilling.interbranchAmount),
          }
        : null,
    },
    {
      key: "opd",
      label: "OPD",
      amount: opd,
      pct: pctOf(opd),
      count: opdLab.opdPatients,
      countBasis: "patients",
      avg: avgOf(opd, opdLab.opdPatients),
    },
    {
      key: "pharmacy",
      label: "Pharmacy",
      amount: pharmacy,
      pct: pctOf(pharmacy),
      count: pharmacyInvoices,
      countBasis: "invoices",
      avg: avgOf(pharmacy, pharmacyInvoices),
    },
    {
      key: "lab",
      label: "Lab",
      amount: lab,
      pct: pctOf(lab),
      count: opdLab.labPatients,
      countBasis: "patients",
      avg: avgOf(lab, opdLab.labPatients),
    },
  ].sort((a, b) => b.amount - a.amount);

  const value = {
    meta: { location, from, to, generatedAt: new Date().toISOString() },
    total,
    byDept,
  };

  cache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { getCollection };
