/**
 * opdRevenueReportModel.js
 * ---------------------------------------------------------------------------
 * Month-wise, LOCATION-WISE OPD report: total OPD number and total OPD revenue
 * for a 6-month window (default Jan–Jun 2026) vs the same months of the previous
 * year (default Jan–Jun 2025), split per branch, with an Excel export in the
 * SheetJS style used in this codebase.
 *
 * ── Definition (matches the DSR / getLocationSummary OPD figures) ─────────────
 * OPD is sourced from `patient_itemreceipt` (the table the DSR uses for OPD;
 * `patient_receipt` is treated as pharmacy/LabTest elsewhere, so it is NOT used
 * here). Filtered on is_deleted != 1 and bucketed by MONTH(item_date):
 *
 *   • OPD number  = COUNT(DISTINCT receipt_id)  (number of OPD receipts/visits)
 *   • OPD items   = COUNT(*)                     (billed line-items, reference)
 *   • OPD revenue = SUM(total)
 *
 * OPD revenue therefore reconciles with the OPD component of the collection /
 * revenue report (getLocationSummary opd.total = SUM(patient_itemreceipt.total)).
 * To use line-items instead of receipts as the headline "OPD number", swap
 * `count` for `items` in the Excel builders (both are already computed).
 *
 * item_date is a DATE (the daily DSR filters it as 'YYYY-MM-DD'), so no timezone
 * conversion is needed and month boundaries are exact.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   const {
 *     getMonthwiseOpdReport,
 *     generateMonthwiseOpdExcel,
 *   } = require("./opdRevenueReportModel");
 *
 *   const report = await getMonthwiseOpdReport(["Andheri", "Thane", "Vashi"]);
 *   const { filePath } = await generateMonthwiseOpdExcel(
 *     ["Andheri", "Thane", "Vashi"],
 *     { year: 2026, startMonth: 1, endMonth: 6 },
 *   );
 *
 * Express handlers: getMonthwiseOpdReportHandler(req),
 *                   generateMonthwiseOpdExcelHandler(req).
 * Location strings must match the branch keys used by getConnectionByLocation.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");

const reportsDir = path.join(__dirname, "..", "report");
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

/* ── SQL ──────────────────────────────────────────────────────────────────── */

// OPD counts + revenue, grouped per month, over the window.
const OPD_SQL = `
  SELECT
    MONTH(item_date) AS mon,
    COUNT(DISTINCT receipt_id) AS opd_count,
    COUNT(*)                   AS opd_items,
    COALESCE(SUM(total), 0)    AS opd_revenue
  FROM patient_itemreceipt
  WHERE item_date >= ? AND item_date <= ?
    AND is_deleted != 1
  GROUP BY MONTH(item_date)
`;

/* ── Per (location, year) fetch ───────────────────────────────────────────── */

async function collectLocationYear(loc, year, monthList) {
  const { getConnectionByLocation } = require("../../databaseUtils");
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
  const end = `${year}-${pad2(lastM)}-${pad2(endDay)}`;

  const rows = await run(OPD_SQL, [start, end]);

  const monthTotals = {};
  for (const m of monthList)
    monthTotals[m] = { count: 0, items: 0, revenue: 0 };
  for (const r of rows) {
    const mon = Number(r.mon);
    if (!monthTotals[mon]) continue;
    monthTotals[mon].count += Number(r.opd_count) || 0;
    monthTotals[mon].items += Number(r.opd_items) || 0;
    monthTotals[mon].revenue += Number(r.opd_revenue) || 0;
  }
  return { monthTotals };
}

/* ── reducers ─────────────────────────────────────────────────────────────── */

function emptyMonthTotals(monthList) {
  const m = {};
  for (const mm of monthList) m[mm] = { count: 0, items: 0, revenue: 0 };
  return m;
}

function mergeMonthTotals(agg, part, monthList) {
  for (const m of monthList) {
    agg[m].count += part.monthTotals[m].count;
    agg[m].items += part.monthTotals[m].items;
    agg[m].revenue += part.monthTotals[m].revenue;
  }
}

function windowTotals(monthTotals, monthList) {
  return monthList.reduce(
    (a, m) => {
      a.count += monthTotals[m].count;
      a.items += monthTotals[m].items;
      a.revenue += monthTotals[m].revenue;
      return a;
    },
    { count: 0, items: 0, revenue: 0 },
  );
}

function monthlyArray(monthTotals, monthList) {
  return monthList.map((m) => ({
    month: m,
    monthName: MONTH_NAMES[m - 1],
    count: monthTotals[m].count,
    items: monthTotals[m].items,
    revenue: round2(monthTotals[m].revenue),
  }));
}

const zeroMonthly = (monthList) =>
  monthList.map((m) => ({
    month: m,
    monthName: MONTH_NAMES[m - 1],
    count: 0,
    items: 0,
    revenue: 0,
  }));

/* ── Main entry point ─────────────────────────────────────────────────────── */

