/**
 * tmp_generateNewPatientsReport_Jan_Jul.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * Month-wise, LOCATION-WISE NEW PATIENT COUNT:
 *
 *      Jan–Jul 2026   vs   Jan–Jul 2025
 *
 * Unlike the surgery / OPD / revenue runners, there is NO existing model for
 * this — no monthwiseNewPatientsModel exists in src/models. So this file is
 * self-contained: it queries the branch DBs directly and builds the workbook
 * itself, deliberately mirroring the structure and SheetJS style of
 * opdRevenueReportModel.js so the output looks like the other three reports.
 *
 * If this report is wanted permanently, lift the SQL + builders out of here
 * into src/models/newPatientsReportModel.js and reduce this file to a runner.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  READ THIS BEFORE CIRCULATING THE NUMBERS — "new patient" is not one thing
 * ═══════════════════════════════════════════════════════════════════════════
 * The codebase counts new patients THREE different ways:
 *
 *   (A) targetComparisonModel.getNewPatientCount, targetComparisonNewModel,
 *       dailyOPDModel, dashboardModel:
 *           patient_type='New' AND is_deleted!=1 AND executivechk=2
 *
 *   (B) DoctorPerformanceModel:
 *           (A) + AND confirm_time != '0'
 *       (its comment claims parity with Target Comparison, but the extra
 *        confirm_time clause means it does NOT match — (B) <= (A).)
 *
 *   (C) performanceModel:
 *           patient_type='New' AND is_deleted!=1 AND confirm_time!='0'
 *           (no executivechk)
 *
 * This script defaults to (A), because that is what the Target Comparison
 * screen shows management as "New Patients" — so these figures reconcile with
 * that dashboard. Flip REQUIRE_CONFIRM_TIME to true to get definition (B),
 * i.e. only patients who actually showed up.
 *
 * The two will NOT agree. Decide which one you are reporting BEFORE sending
 * the file, and say so in the covering mail — otherwise someone will diff it
 * against the Target Comparison screen and raise a query.
 *
 * ── Counting note ───────────────────────────────────────────────────────────
 * Definition (A) uses COUNT(patient_type) — it counts appointment ROWS, so one
 * patient with two 'New' rows in a month counts twice. That is what Target
 * Comparison does, so it is kept as the headline figure for reconciliation.
 * COUNT(DISTINCT patient_id) is ALSO computed and written to its own sheet, so
 * you can see how far apart the two are. If the gap is large on any branch,
 * that branch likely has duplicate registrations worth investigating.
 *
 * ── Date column ─────────────────────────────────────────────────────────────
 * appointment_timestamp is a DATE column (Target Comparison bounds it with a
 * plain date BETWEEN), so month boundaries are exact — no timezone handling.
 *
 * ── Place this file at the PROJECT ROOT ──────────────────────────────────────
 * (next to app.js / databaseUtils.js / dbconfig.js).
 *
 * ── Run ─────────────────────────────────────────────────────────────────────
 *   node tmp_generateNewPatientsReport_Jan_Jul.js
 *   node tmp_generateNewPatientsReport_Jan_Jul.js "Navi Mumbai,Andheri,Thane,Vashi"
 *   node tmp_generateNewPatientsReport_Jan_Jul.js "Andheri,Thane" 2026 1 7
 *
 * ── Output ──────────────────────────────────────────────────────────────────
 *   src/report/Monthwise_NewPatients_2026_vs_2025_01-07.xlsx
 *
 * DELETE THIS FILE once the workbook has been generated.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");
const { getConnectionByLocation } = require("../databaseUtils");

/* ── Config ──────────────────────────────────────────────────────────────── */

// Same four branches as the other Jan–Jun workbooks, same order.
const DEFAULT_LOCATIONS = ["Andheri", "Navi Mumbai", "Thane", "Vashi"];

// false → definition (A), matches the Target Comparison screen  [DEFAULT]
// true  → definition (B), only patients who actually turned up
const REQUIRE_CONFIRM_TIME = false;

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

