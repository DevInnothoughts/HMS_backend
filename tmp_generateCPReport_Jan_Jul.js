/**
 * tmp_generateCPReport_Jan_Jul.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * Month-wise, LOCATION-WISE C+P COUNT:
 *
 *      Jan–Jul 2026   vs   Jan–Jul 2025
 *
 * "C+P" is the label used on the admin dashboard card (src/admin/AdminHome.js),
 * which renders dashboardValues.dailyOPDReport.procto — i.e. the PROCTOSCOPY
 * count from patient_itemreceipt. The daily/OPD screens
 * (DailyOPDReport.js / OPDApproval.js) show the same number under the column
 * header 'PROCTOSCOPY'. Same figure, two labels.
 *
 * Like the new-patients script, there is NO existing month-wise model for this,
 * so this file is self-contained: it queries the branch DBs directly and builds
 * the workbook itself, mirroring the style of opdRevenueReportModel.js.
 *
 * ── Source query ────────────────────────────────────────────────────────────
 * Taken from dashboardModel.js's proctoscopyCountQuery (the RANGE variant —
 * dailyOPDModel.js has the same query bounded to a single day with item_date = ?):
 *
 *     SELECT COUNT(consultation) AS proctoscopy
 *     FROM patient_itemreceipt
 *     WHERE item_date >= ? AND item_date <= ?
 *       AND consultation = 'PROCTOSCOPY'
 *       AND is_deleted != 1
 *
 * This script keeps that filter EXACTLY and only adds MONTH(item_date) grouping,
 * so the totals reconcile with the dashboard card for the same date range.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  TWO THINGS TO CHECK BEFORE CIRCULATING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. EXACT STRING MATCH. The filter is consultation = 'PROCTOSCOPY'. Elsewhere
 *    in dailyOPDModel.js several consultation lookups defend against messy data
 *    with REPLACE(LOWER(consultation), ' ', '') — e.g. 'bloodtests+ecg',
 *    'sitzbath'. The proctoscopy query does NOT. MySQL's default collation is
 *    case-insensitive and ignores trailing spaces, so 'Proctoscopy ' still
 *    matches — but a variant like 'PROCTOSCOPY + CONSULTATION' or
 *    'PROCTO' would be silently EXCLUDED from the count.
 *
 *    Because this report spans 14 months rather than one day, any such variant
 *    accumulates. So the workbook includes a "Consultation Audit" sheet listing
 *    every distinct consultation value matching '%PROCTO%' with its row count,
 *    flagging which ones the C+P filter actually picks up. CHECK THAT SHEET. If
 *    it shows meaningful volume under a non-matching variant, the headline
 *    number is understated and you should widen the filter before sending.
 *
 * 2. ROWS, NOT PATIENTS. COUNT(consultation) counts itemreceipt ROWS, so a
 *    patient billed for two proctoscopies counts twice. That is what the
 *    dashboard does, so it stays as the headline. COUNT(DISTINCT patient_id) is
 *    computed alongside so you can see the gap.
 *
 * ── item_date ───────────────────────────────────────────────────────────────
 * A DATE column (same as the OPD report, which buckets on MONTH(item_date)),
 * so month boundaries are exact — no timezone drift.
 *
 * ── Place this file at the PROJECT ROOT ──────────────────────────────────────
 * (next to app.js / databaseUtils.js / dbconfig.js).
 *
 * ── Run ─────────────────────────────────────────────────────────────────────
 *   node tmp_generateCPReport_Jan_Jul.js
 *   node tmp_generateCPReport_Jan_Jul.js "Navi Mumbai,Andheri,Thane,Vashi"
 *   node tmp_generateCPReport_Jan_Jul.js "Andheri,Thane" 2026 1 7
 *
 * ── Output ──────────────────────────────────────────────────────────────────
 *   src/report/Monthwise_CP_2026_vs_2025_01-07.xlsx
 *
 * DELETE THIS FILE once the workbook has been generated.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");
const { getConnectionByLocation } = require("./databaseUtils");

/* ── Config ──────────────────────────────────────────────────────────────── */

// Same four branches, same order as the other Jan–Jun workbooks.
const DEFAULT_LOCATIONS = ["Andheri", "Navi Mumbai", "Thane", "Vashi"];

// The exact consultation value the dashboard counts as C+P.
const CP_CONSULTATION = "PROCTOSCOPY";

