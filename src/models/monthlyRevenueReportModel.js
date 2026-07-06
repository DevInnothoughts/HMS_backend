/**
 * monthlyRevenueReportModel.js
 * ---------------------------------------------------------------------------
 * Month-wise TOTAL revenue for a set of locations, comparing a 6-month window
 * (default: Jan–Jun 2026) against the SAME months of the previous year
 * (default: Jan–Jun 2025) — reported separately for each month — with an
 * Excel export in the same SheetJS style used elsewhere in this codebase.
 *
 * ── Revenue definition ─────────────────────────────────────────────────────
 * This module deliberately REUSES `getLocationSummary()` from
 * ./reportMailModel so the figures reconcile 1:1 with your existing summary
 * report (`generateSummaryReport`). For each location + month it therefore
 * uses that module's definition of a branch total:
 *
 *      monthly total (grandTotal) = OPD collection      (patient_itemreceipt)
 *                                 + IPD billed amount    (invoice.totalamt)
 *                                 + Pharmacy collection  (pharmacybill / LabTest + Evital)
 *
 * Notes (kept intentionally, matching the existing summary):
 *   • IPD *cash collection* (ipd_payment) is NOT part of the total — the billed
 *     IPD invoice amount is used instead. IPD collection is still returned per
 *     month, purely for reference.
 *   • Insurance settlement is not added as a separate line here, because the
 *     summary path does not fetch it. If you want the pure-cash DSR definition
 *     (which includes insurance settlement and uses IPD cash collection), swap
 *     getLocationSummary for a DSR/collection-style function instead.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   const {
 *     getMonthwiseRevenue,
 *     generateMonthwiseRevenueExcel,
 *   } = require("./monthlyRevenueReportModel");
 *
 *   // Just the data (defaults to Jan–Jun 2026 vs Jan–Jun 2025):
 *   const report = await getMonthwiseRevenue(["DP Road", "Andheri", "Baner"]);
 *
 *   // Data + an .xlsx written to the /report folder, returns the file path:
 *   const { filePath } = await generateMonthwiseRevenueExcel(
 *     ["DP Road", "Andheri", "Baner"],
 *     { year: 2026, startMonth: 1, endMonth: 6 },
 *   );
 *
 * As Express handlers (locations from body/query, matching the req-based
 * signatures used elsewhere in this codebase):
 *   const {
 *     getMonthwiseRevenueReport,
 *     generateMonthwiseRevenueExcelHandler,
 *   } = require("./monthlyRevenueReportModel");
 *
 *   router.post("/reports/monthwise-revenue", async (req, res, next) => {
 *     try { res.json(await getMonthwiseRevenueReport(req)); }
 *     catch (e) { next(e); }
 *   });
 *
 *   router.post("/reports/monthwise-revenue/excel", async (req, res, next) => {
 *     try {
 *       const { filePath, fileName } = await generateMonthwiseRevenueExcelHandler(req);
 *       res.download(filePath, fileName);          // stream the workbook back
 *     } catch (e) { next(e); }
 *   });
 *
 * IMPORTANT: the location strings you pass must match the branch keys used by
 * getConnectionByLocation (e.g. "DP Road", "Andheri", "Baner", ...).
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");

// Reuse the existing report folder convention (project root /report).
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
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Percentage change vs previous year. Returns null when there was no prior
// revenue but there is current revenue (growth is undefined / "N/A").
const pctChange = (cur, prev) =>
  prev > 0 ? round2(((cur - prev) / prev) * 100) : cur > 0 ? null : 0;

// First/last calendar day of a 1-based month, as 'YYYY-MM-DD' strings.
// getLocationSummary treats these bounds inclusively for every stream
// (it appends 00:00:00 / 23:59:59 internally for the datetime columns).
function monthBounds(year, month /* 1-12 */) {
  const lastDay = new Date(year, month, 0).getDate();
  return {
    start: `${year}-${pad2(month)}-01`,
    end: `${year}-${pad2(month)}-${pad2(lastDay)}`,
  };
}

// Empty accumulator for one (year, month) bucket.
function emptyBucket() {
  return { opd: 0, ipdCollection: 0, ipdInvoice: 0, pharmacy: 0, total: 0 };
}

