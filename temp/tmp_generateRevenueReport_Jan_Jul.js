/**
 * tmp_generateRevenueReport_Jan_Jul.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * One-off runner for the month-wise TOTAL REVENUE report, Jan–JULY:
 *
 *      Jan–Jul 2026   vs   Jan–Jul 2025
 *
 * ── What "revenue" means here ────────────────────────────────────────────────
 *
 *     Monthly total = OPD collection + IPD BILLED (net of interbranch) + Pharmacy
 *
 * IPD *cash collection* is carried for reference but is NOT part of the total —
 * same as generateSummaryReport's grandTotal.
 *
 * ── INTERBRANCH ADJUSTMENT ──────────────────────────────────────────────────
 * When a patient's OPD is at branch A (source) but the surgery is at branch B
 * (operating), the SAME invoice exists in both branch DBs. The revenue belongs
 * to the SOURCE branch, so the operating branch's copy is excluded — the rule
 * in src/models/utils/interbranch.js (countedSql), used by every IPD screen:
 *
 *     excluded  = patient_location set AND COALESCE(interbranch_id, 0) = 0
 *                 (except patient_location 'DP Road', which is always counted)
 *
 * This runner applies it EXACTLY the way the backend already does in
 * reportMailModel.generateSummaryReportV2 (INTERBRANCH_SQL +
 * applyInterbranchToBranch), without changing any shared model:
 *
 *   • reportMailModel.getLocationSummary is wrapped FOR THIS PROCESS ONLY.
 *     Each call (one per branch × month) also runs the V2 interbranch query —
 *     same invoice table, same creation_date bounds (00:00:00 / 23:59:59),
 *     same is_deleted filter, same totalamt — and nets the result in place:
 *
 *         ipdInvoice.total  −= excluded       grandTotal −= excluded
 *         ipdInvoice.byStatus / totalDiscount netted the same way
 *
 *   • monthlyRevenueReportModel therefore aggregates NET figures everywhere —
 *     Monthly Summary, By Location <year>, window totals — so a branch is
 *     never half-netted, even if it fails part-way through the window.
 *   • If the interbranch query fails for a branch-month, that call FAILS, so
 *     the model skips the branch and lists it under "Skipped Locations". A
 *     gross figure is never silently mixed into net totals.
 *   • The script STOPS if the wrapper was never used (e.g. the model stopped
 *     calling getLocationSummary), instead of writing a gross workbook.
 *
 * Workbook:
 *     Monthly Summary        IPD Billed gross · Interbranch excl. · IPD Billed
 *                            net · Total net / gross, both years
 *     By Location <year>     NET totals per branch per month
 *     Interbranch <year>     per branch per month: excluded amount + invoices
 *     Skipped Locations      only if a branch failed
 *
 *   Gross = net + interbranch excl., per branch per month, exactly.
 *
 * ── Connection resilience (temp/_dbResilience.js) ───────────────────────────
 * All branch DBs share one MySQL host. Before anything runs, the pools for the
 * requested branches get a 30 s connect timeout, a shared cap on concurrent
 * queries (REPORT_DB_CONCURRENCY, default 4) and automatic retries on
 * handshake / network timeouts; one SELECT 1 checks the host is reachable.
 * If EVERY branch still fails, no workbook is written (an all-zero file is
 * worse than none); if some fail, they are listed loudly and on a sheet.
 *
 * ── Runtime warning ─────────────────────────────────────────────────────────
 * The model calls getLocationSummary ONCE PER (location, year, month), walking
 * months sequentially; each call now adds one light interbranch query.
 * Expect it to take a while; let it finish.
 *
 * ── Place this file in temp/ ─────────────────────────────────────────────────
 * It requires ../src/models/monthlyRevenueReportModel,
 * ../src/models/reportMailModel, ../databaseUtils and
 * ../src/models/utils/interbranch.
 *
 * ── Run ─────────────────────────────────────────────────────────────────────
 *   node temp/tmp_generateRevenueReport_Jan_Jul.js
 *
 *   # override branches (comma-separated, must match getConnectionByLocation keys)
 *   node temp/tmp_generateRevenueReport_Jan_Jul.js "Navi Mumbai,Andheri,Thane,Vashi"
 *
 *   # override the window too:  <locations> <year> <startMonth> <endMonth>
 *   node temp/tmp_generateRevenueReport_Jan_Jul.js "Andheri,Thane, Vashi, Navi Mumbai, Kalyan" 2026 1 9
 *
 * ── Output ──────────────────────────────────────────────────────────────────
 *   src/report/Monthwise_Revenue_2026_vs_2025_01-07_IPDnet.xlsx
 *   (the _IPDnet suffix keeps it distinct from any earlier gross workbook)
 *
 * DELETE THIS FILE once the workbook has been generated.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");

const { getConnectionByLocation } = require("../databaseUtils");
const { countedSql } = require("../src/models/utils/interbranch");
const reportMailModel = require("../src/models/reportMailModel");
const {
  getMonthwiseRevenue,
  buildMonthwiseRevenueWorkbook,
} = require("../src/models/monthlyRevenueReportModel");
const { harden, preflight, getRetriesUsed } = require("./_dbResilience");

/* ── Config ──────────────────────────────────────────────────────────────── */

