// src/models/overview/branchTrendModel.js
// ─────────────────────────────────────────────────────────────────────────────
// One branch over time — new patients and revenue per new patient, for the
// line charts opened from Branch Summary.
//
//   GET /overview/branchTrend?location=Baner
//     → { meta, monthly: [bucket×12], quarterly: [bucket×8], yearly: [bucket×5] }
//
//   bucket = { key, label, from, to, partial,
//              newPatients, opd, ipd, pharmacy, totalRevenue,
//              revenuePerNewPatient }
//
// ⚠️ ONE PASS, ALL THREE VIEWS
// ────────────────────────────
// Every figure is read ONCE, grouped by calendar month, over the five
// financial years the yearly view needs. Quarters and years are then summed
// from those months in JS. So switching Monthly → Quarterly → Yearly on the
// phone is instant and the three views can never disagree with each other.
//
// Calling getLocationSummary once per bucket (as monthlyRevenueReportModel
// does) would be 25 calls, each re-scanning evital_pharmacy_invoice — its date
// lives inside JSON, so no index helps. One grouped pass scans it once.
//
// ⚠️ SAME REVENUE DEFINITION AS getLocationSummary — KEEP IN STEP
// ────────────────────────────────────────────────────────────────
// The predicates below are copied from reportMailModel.getLocationSummary so a
// month here equals that function run for the same month:
//   OPD       patient_itemreceipt.total, modes Cash/Card/Online/UPI (lab incl.)
//   IPD       invoice.totalamt (billed, not collected)
//   Pharmacy  pharmacybill.final_total, modes Cash/Card/Online/UPI/Paytm
//             (DP Road: patient_receipt LabTest, Cash/Card/Online/UPI)
//             + Evital, Cash/Card/Online only — "Other" is dropped there too
// Every patient type counts toward revenue; only the denominator is New.
// If getLocationSummary's definition changes, change it here as well.
//
// ⚠️ FINANCIAL YEAR, NOT CALENDAR YEAR
// ────────────────────────────────────
// Quarters are Q1 Apr–Jun … Q4 Jan–Mar and years are FY Apr–Mar — the same
// convention Target Comparison uses, so "Q2" means the same thing on both.
//
// ⚠️ THE CURRENT PERIOD IS PARTIAL
// ────────────────────────────────
// The last bucket of each view runs only to today and is flagged `partial`.
// New-patient counts will look low against complete periods; the per-new-
// patient ratio is fairer but still moves as the period fills in.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../../databaseUtils");

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const WINDOW = { monthly: 12, quarterly: 8, yearly: 5 };

const n0 = (v) => Number(v) || 0;
const pad = (n) => String(n).padStart(2, "0");
const ymKey = (y, m) => `${y}-${pad(m)}`; // m is 1-based
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const fyOf = (y, m) => (m >= 4 ? y : y - 1); // FY named by its starting year
const fyLabel = (fy) => `FY ${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;
const quarterOf = (m) => (m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4);

const perNew = (revenue, newPatients) =>
  newPatients > 0 ? Math.round(revenue / newPatients) : null;

const runOn = (connection, sql, params = []) =>
  new Promise((resolve, reject) =>
    connection.query(sql, params, (err, rows) =>
      err ? reject(err) : resolve(rows),
    ),
  );

/** Today in IST, whatever timezone the server runs in. */
function todayIST() {
  const d = new Date(Date.now() + 330 * 60 * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

// ─── Queries: one row per month ──────────────────────────────────────────────
// All take [fromDt, toExclusiveDt]. The exclusive upper bound covers the whole
// of today whether the column is DATE or DATETIME.

const NEW_SQL = `
  SELECT DATE_FORMAT(ap.appointment_timestamp, '%Y-%m') AS ym,
         COUNT(*)                                       AS v
  FROM appointment ap
  WHERE ap.appointment_timestamp >= ? AND ap.appointment_timestamp < ?
    AND ap.is_deleted != 1
    AND ap.confirm_time != 0
    AND ap.patient_type = 'New'
  GROUP BY ym
`;

const OPD_SQL = `
  SELECT DATE_FORMAT(item_date, '%Y-%m') AS ym, COALESCE(SUM(total), 0) AS v
  FROM patient_itemreceipt
  WHERE item_date >= ? AND item_date < ?
    AND payment_mode IN ('Cash', 'Card', 'Online', 'UPI')
    AND is_deleted != 1
  GROUP BY ym