function roundBucket(b) {
  return {
    opd: round2(b.opd),
    ipdCollection: round2(b.ipdCollection),
    ipdInvoice: round2(b.ipdInvoice),
    pharmacy: round2(b.pharmacy),
    total: round2(b.total),
  };
}

// Fold one location's getLocationSummary() result into a bucket, keeping the
// SAME grand-total formula as generateSummaryReport.
function addSummary(bucket, s) {
  const opd = Number(s?.opd?.total) || 0;
  const ipdCollection = Number(s?.ipdCollection?.total) || 0;
  const ipdInvoice = Number(s?.ipdInvoice?.total) || 0;
  const pharmacy = Number(s?.pharmacy?.total) || 0;

  bucket.opd += opd;
  bucket.ipdCollection += ipdCollection;
  bucket.ipdInvoice += ipdInvoice;
  bucket.pharmacy += pharmacy;
  bucket.total += opd + ipdInvoice + pharmacy; // grandTotal (IPD collection excluded)
  return bucket;
}

/**
 * Calculate month-wise total revenue across the passed locations.
 *
 * @param {string[]} locations           Branch keys, e.g. ["DP Road", "Andheri"].
 * @param {object}   [options]
 * @param {number}   [options.year=2026]        Current-year window.
 * @param {number}   [options.previousYear]     Comparison year (default: year - 1).
 * @param {number}   [options.startMonth=1]     1-based, inclusive.
 * @param {number}   [options.endMonth=6]       1-based, inclusive.
 * @returns {Promise<object>} Month-wise totals + per-location breakdown.
 */
