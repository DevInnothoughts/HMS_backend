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
 * ── INTERBRANCH ADJUSTMENT (new) ────────────────────────────────────────────
 * When a patient's OPD is at branch A (source) but the surgery is at branch B
 * (operating), the SAME invoice exists in both branch DBs. The revenue belongs
 * to the SOURCE branch, so the operating branch's copy is excluded — the same
 * rule the app now applies everywhere (src/models/utils/interbranch.js):
 *
 *     excluded  = patient_location set AND interbranch_id = 0/NULL
 *                 (except patient_location 'DP Road', which is always counted)
 *
 * The model (monthlyRevenueReportModel → getLocationSummary) is shared and still
 * counts every invoice, so it is NOT changed. Instead this runner:
 *
 *   1. runs the model as before            → GROSS figures
 *   2. queries, per branch per month, the interbranch invoices the rule
 *      excludes — same date bounds and is_deleted filter as getLocationSummary's
 *      IPD query, so   NET = GROSS − EXCLUDED   exactly
 *   3. writes the workbook on NET figures, with the difference shown:
 *
 *        Monthly Summary        IPD Billed (gross) · Interbranch excl. · IPD
 *                               Billed (net) · Total (net), both years
 *        By Location <year>     NET totals (as before, now corrected)
 *        Interbranch <year>     per branch per month: excluded amount + count
 *        Skipped Locations      only if a branch failed
 *
 *   Totals across branches are now correct: an interbranch surgery is counted
 *   once, at its source branch, instead of at both.
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
 * months sequentially. The interbranch pass adds one light query per
 * (location, year, month). Expect it to take a while; let it finish.
 *
 * ── Place this file in temp/ ─────────────────────────────────────────────────
 * It requires ../src/models/monthlyRevenueReportModel, ../databaseUtils and
 * ../src/models/utils/interbranch.
 *
 * ── Run ─────────────────────────────────────────────────────────────────────
 *   node temp/tmp_generateRevenueReport_Jan_Jul.js
 *
 *   # override branches (comma-separated, must match getConnectionByLocation keys)
 *   node temp/tmp_generateRevenueReport_Jan_Jul.js "Navi Mumbai,Andheri,Thane,Vashi"
 *
 *   # override the window too:  <locations> <year> <startMonth> <endMonth>
 *   node temp/tmp_generateRevenueReport_Jan_Jul.js "Andheri,Thane" 2026 1 7
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

const {
  getMonthwiseRevenue,
  buildMonthwiseRevenueWorkbook,
} = require("../src/models/monthlyRevenueReportModel");
const { getConnectionByLocation } = require("../databaseUtils");
const { countedSql } = require("../src/models/utils/interbranch");
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
const pctChange = (cur, prev) =>
  prev > 0 ? round2(((cur - prev) / prev) * 100) : cur > 0 ? null : 0;
const pctFraction = (cur, prev) =>
  prev > 0 ? (cur - prev) / prev : cur > 0 ? null : 0;

const CURRENCY_FMT = '#,##0;(#,##0);"-"';
const PCT_FMT = '0.0%;(0.0%);"-"';
const COUNT_FMT = '0;(0);"-"';

function monthBounds(year, month) {
  const lastDay = new Date(year, month, 0).getDate();
  return {
    start: `${year}-${pad2(month)}-01`,
    end: `${year}-${pad2(month)}-${pad2(lastDay)}`,
  };
}

function formatRange(ws, c0, c1, r0, r1, fmt) {
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) {
      const cell = ws[xlsx.utils.encode_cell({ r, c })];
      if (cell && cell.t === "n") cell.z = fmt;
    }
}

/* ── Interbranch pass ────────────────────────────────────────────────────── */

// Same bounds and is_deleted filter as getLocationSummary's IPD invoice query,
// restricted to the rows the interbranch rule EXCLUDES. So net = gross − this.
const IB_SQL = `
  SELECT COUNT(*) AS cnt, COALESCE(SUM(i.totalamt), 0) AS amount
    FROM invoice i
   WHERE i.creation_date >= ? AND i.creation_date <= ?
     AND i.is_deleted != 1
     AND NOT (${countedSql("i")})
`;

