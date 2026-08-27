/**
 * tmp_generatePharmacyReport_Jan_Jul.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * Month-wise, LOCATION-WISE PHARMACY REVENUE:
 *
 *      Jan–Jul 2026   vs   Jan–Jul 2025
 *
 * Pharmacy is the messiest of these reports because revenue comes from TWO
 * unrelated systems that getLocationSummary (reportMailModel.js) adds together:
 *
 *   1. HMS pharmacy  — a plain SQL table, one row per bill:
 *        • normal branches → pharmacybill.final_total, dated created_at
 *        • "DP Road" ONLY  → patient_receipt.totalamt where
 *                            chargeCondition='LabTest', dated receipt_date
 *      (that branch split is in getLocationSummary and dailyOPDModel — kept here)
 *
 *   2. eVital pharmacy — evital_pharmacy_invoice, where the amount and the
 *      payment mode live inside a JSON blob, so it CANNOT be summed in SQL and
 *      has to be parsed row-by-row in Node. Existing code does exactly that.
 *
 * Totals here are built to reconcile with getLocationSummary, i.e. with the
 * "Pharmacy" figure in the Monthwise_Revenue workbook.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  ⚠️  THE "OTHER" MODE IS EXCLUDED FROM THE HEADLINE — BY DESIGN, UPSTREAM
 * ═══════════════════════════════════════════════════════════════════════════
 * getLocationSummary tallies eVital into four buckets {Cash, Card, Online,
 * Other} and then assembles:
 *
 *     pharmacy.cash   = HMS cash   + evitalTotals.Cash
 *     pharmacy.card   = HMS card   + evitalTotals.Card
 *     pharmacy.online = HMS online + evitalTotals.Online
 *     pharmacy.total  = cash + card + online          ← Other is NEVER added
 *
 * So any eVital invoice whose payment mode isn't Cash / CC-DC / Credit / UPI /
 * Online is silently dropped from pharmacy revenue — and therefore from the
 * grand total in the monthly revenue report too.
 *
 * This script reproduces that definition for the headline (so the numbers tie
 * out), but ALSO computes the Other bucket and shows it in its own column and
 * on the "Source & Mode Split" sheet. If Other is material, the pharmacy line
 * you have been reporting is understated and this is worth raising separately —
 * it is an upstream issue, not something this script should quietly "fix".
 *
 * ── Other things carried over deliberately ─────────────────────────────────
 * • Split payments: when UpdatedInvoiceDetails has >1 transaction, each txn's
 *   OWN amount is assigned to its own mode (existing behaviour). Note that the
 *   per-mode amounts then come from transactions while a single-txn row uses
 *   invoice.total — if a split's transactions don't sum to invoice.total, the
 *   mode split and the invoice value disagree. The script counts these rows and
 *   reports the drift instead of hiding it.
 * • Math.round on every eVital amount, as in reportMailModel.
 * • Rows with null/invalid invoice_details JSON are skipped, as upstream.
 *
 * ── Date handling ──────────────────────────────────────────────────────────
 * • eVital is dated by JSON bill_date via STR_TO_DATE(...) — a DATETIME, so the
 *   window is bounded '00:00:00' to '23:59:59' exactly as existing code does.
 * • HMS: existing code writes `created_at >= ? AND created_at <= ?` with plain
 *   date strings. If created_at is a DATETIME that quietly drops bills made
 *   after midnight on the last day. This script uses an EXCLUSIVE upper bound
 *   (>= first day, < day-after-last) instead, which is correct whether the
 *   column is DATE or DATETIME. That is a deliberate deviation and the only
 *   place this script does not copy upstream verbatim; on a DATE column the two
 *   are identical, so it cannot make the numbers disagree.
 *
 * ── Place this file at the PROJECT ROOT ────────────────────────────────────
 * (next to app.js / databaseUtils.js / dbconfig.js).
 *
 * ── Run ────────────────────────────────────────────────────────────────────
 *   node tmp_generatePharmacyReport_Jan_Jul.js
 *   node tmp_generatePharmacyReport_Jan_Jul.js "Navi Mumbai,Andheri,Thane,Vashi"
 *   node tmp_generatePharmacyReport_Jan_Jul.js "Andheri,Thane" 2026 1 7
 *
 * ── Output ─────────────────────────────────────────────────────────────────
 *   src/report/Monthwise_Pharmacy_2026_vs_2025_01-07.xlsx
 *
 * DELETE THIS FILE once the workbook has been generated.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");
const { getConnectionByLocation } = require("../databaseUtils");

/* ── Config ──────────────────────────────────────────────────────────────── */

