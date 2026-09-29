// src/models/overview/periodFiguresModel.js
// ─────────────────────────────────────────────────────────────────────────────
// New patients and revenue for ONE branch over SEVERAL date ranges, read in a
// single pass — used by Branch Summary V2 for the selected range plus its
// MoM and YoY comparison ranges.
//
//   readPeriodFigures(location, { cur: {from,to}, mom: {from,to}, yoy: {from,to} })
//     → { cur: { newPatients, opd, ipd, pharmacy, totalRevenue }, mom: …, yoy: … }
//
// ⚠️ ONE PASS, GROUPED BY DAY
// ───────────────────────────
// Each source is read once over [earliest from → latest to], grouped by
// calendar day, and each range is then summed from those days. Three ranges
// cost the same queries as one — the alternative, getLocationSummary three
// times per branch, would triple an already slow screen.
//
// ⚠️ SAME REVENUE DEFINITION AS branchTrendModel / getLocationSummary
// ───────────────────────────────────────────────────────────────────
//   OPD       patient_itemreceipt.total, Cash/Card/Online/UPI (lab included)
//   IPD       invoice.totalamt (billed)
//   Pharmacy  pharmacybill.final_total, Cash/Card/Online/UPI/Paytm
//             (DP Road: patient_receipt LabTest, Cash/Card/Online/UPI)
//             + Evital, Cash/Card/Online only (evitalAmount from branchTrend)
// Every range runs to 23:59:59 on its last day (exclusive next-midnight bound),
// as in branchTrendModel, so a day is always counted whole.
//
// New patients: confirmed, not deleted, patient_type = 'New'.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../../databaseUtils");
const { evitalAmount } = require("./branchTrendModel");

const n0 = (v) => Number(v) || 0;
const pad = (n) => String(n).padStart(2, "0");

const runOn = (connection, sql, params = []) =>
  new Promise((resolve, reject) =>
    connection.query(sql, params, (err, rows) =>
      err ? reject(err) : resolve(rows),
    ),
  );

/** 'YYYY-MM-DD' + 1 day, as 'YYYY-MM-DD 00:00:00' (exclusive upper bound). */
const nextMidnight = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(
    t.getUTCDate(),
  )} 00:00:00`;
};

const DAY = (col) => `DATE_FORMAT(${col}, '%Y-%m-%d')`;

const NEW_SQL = `
  SELECT ${DAY("appointment_timestamp")} AS d, COUNT(*) AS v
  FROM appointment
  WHERE appointment_timestamp >= ? AND appointment_timestamp < ?
    AND is_deleted != 1
    AND confirm_time != 0
    AND patient_type = 'New'
  GROUP BY d
`;

const OPD_SQL = `
  SELECT ${DAY("item_date")} AS d, COALESCE(SUM(total), 0) AS v
  FROM patient_itemreceipt
  WHERE item_date >= ? AND item_date < ?
    AND payment_mode IN ('Cash', 'Card', 'Online', 'UPI')
    AND is_deleted != 1
  GROUP BY d
`;

const IPD_SQL = `
  SELECT ${DAY("creation_date")} AS d, COALESCE(SUM(totalamt), 0) AS v
  FROM invoice
  WHERE creation_date >= ? AND creation_date < ?
    AND is_deleted != 1
  GROUP BY d
`;

const PHARMACY_SQL = `
  SELECT ${DAY("created_at")} AS d, COALESCE(SUM(final_total), 0) AS v
  FROM pharmacybill
  WHERE created_at >= ? AND created_at < ?
    AND paymentmode IN ('Cash', 'Card', 'Online', 'UPI', 'Paytm')
    AND is_deleted != 1
  GROUP BY d
`;

const PHARMACY_DP_ROAD_SQL = `
  SELECT ${DAY("receipt_date")} AS d, COALESCE(SUM(totalamt), 0) AS v
  FROM patient_receipt
  WHERE receipt_date >= ? AND receipt_date < ?
    AND chargeCondition = 'LabTest'
    AND paymentmode IN ('Cash', 'Card', 'Online', 'UPI')
    AND is_deleted != 1
  GROUP BY d