`;

const IPD_SQL = `
  SELECT DATE_FORMAT(creation_date, '%Y-%m') AS ym,
         COALESCE(SUM(totalamt), 0)          AS v
  FROM invoice
  WHERE creation_date >= ? AND creation_date < ?
    AND is_deleted != 1
  GROUP BY ym
`;

const PHARMACY_SQL = `
  SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym,
         COALESCE(SUM(final_total), 0)    AS v
  FROM pharmacybill
  WHERE created_at >= ? AND created_at < ?
    AND paymentmode IN ('Cash', 'Card', 'Online', 'UPI', 'Paytm')
    AND is_deleted != 1
  GROUP BY ym
`;

// DP Road bills its "pharmacy" line as LabTest receipts — as getLocationSummary.
const PHARMACY_DP_ROAD_SQL = `
  SELECT DATE_FORMAT(receipt_date, '%Y-%m') AS ym,
         COALESCE(SUM(totalamt), 0)         AS v
  FROM patient_receipt
  WHERE receipt_date >= ? AND receipt_date < ?
    AND chargeCondition = 'LabTest'
    AND paymentmode IN ('Cash', 'Card', 'Online', 'UPI')
    AND is_deleted != 1
  GROUP BY ym
`;

const BILL_DATE = `STR_TO_DATE(
    JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.bill_date')),
    '%Y-%m-%d %H:%i:%s')`;

const EVITAL_SQL = `
  SELECT DATE_FORMAT(${BILL_DATE}, '%Y-%m') AS ym,
         invoice_details,
         UpdatedInvoiceDetails
  FROM evital_pharmacy_invoice
  WHERE ${BILL_DATE} >= ? AND ${BILL_DATE} < ?