// Same four branches, same order as the other Jan–Jun workbooks.
const DEFAULT_LOCATIONS = [
  "HSR",
  "Indiranagar",
  "JP Nagar",
  "Rajaji Nagar",
  "Sarjapura",
  "Whitefield",
  "Electronic City",
  "Sahakar Nagar",
  "RR Nagar",
];

const argLocations = (process.argv[2] || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const LOCATIONS = argLocations.length ? argLocations : DEFAULT_LOCATIONS;

const YEAR = Number(process.argv[3]) || 2026;
const PREVIOUS_YEAR = YEAR - 1;
const START_MONTH = Number(process.argv[4]) || 1;
const END_MONTH = Number(process.argv[5]) || 7; // ← July

/* ── Shared helpers ──────────────────────────────────────────────────────── */

const reportsDir = path.join(__dirname, "src", "report");
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const pad2 = (n) => String(n).padStart(2, "0");
const round2 = (n) =>
  Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

const pctChange = (cur, prev) =>
  prev > 0 ? round2(((cur - prev) / prev) * 100) : cur > 0 ? null : 0;

const NUM_FMT = '#,##0;(#,##0);"-"';
const PCT_FMT = '0.0%;(0.0%);"-"';

function pctFraction(cur, prev) {
  if (prev > 0) return (cur - prev) / prev;
  return cur > 0 ? null : 0;
}

function formatColumn(ws, colIdx, firstRow, lastRow, fmt) {
  for (let r = firstRow; r <= lastRow; r++) {
    const addr = xlsx.utils.encode_cell({ r, c: colIdx });
    const cell = ws[addr];
    if (cell && cell.t === "n") cell.z = fmt;
  }
}

// Verbatim from reportMailModel / evitalPharmacyCollectionModal.
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

const safeParseInvoice = (raw) => {
  try {
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

/* ── SQL ─────────────────────────────────────────────────────────────────── */

// HMS pharmacy, grouped by month. Branch split from getLocationSummary.
function hmsSqlFor(location) {
  if (location === "DP Road") {
    return `
      SELECT
        MONTH(receipt_date) AS mon,
        COALESCE(SUM(CASE WHEN paymentmode = 'Cash' THEN totalamt ELSE 0 END), 0) AS cash,
        COALESCE(SUM(CASE WHEN paymentmode = 'Card' THEN totalamt ELSE 0 END), 0) AS card,
        COALESCE(SUM(CASE WHEN paymentmode IN ('Online','UPI') THEN totalamt ELSE 0 END), 0) AS online,
        COUNT(*) AS bills
      FROM patient_receipt
      WHERE receipt_date >= ? AND receipt_date < ?
        AND chargeCondition = 'LabTest'
        AND is_deleted != 1
      GROUP BY MONTH(receipt_date)
    `;
  }
  return `
    SELECT
      MONTH(created_at) AS mon,
      COALESCE(SUM(CASE WHEN paymentmode = 'Cash' THEN final_total ELSE 0 END), 0) AS cash,
      COALESCE(SUM(CASE WHEN paymentmode = 'Card' THEN final_total ELSE 0 END), 0) AS card,
      COALESCE(SUM(CASE WHEN paymentmode IN ('Online','UPI','Paytm') THEN final_total ELSE 0 END), 0) AS online,
      COUNT(*) AS bills
    FROM pharmacybill
    WHERE created_at >= ? AND created_at < ?
      AND is_deleted != 1
    GROUP BY MONTH(created_at)
  `;
}

// eVital: same date predicate as getPharmacyCollection, but only the columns we
// actually need (upstream does SELECT * — fine for one day, wasteful over 7
// months), plus the parsed bill month so bucketing doesn't re-parse dates in JS.
const EVITAL_SQL = `
  SELECT
    MONTH(STR_TO_DATE(
      JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.bill_date')),
      '%Y-%m-%d %H:%i:%s'
    )) AS mon,
    invoice_details,
    UpdatedInvoiceDetails
  FROM evital_pharmacy_invoice
  WHERE STR_TO_DATE(
          JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.bill_date')),
          '%Y-%m-%d %H:%i:%s'
        ) BETWEEN ? AND ?
`;

/* ── eVital reduction (mirrors reportMailModel's evitalTotals) ───────────── */

function reduceEvitalRow(row, bucket, stats) {
  const invoice = safeParseInvoice(row.invoice_details);
  if (!invoice) {
    stats.skippedBadJson++;
    return;
  }
  const total = Math.round(Number(invoice.total) || 0);
  stats.invoices++;

  if (row.UpdatedInvoiceDetails) {
    try {
      const updated = JSON.parse(row.UpdatedInvoiceDetails);
      const txns = updated?.transaction_summary?.transactions ?? [];

      if (txns.length === 1) {
        // Single txn → the whole invoice total goes to that method.
        bucket[normalizeMode(txns[0].method)] += total;
        return;
      }
      if (txns.length > 1) {
        // Split → each txn's own amount to its own mode. The per-mode sum can
        // drift from invoice.total; track it rather than silently absorbing it.
        let txnSum = 0;
        txns.forEach((txn) => {
          const amt = Math.round(Number(txn.amount) || 0);
          bucket[normalizeMode(txn.method)] += amt;
          txnSum += amt;
        });
        stats.splitInvoices++;
        stats.splitDrift += txnSum - total;
        return;
      }
    } catch {
      // Unparseable → fall through to the invoice's own payment_mode.
      stats.badUpdatedJson++;
    }
  }

  bucket[normalizeMode(invoice.payment_mode)] += total;
}

/* ── Per (location, year) fetch ──────────────────────────────────────────── */

const emptyBucket = () => ({ Cash: 0, Card: 0, Online: 0, Other: 0 });

async function collectLocationYear(loc, year, monthList) {
  const { connection } = getConnectionByLocation(loc);
  if (!connection) throw new Error(`Invalid location: ${loc}`);

  const run = (sql, params = []) =>
    new Promise((res, rej) =>
      connection.query(sql, params, (e, r) => (e ? rej(e) : res(r))),
    );

  const firstM = monthList[0];
  const lastM = monthList[monthList.length - 1];
  const start = `${year}-${pad2(firstM)}-01`;
  const endDay = new Date(year, lastM, 0).getDate();
  const endInclusive = `${year}-${pad2(lastM)}-${pad2(endDay)}`;

  // Exclusive upper bound for HMS — correct for DATE and DATETIME alike.
  const endExclusive = new Date(year, lastM, 1);
  const endExclusiveStr = `${endExclusive.getFullYear()}-${pad2(
    endExclusive.getMonth() + 1,
  )}-01`;

  const stats = {
    invoices: 0,
    skippedBadJson: 0,
    badUpdatedJson: 0,
    splitInvoices: 0,
    splitDrift: 0,
    hmsBills: 0,
  };

  const [hmsRows, evitalRows] = await Promise.all([
    run(hmsSqlFor(loc), [start, endExclusiveStr]),
    run(EVITAL_SQL, [`${start} 00:00:00`, `${endInclusive} 23:59:59`]),
  ]);

  const monthTotals = {};
  for (const m of monthList) {
    monthTotals[m] = { hms: emptyBucket(), evital: emptyBucket() };
  }

  for (const r of hmsRows) {
    const mon = Number(r.mon);
    if (!monthTotals[mon]) continue;
    monthTotals[mon].hms.Cash += Number(r.cash) || 0;
    monthTotals[mon].hms.Card += Number(r.card) || 0;
    monthTotals[mon].hms.Online += Number(r.online) || 0;
    stats.hmsBills += Number(r.bills) || 0;
  }

  for (const r of evitalRows) {
    const mon = Number(r.mon);
    if (!monthTotals[mon]) continue; // NULL mon = unparseable bill_date
    reduceEvitalRow(r, monthTotals[mon].evital, stats);
  }

  return { monthTotals, stats };
}

/* ── Reducers ────────────────────────────────────────────────────────────── */

const addBucket = (a, b) => {
  a.Cash += b.Cash;
  a.Card += b.Card;
  a.Online += b.Online;
  a.Other += b.Other;
};

function emptyMonthTotals(monthList) {
  const m = {};
  for (const mm of monthList)
    m[mm] = { hms: emptyBucket(), evital: emptyBucket() };
  return m;
}

function mergeMonthTotals(agg, part, monthList) {
  for (const m of monthList) {
    addBucket(agg[m].hms, part.monthTotals[m].hms);
    addBucket(agg[m].evital, part.monthTotals[m].evital);
  }
}

// The definition that matters. Headline total = Cash + Card + Online.
// `other` is carried alongside so the exclusion stays visible.
function shape(node, yr) {
  const cash = node.hms.Cash + node.evital.Cash;
  const card = node.hms.Card + node.evital.Card;
  const online = node.hms.Online + node.evital.Online;
  const other = node.hms.Other + node.evital.Other; // HMS Other is always 0
  return {
    year: yr,
    cash: round2(cash),
    card: round2(card),
    online: round2(online),
    total: round2(cash + card + online), // ← matches getLocationSummary
    other: round2(other), // ← NOT in total, upstream drops it
    hms: round2(node.hms.Cash + node.hms.Card + node.hms.Online),
    evital: round2(node.evital.Cash + node.evital.Card + node.evital.Online),
  };
}

function windowNode(monthTotals, monthList) {
  const acc = { hms: emptyBucket(), evital: emptyBucket() };
  for (const m of monthList) {
    addBucket(acc.hms, monthTotals[m].hms);
    addBucket(acc.evital, monthTotals[m].evital);
  }
  return acc;
}

function monthlyArray(monthTotals, monthList, yr) {
  return monthList.map((m) => ({
    month: m,
    monthName: MONTH_NAMES[m - 1],
    ...shape(monthTotals[m], yr),
  }));
}

const zeroMonthly = (monthList, yr) =>
  monthList.map((m) => ({
    month: m,
    monthName: MONTH_NAMES[m - 1],
    ...shape({ hms: emptyBucket(), evital: emptyBucket() }, yr),
  }));

/* ── Main data build ─────────────────────────────────────────────────────── */

async function getMonthwisePharmacy(locations, options = {}) {
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new Error("`locations` must be a non-empty array of branch names.");
  }

  const year = Number(options.year) || 2026;
  const previousYear = Number(options.previousYear) || year - 1;
  const startMonth = Number(options.startMonth) || 1;
  const endMonth = Number(options.endMonth) || 7;
  if (endMonth < startMonth) {
    throw new Error("`endMonth` cannot be earlier than `startMonth`.");
  }

  const monthList = [];
  for (let m = startMonth; m <= endMonth; m++) monthList.push(m);

  const failures = [];
  const failed = new Set();
  const aggByYear = {
    [year]: emptyMonthTotals(monthList),
    [previousYear]: emptyMonthTotals(monthList),
  };
  const perLoc = {};
  for (const loc of locations) perLoc[loc] = {};
  const allStats = {
    invoices: 0,
    skippedBadJson: 0,
    badUpdatedJson: 0,
    splitInvoices: 0,
    splitDrift: 0,
    hmsBills: 0,
  };

  async function collect(loc, yr) {
    if (failed.has(loc)) return;
    try {
      const part = await collectLocationYear(loc, yr, monthList);
      mergeMonthTotals(aggByYear[yr], part, monthList);
      perLoc[loc][yr] = part;
      for (const k of Object.keys(allStats)) allStats[k] += part.stats[k] || 0;
    } catch (e) {
      failed.add(loc);
      failures.push({ location: loc, error: e?.message || String(e) });
    }
  }

  // Two queries per (branch, year), parallel across branches. The eVital fetch
  // returns raw rows for JSON parsing, so this is heavier than the OPD report
  // but far lighter than the revenue report's per-month loop.
  for (const yr of [year, previousYear]) {
    await Promise.all(locations.map((loc) => collect(loc, yr)));
  }

  const aggY = aggByYear[year];
  const aggP = aggByYear[previousYear];

  const changeOf = (c, p) => ({
    total: {
      amount: round2(c.total - p.total),
      pct: pctChange(c.total, p.total),
    },
  });

  const months = monthList.map((m) => {
    const c = shape(aggY[m], year);
    const p = shape(aggP[m], previousYear);
    return {
      month: m,
      monthName: MONTH_NAMES[m - 1],
      current: c,
      previous: p,
      change: changeOf(c, p),
    };
  });

  const cT = shape(windowNode(aggY, monthList), year);
  const pT = shape(windowNode(aggP, monthList), previousYear);
  const totals = { current: cT, previous: pT, change: changeOf(cT, pT) };

  const byLocation = locations
    .map((loc) => {
      const cur = perLoc[loc][year];
      const prev = perLoc[loc][previousYear];
      if (!cur && !prev) return null;
      const zero = { hms: emptyBucket(), evital: emptyBucket() };
      const c = shape(
        cur ? windowNode(cur.monthTotals, monthList) : zero,
        year,
      );
      const p = shape(
        prev ? windowNode(prev.monthTotals, monthList) : zero,
        previousYear,
      );
      return {
        location: loc,
        current: c,
        previous: p,
        change: changeOf(c, p),
        monthlyCurrent: cur
          ? monthlyArray(cur.monthTotals, monthList, year)
          : zeroMonthly(monthList, year),
        monthlyPrevious: prev
          ? monthlyArray(prev.monthTotals, monthList, previousYear)
          : zeroMonthly(monthList, previousYear),
      };
    })
    .filter(Boolean);
  // Order preserved so rows line up with the other workbooks.

  return {
    generatedAt: new Date().toISOString(),
    period: {
      year,
      previousYear,
      months: `${MONTH_NAMES[startMonth - 1]}–${MONTH_NAMES[endMonth - 1]}`,
      startMonth,
      endMonth,
      monthList,
      monthNames: monthList.map((m) => MONTH_NAMES[m - 1]),
    },
    locationsRequested: locations,
    locationsFailed: failures,
    months,
    totals,
    byLocation,
    stats: allStats,
  };
}

/* ── Excel builders ──────────────────────────────────────────────────────── */

function buildComparisonSheet(report, kind /* 'month' | 'location' */) {
  const { year: Y, previousYear: P, months: ML } = report.period;
  const cfg = {
    month: {
      first: "Month",
      rows: report.months,
      label: (r) => r.monthName,
      title: `Monthly Pharmacy Revenue — ${P} vs ${Y} (${ML})`,
      totalLabel: `Total (${ML})`,
      w: 16,
    },
    location: {
      first: "Location",
      rows: report.byLocation,
      label: (r) => r.location,
      title: `Pharmacy Revenue by Location — ${P} vs ${Y} (${ML})`,
      totalLabel: "Grand Total",
      w: 22,
    },
  }[kind];

  const header = [
    cfg.first,
    `Pharmacy (₹) ${Y}`,
    `Pharmacy (₹) ${P}`,
    "Δ (₹)",
    "Δ (%)",
    `HMS ${Y}`,
    `eVital ${Y}`,
    `Other — excluded ${Y}`,
    `Other — excluded ${P}`,
  ];
  const aoa = [
    [cfg.title],
    [
      "Total = Cash + Card + Online (matches getLocationSummary). 'Other' is NOT included — see Definition sheet.",
    ],
    header,
  ];

  const rowFor = (label, c, p) => [
    label,
    c.total,
    p.total,
    round2(c.total - p.total),
    pctFraction(c.total, p.total) ?? "N/A",
    c.hms,
    c.evital,
    c.other,
    p.other,
  ];

  const t = { c: 0, p: 0, hms: 0, ev: 0, co: 0, po: 0 };
  cfg.rows.forEach((r) => {
    aoa.push(rowFor(cfg.label(r), r.current, r.previous));
    t.c += r.current.total;
    t.p += r.previous.total;
    t.hms += r.current.hms;
    t.ev += r.current.evital;
    t.co += r.current.other;
    t.po += r.previous.other;
  });
  aoa.push(
    rowFor(
      cfg.totalLabel,
      {
        total: round2(t.c),
        hms: round2(t.hms),
        evital: round2(t.ev),
        other: round2(t.co),
      },
      { total: round2(t.p), other: round2(t.po) },
    ),
  );

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: header.length - 1 } },
  ];
  ws["!cols"] = [
    { wch: cfg.w },
    { wch: 17 },
    { wch: 17 },
    { wch: 14 },
    { wch: 10 },
    { wch: 15 },
    { wch: 15 },
    { wch: 19 },
    { wch: 19 },
  ];

  const fr = 3;
  const lr = 3 + cfg.rows.length;
  [1, 2, 3, 5, 6, 7, 8].forEach((c) => formatColumn(ws, c, fr, lr, NUM_FMT));
  formatColumn(ws, 4, fr, lr, PCT_FMT);
  return ws;
}

