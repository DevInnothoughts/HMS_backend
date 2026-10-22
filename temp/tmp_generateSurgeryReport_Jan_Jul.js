/**
 * tmp_generateSurgeryReport_Jan_Jul.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * One-off runner for the month-wise surgery report (current year vs previous),
 * NET OF INTERBRANCH. The shared model (src/models/surgeryRevenueReportModel)
 * is NOT modified — the rule is applied entirely from this script.
 *
 * ── Interbranch rule (src/models/utils/interbranch.js → countedSql) ─────────
 * An interbranch surgery (OPD at source branch A, operated at branch B) has the
 * SAME invoice in both branch DBs. It counts ONLY at the SOURCE branch:
 *   source copy    (interbranch_id <> 0, patient_location = 'B') → counted
 *   operating copy (interbranch_id = 0/NULL, patient_location = 'A') → excluded
 *   patient_location 'DP Road' (always an operating branch) → always counted
 *
 * ── How it is applied ───────────────────────────────────────────────────────
 * 1. NET: getConnectionByLocation is wrapped for this process only, so the
 *    model's invoice query gets `AND <countedSql>` appended. Every model figure
 *    (month, type, location, sub-type) is then net — operating-branch copies
 *    never reach it. If the model's invoice SQL ever changes shape, the script
 *    STOPS instead of silently producing gross numbers.
 * 2. EXCLUDED: one query per branch per year lists what the rule left out,
 *    per month, on the model's own definition (one patient-month = one surgery):
 *      excluded surgeries = patient-months whose invoices are ALL excluded
 *      excluded revenue   = SUM(totalamt) of the excluded invoices
 *    So, per branch per month, gross = net + excluded EXACTLY.
 * 3. PREVIOUS-YEAR LOCATION SHEETS: the model writes the "Surg/Rev by Loc-…"
 *    sheets for the current year only. The script runs the model a second time
 *    with the previous year as "current" (same patch → also net), takes those
 *    sheets from that run, and inserts each one right after its current-year
 *    counterpart. Sheet names get a year suffix so both years sit side by side.
 *
 * ── Workbook (same layout as the gross file, plus) ──────────────────────────
 *   Monthly Totals / Location Summary   + IB excl. surgeries & ₹, both years
 *   By Surgery Type                     net (excluded cases carry no type)
 *   Surg/Rev by Loc-Month <Y> and <P>   net, one sheet per year
 *   Surg/Rev by Loc-Type  <Y> and <P>   net, one sheet per year
 *   Interbranch <year> (×2, new)        branch × month: excluded # and ₹
 *   Interbranch Warnings (only if any)  branches whose excluded lookup failed
 *
 * ── Run (from the backend root) ─────────────────────────────────────────────
 *   node temp/tmp_generateSurgeryReport_Jan_Jul.js
 *   node temp/tmp_generateSurgeryReport_Jan_Jul.js "Navi Mumbai,Andheri,Thane,Vashi,Kalyan" 2026 1 9
 *        args: <locations> <year> <startMonth> <endMonth>
 *        (location strings must match getConnectionByLocation keys)
 *
 * ── Output ──────────────────────────────────────────────────────────────────
 *   src/report/Monthwise_Surgeries_<Y>_vs_<P>_<MM>-<MM>_IPDnet.xlsx
 *   (_IPDnet marks the interbranch-adjusted file; it never overwrites a gross one)
 *
 * DELETE THIS FILE once the workbook has been generated.
 * ---------------------------------------------------------------------------
 */

const path = require("path");
const xlsx = require("xlsx");
const databaseUtils = require("../databaseUtils");
const { countedSql } = require("../src/models/utils/interbranch");

/* ── Config ──────────────────────────────────────────────────────────────── */

// Keep the strings exactly as getConnectionByLocation expects them.
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

const OPTIONS = {
  year: Number(process.argv[3]) || 2026,
  previousYear: Number(process.argv[3]) ? Number(process.argv[3]) - 1 : 2025,
  startMonth: Number(process.argv[4]) || 1,
  endMonth: Number(process.argv[5]) || 9,
};