function runQuery(connection, sql, params) {
  return new Promise((resolve, reject) =>
    connection.query(sql, params, (err, rows) =>
      err ? reject(err) : resolve(rows),
    ),
  );
}

/**
 * → { [loc]: { [`${yr}-${m}`]: { amount, count } } }, plus failures.
 * Branches the model already dropped are skipped, so net stays consistent
 * with what the model counted.
 */
async function getInterbranchExcluded(locations, years, months, skip) {
  const out = {};
  const failures = [];
  const bad = new Set(skip);
  for (const loc of locations) out[loc] = {};

  for (const yr of years) {
    for (const m of months) {
      await Promise.all(
        locations.map(async (loc) => {
          if (bad.has(loc)) return;
          const { start, end } = monthBounds(yr, m);
          try {
            const { connection } = getConnectionByLocation(loc);
            if (!connection) throw new Error("invalid location");
            const [row] = await runQuery(connection, IB_SQL, [
              `${start} 00:00:00`,
              `${end} 23:59:59`,
            ]);
            out[loc][`${yr}-${m}`] = {
              amount: Number(row?.amount) || 0,
              count: Number(row?.cnt) || 0,
            };
          } catch (e) {
            bad.add(loc);
            failures.push({ location: loc, error: e?.message || String(e) });
          }
        }),
      );
    }
  }
  return { byLoc: out, failures };
}

/* ── Apply the adjustment to the model's report ──────────────────────────── */