function buildLocationMonthSheet(report, which /* 'current'|'previous' */, yr) {
  const monthNames = report.period.monthNames;
  const title = `Pharmacy Revenue (₹) by Location × Month — ${yr} (${report.period.months})`;
  const header = ["Location", ...monthNames, "Total (₹)"];
  const aoa = [[title], [], header];
  const key = which === "current" ? "monthlyCurrent" : "monthlyPrevious";

  const colSums = new Array(monthNames.length).fill(0);
  let grand = 0;
  report.byLocation.forEach((loc) => {
    const vals = loc[key].map((mm) => mm.total || 0);
    const rowTotal = vals.reduce((a, b) => a + b, 0);
    vals.forEach((v, i) => (colSums[i] += v));
    grand += rowTotal;
    aoa.push([loc.location, ...vals.map(round2), round2(rowTotal)]);
  });
  aoa.push(["Grand Total", ...colSums.map(round2), round2(grand)]);

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }];
  ws["!cols"] = [
    { wch: 22 },
    ...monthNames.map(() => ({ wch: 14 })),
    { wch: 16 },
  ];
  const fr = 3;
  const lr = 3 + report.byLocation.length;
  for (let c = 1; c < header.length; c++) formatColumn(ws, c, fr, lr, NUM_FMT);
  return ws;
}