// Audit sheet: distinct consultation values matching this LIKE pattern, so you
// can spot near-miss spellings the exact-match filter drops.
const CP_AUDIT_PATTERN = "%PROCTO%";

const argLocations = (process.argv[2] || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const LOCATIONS = argLocations.length ? argLocations : DEFAULT_LOCATIONS;

const YEAR = Number(process.argv[3]) || 2026;
const PREVIOUS_YEAR = YEAR - 1;
const START_MONTH = Number(process.argv[4]) || 1;
const END_MONTH = Number(process.argv[5]) || 7; // ← July

/* ── Shared helpers (same conventions as the other report models) ─────────── */

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

/* ── SQL ─────────────────────────────────────────────────────────────────── */

// dashboardModel's proctoscopyCountQuery filter, verbatim, + month grouping.
// COUNT(consultation) is kept (not COUNT(*)) to match the source exactly.
const CP_SQL = `
  SELECT
    MONTH(item_date)           AS mon,
    COUNT(consultation)        AS cp_rows,
    COUNT(DISTINCT patient_id) AS cp_distinct,
    SUM(COALESCE(total, 0))    AS cp_revenue
  FROM patient_itemreceipt
  WHERE item_date >= ? AND item_date <= ?
    AND consultation = ?
    AND is_deleted != 1
  GROUP BY MONTH(item_date)
`;

// Audit: every distinct consultation spelling in the window that looks like a
// proctoscopy. Cheap, and the only way to know the exact match isn't leaking.
const CP_AUDIT_SQL = `
  SELECT
    consultation,
    COUNT(*)                AS rows_cnt,
    SUM(COALESCE(total, 0)) AS revenue
  FROM patient_itemreceipt
  WHERE item_date >= ? AND item_date <= ?
    AND is_deleted != 1
    AND consultation LIKE ?
  GROUP BY consultation
  ORDER BY rows_cnt DESC
`;

/* ── Per (location, year) fetch ──────────────────────────────────────────── */

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
  const end = `${year}-${pad2(lastM)}-${pad2(endDay)}`;

  const [rows, auditRows] = await Promise.all([
    run(CP_SQL, [start, end, CP_CONSULTATION]),
    run(CP_AUDIT_SQL, [start, end, CP_AUDIT_PATTERN]),
  ]);

  const monthTotals = {};
  for (const m of monthList) {
    monthTotals[m] = { count: 0, distinct: 0, revenue: 0 };
  }
  for (const r of rows) {
    const mon = Number(r.mon);
    if (!monthTotals[mon]) continue;
    monthTotals[mon].count += Number(r.cp_rows) || 0;
    monthTotals[mon].distinct += Number(r.cp_distinct) || 0;
    monthTotals[mon].revenue += Number(r.cp_revenue) || 0;
  }

  const audit = auditRows.map((r) => ({
    consultation: r.consultation,
    rows: Number(r.rows_cnt) || 0,
    revenue: round2(r.revenue),
    // MySQL's default collation is case-insensitive and ignores trailing
    // spaces, so mirror that when deciding whether the exact filter caught it.
    counted:
      String(r.consultation || "")
        .trim()
        .toUpperCase() === CP_CONSULTATION.toUpperCase(),
  }));

  return { monthTotals, audit };
}

/* ── Reducers ────────────────────────────────────────────────────────────── */

function emptyMonthTotals(monthList) {
  const m = {};
  for (const mm of monthList) m[mm] = { count: 0, distinct: 0, revenue: 0 };
  return m;
}

function mergeMonthTotals(agg, part, monthList) {
  for (const m of monthList) {
    agg[m].count += part.monthTotals[m].count;
    agg[m].distinct += part.monthTotals[m].distinct;
    agg[m].revenue += part.monthTotals[m].revenue;
  }
}

function windowTotals(monthTotals, monthList) {
  return monthList.reduce(
    (a, m) => {
      a.count += monthTotals[m].count;
      a.distinct += monthTotals[m].distinct;
      a.revenue += monthTotals[m].revenue;
      return a;
    },
    { count: 0, distinct: 0, revenue: 0 },
  );
}