async function getMonthwiseOpdReport(locations, options = {}) {
  if (!Array.isArray(locations) || locations.length === 0) {
    const err = new Error(
      "`locations` must be a non-empty array of branch names.",
    );
    err.status = 400;
    throw err;
  }

  const year = Number(options.year) || 2026;
  const previousYear = Number(options.previousYear) || year - 1;
  const startMonth = Number(options.startMonth) || 1;
  const endMonth = Number(options.endMonth) || 6;
  if (endMonth < startMonth) {
    const err = new Error("`endMonth` cannot be earlier than `startMonth`.");
    err.status = 400;
    throw err;
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

  async function collect(loc, yr) {
    if (failed.has(loc)) return;
    try {
      const part = await collectLocationYear(loc, yr, monthList);
      mergeMonthTotals(aggByYear[yr], part, monthList);
      perLoc[loc][yr] = part;
    } catch (e) {
      failed.add(loc);
      failures.push({ location: loc, error: e?.message || String(e) });
    }
  }

  for (const yr of [year, previousYear]) {
    await Promise.all(locations.map((loc) => collect(loc, yr)));
  }

  const aggY = aggByYear[year];
  const aggP = aggByYear[previousYear];

  const shape = (b, yr) => ({
    year: yr,
    count: b.count,
    items: b.items,
    revenue: round2(b.revenue),
    avgRevenue: b.count ? round2(b.revenue / b.count) : 0,
  });
  const changeOf = (c, p) => ({
    count: { amount: c.count - p.count, pct: pctChange(c.count, p.count) },
    revenue: {
      amount: round2(c.revenue - p.revenue),
      pct: pctChange(c.revenue, p.revenue),
    },
  });

  // Group-level monthly totals
  const months = monthList.map((m) => {
    const cur = aggY[m]; // aggY / aggP are month-keyed { count, items, revenue }
    const prev = aggP[m];
    return {
      month: m,
      monthName: MONTH_NAMES[m - 1],
      current: shape(cur, year),
      previous: shape(prev, previousYear),
      change: changeOf(cur, prev),
    };
  });

  const cT = windowTotals(aggY, monthList);
  const pT = windowTotals(aggP, monthList);
  const totals = {
    current: shape(cT, year),
    previous: shape(pT, previousYear),
    change: changeOf(cT, pT),
  };

  // Per-location breakdown
  const byLocation = locations
    .map((loc) => {
      const cur = perLoc[loc][year];
      const prev = perLoc[loc][previousYear];
      if (!cur && !prev) return null;
      const cWin = cur
        ? windowTotals(cur.monthTotals, monthList)
        : { count: 0, items: 0, revenue: 0 };
      const pWin = prev
        ? windowTotals(prev.monthTotals, monthList)
        : { count: 0, items: 0, revenue: 0 };
      return {
        location: loc,
        current: shape(cWin, year),
        previous: shape(pWin, previousYear),
        change: changeOf(cWin, pWin),
        monthlyCurrent: cur
          ? monthlyArray(cur.monthTotals, monthList)
          : zeroMonthly(monthList),
        monthlyPrevious: prev
          ? monthlyArray(prev.monthTotals, monthList)
          : zeroMonthly(monthList),
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        b.current.revenue - a.current.revenue ||
        b.current.count - a.current.count,
    );

  return {
    generatedAt: new Date().toISOString(),
    definition:
      "OPD number = COUNT(DISTINCT receipt_id) and OPD revenue = SUM(total) from " +
      "patient_itemreceipt (is_deleted != 1), by item_date. Reconciles with the OPD " +
      "component of the collection/revenue report. 'items' = COUNT(*) line-items (reference).",
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
  };
}

/* ===========================================================================
 * Excel export (SheetJS)
 * ======================================================================== */

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

// Comparison sheet shared by Month / Location (OPD number + revenue).
// Total row is summed from the visible rows.
function buildComparisonSheet(report, kind /* 'month' | 'location' */) {
  const { year: Y, previousYear: P, months: ML } = report.period;
  const cfg = {
    month: {
      first: "Month",
      rows: report.months,
      label: (r) => r.monthName,
      title: `Monthly OPD Number & Revenue — ${P} vs ${Y} (${ML})`,
      totalLabel: `Total (${ML})`,
      w: 16,
    },
    location: {
      first: "Location",
      rows: report.byLocation,
      label: (r) => r.location,
      title: `OPD Number & Revenue by Location — ${P} vs ${Y} (${ML})`,
      totalLabel: "Grand Total",
      w: 22,
    },
  }[kind];

  const header = [
    cfg.first,
    `OPD Number ${Y}`,
    `OPD Number ${P}`,
    "Δ OPD",
    `OPD Revenue (₹) ${Y}`,
    `OPD Revenue (₹) ${P}`,
    "Δ Revenue (₹)",
    "Δ Revenue (%)",
  ];
  const aoa = [[cfg.title], [], header];

  const rowFor = (label, c, p) => [
    label,
    c.count,
    p.count,
    c.count - p.count,
    c.revenue,
    p.revenue,
    round2(c.revenue - p.revenue),
    pctFraction(c.revenue, p.revenue) ?? "N/A",
  ];

  const t = { cc: 0, cr: 0, pc: 0, pr: 0 };
  cfg.rows.forEach((r) => {
    aoa.push(rowFor(cfg.label(r), r.current, r.previous));
    t.cc += r.current.count;
    t.cr += r.current.revenue;
    t.pc += r.previous.count;
    t.pr += r.previous.revenue;
  });
  aoa.push(
    rowFor(
      cfg.totalLabel,
      { count: t.cc, revenue: round2(t.cr) },
      { count: t.pc, revenue: round2(t.pr) },
    ),
  );

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }];
  ws["!cols"] = [
    { wch: cfg.w },
    { wch: 15 },
    { wch: 15 },
    { wch: 10 },
    { wch: 18 },
    { wch: 18 },
    { wch: 15 },
    { wch: 13 },
  ];

  const fr = 3;
  const lr = 3 + cfg.rows.length;
  [1, 2, 3, 4, 5, 6].forEach((c) => formatColumn(ws, c, fr, lr, NUM_FMT));
  formatColumn(ws, 7, fr, lr, PCT_FMT);
  return ws;
}

// Location × Month matrix (OPD number or revenue), for one year.
function buildLocationMonthSheet(
  report,
  metric /* 'count'|'revenue' */,
  which /* 'current'|'previous' */,
  yr,
) {
  const monthNames = report.period.monthNames;
  const isRev = metric === "revenue";
  const title = `${isRev ? "OPD Revenue (₹)" : "OPD Number"} by Location × Month — ${yr} (${report.period.months})`;
  const header = ["Location", ...monthNames, isRev ? "Total (₹)" : "Total"];
  const aoa = [[title], [], header];
  const key = which === "current" ? "monthlyCurrent" : "monthlyPrevious";

  const colSums = new Array(monthNames.length).fill(0);
  let grand = 0;
  report.byLocation.forEach((loc) => {
    const vals = loc[key].map((mm) => (isRev ? mm.revenue : mm.count) || 0);
    const rowTotal = vals.reduce((a, b) => a + b, 0);
    vals.forEach((v, i) => (colSums[i] += v));
    grand += rowTotal;
    aoa.push([loc.location, ...vals, rowTotal]);
  });
  aoa.push(["Grand Total", ...colSums, grand]);

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }];
  ws["!cols"] = [
    { wch: 22 },
    ...monthNames.map(() => ({ wch: 13 })),
    { wch: 15 },
  ];
  const fr = 3;
  const lr = 3 + report.byLocation.length;
  for (let c = 1; c < header.length; c++) formatColumn(ws, c, fr, lr, NUM_FMT);
  return ws;
}