/* ── 1. NET: inject the interbranch rule into the model's invoice query ──── */

// Matches the model's INVOICE_SQL WHERE clause (surgeryRevenueReportModel.js).
const INVOICE_WHERE_RE =
  /FROM\s+invoice\s+WHERE\s+creation_date\s*>=\s*\?\s+AND\s+creation_date\s*<=\s*\?\s+AND\s+is_deleted\s*!=\s*1/i;

let invoiceQueriesPatched = 0;

const origGetConnection = databaseUtils.getConnectionByLocation;
databaseUtils.getConnectionByLocation = (loc) => {
  const res = origGetConnection(loc);
  if (!res || !res.connection) return res;
  const conn = res.connection;
  const wrapped = {
    query(sql, params, cb) {
      if (typeof sql === "string" && /FROM\s+invoice\b/i.test(sql)) {
        if (!INVOICE_WHERE_RE.test(sql)) {
          const err = new Error(
            "Interbranch patch: the model's invoice SQL changed shape — " +
              "update INVOICE_WHERE_RE in this script (refusing to report gross).",
          );
          return cb(err);
        }
        sql = sql.replace(
          INVOICE_WHERE_RE,
          (m) => `${m}\n    AND (${countedSql("invoice")})`,
        );
        invoiceQueriesPatched += 1;
      }
      return conn.query(sql, params, cb);
    },
  };
  return { ...res, connection: wrapped };
};

// Required AFTER the patch (the model looks the helper up at call time anyway).
const {
  getMonthwiseSurgeryReport,
  buildMonthwiseSurgeryWorkbook,
} = require("../src/models/surgeryRevenueReportModel");

/* ── 2. EXCLUDED: what the rule left out, per branch per month ───────────── */

const IB_SQL = `
  SELECT x.mon,
         SUM(CASE WHEN x.cnt = 0 THEN 1 ELSE 0 END) AS surgeries,
         COALESCE(SUM(x.ibAmt), 0)                  AS revenue
    FROM (
      SELECT i.patient_id,
             MONTH(i.creation_date) AS mon,
             SUM(CASE WHEN ${countedSql("i")} THEN 1 ELSE 0 END)                       AS cnt,
             SUM(CASE WHEN ${countedSql("i")} THEN 0 ELSE 1 END)                       AS ibCnt,
             SUM(CASE WHEN ${countedSql("i")} THEN 0 ELSE COALESCE(i.totalamt, 0) END) AS ibAmt
        FROM invoice i
       WHERE i.creation_date >= ? AND i.creation_date <= ?
         AND i.is_deleted != 1
       GROUP BY i.patient_id, MONTH(i.creation_date)
    ) x
   WHERE x.ibCnt > 0
   GROUP BY x.mon
`;

const pad2 = (n) => String(n).padStart(2, "0");
const round2 = (n) =>
  Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

function windowBounds(year, startMonth, endMonth) {
  const endDay = new Date(year, endMonth, 0).getDate();
  return [
    `${year}-${pad2(startMonth)}-01 00:00:00`,
    `${year}-${pad2(endMonth)}-${pad2(endDay)} 23:59:59`,
  ];
}

/** → { byLoc: { [loc]: { [year]: { [month]: {surgeries, revenue} } } }, failures } */
async function getInterbranchExcluded(report) {
  const { year, previousYear, startMonth, endMonth } = report.period;
  const skip = new Set(report.locationsFailed.map((f) => f.location));
  const byLoc = {};
  const failures = [];

  await Promise.all(
    report.locationsRequested.map(async (loc) => {
      if (skip.has(loc)) return;
      byLoc[loc] = {};
      try {
        const { connection } = origGetConnection(loc);
        if (!connection) throw new Error("invalid location");
        for (const yr of [year, previousYear]) {
          const rows = await new Promise((res, rej) =>
            connection.query(
              IB_SQL,
              windowBounds(yr, startMonth, endMonth),
              (e, r) => (e ? rej(e) : res(r)),
            ),
          );
          byLoc[loc][yr] = {};
          for (const r of rows)
            byLoc[loc][yr][Number(r.mon)] = {
              surgeries: Number(r.surgeries) || 0,
              revenue: Number(r.revenue) || 0,
            };
        }
      } catch (e) {
        delete byLoc[loc];
        failures.push({ location: loc, error: e?.message || String(e) });
      }
    }),
  );
  return { byLoc, failures };
}