// The model preserves this array's order for the By Location sheets (it does
// NOT sort by revenue), so keep the order you want in the output.
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
  endMonth: Number(process.argv[5]) || 7,
};

const reportsDir = path.join(__dirname, "..", "src", "report");

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const pad2 = (n) => String(n).padStart(2, "0");
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pctFraction = (cur, prev) =>
  prev > 0 ? (cur - prev) / prev : cur > 0 ? null : 0;

const CURRENCY_FMT = '#,##0;(#,##0);"-"';
const PCT_FMT = '0.0%;(0.0%);"-"';
const COUNT_FMT = '0;(0);"-"';

function formatRange(ws, c0, c1, r0, r1, fmt) {
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) {
      const cell = ws[xlsx.utils.encode_cell({ r, c })];
      if (cell && cell.t === "n") cell.z = fmt;
    }
}

/* ── Interbranch: the backend's own V2 rule, applied per summary call ────── */

// Identical to reportMailModel's INTERBRANCH_SQL (used by
// generateSummaryReportV2): same table, bounds, is_deleted filter and amount
// column as getLocationSummary's IPD invoice query, restricted to the rows
// countedSql excludes. So net = gross − this, exactly.
const INTERBRANCH_SQL = `
  SELECT i.status,
         COUNT(*)                        AS cnt,
         COALESCE(SUM(i.totalamt), 0)    AS amount,
         COALESCE(SUM(i.discount), 0)    AS discount
    FROM invoice i
   WHERE i.creation_date >= ? AND i.creation_date <= ?
     AND i.is_deleted != 1
     AND NOT (${countedSql("i")})
   GROUP BY i.status
`;

function interbranchFor(location, from, to) {
  return new Promise((resolve, reject) => {
    const { connection } = getConnectionByLocation(location);
    if (!connection) return reject(new Error(`Invalid location: ${location}`));
    connection.query(
      INTERBRANCH_SQL,
      [`${from} 00:00:00`, `${to} 23:59:59`],
      (err, rows) => {
        if (err) return reject(err);
        const out = { invoices: 0, amount: 0, discount: 0, byStatus: {} };
        for (const r of rows || []) {
          const amt = Number(r.amount) || 0;
          out.invoices += Number(r.cnt) || 0;
          out.amount += amt;
          out.discount += Number(r.discount) || 0;
          out.byStatus[r.status] = (out.byStatus[r.status] || 0) + amt;
        }
        resolve(out);
      },
    );
  });
}

// Same netting as reportMailModel.applyInterbranchToBranch.
function netSummary(s, ib) {
  const inv =
    s.ipdInvoice ||
    (s.ipdInvoice = { byStatus: {}, total: 0, totalDiscount: 0 });
  inv.grossTotal = Number(inv.total) || 0;
  inv.interbranch = ib;
  s.grandTotalGross = Number(s.grandTotal) || 0;
  if (!ib.invoices) return s;
  for (const [st, amt] of Object.entries(ib.byStatus)) {
    if (!inv.byStatus) inv.byStatus = {};
    const left = (Number(inv.byStatus[st]) || 0) - amt;
    if (Math.abs(left) < 0.005) delete inv.byStatus[st];
    else inv.byStatus[st] = left;
  }
  inv.total = inv.grossTotal - ib.amount;
  inv.totalDiscount = (Number(inv.totalDiscount) || 0) - ib.discount;
  s.grandTotal = s.grandTotalGross - ib.amount;
  return s;
}

// Excluded figures, recorded ONLY for summaries the model actually received:
// { [loc]: { [`${yr}-${m}`]: { amount, count } } }
const IB = {};
let wrappedCalls = 0;