async function getMonthwiseRevenue(locations, options = {}) {
  // Lazy require so the Excel/build helpers in this file can be used (and
  // unit-tested) without pulling in the DB layer that reportMailModel needs.
  const { getLocationSummary } = require("./reportMailModel");

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
  const failedLocations = new Set(); // skip a branch after its first failure

  // Aggregate buckets keyed `${yr}-${m}`; per-location buckets keyed the same.
  const buckets = {};
  const perLocation = {};
  for (const loc of locations) perLocation[loc] = {};

  // Pull one location's numbers for one month; fold into aggregate + per-location.
  async function collect(loc, yr, m) {
    if (failedLocations.has(loc)) return; // already known-bad, don't retry
    const { start, end } = monthBounds(yr, m);
    try {
      const summary = await getLocationSummary(loc, start, end);
      const key = `${yr}-${m}`;
      buckets[key] = addSummary(buckets[key] || emptyBucket(), summary);
      perLocation[loc][key] = addSummary(
        perLocation[loc][key] || emptyBucket(),
        summary,
      );
    } catch (e) {
      failedLocations.add(loc);
      failures.push({ location: loc, error: e?.message || String(e) });
    }
  }

  // Sequential across (year, month); parallel across locations within a step.
  // Each location is its own DB pool, so per-location parallelism is safe.
  for (const yr of [year, previousYear]) {
    for (const m of monthList) {
      await Promise.all(locations.map((loc) => collect(loc, yr, m)));
    }
  }

  // ── Shape the response ─────────────────────────────────────────────────
  const bucketOrEmpty = (yr, m) => buckets[`${yr}-${m}`] || emptyBucket();

  const months = monthList.map((m) => {
    const cur = bucketOrEmpty(year, m);
    const prev = bucketOrEmpty(previousYear, m);
    return {
      month: m,
      monthName: MONTH_NAMES[m - 1],
      current: { year, ...roundBucket(cur) },
      previous: { year: previousYear, ...roundBucket(prev) },
      change: {
        amount: round2(cur.total - prev.total),
        pct: pctChange(cur.total, prev.total),
      },
    };
  });

  // Whole-window (6-month) totals per year.
  const sumBuckets = (yr) =>
    monthList.reduce((acc, m) => {
      const b = bucketOrEmpty(yr, m);
      acc.opd += b.opd;
      acc.ipdCollection += b.ipdCollection;
      acc.ipdInvoice += b.ipdInvoice;
      acc.pharmacy += b.pharmacy;
      acc.total += b.total;
      return acc;
    }, emptyBucket());

  const curTotals = sumBuckets(year);
  const prevTotals = sumBuckets(previousYear);

  // Per-location, month-by-month (totals only, to keep the payload readable).
  const byLocation = {};
  for (const loc of locations) {
    byLocation[loc] = monthList.map((m) => {
      const c = perLocation[loc][`${year}-${m}`] || emptyBucket();
      const p = perLocation[loc][`${previousYear}-${m}`] || emptyBucket();
      return {
        month: m,
        monthName: MONTH_NAMES[m - 1],
        current: { year, total: round2(c.total) },
        previous: { year: previousYear, total: round2(p.total) },
        change: {
          amount: round2(c.total - p.total),
          pct: pctChange(c.total, p.total),
        },
      };
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    definition:
      "Monthly total = OPD collection + IPD billed (invoice) + Pharmacy collection " +
      "(matches generateSummaryReport grandTotal). IPD cash collection is listed " +
      "separately for reference and is NOT part of the total.",
    period: {
      year,
      previousYear,
      months: `${MONTH_NAMES[startMonth - 1]}–${MONTH_NAMES[endMonth - 1]}`,
      startMonth,
      endMonth,
    },
    locationsRequested: locations,
    locationsFailed: failures, // [] when every branch succeeded
    months, // ← core deliverable: one entry per month, current vs previous year
    totals: {
      current: { year, ...roundBucket(curTotals) },
      previous: { year: previousYear, ...roundBucket(prevTotals) },
      change: {
        amount: round2(curTotals.total - prevTotals.total),
        pct: pctChange(curTotals.total, prevTotals.total),
      },
    },
    byLocation,
  };
}

/* ===========================================================================
 * Excel export (SheetJS, matching the xlsx usage in reportMailModel.js)
 * ======================================================================== */

// Custom number formats. Negatives in parentheses, zeros shown as "-".
const CURRENCY_FMT = '#,##0;(#,##0);"-"';
const PCT_FMT = '0.0%;(0.0%);"-"';

// Change as a FRACTION for Excel's percent format (0.125 -> "12.5%").
// null => no prior revenue (shown as "N/A"); 0 => flat.
function pctFraction(cur, prev) {
  if (prev > 0) return (cur - prev) / prev;
  return cur > 0 ? null : 0;
}

// Apply a number format to a vertical run of cells in one column.
function formatColumn(ws, colIdx, firstRow, lastRow, fmt) {
  for (let r = firstRow; r <= lastRow; r++) {
    const addr = xlsx.utils.encode_cell({ r, c: colIdx });
    const cell = ws[addr];
    if (cell && cell.t === "n") cell.z = fmt; // only number cells
  }
}

// Build the "Monthly Summary" sheet: one row per month, current vs previous
// year, with the current-year stream breakdown and a totals row.
function buildSummarySheet(report) {
  const { year, previousYear, months: monthsLabel } = report.period;

  const header = [
    "Month",
    `OPD (₹) ${year}`,
    `IPD Billed (₹) ${year}`,
    `Pharmacy (₹) ${year}`,
    `Total (₹) ${year}`,
    `Total (₹) ${previousYear}`,
    "Change (₹)",
    "Change (%)",
    "IPD Collection (₹) ref",
  ];

  const aoa = [
    [`Monthwise Total Revenue — ${previousYear} vs ${year} (${monthsLabel})`],
    [],
    header,
  ];

  const rowFor = (label, cur, prev) => [
    label,
    cur.opd,
    cur.ipdInvoice,
    cur.pharmacy,
    cur.total,
    prev.total,
    cur.total - prev.total,
    pctFraction(cur.total, prev.total) ?? "N/A",
    cur.ipdCollection,
  ];

  report.months.forEach((m) =>
    aoa.push(rowFor(m.monthName, m.current, m.previous)),
  );
  aoa.push(
    rowFor(
      `Total (${monthsLabel})`,
      report.totals.current,
      report.totals.previous,
    ),
  );

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }];
  ws["!cols"] = [
    { wch: 18 },
    { wch: 15 },
    { wch: 17 },
    { wch: 14 },
    { wch: 15 },
    { wch: 15 },
    { wch: 13 },
    { wch: 11 },
    { wch: 20 },
  ];

  const firstDataRow = 3;
  const lastDataRow = firstDataRow + report.months.length; // includes total row
  [1, 2, 3, 4, 5, 6, 8].forEach((c) =>
    formatColumn(ws, c, firstDataRow, lastDataRow, CURRENCY_FMT),
  );
  formatColumn(ws, 7, firstDataRow, lastDataRow, PCT_FMT);

  return ws;
}