/* ── Attach excluded figures to the (already net) report ─────────────────── */

function applyInterbranch(report, ib) {
  const { year, previousYear, monthList } = report.period;
  const at = (loc, yr, m) =>
    ib.byLoc[loc]?.[yr]?.[m] || { surgeries: 0, revenue: 0 };
  const sum = (list) =>
    list.reduce(
      (a, v) => ({
        surgeries: a.surgeries + v.surgeries,
        revenue: round2(a.revenue + v.revenue),
      }),
      { surgeries: 0, revenue: 0 },
    );
  const locs = report.byLocation.map((l) => l.location);

  report.months.forEach((mm) => {
    mm.current.interbranch = sum(locs.map((l) => at(l, year, mm.month)));
    mm.previous.interbranch = sum(
      locs.map((l) => at(l, previousYear, mm.month)),
    );
  });
  report.totals.current.interbranch = sum(
    report.months.map((m) => m.current.interbranch),
  );
  report.totals.previous.interbranch = sum(
    report.months.map((m) => m.previous.interbranch),
  );

  report.byLocation.forEach((l) => {
    l.ibMonthlyCurrent = monthList.map((m) => at(l.location, year, m));
    l.ibMonthlyPrevious = monthList.map((m) => at(l.location, previousYear, m));
    l.current.interbranch = sum(l.ibMonthlyCurrent);
    l.previous.interbranch = sum(l.ibMonthlyPrevious);
  });

  report.definition +=
    " NET OF INTERBRANCH: a surgery operated at one branch for another counts only " +
    "at its SOURCE branch; the operating branch's copy is excluded and listed " +
    "separately (DP Road always counted). Gross = net + IB excl.";
  report.interbranch = ib;
  return report;
}

/* ── 3. PREVIOUS-YEAR location sheets (model re-run, previous year as current) */

// The model's per-location sheets ("Surg by Loc-Month", "Rev by Loc-Type", …).
const LOC_SHEET_RE = /^(Surg|Rev) by Loc-/;

// Sheet name without any year in it — used to pair the two runs' sheets.
const sheetKey = (name) =>
  name
    .replace(/\s*\b(19|20)\d{2}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

// "<base> <year>", kept inside Excel's 31-char sheet-name limit.
const withYear = (name, yr) => {
  const base = sheetKey(name);
  const suffix = ` ${yr}`;
  return base.slice(0, 31 - suffix.length) + suffix;
};

async function getPreviousYearReport(report) {
  const { previousYear, startMonth, endMonth } = report.period;
  return getMonthwiseSurgeryReport(LOCATIONS, {
    year: previousYear,
    previousYear: previousYear - 1, // only the "current" side of this run is used
    startMonth,
    endMonth,
  });
}

/* ── Workbook additions ──────────────────────────────────────────────────── */

const NUM_FMT = '#,##0;(#,##0);"-"';

// Adds 4 IB columns (I–L) to a model comparison sheet. Data rows follow `rows`
// in order (as the model wrote them), then the total row.
function addIbColumns(ws, rows, Y, P) {
  const r0 = 3; // first data row (0-based) — title, note/blank, header
  const ibs = rows.map((r) => [
    r.current.interbranch.surgeries,
    r.previous.interbranch.surgeries,
    r.current.interbranch.revenue,
    r.previous.interbranch.revenue,
  ]);
  const tot = ibs.reduce(
    (a, v) => a.map((x, i) => round2(x + v[i])),
    [0, 0, 0, 0],
  );
  xlsx.utils.sheet_add_aoa(
    ws,
    [
      [
        `IB excl. Surgeries ${Y}`,
        `IB excl. Surgeries ${P}`,
        `IB excl. Revenue (₹) ${Y}`,
        `IB excl. Revenue (₹) ${P}`,
      ],
      ...ibs,
      tot,
    ],
    { origin: { r: 2, c: 8 } },
  );
  for (let r = r0; r <= r0 + rows.length; r++)
    for (let c = 8; c <= 11; c++) {
      const cell = ws[xlsx.utils.encode_cell({ r, c })];
      if (cell && cell.t === "n") cell.z = NUM_FMT;
    }
  ws["!cols"] = [
    ...(ws["!cols"] || []).slice(0, 8),
    { wch: 14 },
    { wch: 14 },
    { wch: 17 },
    { wch: 17 },
  ];
  markNet(ws, 11);
}

// Title → "… — net of interbranch", note in row 2, title merge widened.
function markNet(ws, lastCol, note = NOTE_IB) {
  const t = ws.A1;
  if (t && typeof t.v === "string" && !t.v.includes("net of interbranch")) {
    t.v = `${t.v} — net of interbranch`;
    delete t.w;
  }
  xlsx.utils.sheet_add_aoa(ws, [[note]], { origin: "A2" });
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } }];
}