// monthlyRevenueReportModel requires reportMailModel lazily and reads
// getLocationSummary off its exports at call time, so replacing the export
// here reaches it. Process-local: nothing on disk changes.
const origGetLocationSummary = reportMailModel.getLocationSummary;
reportMailModel.getLocationSummary = async (location, fromDate, toDate) => {
  const [s, ib] = await Promise.all([
    origGetLocationSummary(location, fromDate, toDate),
    interbranchFor(location, fromDate, toDate).catch((e) => {
      // Fail the call: the model then skips this branch (Skipped Locations)
      // rather than counting a gross month among net ones.
      throw new Error(`interbranch lookup failed — ${e?.message || e}`);
    }),
  ]);
  netSummary(s, ib);
  const [yr, mm] = String(fromDate).split("-");
  (IB[location] ||= {})[`${Number(yr)}-${Number(mm)}`] = {
    amount: ib.amount,
    count: ib.invoices,
  };
  wrappedCalls += 1;
  return s;
};

/* ── Attach excluded / gross figures to the (already net) report ─────────── */

function attachInterbranch(report) {
  const { year, previousYear } = report.period;
  const monthNums = report.months.map((m) => m.month);
  const ibAt = (loc, yr, m) =>
    IB[loc]?.[`${yr}-${m}`] || { amount: 0, count: 0 };
  const sum = (yr, months) =>
    report.locationsRequested.reduce(
      (acc, loc) => {
        for (const m of months) {
          const v = ibAt(loc, yr, m);
          acc.amount += v.amount;
          acc.count += v.count;
        }
        return acc;
      },
      { amount: 0, count: 0 },
    );
  const sides = [
    ["current", year],
    ["previous", previousYear],
  ];
  const decorate = (b, x) => {
    b.interbranchExcluded = round2(x.amount);
    b.interbranchCount = x.count;
    if (b.ipdInvoice != null)
      b.ipdInvoiceGross = round2(b.ipdInvoice + x.amount);
    b.totalGross = round2(b.total + x.amount);
  };

  report.months.forEach((mm) => {
    for (const [side, yr] of sides) decorate(mm[side], sum(yr, [mm.month]));
  });
  for (const [side, yr] of sides)
    decorate(report.totals[side], sum(yr, monthNums));

  for (const loc of report.locationsRequested)
    (report.byLocation[loc] || []).forEach((r) => {
      for (const [side, yr] of sides) decorate(r[side], ibAt(loc, yr, r.month));
    });

  report.definition =
    "Monthly total = OPD collection + IPD billed NET of interbranch + Pharmacy " +
    "collection. Interbranch invoices operated at a branch for another branch " +
    "are excluded (counted at the source branch; DP Road always counted) — the " +
    "same rule as the IPD Invoice screen and the summary report. " +
    "IPD cash collection is listed for reference only and is NOT in the total.";
  return report;
}

/* ── Sheets ──────────────────────────────────────────────────────────────── */

// Replaces the model's Monthly Summary: same idea, with the interbranch
// difference shown for both years.
function buildSummarySheetIB(report) {
  const { year, previousYear, months: label } = report.period;
  const header = [
    "Month",
    `OPD (₹) ${year}`,
    `IPD Billed gross (₹) ${year}`,
    `Interbranch excl. (₹) ${year}`,
    `IB invoices ${year}`,
    `IPD Billed net (₹) ${year}`,
    `Pharmacy (₹) ${year}`,
    `Total net (₹) ${year}`,
    `Total gross (₹) ${year}`,
    `Total net (₹) ${previousYear}`,
    `Interbranch excl. (₹) ${previousYear}`,
    `Total gross (₹) ${previousYear}`,
    "Change net (₹)",
    "Change net (%)",
    "IPD Collection (₹) ref",
  ];

  const aoa = [
    [
      `Monthwise Total Revenue — ${previousYear} vs ${year} (${label}) — IPD net of interbranch`,
    ],
    [],
    header,
  ];

  const rowFor = (name, c, p) => [
    name,
    c.opd,
    c.ipdInvoiceGross,
    c.interbranchExcluded,
    c.interbranchCount,
    c.ipdInvoice,
    c.pharmacy,
    c.total,
    c.totalGross,
    p.total,
    p.interbranchExcluded,
    p.totalGross,
    round2(c.total - p.total),
    pctFraction(c.total, p.total) ?? "N/A",
    c.ipdCollection,
  ];

  report.months.forEach((m) =>
    aoa.push(rowFor(m.monthName, m.current, m.previous)),
  );
  aoa.push(
    rowFor(`Total (${label})`, report.totals.current, report.totals.previous),
  );
  aoa.push([]);
  aoa.push([report.definition]);

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  const lastData = 3 + report.months.length; // includes total row
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } },
    {
      s: { r: lastData + 2, c: 0 },
      e: { r: lastData + 2, c: header.length - 1 },
    },
  ];
  ws["!cols"] = [
    { wch: 18 },
    { wch: 14 },
    { wch: 19 },
    { wch: 20 },
    { wch: 12 },
    { wch: 18 },
    { wch: 14 },
    { wch: 16 },
    { wch: 17 },
    { wch: 16 },
    { wch: 20 },
    { wch: 17 },
    { wch: 14 },
    { wch: 13 },
    { wch: 20 },
  ];
  formatRange(ws, 1, 3, 3, lastData, CURRENCY_FMT);
  formatRange(ws, 4, 4, 3, lastData, COUNT_FMT);
  formatRange(ws, 5, 12, 3, lastData, CURRENCY_FMT);
  formatRange(ws, 13, 13, 3, lastData, PCT_FMT);
  formatRange(ws, 14, 14, 3, lastData, CURRENCY_FMT);
  return ws;
}