// Where the two systems and the four modes are laid bare.
function buildSplitSheet(report) {
  const { year: Y, previousYear: P } = report.period;
  const header = [
    "Location",
    "Year",
    "HMS (₹)",
    "eVital (₹)",
    "Cash (₹)",
    "Card (₹)",
    "Online (₹)",
    "TOTAL (₹)",
    "Other — EXCLUDED (₹)",
  ];
  const aoa = [
    ["Pharmacy revenue — source and payment-mode split"],
    [
      "The TOTAL column is Cash + Card + Online. The Other column is computed but " +
        "deliberately left out, because getLocationSummary leaves it out.",
    ],
    [],
    header,
  ];

  const push = (label, s) =>
    aoa.push([
      label,
      s.year,
      s.hms,
      s.evital,
      s.cash,
      s.card,
      s.online,
      s.total,
      s.other,
    ]);

  report.byLocation.forEach((loc) => {
    push(loc.location, loc.current);
    push(loc.location, loc.previous);
  });
  push("GRAND TOTAL", report.totals.current);
  push("GRAND TOTAL", report.totals.previous);

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: header.length - 1 } },
  ];
  ws["!cols"] = [
    { wch: 22 },
    { wch: 8 },
    { wch: 15 },
    { wch: 15 },
    { wch: 15 },
    { wch: 15 },
    { wch: 15 },
    { wch: 16 },
    { wch: 21 },
  ];
  const fr = 4;
  const lr = 4 + report.byLocation.length * 2 + 1;
  for (let c = 2; c < header.length; c++) formatColumn(ws, c, fr, lr, NUM_FMT);
  return ws;
}