const NOTE_IB =
  "Net of interbranch: surgeries operated here for another branch are excluded " +
  "(counted at their source branch). IB excl. columns show what was left out; gross = net + IB excl.";
const NOTE_NET =
  "Net of interbranch: surgeries operated here for another branch are excluded " +
  "(counted at their source branch).";

function buildInterbranchSheet(report, which, yr) {
  const monthNames = report.period.monthNames;
  const key = which === "current" ? "ibMonthlyCurrent" : "ibMonthlyPrevious";
  const failed = new Set(report.interbranch.failures.map((f) => f.location));
  const header = [
    "Location",
    ...monthNames.map((m) => `${m} (#)`),
    "Total (#)",
    ...monthNames.map((m) => `${m} (₹)`),
    "Total (₹)",
  ];
  const aoa = [
    [
      `Interbranch surgeries EXCLUDED (operated here, counted at source branch) — ${yr} (${report.period.months})`,
    ],
    [],
    header,
  ];
  const n = monthNames.length;
  const colCnt = new Array(n).fill(0);
  const colAmt = new Array(n).fill(0);
  let gCnt = 0;
  let gAmt = 0;
  report.byLocation.forEach((l) => {
    const cnts = l[key].map((v) => v.surgeries);
    const amts = l[key].map((v) => v.revenue);
    const tc = cnts.reduce((a, b) => a + b, 0);
    const ta = round2(amts.reduce((a, b) => a + b, 0));
    cnts.forEach((v, i) => (colCnt[i] += v));
    amts.forEach((v, i) => (colAmt[i] += v));
    gCnt += tc;
    gAmt += ta;
    const label = failed.has(l.location)
      ? `${l.location} (lookup failed)`
      : l.location;
    aoa.push([label, ...cnts, tc, ...amts, ta]);
  });
  aoa.push([
    "Grand Total",
    ...colCnt,
    gCnt,
    ...colAmt.map(round2),
    round2(gAmt),
  ]);

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }];
  ws["!cols"] = [
    { wch: 22 },
    ...monthNames.map(() => ({ wch: 10 })),
    { wch: 10 },
    ...monthNames.map(() => ({ wch: 13 })),
    { wch: 15 },
  ];
  for (let r = 3; r <= 3 + report.byLocation.length; r++)
    for (let c = 1; c < header.length; c++) {
      const cell = ws[xlsx.utils.encode_cell({ r, c })];
      if (cell && cell.t === "n") cell.z = NUM_FMT;
    }
  return ws;
}