function applyInterbranch(report, ib) {
  const { year, previousYear } = report.period;
  const monthNums = report.months.map((m) => m.month);
  // A branch whose lookup failed at ANY month stays wholly gross — adjusting
  // only some of its months would make its trend meaningless.
  const ibFailed = new Set(ib.failures.map((f) => f.location));
  const ibAt = (loc, yr, m) =>
    (!ibFailed.has(loc) && ib.byLoc[loc]?.[`${yr}-${m}`]) || {
      amount: 0,
      count: 0,
    };

  // Only branches the model actually counted contribute.
  const counted = report.locationsRequested.filter(
    (l) => !report.locationsFailed.some((f) => f.location === l),
  );

  const sumMonth = (yr, m) =>
    counted.reduce(
      (acc, loc) => {
        const v = ibAt(loc, yr, m);
        acc.amount += v.amount;
        acc.count += v.count;
        return acc;
      },
      { amount: 0, count: 0 },
    );

  // Per-month aggregates: keep gross, subtract excluded for net.
  report.months.forEach((mm) => {
    for (const [side, yr] of [
      ["current", year],
      ["previous", previousYear],
    ]) {
      const b = mm[side];
      const x = sumMonth(yr, mm.month);
      b.ipdInvoiceGross = b.ipdInvoice;
      b.interbranchExcluded = round2(x.amount);
      b.interbranchCount = x.count;
      b.ipdInvoice = round2(b.ipdInvoice - x.amount);
      b.totalGross = b.total;
      b.total = round2(b.total - x.amount);
    }
    mm.change = {
      amount: round2(mm.current.total - mm.previous.total),
      pct: pctChange(mm.current.total, mm.previous.total),
    };
  });

  // Window totals.
  for (const [side, yr] of [
    ["current", year],
    ["previous", previousYear],
  ]) {
    const t = report.totals[side];
    const x = monthNums.reduce(
      (acc, m) => {
        const v = sumMonth(yr, m);
        acc.amount += v.amount;
        acc.count += v.count;
        return acc;
      },
      { amount: 0, count: 0 },
    );
    t.ipdInvoiceGross = t.ipdInvoice;
    t.interbranchExcluded = round2(x.amount);
    t.interbranchCount = x.count;
    t.ipdInvoice = round2(t.ipdInvoice - x.amount);
    t.totalGross = t.total;
    t.total = round2(t.total - x.amount);
  }
  report.totals.change = {
    amount: round2(report.totals.current.total - report.totals.previous.total),
    pct: pctChange(report.totals.current.total, report.totals.previous.total),
  };

  // Per-location month rows (the By Location sheets read `.total`).
  for (const loc of counted) {
    (report.byLocation[loc] || []).forEach((r) => {
      for (const [side, yr] of [
        ["current", year],
        ["previous", previousYear],
      ]) {
        const v = ibAt(loc, yr, r.month);
        r[side].totalGross = r[side].total;
        r[side].interbranchExcluded = round2(v.amount);
        r[side].interbranchCount = v.count;
        r[side].total = round2(r[side].total - v.amount);
      }
      r.change = {
        amount: round2(r.current.total - r.previous.total),
        pct: pctChange(r.current.total, r.previous.total),
      };
    });
  }

  report.definition =
    "Monthly total = OPD collection + IPD billed NET of interbranch + Pharmacy " +
    "collection. Interbranch invoices operated at a branch for another branch " +
    "are excluded (counted at the source branch; DP Road always counted). " +
    "IPD cash collection is listed for reference only and is NOT in the total.";
  report.interbranch = ib;
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
    c.total - p.total,
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
    const ibFailed = report.interbranch?.failures?.some(
      (f) => f.location === loc,
    );
    const failed = skipped || ibFailed;
    const rows = report.byLocation[loc] || [];
    const amts = rows.map((r) =>
      failed ? 0 : Number(r[which]?.interbranchExcluded) || 0,
    );
    const cnts = rows.map((r) =>
      failed ? 0 : Number(r[which]?.interbranchCount) || 0,
    );
    const ta = amts.reduce((a, b) => a + b, 0);
    const tc = cnts.reduce((a, b) => a + b, 0);
    amts.forEach((v, i) => (colAmt[i] += v));
    cnts.forEach((v, i) => (colCnt[i] += v));
    gAmt += ta;
    gCnt += tc;
    const label = skipped
      ? `${loc} (skipped)`
      : ibFailed
        ? `${loc} (lookup failed — gross)`
        : loc;
    aoa.push([label, ...amts, ta, ...cnts, tc]);
  });
  aoa.push(["Total", ...colAmt, gAmt, ...colCnt, gCnt]);

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
    `Workload : ~${LOCATIONS.length * 2 * monthCount} summary calls ` +
      `+ the same number of interbranch queries — be patient.`,
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

    // 1) Gross, from the unchanged model.
    const report = await getMonthwiseRevenue(LOCATIONS, OPTIONS);
    if (report.locationsFailed.length === LOCATIONS.length) {
      throw new Error(
        "Every branch failed — no workbook written. Errors: " +
          report.locationsFailed
            .map((f) => `${f.location}: ${f.error}`)
            .join(" | "),
      );
    }

    // 2) Interbranch exclusions, same windows.
    const monthNums = report.months.map((m) => m.month);
    const ib = await getInterbranchExcluded(
      LOCATIONS,
      [report.period.year, report.period.previousYear],
      monthNums,
      report.locationsFailed.map((f) => f.location),
    );

    // 3) Net figures + workbook.
    applyInterbranch(report, ib);

    const wb = buildMonthwiseRevenueWorkbook(report); // By Location sheets read net totals
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
    if (ib.failures.length) {
      const ws = xlsx.utils.aoa_to_sheet([
        [
          "Interbranch lookup failed — figures for these branches are GROSS",
          "Reason",
        ],
        ...ib.failures.map((f) => [f.location, f.error]),
      ]);
      ws["!cols"] = [{ wch: 60 }, { wch: 55 }];
      xlsx.utils.book_append_sheet(wb, ws, "Interbranch Warnings");
    }

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
        "   Note: a branch is dropped for the WHOLE window after its first " +
          "failed month, so its earlier months are excluded from the totals too.",
      );
    }
    if (ib.failures.length) {
      console.warn(
        "\n⚠️  Interbranch lookup failed for (their figures stay GROSS — see 'Interbranch Warnings'):",
      );
      ib.failures.forEach((f) =>
        console.warn(`   • ${f.location}: ${f.error}`),
      );
    }

    if (getRetriesUsed())
      console.log(
        `\n   (${getRetriesUsed()} transient DB errors were retried successfully or exhausted — see ↻ lines)`,
      );
    console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    // Non-zero exit if any branch is missing, so it can't pass unnoticed.
    process.exit(report.locationsFailed.length || ib.failures.length ? 1 : 0);
  } catch (err) {
    console.error(
      "\n❌ Revenue report generation failed:",
      err?.message || err,
    );
    console.error(err?.stack || "");
    process.exit(1);
  }
})();