`;

// ─── Evital: same per-row rules as getLocationSummary ────────────────────────

const normalizeMode = (mode = "") => {
  switch (mode) {
    case "CC/DC":
    case "Credit":
      return "Card";
    case "UPI":
    case "Online":
      return "Online";
    case "Cash":
      return "Cash";
    default:
      return "Other";
  }
};

const safeParse = (s) => {
  try {
    if (!s) return null;
    const p = JSON.parse(s);
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
};

/** One Evital invoice → the amount that counts (Cash + Card + Online). */
function evitalAmount(row) {
  const invoice = safeParse(row.invoice_details);
  if (!invoice) return 0;
  const total = Math.round(Number(invoice.total) || 0);
  const counts = (mode) => normalizeMode(mode) !== "Other";

  if (row.UpdatedInvoiceDetails) {
    try {
      const updated = JSON.parse(row.UpdatedInvoiceDetails);
      const txns = updated?.transaction_summary?.transactions ?? [];
      if (txns.length === 1) return counts(txns[0].method) ? total : 0;
      if (txns.length > 1) {
        return txns.reduce(
          (a, t) =>
            a + (counts(t.method) ? Math.round(Number(t.amount) || 0) : 0),
          0,
        );
      }
    } catch (_) {
      // fall through to the invoice's own payment mode, as the original does
    }
  }
  return counts(invoice.payment_mode) ? total : 0;
}

// ─── Read ────────────────────────────────────────────────────────────────────

const toMap = (rows) => {
  const m = {};
  for (const r of rows || []) if (r.ym) m[r.ym] = n0(r.v);
  return m;
};

async function readMonths(location, fromDt, toExclDt) {
  const { connection } = getConnectionByLocation(location);
  if (!connection) {
    const err = new Error(`Invalid location: ${location}`);
    err.status = 404;
    throw err;
  }
  const p = [fromDt, toExclDt];

  // Sequential on purpose: branch pools are capped at 5 connections and
  // Branch Summary may still be reading this same branch.
  const newPt = toMap(await runOn(connection, NEW_SQL, p));
  const opd = toMap(await runOn(connection, OPD_SQL, p));
  const ipd = toMap(await runOn(connection, IPD_SQL, p));
  const pharmacy = toMap(
    await runOn(
      connection,
      location === "DP Road" ? PHARMACY_DP_ROAD_SQL : PHARMACY_SQL,
      p,
    ),
  );

  // Evital adds to the same pharmacy month, as getLocationSummary adds it to
  // pharmacy.total.
  const evital = await runOn(connection, EVITAL_SQL, p);
  for (const r of evital || []) {
    if (!r.ym) continue;
    pharmacy[r.ym] = n0(pharmacy[r.ym]) + evitalAmount(r);
  }

  return { newPt, opd, ipd, pharmacy };
}

// ─── Bucketing ───────────────────────────────────────────────────────────────

function emptyBucket(key, label, from, to) {
  return {
    key,
    label,
    from,
    to,
    partial: false,
    newPatients: 0,
    opd: 0,
    ipd: 0,
    pharmacy: 0,
    totalRevenue: 0,
    revenuePerNewPatient: null,
  };
}

/**
 * Pure: month maps + today → { monthly, quarterly, yearly }. Kept free of I/O
 * so the roll-up can be tested on its own.
 */
function buildTrend(data, today) {
  const { y: ty, m: tm, d: td } = today;
  const curFY = fyOf(ty, tm);
  const todayStr = `${ty}-${pad(tm)}-${pad(td)}`;

  // Every month from 1 Apr of the oldest FY to the current month.
  const months = [];
  for (let y = curFY - (WINDOW.yearly - 1), m = 4; ; ) {
    months.push({ y, m });
    if (y === ty && m === tm) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }

  const monthly = [];
  const quarters = new Map();
  const years = new Map();

  for (const { y, m } of months) {
    const k = ymKey(y, m);
    const isCurrent = y === ty && m === tm;
    const from = `${k}-01`;
    const to = isCurrent ? todayStr : `${k}-${pad(lastDay(y, m))}`;

    const b = emptyBucket(k, `${MONTHS[m - 1]} '${String(y).slice(2)}`, from, to);
    b.partial = isCurrent;
    b.newPatients = n0(data.newPt[k]);
    b.opd = Math.round(n0(data.opd[k]));
    b.ipd = Math.round(n0(data.ipd[k]));
    b.pharmacy = Math.round(n0(data.pharmacy[k]));
    monthly.push(b);

    const fy = fyOf(y, m);
    const q = quarterOf(m);
    const qk = `${fy}-Q${q}`;
    if (!quarters.has(qk)) {
      quarters.set(
        qk,
        emptyBucket(qk, `Q${q} FY${String(fy + 1).slice(2)}`, from, to),
      );
    }
    if (!years.has(fy)) {
      years.set(fy, emptyBucket(`FY${fy}`, fyLabel(fy), from, to));
    }
    for (const agg of [quarters.get(qk), years.get(fy)]) {
      agg.to = to;
      agg.partial = agg.partial || isCurrent;
      agg.newPatients += b.newPatients;
      agg.opd += b.opd;
      agg.ipd += b.ipd;
      agg.pharmacy += b.pharmacy;
    }
  }

  const finish = (list) =>
    list.map((b) => {
      b.totalRevenue = b.opd + b.ipd + b.pharmacy;
      b.revenuePerNewPatient = perNew(b.totalRevenue, b.newPatients);
      return b;
    });

  return {
    monthly: finish(monthly.slice(-WINDOW.monthly)),
    quarterly: finish([...quarters.values()].slice(-WINDOW.quarterly)),
    yearly: finish([...years.values()].slice(-WINDOW.yearly)),
  };
}

/**
 * getBranchTrend({ location })
 */
async function getBranchTrend({ location }) {
  if (!location) {
    const err = new Error("location is required");
    err.status = 400;
    throw err;
  }

  const today = todayIST();
  const startFY = fyOf(today.y, today.m) - (WINDOW.yearly - 1);
  const fromDt = `${startFY}-04-01 00:00:00`;
  // Midnight after today, computed in UTC arithmetic so month/year roll over.
  const t = new Date(Date.UTC(today.y, today.m - 1, today.d + 1));
  const toExclDt = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(
    t.getUTCDate(),
  )} 00:00:00`;

  const data = await readMonths(location, fromDt, toExclDt);

  return {
    meta: {
      location,
      from: fromDt.slice(0, 10),
      to: `${today.y}-${pad(today.m)}-${pad(today.d)}`,
      fiscalYearStartMonth: 4,
      generatedAt: new Date().toISOString(),
    },
    ...buildTrend(data, today),
  };
}

module.exports = { getBranchTrend, buildTrend, evitalAmount };