// Renames the current-year location sheets "<name> <Y>" and inserts the
// previous-year copy "<name> <P>" right after each one.
function addPreviousYearLocSheets(wb, prevReport, year, previousYear) {
  const prevWb = buildMonthwiseSurgeryWorkbook(prevReport); // net, P as "current"
  const prevByKey = {};
  for (const name of prevWb.SheetNames)
    if (LOC_SHEET_RE.test(name))
      prevByKey[sheetKey(name)] = prevWb.Sheets[name];

  const order = [];
  const missing = [];
  for (const name of wb.SheetNames) {
    if (!LOC_SHEET_RE.test(name)) {
      order.push(name);
      continue;
    }
    const curName = withYear(name, year);
    if (curName !== name) {
      wb.Sheets[curName] = wb.Sheets[name];
      delete wb.Sheets[name];
    }
    order.push(curName);

    const prevWs = prevByKey[sheetKey(name)];
    if (!prevWs) {
      missing.push(name);
      continue;
    }
    const lastCol = xlsx.utils.decode_range(prevWs["!ref"]).e.c;
    markNet(prevWs, lastCol, NOTE_NET);
    const prevName = withYear(name, previousYear);
    wb.Sheets[prevName] = prevWs;
    order.push(prevName);
  }
  wb.SheetNames = order;
  return missing;
}

function buildWorkbookIB(report, prevReport) {
  const { year, previousYear } = report.period;
  const wb = buildMonthwiseSurgeryWorkbook(report); // model layout, net figures

  addIbColumns(wb.Sheets["Monthly Totals"], report.months, year, previousYear);
  addIbColumns(
    wb.Sheets["Location Summary"],
    report.byLocation,
    year,
    previousYear,
  );
  markNet(wb.Sheets["By Surgery Type"], 7, NOTE_NET);
  for (const name of wb.SheetNames)
    if (LOC_SHEET_RE.test(name)) {
      const ws = wb.Sheets[name];
      const lastCol = xlsx.utils.decode_range(ws["!ref"]).e.c;
      markNet(ws, lastCol, NOTE_NET);
    }

  // Previous-year copies of the per-location sheets
  const missing = addPreviousYearLocSheets(wb, prevReport, year, previousYear);
  if (missing.length)
    console.warn(
      `\n⚠️  No ${previousYear} counterpart found for: ${missing.join(", ")}`,
    );

  xlsx.utils.book_append_sheet(
    wb,
    buildInterbranchSheet(report, "current", year),
    `Interbranch ${year}`,
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildInterbranchSheet(report, "previous", previousYear),
    `Interbranch ${previousYear}`,
  );

  if (report.interbranch.failures.length) {
    const ws = xlsx.utils.aoa_to_sheet([
      [
        "Excluded-interbranch lookup failed — net figures are still correct; " +
          "only the IB excl. columns for these branches show 0",
      ],
      ["Location", "Error"],
      ...report.interbranch.failures.map((f) => [f.location, f.error]),
    ]);
    ws["!cols"] = [{ wch: 24 }, { wch: 60 }];
    xlsx.utils.book_append_sheet(wb, ws, "Interbranch Warnings");
  }
  return wb;
}

/* ── Run ─────────────────────────────────────────────────────────────────── */