function buildWorkbook(report) {
  const { year, previousYear } = report.period;
  const wb = xlsx.utils.book_new();

  xlsx.utils.book_append_sheet(
    wb,
    buildComparisonSheet(report, "month"),
    "Monthly Totals",
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildComparisonSheet(report, "location"),
    "Location Summary",
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationMonthSheet(report, "current", year),
    `Pharmacy by Loc ${year}`,
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationMonthSheet(report, "previous", previousYear),
    `Pharmacy by Loc ${previousYear}`,
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildSplitSheet(report),
    "Source & Mode Split",
  );

  const s = report.stats;
  const notes = [
    ["Pharmacy revenue — definition"],
    [],
    [
      "Headline total",
      "HMS pharmacy + eVital pharmacy, counting Cash + Card + Online only",
    ],
    [
      "Reconciles with",
      "getLocationSummary().pharmacy.total → the 'Pharmacy' line in Monthwise_Revenue",
    ],
    [],
    [
      "Source 1 — HMS",
      "pharmacybill.final_total, dated created_at, is_deleted != 1",
    ],
    [
      "  DP Road only",
      "patient_receipt.totalamt, chargeCondition='LabTest', dated receipt_date",
    ],
    [
      "Source 2 — eVital",
      "evital_pharmacy_invoice, amount + mode parsed from invoice_details JSON",
    ],
    ["  eVital dating", "JSON bill_date via STR_TO_DATE(...)"],
    [],
    [
      "Mode normalisation",
      "CC/DC + Credit → Card; UPI + Online → Online; Cash → Cash; anything else → Other",
    ],
    [
      "⚠ Other excluded",
      "getLocationSummary computes pharmacy.total as cash + card + online, so the " +
        "Other bucket never reaches the total. This report reproduces that so the " +
        "figures tie out, and shows Other separately. If Other is material, the " +
        "pharmacy revenue reported upstream is understated — raise it, don't patch it here.",
    ],
    [
      "Split payments",
      "When UpdatedInvoiceDetails has >1 transaction, each transaction's own amount " +
        "goes to its own mode; a single transaction assigns the whole invoice total.",
    ],
    [],
    ["eVital invoices parsed", s.invoices],
    ["HMS bills counted", s.hmsBills],
    ["Split-payment invoices", s.splitInvoices],
    ["Split drift (₹)", round2(s.splitDrift)],
    ["Rows skipped — bad invoice JSON", s.skippedBadJson],
    ["Rows with unparseable UpdatedInvoiceDetails", s.badUpdatedJson],
    ["Generated at", report.generatedAt],
  ];
  const nws = xlsx.utils.aoa_to_sheet(notes);
  nws["!cols"] = [{ wch: 34 }, { wch: 95 }];
  xlsx.utils.book_append_sheet(wb, nws, "Definition");

  if (report.locationsFailed && report.locationsFailed.length) {
    const aoa = [
      ["Skipped Location", "Reason"],
      ...report.locationsFailed.map((f) => [f.location, f.error]),
    ];
    const ws = xlsx.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 24 }, { wch: 55 }];
    xlsx.utils.book_append_sheet(wb, ws, "Skipped Locations");
  }

  return wb;
}