function monthlyArray(monthTotals, monthList) {
  return monthList.map((m) => ({
    month: m,
    monthName: MONTH_NAMES[m - 1],
    count: monthTotals[m].count,
    distinct: monthTotals[m].distinct,
    revenue: round2(monthTotals[m].revenue),
  }));
}

const zeroMonthly = (monthList) =>
  monthList.map((m) => ({
    month: m,
    monthName: MONTH_NAMES[m - 1],
    count: 0,
    distinct: 0,
    revenue: 0,
  }));

/* ── Main data build ─────────────────────────────────────────────────────── */

async function getMonthwiseCP(locations, options = {}) {
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
  const auditRows = [];

  async function collect(loc, yr) {
    if (failed.has(loc)) return;
    try {
      const part = await collectLocationYear(loc, yr, monthList);
      mergeMonthTotals(aggByYear[yr], part, monthList);
      perLoc[loc][yr] = part;
      part.audit.forEach((a) => auditRows.push({ location: loc, year: yr, ...a }));
    } catch (e) {
      failed.add(loc);
      failures.push({ location: loc, error: e?.message || String(e) });
    }
  }

  // Two queries per (branch, year), parallel across branches — fast.
  for (const yr of [year, previousYear]) {
    await Promise.all(locations.map((loc) => collect(loc, yr)));
  }

  const aggY = aggByYear[year];
  const aggP = aggByYear[previousYear];

  const shape = (b, yr) => ({
    year: yr,
    count: b.count,
    distinct: b.distinct,
    revenue: round2(b.revenue),
  });
  const changeOf = (c, p) => ({
    count: { amount: c.count - p.count, pct: pctChange(c.count, p.count) },
    revenue: {
      amount: round2(c.revenue - p.revenue),
      pct: pctChange(c.revenue, p.revenue),
    },
  });

  const months = monthList.map((m) => ({
    month: m,
    monthName: MONTH_NAMES[m - 1],
    current: shape(aggY[m], year),
    previous: shape(aggP[m], previousYear),
    change: changeOf(aggY[m], aggP[m]),
  }));

  const cT = windowTotals(aggY, monthList);
  const pT = windowTotals(aggP, monthList);
  const totals = {
    current: shape(cT, year),
    previous: shape(pT, previousYear),
    change: changeOf(cT, pT),
  };

  const byLocation = locations
    .map((loc) => {
      const cur = perLoc[loc][year];
      const prev = perLoc[loc][previousYear];
      if (!cur && !prev) return null;
      const z = { count: 0, distinct: 0, revenue: 0 };
      const cWin = cur ? windowTotals(cur.monthTotals, monthList) : z;
      const pWin = prev ? windowTotals(prev.monthTotals, monthList) : z;
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
    .filter(Boolean);
  // Order preserved (not sorted by size) so rows line up with the other reports.

  // Audit: sort so uncounted variants surface at the top, biggest first.
  auditRows.sort(
    (a, b) =>
      Number(a.counted) - Number(b.counted) ||
      b.rows - a.rows ||
      a.location.localeCompare(b.location),
  );
  const missedRows = auditRows
    .filter((a) => !a.counted)
    .reduce((s, a) => s + a.rows, 0);

  return {
    generatedAt: new Date().toISOString(),
    definition:
      `C+P = patient_itemreceipt rows with consultation = '${CP_CONSULTATION}' ` +
      `and is_deleted != 1, bucketed by MONTH(item_date). Filter copied from ` +
      `dashboardModel.proctoscopyCountQuery; the admin dashboard shows this ` +
      `same figure on the card labelled "C+P".`,
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
    audit: auditRows,
    missedRows,
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
      title: `Monthly C+P Count — ${P} vs ${Y} (${ML})`,
      totalLabel: `Total (${ML})`,
      w: 16,
    },
    location: {
      first: "Location",
      rows: report.byLocation,
      label: (r) => r.location,
      title: `C+P Count by Location — ${P} vs ${Y} (${ML})`,
      totalLabel: "Grand Total",
      w: 22,
    },
  }[kind];

  const header = [
    cfg.first,
    `C+P ${Y}`,
    `C+P ${P}`,
    "Δ",
    "Δ (%)",
    `Distinct Patients ${Y}`,
    `Distinct Patients ${P}`,
    `Revenue (₹) ${Y}`,
    `Revenue (₹) ${P}`,
  ];
  const aoa = [
    [cfg.title],
    [`consultation = '${CP_CONSULTATION}' — dashboard "C+P" card`],
    header,
  ];

  const rowFor = (label, c, p) => [
    label,
    c.count,
    p.count,
    c.count - p.count,
    pctFraction(c.count, p.count) ?? "N/A",
    c.distinct,
    p.distinct,
    c.revenue,
    p.revenue,
  ];

  const t = { cc: 0, pc: 0, cd: 0, pd: 0, cr: 0, pr: 0 };
  cfg.rows.forEach((r) => {
    aoa.push(rowFor(cfg.label(r), r.current, r.previous));
    t.cc += r.current.count;
    t.pc += r.previous.count;
    t.cd += r.current.distinct;
    t.pd += r.previous.distinct;
    t.cr += r.current.revenue;
    t.pr += r.previous.revenue;
  });
  aoa.push(
    rowFor(
      cfg.totalLabel,
      { count: t.cc, distinct: t.cd, revenue: round2(t.cr) },
      { count: t.pc, distinct: t.pd, revenue: round2(t.pr) },
    ),
  );

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: header.length - 1 } },
  ];
  ws["!cols"] = [
    { wch: cfg.w },
    { wch: 12 },
    { wch: 12 },
    { wch: 10 },
    { wch: 10 },
    { wch: 19 },
    { wch: 19 },
    { wch: 16 },
    { wch: 16 },
  ];

  const fr = 3;
  const lr = 3 + cfg.rows.length;
  [1, 2, 3, 5, 6, 7, 8].forEach((c) => formatColumn(ws, c, fr, lr, NUM_FMT));
  formatColumn(ws, 4, fr, lr, PCT_FMT);
  return ws;
}