(async () => {
  const t0 = Date.now();
  console.log("──────────────────────────────────────────────────────────");
  console.log(
    "Month-wise Surgery Report — NET of interbranch (temporary runner)",
  );
  console.log(
    `Window   : ${OPTIONS.startMonth}–${OPTIONS.endMonth} | ` +
      `${OPTIONS.year} vs ${OPTIONS.previousYear}`,
  );
  console.log(`Branches : ${LOCATIONS.join(", ")}`);
  console.log("──────────────────────────────────────────────────────────");

  try {
    // 1) Net report (model + injected rule)
    const report = await getMonthwiseSurgeryReport(LOCATIONS, OPTIONS);
    const ok = report.locationsRequested.length - report.locationsFailed.length;
    if (ok > 0 && invoiceQueriesPatched === 0)
      throw new Error(
        "Interbranch patch was never applied — refusing to write a gross workbook.",
      );

    // 2) Excluded interbranch, same windows
    const ib = await getInterbranchExcluded(report);
    applyInterbranch(report, ib);

    // 3) Previous year as "current" (net too) — feeds the <P> location sheets
    const patchedBefore = invoiceQueriesPatched;
    const prevReport = await getPreviousYearReport(report);
    const prevOk =
      prevReport.locationsRequested.length - prevReport.locationsFailed.length;
    if (prevOk > 0 && invoiceQueriesPatched === patchedBefore)
      throw new Error(
        "Interbranch patch was not applied to the previous-year run — refusing to write gross sheets.",
      );

    // Cross-check: previous-year totals must match the main run's "previous" side
    const pMain = report.totals.previous;
    const pRun = prevReport.totals.current;
    if (
      pMain.surgeries !== pRun.surgeries ||
      Math.abs((pMain.revenue || 0) - (pRun.revenue || 0)) > 1
    )
      console.warn(
        `\n⚠️  ${report.period.previousYear} totals differ between runs: ` +
          `main ${pMain.surgeries} SX / ₹${round2(pMain.revenue)} vs ` +
          `re-run ${pRun.surgeries} SX / ₹${round2(pRun.revenue)} — check before sharing.`,
      );

    // 4) Workbook
    const wb = buildWorkbookIB(report, prevReport);
    const { year, previousYear, startMonth, endMonth } = report.period;
    const fileName = `Monthwise_Surgeries_${year}_vs_${previousYear}_${pad2(startMonth)}-${pad2(endMonth)}_IPDnet.xlsx`;
    const filePath = path.join(__dirname, "..", "src", "report", fileName);
    xlsx.writeFile(wb, filePath);
    console.log(`\n✅ Workbook written: ${filePath}`);
    console.log(`   Sheets: ${wb.SheetNames.join(" | ")}`);

    // Sanity print
    const inr = (n) => Math.round(Number(n) || 0).toLocaleString("en-IN");
    const { current: c, previous: p } = report.totals;
    console.log(
      `\nTotals (${report.period.months}) — ${year} vs ${previousYear}:`,
    );
    console.log(
      `   Surgeries (net) : ${c.surgeries}  vs  ${p.surgeries}   (Δ ${c.surgeries - p.surgeries})`,
    );
    console.log(
      `   Revenue ₹ (net) : ${inr(c.revenue)}  vs  ${inr(p.revenue)}`,
    );
    console.log(
      `   Interbranch excl: ${c.interbranch.surgeries} SX · ₹ ${inr(c.interbranch.revenue)}` +
        `  vs  ${p.interbranch.surgeries} SX · ₹ ${inr(p.interbranch.revenue)}`,
    );
    console.log(
      `   [gross = ${c.surgeries + c.interbranch.surgeries} SX · ₹ ${inr(c.revenue + c.interbranch.revenue)}` +
        `  vs  ${p.surgeries + p.interbranch.surgeries} SX · ₹ ${inr(p.revenue + p.interbranch.revenue)}]`,
    );

    console.log("\nBy location (net)   [interbranch excluded]:");
    report.byLocation.forEach((l) =>
      console.log(
        `   ${l.location.padEnd(16)} ${String(l.current.surgeries).padStart(5)}` +
          `  vs ${String(l.previous.surgeries).padStart(5)}` +
          `   [${l.current.interbranch.surgeries} vs ${l.previous.interbranch.surgeries}]`,
      ),
    );

    if (report.locationsFailed.length) {
      console.warn("\n⚠️  Skipped branches (see 'Skipped Locations' sheet):");
      report.locationsFailed.forEach((f) =>
        console.warn(`   • ${f.location}: ${f.error}`),
      );
    }
    if (prevReport.locationsFailed.length) {
      console.warn(`\n⚠️  Skipped in the ${previousYear} location sheets:`);
      prevReport.locationsFailed.forEach((f) =>
        console.warn(`   • ${f.location}: ${f.error}`),
      );
    }
    if (ib.failures.length) {
      console.warn("\n⚠️  Excluded-interbranch lookup failed (IB columns 0):");
      ib.failures.forEach((f) =>
        console.warn(`   • ${f.location}: ${f.error}`),
      );
    }

    console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exit(0); // mysql pools keep the event loop alive
  } catch (err) {
    console.error("\n❌ Report generation failed:", err?.message || err);
    console.error(err?.stack || "");
    process.exit(1);
  }
})();