/* ── Run ─────────────────────────────────────────────────────────────────── */

(async () => {
  const t0 = Date.now();
  const inr = (n) => Math.round(Number(n) || 0).toLocaleString("en-IN");

  console.log("──────────────────────────────────────────────────────────");
  console.log("Month-wise Pharmacy Revenue Report (temporary runner)");
  console.log(
    `Window   : ${START_MONTH}–${END_MONTH} | ${YEAR} vs ${PREVIOUS_YEAR}`,
  );
  console.log(`Branches : ${LOCATIONS.join(", ")}`);
  console.log(`Sources  : HMS (pharmacybill) + eVital (JSON, parsed in Node)`);
  console.log("──────────────────────────────────────────────────────────");

  try {
    const report = await getMonthwisePharmacy(LOCATIONS, {
      year: YEAR,
      previousYear: PREVIOUS_YEAR,
      startMonth: START_MONTH,
      endMonth: END_MONTH,
    });

    const wb = buildWorkbook(report);
    const fileName =
      `Monthwise_Pharmacy_${YEAR}_vs_${PREVIOUS_YEAR}_` +
      `${pad2(START_MONTH)}-${pad2(END_MONTH)}.xlsx`;
    const filePath = path.join(reportsDir, fileName);
    xlsx.writeFile(wb, filePath);

    const { current, previous, change } = report.totals;

    console.log(`\n✅ Workbook written: ${filePath}`);

    console.log(
      `\nTotals (${report.period.months}) — ${YEAR} vs ${PREVIOUS_YEAR}:`,
    );
    console.log(
      `   HMS      ₹ ${inr(current.hms).padStart(14)}  vs ${inr(previous.hms).padStart(14)}`,
    );
    console.log(
      `   eVital   ₹ ${inr(current.evital).padStart(14)}  vs ${inr(previous.evital).padStart(14)}`,
    );
    console.log(`   ─────────────────────────────────────────────────────`);
    console.log(
      `   Cash     ₹ ${inr(current.cash).padStart(14)}  vs ${inr(previous.cash).padStart(14)}`,
    );
    console.log(
      `   Card     ₹ ${inr(current.card).padStart(14)}  vs ${inr(previous.card).padStart(14)}`,
    );
    console.log(
      `   Online   ₹ ${inr(current.online).padStart(14)}  vs ${inr(previous.online).padStart(14)}`,
    );
    console.log(
      `   TOTAL    ₹ ${inr(current.total).padStart(14)}  vs ${inr(previous.total).padStart(14)}` +
        `   (${change.total.pct === null ? "N/A" : change.total.pct + "%"})`,
    );

    console.log("\nMonth-wise pharmacy revenue (₹):");
    report.months.forEach((m) => {
      console.log(
        `   ${m.monthName.padEnd(10)} ${inr(m.current.total).padStart(14)}` +
          `  vs ${inr(m.previous.total).padStart(14)}`,
      );
    });

    // The finding most likely to change what you send out.
    if (current.other > 0 || previous.other > 0) {
      const pct =
        current.total > 0
          ? ((current.other / current.total) * 100).toFixed(2)
          : "0";
      console.warn(
        `\n⚠️  'Other' payment mode is EXCLUDED from the totals above ` +
          `(getLocationSummary sums only cash+card+online):`,
      );
      console.warn(
        `      ${YEAR}: ₹${inr(current.other)}   ${PREVIOUS_YEAR}: ₹${inr(previous.other)}` +
          `   — ${pct}% of the ${YEAR} pharmacy total`,
      );
      console.warn(
        `   → This means the pharmacy line in the revenue report is understated by ` +
          `the same amount. See 'Source & Mode Split'. Upstream issue, not fixed here.`,
      );
    } else {
      console.log(
        `\n✓ No 'Other'-mode pharmacy revenue — nothing being dropped.`,
      );
    }

    const s = report.stats;
    if (s.skippedBadJson > 0) {
      console.warn(
        `\n⚠️  ${s.skippedBadJson} eVital row(s) had null/invalid invoice_details ` +
          `and were skipped (upstream does the same) — their revenue is in no total.`,
      );
    }
    if (s.splitInvoices > 0 && Math.abs(s.splitDrift) >= 1) {
      console.warn(
        `\n⚠️  ${s.splitInvoices} split-payment invoice(s); transaction amounts differ ` +
          `from invoice totals by ₹${inr(s.splitDrift)} in aggregate.`,
      );
    }

    if (report.locationsFailed?.length) {
      console.warn("\n⚠️  Skipped branches (see 'Skipped Locations' sheet):");
      report.locationsFailed.forEach((f) =>
        console.warn(`   • ${f.location}: ${f.error}`),
      );
    }

    console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Pharmacy report failed:", err?.message || err);
    console.error(err?.stack || "");
    process.exit(1);
  }
})();