/** Build the full location-wise workbook from an already-computed report. */
function buildMonthwiseOpdWorkbook(report) {
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
    buildLocationMonthSheet(report, "count", "current", year),
    `OPD Count by Loc ${year}`,
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationMonthSheet(report, "count", "previous", previousYear),
    `OPD Count by Loc ${previousYear}`,
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationMonthSheet(report, "revenue", "current", year),
    `OPD Revenue by Loc ${year}`,
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationMonthSheet(report, "revenue", "previous", previousYear),
    `OPD Revenue by Loc ${previousYear}`,
  );

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

async function generateMonthwiseOpdExcel(locations, options = {}) {
  const report = await getMonthwiseOpdReport(locations, options);
  const wb = buildMonthwiseOpdWorkbook(report);

  const { year, previousYear, startMonth, endMonth } = report.period;
  const fileName = `Monthwise_OPD_${year}_vs_${previousYear}_${pad2(startMonth)}-${pad2(endMonth)}.xlsx`;
  const filePath = path.join(reportsDir, fileName);
  xlsx.writeFile(wb, filePath);

  return {
    success: true,
    filePath,
    fileName,
    branchesRequested: report.locationsRequested.length,
    locationsFailed: report.locationsFailed,
    report,
  };
}

/* ── Express adapters ─────────────────────────────────────────────────────── */

function extractParams(req) {
  const raw =
    (req.body && req.body.locations) ??
    (req.query && req.query.locations) ??
    null;

  let locations = raw;
  if (typeof raw === "string") {
    locations = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const options = {};
  if (req.query) {
    if (req.query.year) options.year = Number(req.query.year);
    if (req.query.previousYear)
      options.previousYear = Number(req.query.previousYear);
    if (req.query.startMonth) options.startMonth = Number(req.query.startMonth);
    if (req.query.endMonth) options.endMonth = Number(req.query.endMonth);
  }
  return { locations, options };
}

const getMonthwiseOpdReportHandler = async (req) => {
  const { locations, options } = extractParams(req);
  return getMonthwiseOpdReport(locations, options);
};

const generateMonthwiseOpdExcelHandler = async (req) => {
  const { locations, options } = extractParams(req);
  return generateMonthwiseOpdExcel(locations, options);
};

module.exports = {
  getMonthwiseOpdReport,
  getMonthwiseOpdReportHandler,
  buildMonthwiseOpdWorkbook,
  generateMonthwiseOpdExcel,
  generateMonthwiseOpdExcelHandler,
};