function buildLocationMonthSheet(
  report,
  metric /* 'count' | 'revenue' */,
  which /* 'current' | 'previous' */,
  yr,
) {
  const monthNames = report.period.monthNames;
  const isRev = metric === "revenue";
  const title =
    `${isRev ? "C+P Revenue (₹)" : "C+P Count"} ` +
    `by Location × Month — ${yr} (${report.period.months})`;
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
    aoa.push([loc.location, ...vals, round2(rowTotal)]);
  });
  aoa.push(["Grand Total", ...colSums.map(round2), round2(grand)]);

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

// The sheet to actually look at before sending the file.
function buildAuditSheet(report) {
  const aoa = [
    [`Consultation values matching '${CP_AUDIT_PATTERN}' — data-quality check`],
    [
      `Rows marked "NO" are NOT in the C+P totals because the filter is an ` +
        `exact match on '${CP_CONSULTATION}'. If any of those show real volume, ` +
        `the headline count is understated.`,
    ],
    [],
    ["Location", "Year", "Consultation value", "Rows", "Revenue (₹)", "Counted in C+P?"],
  ];

  report.audit.forEach((a) => {
    aoa.push([
      a.location,
      a.year,
      a.consultation,
      a.rows,
      a.revenue,
      a.counted ? "YES" : "NO",
    ]);
  });

  if (!report.audit.length) {
    aoa.push(["—", "—", "(no matching consultation values found)", 0, 0, "—"]);
  }

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 5 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 5 } },
  ];
  ws["!cols"] = [
    { wch: 18 },
    { wch: 8 },
    { wch: 40 },
    { wch: 10 },
    { wch: 14 },
    { wch: 16 },
  ];
  const fr = 4;
  const lr = 4 + Math.max(report.audit.length, 1) - 1;
  [3, 4].forEach((c) => formatColumn(ws, c, fr, lr, NUM_FMT));
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
    buildLocationMonthSheet(report, "count", "current", year),
    `C+P by Loc ${year}`,
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationMonthSheet(report, "count", "previous", previousYear),
    `C+P by Loc ${previousYear}`,
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationMonthSheet(report, "revenue", "current", year),
    `C+P Rev by Loc ${year}`,
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationMonthSheet(report, "revenue", "previous", previousYear),
    `C+P Rev by Loc ${previousYear}`,
  );
  xlsx.utils.book_append_sheet(wb, buildAuditSheet(report), "Consultation Audit");

  const notes = [
    ["C+P report — definition"],
    [],
    ["Definition", report.definition],
    ["Dashboard label", `AdminHome.js card "C+P" → dailyOPDReport.procto`],
    ["Other label", `DailyOPDReport.js / OPDApproval.js column "PROCTOSCOPY"`],
    [],
    ["SQL WHERE clause", "item_date >= ? AND item_date <= ?"],
    ["", `AND consultation = '${CP_CONSULTATION}'`],
    ["", "AND is_deleted != 1"],
    ["", "bucketed on MONTH(item_date)"],
    [],
    [
      "Counting",
      "COUNT(consultation) counts itemreceipt ROWS, so a patient billed twice " +
        "counts twice — this matches the dashboard. Distinct patient_id is " +
        "shown alongside for reference.",
    ],
    [
      "Caveat",
      "Exact string match. Variant spellings are excluded — see the " +
        "'Consultation Audit' sheet before relying on these totals.",
    ],
    ["Generated at", report.generatedAt],
  ];
  const nws = xlsx.utils.aoa_to_sheet(notes);
  nws["!cols"] = [{ wch: 20 }, { wch: 95 }];
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
  const num = (n) => Number(n || 0).toLocaleString("en-IN");

  console.log("──────────────────────────────────────────────────────────");
  console.log("Month-wise C+P (Proctoscopy) Report (temporary runner)");
  console.log(`Window   : ${START_MONTH}–${END_MONTH} | ${YEAR} vs ${PREVIOUS_YEAR}`);
  console.log(`Branches : ${LOCATIONS.join(", ")}`);
  console.log(`Filter   : consultation = '${CP_CONSULTATION}', is_deleted != 1`);
  console.log("──────────────────────────────────────────────────────────");

  try {
    const report = await getMonthwiseCP(LOCATIONS, {
      year: YEAR,
      previousYear: PREVIOUS_YEAR,
      startMonth: START_MONTH,
      endMonth: END_MONTH,
    });

    const wb = buildWorkbook(report);
    const fileName =
      `Monthwise_CP_${YEAR}_vs_${PREVIOUS_YEAR}_` +
      `${pad2(START_MONTH)}-${pad2(END_MONTH)}.xlsx`;
    const filePath = path.join(reportsDir, fileName);
    xlsx.writeFile(wb, filePath);

    const { current, previous, change } = report.totals;

    console.log(`\n✅ Workbook written: ${filePath}`);

    console.log(`\nTotals (${report.period.months}) — ${YEAR} vs ${PREVIOUS_YEAR}:`);
    console.log(
      `   C+P count         : ${num(current.count).padStart(9)}  vs ` +
        `${num(previous.count).padStart(9)}   ` +
        `(${change.count.pct === null ? "N/A" : change.count.pct + "%"})`,
    );
    console.log(
      `   Distinct patients : ${num(current.distinct).padStart(9)}  vs ` +
        `${num(previous.distinct).padStart(9)}`,
    );
    console.log(
      `   Revenue ₹         : ${num(Math.round(current.revenue)).padStart(9)}  vs ` +
        `${num(Math.round(previous.revenue)).padStart(9)}`,
    );

    console.log("\nMonth-wise C+P:");
    report.months.forEach((m) => {
      console.log(
        `   ${m.monthName.padEnd(10)} ${num(m.current.count).padStart(8)}` +
          `  vs ${num(m.previous.count).padStart(8)}`,
      );
    });

    // The check worth surfacing loudly — a silent exact-match miss is the most
    // likely way this report is wrong.
    if (report.missedRows > 0) {
      console.warn(
        `\n⚠️  DATA-QUALITY WARNING: ${num(report.missedRows)} row(s) matched ` +
          `'${CP_AUDIT_PATTERN}' but NOT the exact filter '${CP_CONSULTATION}', ` +
          `so they are EXCLUDED from the counts above:`,
      );
      report.audit
        .filter((a) => !a.counted)
        .slice(0, 15)
        .forEach((a) =>
          console.warn(
            `   • ${a.location} ${a.year}: "${a.consultation}" — ${num(a.rows)} rows`,
          ),
        );
      console.warn(
        `   → Review the 'Consultation Audit' sheet and decide whether to ` +
          `widen CP_CONSULTATION before circulating this file.`,
      );
    } else {
      console.log(
        `\n✓ No near-miss consultation spellings found — exact filter looks clean.`,
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
    console.error("\n❌ C+P report failed:", err?.message || err);
    console.error(err?.stack || "");
    process.exit(1);
  }
})();