`;

const BILL_DATE = `STR_TO_DATE(
    JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.bill_date')),
    '%Y-%m-%d %H:%i:%s')`;

const EVITAL_SQL = `
  SELECT DATE_FORMAT(${BILL_DATE}, '%Y-%m-%d') AS d,
         invoice_details,
         UpdatedInvoiceDetails
  FROM evital_pharmacy_invoice
  WHERE ${BILL_DATE} >= ? AND ${BILL_DATE} < ?
`;

const toDayMap = (rows) => {
  const m = {};
  for (const r of rows || []) if (r.d) m[r.d] = n0(r.v);
  return m;
};

/** Sum a day map over [from, to] inclusive ('YYYY-MM-DD' strings sort). */
const sumRange = (map, from, to) => {
  let s = 0;
  for (const [d, v] of Object.entries(map)) if (d >= from && d <= to) s += v;
  return s;
};

async function readPeriodFigures(location, ranges) {
  const { connection } = getConnectionByLocation(location);
  if (!connection) throw new Error("Invalid location");

  const list = Object.values(ranges);
  const from = list.map((r) => r.from).sort()[0];
  const to = list
    .map((r) => r.to)
    .sort()
    .slice(-1)[0];
  const p = [`${from} 00:00:00`, nextMidnight(to)];

  // Sequential on purpose — branch pools are capped at 5 connections and are
  // shared with the staff working at the branch.
  const newPt = toDayMap(await runOn(connection, NEW_SQL, p));
  const opd = toDayMap(await runOn(connection, OPD_SQL, p));
  const ipd = toDayMap(await runOn(connection, IPD_SQL, p));
  const pharmacy = toDayMap(
    await runOn(
      connection,
      location === "DP Road" ? PHARMACY_DP_ROAD_SQL : PHARMACY_SQL,
      p,
    ),
  );
  const evital = await runOn(connection, EVITAL_SQL, p);
  for (const r of evital || []) {
    if (!r.d) continue;
    pharmacy[r.d] = n0(pharmacy[r.d]) + evitalAmount(r);
  }

  const out = {};
  for (const [key, r] of Object.entries(ranges)) {
    const o = Math.round(sumRange(opd, r.from, r.to));
    const i = Math.round(sumRange(ipd, r.from, r.to));
    const ph = Math.round(sumRange(pharmacy, r.from, r.to));
    out[key] = {
      newPatients: sumRange(newPt, r.from, r.to),
      opd: o,
      ipd: i,
      pharmacy: ph,
      totalRevenue: o + i + ph,
    };
  }
  return out;
}

/**
 * Shift 'YYYY-MM-DD' back by `months`, clamping the day to the target month's
 * length (31 Mar − 1 month → 28/29 Feb; 29 Feb − 12 months → 28 Feb).
 */
function shiftMonths(ymd, months) {
  const [y, m, d] = ymd.split("-").map(Number);
  const idx = y * 12 + (m - 1) - months;
  const ty = Math.floor(idx / 12);
  const tm = (idx % 12) + 1;
  const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return `${ty}-${pad(tm)}-${pad(Math.min(d, last))}`;
}

/**
 * The selected range and its comparison ranges:
 *   mom — the same range one month earlier (MTD vs last month's same days)
 *   yoy — the same range one year earlier
 * When the range is whole calendar months (from = the 1st, to = a month end),
 * the shifted `to` is the shifted month's last day too, so a full month always
 * compares to a full month (Feb vs Jan = 1–28 Feb vs 1–31 Jan).
 */
function comparisonRanges(from, to) {
  const isMonthEnd = (ymd) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return d === new Date(Date.UTC(y, m, 0)).getUTCDate();
  };
  const wholeMonths = from.endsWith("-01") && isMonthEnd(to);
  const shiftTo = (ymd, months) => {
    const s = shiftMonths(ymd, months);
    if (!wholeMonths) return s;
    const [y, m] = s.split("-").map(Number);
    return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
  };
  return {
    cur: { from, to },
    mom: { from: shiftMonths(from, 1), to: shiftTo(to, 1) },
    yoy: { from: shiftMonths(from, 12), to: shiftTo(to, 12) },
  };
}

module.exports = { readPeriodFigures, comparisonRanges, shiftMonths };