// Build a "By Location" matrix sheet for one year: rows = branch,
// columns = each month's total + a row total, plus a column-total row.
function buildLocationSheet(report, which /* 'current' | 'previous' */, yr) {
  const monthNames = report.months.map((m) => m.monthName);
  const header = ["Location", ...monthNames, `Total (₹) ${yr}`];

  const aoa = [
    [`Revenue by Location (₹) — ${yr} (${report.period.months})`],
    [],
    header,
  ];

  const locs = report.locationsRequested;
  const colSums = new Array(monthNames.length).fill(0);
  let grand = 0;

  locs.forEach((loc) => {
    const rows = report.byLocation[loc] || [];
    const vals = rows.map((r) => Number(r[which]?.total) || 0);
    const rowTotal = vals.reduce((a, b) => a + b, 0);
    vals.forEach((v, i) => (colSums[i] += v));
    grand += rowTotal;
    aoa.push([loc, ...vals, rowTotal]);
  });

  aoa.push(["Total", ...colSums, grand]);

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }];
  ws["!cols"] = [
    { wch: 22 },
    ...monthNames.map(() => ({ wch: 13 })),
    { wch: 15 },
  ];

  const firstDataRow = 3;
  const lastDataRow = firstDataRow + locs.length; // includes total row
  for (let c = 1; c < header.length; c++) {
    formatColumn(ws, c, firstDataRow, lastDataRow, CURRENCY_FMT);
  }

  return ws;
}

/**
 * Build a SheetJS workbook from an already-computed report object
 * (the return value of getMonthwiseRevenue). Kept separate so a workbook can
 * be produced from cached data without re-querying the database.
 */
function buildMonthwiseRevenueWorkbook(report) {
  const { year, previousYear } = report.period;
  const wb = xlsx.utils.book_new();

  xlsx.utils.book_append_sheet(
    wb,
    buildSummarySheet(report),
    "Monthly Summary",
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationSheet(report, "current", year),
    `By Location ${year}`,
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationSheet(report, "previous", previousYear),
    `By Location ${previousYear}`,
  );

  // Only add a notes sheet if some branch was skipped.
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

/**
 * Compute the month-wise revenue AND write it to an .xlsx in the /report
 * folder. Returns the file path (and the report data) so the caller can either
 * attach/stream the file or respond with JSON.
 */
async function generateMonthwiseRevenueExcel(locations, options = {}) {
  const report = await getMonthwiseRevenue(locations, options);
  const wb = buildMonthwiseRevenueWorkbook(report);

  const { year, previousYear, startMonth, endMonth } = report.period;
  const fileName =
    `Monthwise_Revenue_${year}_vs_${previousYear}_` +
    `${pad2(startMonth)}-${pad2(endMonth)}.xlsx`;
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

/* ===========================================================================
 * Express adapters
 * ======================================================================== */

// Pull `locations` (array OR comma-separated string) + optional overrides
// out of the request, matching the req-based signatures used elsewhere.
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

const getMonthwiseRevenueReport = async (req) => {
  const { locations, options } = extractParams(req);
  return getMonthwiseRevenue(locations, options);
};

const generateMonthwiseRevenueExcelHandler = async (req) => {
  const { locations, options } = extractParams(req);
  return generateMonthwiseRevenueExcel(locations, options);
};

module.exports = {
  getMonthwiseRevenue,
  getMonthwiseRevenueReport,
  buildMonthwiseRevenueWorkbook,
  generateMonthwiseRevenueExcel,
  generateMonthwiseRevenueExcelHandler,
};