// Per branch per month: excluded amount, then count — so each branch's
// adjustment can be checked against its own IPD invoice screen.
function buildInterbranchSheet(report, which, yr) {
  const monthNames = report.months.map((m) => m.monthName);
  const header = [
    "Location",
    ...monthNames.map((n) => `${n} (₹)`),
    `Total excl. (₹) ${yr}`,
    ...monthNames.map((n) => `${n} (#)`),
    "Total invoices",
  ];
  const aoa = [
    [
      `Interbranch invoices EXCLUDED (operated here, counted at source branch) — ${yr} (${report.period.months})`,
    ],
    [],
    header,
  ];

  const n = monthNames.length;
  const colAmt = new Array(n).fill(0);
  const colCnt = new Array(n).fill(0);
  let gAmt = 0;
  let gCnt = 0;

  report.locationsRequested.forEach((loc) => {
    const skipped = report.locationsFailed.some((f) => f.location === loc);
    const rows = report.byLocation[loc] || [];
    const amts = rows.map((r) => Number(r[which]?.interbranchExcluded) || 0);
    const cnts = rows.map((r) => Number(r[which]?.interbranchCount) || 0);
    const ta = round2(amts.reduce((a, b) => a + b, 0));
    const tc = cnts.reduce((a, b) => a + b, 0);
    amts.forEach((v, i) => (colAmt[i] += v));
    cnts.forEach((v, i) => (colCnt[i] += v));
    gAmt += ta;
    gCnt += tc;
    aoa.push([skipped ? `${loc} (skipped)` : loc, ...amts, ta, ...cnts, tc]);
  });
  aoa.push(["Total", ...colAmt.map(round2), round2(gAmt), ...colCnt, gCnt]);

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }];
  ws["!cols"] = [
    { wch: 22 },
    ...monthNames.map(() => ({ wch: 13 })),
    { wch: 17 },
    ...monthNames.map(() => ({ wch: 10 })),
    { wch: 13 },
  ];
  const last = 3 + report.locationsRequested.length;
  formatRange(ws, 1, n + 1, 3, last, CURRENCY_FMT);
  formatRange(ws, n + 2, 2 * n + 2, 3, last, COUNT_FMT);
  return ws;
}

/* ── Run ─────────────────────────────────────────────────────────────────── */