// Mirrors the other models: they write to src/report from src/models via
// ("..", "report"). This file lives at the root, so it's ("src", "report").
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

// Change as a FRACTION for Excel's percent format. null => "N/A".
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

// Definition (A) by default; the confirm_time line is appended only when
// REQUIRE_CONFIRM_TIME is on, so the default query is byte-for-byte the
// Target Comparison filter plus the month grouping.
const NEW_PATIENT_SQL = `
  SELECT
    MONTH(appointment_timestamp) AS mon,
    COUNT(patient_type)          AS new_rows,
    COUNT(DISTINCT patient_id)   AS new_distinct
  FROM appointment
  WHERE appointment_timestamp >= ? AND appointment_timestamp <= ?
    AND patient_type = 'New'
    AND is_deleted != 1
    AND executivechk = 2
    ${REQUIRE_CONFIRM_TIME ? "AND confirm_time != '0'" : ""}
  GROUP BY MONTH(appointment_timestamp)
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

  const rows = await run(NEW_PATIENT_SQL, [start, end]);

  const monthTotals = {};
  for (const m of monthList) monthTotals[m] = { count: 0, distinct: 0 };
  for (const r of rows) {
    const mon = Number(r.mon);
    if (!monthTotals[mon]) continue;
    monthTotals[mon].count += Number(r.new_rows) || 0;
    monthTotals[mon].distinct += Number(r.new_distinct) || 0;
  }
  return { monthTotals };
}

/* ── Reducers ────────────────────────────────────────────────────────────── */

function emptyMonthTotals(monthList) {
  const m = {};
  for (const mm of monthList) m[mm] = { count: 0, distinct: 0 };
  return m;
}

function mergeMonthTotals(agg, part, monthList) {
  for (const m of monthList) {
    agg[m].count += part.monthTotals[m].count;
    agg[m].distinct += part.monthTotals[m].distinct;
  }
}

function windowTotals(monthTotals, monthList) {
  return monthList.reduce(
    (a, m) => {
      a.count += monthTotals[m].count;
      a.distinct += monthTotals[m].distinct;
      return a;
    },
    { count: 0, distinct: 0 },
  );
}

function monthlyArray(monthTotals, monthList) {
  return monthList.map((m) => ({
    month: m,
    monthName: MONTH_NAMES[m - 1],
    count: monthTotals[m].count,
    distinct: monthTotals[m].distinct,
  }));
}

const zeroMonthly = (monthList) =>
  monthList.map((m) => ({
    month: m,
    monthName: MONTH_NAMES[m - 1],
    count: 0,
    distinct: 0,
  }));

/* ── Main data build ─────────────────────────────────────────────────────── */

async function getMonthwiseNewPatients(locations, options = {}) {
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

  // One query per (branch, year); parallel across branches. Same shape as the
  // OPD model, so this is fast — 2 round trips per branch.
  for (const yr of [year, previousYear]) {
    await Promise.all(locations.map((loc) => collect(loc, yr)));
  }

  const aggY = aggByYear[year];
  const aggP = aggByYear[previousYear];

  const shape = (b, yr) => ({ year: yr, count: b.count, distinct: b.distinct });
  const changeOf = (c, p) => ({
    count: { amount: c.count - p.count, pct: pctChange(c.count, p.count) },
    distinct: {
      amount: c.distinct - p.distinct,
      pct: pctChange(c.distinct, p.distinct),
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
      const cWin = cur
        ? windowTotals(cur.monthTotals, monthList)
        : { count: 0, distinct: 0 };
      const pWin = prev
        ? windowTotals(prev.monthTotals, monthList)
        : { count: 0, distinct: 0 };
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
  // NB: order preserved (not sorted by size), matching the revenue report, so
  // rows line up with the other workbooks for the same branch list.

  return {
    generatedAt: new Date().toISOString(),
    definition:
      `New patient = appointment row with patient_type='New', is_deleted!=1, ` +
      `executivechk=2` +
      (REQUIRE_CONFIRM_TIME ? `, confirm_time!='0'` : ``) +
      `, bucketed by MONTH(appointment_timestamp). Headline figure counts ROWS ` +
      `(matches Target Comparison); distinct patient_id is reported separately.`,
    filter: REQUIRE_CONFIRM_TIME
      ? "(B) DoctorPerformanceModel — confirmed visits only"
      : "(A) Target Comparison — all booked new appointments",
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

/* ── Excel builders ──────────────────────────────────────────────────────── */

// Comparison sheet shared by Month / Location.
function buildComparisonSheet(report, kind /* 'month' | 'location' */) {
  const { year: Y, previousYear: P, months: ML } = report.period;
  const cfg = {
    month: {
      first: "Month",
      rows: report.months,
      label: (r) => r.monthName,
      title: `Monthly New Patients — ${P} vs ${Y} (${ML})`,
      totalLabel: `Total (${ML})`,
      w: 16,
    },
    location: {
      first: "Location",
      rows: report.byLocation,
      label: (r) => r.location,
      title: `New Patients by Location — ${P} vs ${Y} (${ML})`,
      totalLabel: "Grand Total",
      w: 22,
    },
  }[kind];

  const header = [
    cfg.first,
    `New Patients ${Y}`,
    `New Patients ${P}`,
    "Δ",
    "Δ (%)",
    `Distinct Patients ${Y}`,
    `Distinct Patients ${P}`,
  ];
  const aoa = [[cfg.title], [report.filter], header];

  const rowFor = (label, c, p) => [
    label,
    c.count,
    p.count,
    c.count - p.count,
    pctFraction(c.count, p.count) ?? "N/A",
    c.distinct,
    p.distinct,
  ];

  const t = { cc: 0, pc: 0, cd: 0, pd: 0 };
  cfg.rows.forEach((r) => {
    aoa.push(rowFor(cfg.label(r), r.current, r.previous));
    t.cc += r.current.count;
    t.pc += r.previous.count;
    t.cd += r.current.distinct;
    t.pd += r.previous.distinct;
  });
  aoa.push(
    rowFor(
      cfg.totalLabel,
      { count: t.cc, distinct: t.cd },
      { count: t.pc, distinct: t.pd },
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
    { wch: 10 },
    { wch: 10 },
    { wch: 19 },
    { wch: 19 },
  ];

  const fr = 3;
  const lr = 3 + cfg.rows.length;
  [1, 2, 3, 5, 6].forEach((c) => formatColumn(ws, c, fr, lr, NUM_FMT));
  formatColumn(ws, 4, fr, lr, PCT_FMT);
  return ws;
}

// Location × Month matrix for one year.
function buildLocationMonthSheet(
  report,
  metric /* 'count' | 'distinct' */,
  which /* 'current' | 'previous' */,
  yr,
) {
  const monthNames = report.period.monthNames;
  const isDistinct = metric === "distinct";
  const title =
    `${isDistinct ? "Distinct New Patients" : "New Patients"} ` +
    `by Location × Month — ${yr} (${report.period.months})`;
  const header = ["Location", ...monthNames, "Total"];
  const aoa = [[title], [], header];
  const key = which === "current" ? "monthlyCurrent" : "monthlyPrevious";

  const colSums = new Array(monthNames.length).fill(0);
  let grand = 0;
  report.byLocation.forEach((loc) => {
    const vals = loc[key].map(
      (mm) => (isDistinct ? mm.distinct : mm.count) || 0,
    );
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
    `New Pat by Loc ${year}`,
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationMonthSheet(report, "count", "previous", previousYear),
    `New Pat by Loc ${previousYear}`,
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationMonthSheet(report, "distinct", "current", year),
    `Distinct by Loc ${year}`,
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationMonthSheet(report, "distinct", "previous", previousYear),
    `Distinct by Loc ${previousYear}`,
  );

  // Definition sheet — this report has a genuine ambiguity, so ship the
  // definition inside the file rather than relying on the covering mail.
  const notes = [
    ["New Patients report — definition"],
    [],
    ["Filter applied", report.filter],
    ["Definition", report.definition],
    [],
    ["SQL WHERE clause", "patient_type = 'New'"],
    ["", "AND is_deleted != 1"],
    ["", "AND executivechk = 2"],
    ...(REQUIRE_CONFIRM_TIME ? [["", "AND confirm_time != '0'"]] : []),
    ["", "bucketed on MONTH(appointment_timestamp)"],
    [],
    [
      "Note",
      "Headline count is appointment ROWS (COUNT(patient_type)), matching " +
        "targetComparisonModel. Distinct patient_id is on its own sheets; a " +
        "large gap on a branch suggests duplicate registrations.",
    ],
    ["Generated at", report.generatedAt],
  ];
  const nws = xlsx.utils.aoa_to_sheet(notes);
  nws["!cols"] = [{ wch: 20 }, { wch: 90 }];
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
  console.log("Month-wise New Patients Report (temporary runner)");
  console.log(
    `Window   : ${START_MONTH}–${END_MONTH} | ${YEAR} vs ${PREVIOUS_YEAR}`,
  );
  console.log(`Branches : ${LOCATIONS.join(", ")}`);
  console.log(
    `Filter   : ${
      REQUIRE_CONFIRM_TIME
        ? "(B) confirmed visits only — confirm_time != '0'"
        : "(A) Target Comparison parity — all booked new appointments"
    }`,
  );
  console.log("──────────────────────────────────────────────────────────");

  try {
    const report = await getMonthwiseNewPatients(LOCATIONS, {
      year: YEAR,
      previousYear: PREVIOUS_YEAR,
      startMonth: START_MONTH,
      endMonth: END_MONTH,
    });

    const wb = buildWorkbook(report);
    const fileName =
      `Monthwise_NewPatients_${YEAR}_vs_${PREVIOUS_YEAR}_` +
      `${pad2(START_MONTH)}-${pad2(END_MONTH)}.xlsx`;
    const filePath = path.join(reportsDir, fileName);
    xlsx.writeFile(wb, filePath);

    const { current, previous, change } = report.totals;

    console.log(`\n✅ Workbook written: ${filePath}`);

    console.log(
      `\nTotals (${report.period.months}) — ${YEAR} vs ${PREVIOUS_YEAR}:`,
    );
    console.log(
      `   New Patients      : ${num(current.count).padStart(9)}  vs ` +
        `${num(previous.count).padStart(9)}   ` +
        `(${change.count.pct === null ? "N/A" : change.count.pct + "%"})`,
    );
    console.log(
      `   Distinct patients : ${num(current.distinct).padStart(9)}  vs ` +
        `${num(previous.distinct).padStart(9)}`,
    );

    const gap = current.count - current.distinct;
    if (gap > 0) {
      console.log(
        `   ⓘ ${num(gap)} repeat 'New' rows in ${YEAR} ` +
          `(${((gap / current.count) * 100).toFixed(1)}% of the headline count).`,
      );
    }

    console.log("\nMonth-wise new patients:");
    report.months.forEach((m) => {
      console.log(
        `   ${m.monthName.padEnd(10)} ${num(m.current.count).padStart(8)}` +
          `  vs ${num(m.previous.count).padStart(8)}`,
      );
    });

    if (report.locationsFailed?.length) {
      console.warn("\n⚠️  Skipped branches (see 'Skipped Locations' sheet):");
      report.locationsFailed.forEach((f) =>
        console.warn(`   • ${f.location}: ${f.error}`),
      );
    }

    console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exit(0);
  } catch (err) {
    console.error("\n❌ New patients report failed:", err?.message || err);
    console.error(err?.stack || "");
    process.exit(1);
  }
})();