(async () => {
  const t0 = Date.now();
  const inr = (n) => Math.round(Number(n) || 0).toLocaleString("en-IN");
  const monthCount = OPTIONS.endMonth - OPTIONS.startMonth + 1;

  console.log("──────────────────────────────────────────────────────────");
  console.log("Month-wise Total Revenue Report — IPD net of interbranch");
  console.log(
    `Window   : ${OPTIONS.startMonth}–${OPTIONS.endMonth} | ` +
      `${OPTIONS.year} vs ${OPTIONS.previousYear}`,
  );
  console.log(`Branches : ${LOCATIONS.join(", ")}`);
  console.log(
    `Workload : ~${LOCATIONS.length * 2 * monthCount} summary calls, ` +
      `each with one interbranch query — be patient.`,
  );
  console.log("──────────────────────────────────────────────────────────");

  try {
    // 0) Make the shared DB host survivable, and check it is reachable at all.
    const { unknown, maxConcurrent } = harden(LOCATIONS);
    if (unknown.length) {
      throw new Error(
        `Unknown branch name(s): ${unknown.join(", ")} — must match getConnectionByLocation keys exactly.`,
      );
    }
    await preflight(LOCATIONS[0]);
    console.log(
      `  ✓ database host reachable · max ${maxConcurrent} concurrent queries`,
    );

    // 1) Model run — every getLocationSummary call is netted of interbranch.
    const report = await getMonthwiseRevenue(LOCATIONS, OPTIONS);
    if (report.locationsFailed.length === LOCATIONS.length) {
      throw new Error(
        "Every branch failed — no workbook written. Errors: " +
          report.locationsFailed
            .map((f) => `${f.location}: ${f.error}`)
            .join(" | "),
      );
    }
    if (wrappedCalls === 0) {
      throw new Error(
        "Interbranch netting was never applied (getLocationSummary wrapper " +
          "unused) — refusing to write a gross workbook.",
      );
    }

    // 2) Show what was excluded, and gross = net + excluded.
    attachInterbranch(report);

    // 3) Workbook (By Location sheets already read net totals).
    const wb = buildMonthwiseRevenueWorkbook(report);
    wb.Sheets["Monthly Summary"] = buildSummarySheetIB(report);
    const { year, previousYear, startMonth, endMonth } = report.period;
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

    if (!fs.existsSync(reportsDir))
      fs.mkdirSync(reportsDir, { recursive: true });
    const fileName =
      `Monthwise_Revenue_${year}_vs_${previousYear}_` +
      `${pad2(startMonth)}-${pad2(endMonth)}_IPDnet.xlsx`;
    const filePath = path.join(reportsDir, fileName);
    xlsx.writeFile(wb, filePath);

    const { current, previous, change } = report.totals;
    console.log(`\n✅ Workbook written: ${filePath}`);

    console.log(
      `\nTotals (${report.period.months}) — ${year} vs ${previousYear}:`,
    );
    console.log(
      `   OPD                 ₹ ${inr(current.opd).padStart(14)}  vs ${inr(previous.opd).padStart(14)}`,
    );
    console.log(
      `   IPD billed (gross)  ₹ ${inr(current.ipdInvoiceGross).padStart(14)}  vs ${inr(previous.ipdInvoiceGross).padStart(14)}`,
    );
    console.log(
      `   − Interbranch excl. ₹ ${inr(current.interbranchExcluded).padStart(14)}  vs ${inr(previous.interbranchExcluded).padStart(14)}` +
        `   (${current.interbranchCount} vs ${previous.interbranchCount} invoices)`,
    );
    console.log(
      `   IPD billed (net)    ₹ ${inr(current.ipdInvoice).padStart(14)}  vs ${inr(previous.ipdInvoice).padStart(14)}`,
    );
    console.log(
      `   Pharmacy            ₹ ${inr(current.pharmacy).padStart(14)}  vs ${inr(previous.pharmacy).padStart(14)}`,
    );
    console.log(
      `   ────────────────────────────────────────────────────────────────`,
    );
    console.log(
      `   GRAND TOTAL (net)   ₹ ${inr(current.total).padStart(14)}  vs ${inr(previous.total).padStart(14)}` +
        `   (${change.pct === null ? "N/A" : change.pct + "%"})`,
    );
    console.log(
      `   [gross total was    ₹ ${inr(current.totalGross)} vs ₹ ${inr(previous.totalGross)}]`,
    );
    console.log(
      `   [IPD cash collection, NOT in total: ₹ ${inr(current.ipdCollection)} vs ₹ ${inr(previous.ipdCollection)}]`,
    );

    console.log("\nMonth-wise grand total, net (₹)   [interbranch excluded]:");
    report.months.forEach((m) => {
      console.log(
        `   ${m.monthName.padEnd(10)} ${inr(m.current.total).padStart(14)}` +
          `  vs ${inr(m.previous.total).padStart(14)}` +
          `   [${inr(m.current.interbranchExcluded)} vs ${inr(m.previous.interbranchExcluded)}]`,
      );
    });

    if (report.locationsFailed?.length) {
      console.warn("\n⚠️  Skipped branches (see 'Skipped Locations' sheet):");
      report.locationsFailed.forEach((f) =>
        console.warn(`   • ${f.location}: ${f.error}`),
      );
      console.warn(
        "   Note: the model skips a branch from its first failed month onward " +
          "(it walks the current year, then the previous year). Months fetched " +
          "before the failure stay in the totals, already net — so that " +
          "branch's year-on-year comparison is incomplete. Re-run if possible.",
      );
    }

    if (getRetriesUsed())
      console.log(
        `\n   (${getRetriesUsed()} transient DB errors were retried successfully or exhausted — see ↻ lines)`,
      );
    console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    // Non-zero exit if any branch is missing, so it can't pass unnoticed.
    process.exit(report.locationsFailed.length ? 1 : 0);
  } catch (err) {
    console.error(
      "\n❌ Revenue report generation failed:",
      err?.message || err,
    );
    console.error(err?.stack || "");
    process.exit(1);
  }
})();
