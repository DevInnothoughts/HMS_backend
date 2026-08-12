/**
 * tmp_generateRevenueReport_Jan_Jul.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * One-off runner for the month-wise TOTAL REVENUE report, widened to Jan–JULY:
 *
 *      Jan–Jul 2026   vs   Jan–Jul 2025
 *
 * Same workbook layout as Monthwise_Revenue_2026_vs_2025_01-06.xlsx — this only
 * changes the window (endMonth 6 → 7). No model code is touched:
 * getMonthwiseRevenue already takes { year, previousYear, startMonth, endMonth },
 * and both sheet builders derive their month columns from report.months, so
 * July appears automatically in Monthly Summary and both By Location sheets.
 *
 * ── What "revenue" means here ────────────────────────────────────────────────
 * Sourced from getLocationSummary (reportMailModel), same as the summary report:
 *
 *     Monthly total = OPD collection + IPD BILLED (invoice) + Pharmacy collection
 *
 * IPD *cash collection* is carried in the JSON for reference but is deliberately
 * NOT part of the total — this matches generateSummaryReport's grandTotal.
 * If you need the pure-cash DSR definition instead, that's a model change, not
 * something this runner can toggle.
 *
 * ── Runtime warning ─────────────────────────────────────────────────────────
 * Unlike the surgery/OPD reports (one query per branch per year), this model
 * calls getLocationSummary ONCE PER (location, year, month) and walks the
 * months sequentially — parallel only across branches within a month. So:
 *
 *     4 branches × 2 years × 7 months = 56 summary calls, in 14 sequential steps
 *
 * That's 2 more steps than the Jan–Jun run. Expect it to take noticeably longer
 * than the other two runners; let it finish rather than assuming it hung.
 *
 * ── Place this file at the PROJECT ROOT ──────────────────────────────────────
 * (next to app.js / databaseUtils.js / dbconfig.js), because it requires
 * ./src/models/monthlyRevenueReportModel, which lazily pulls in
 * ./reportMailModel from src/models.
 *
 * ── Run ─────────────────────────────────────────────────────────────────────
 *   node tmp_generateRevenueReport_Jan_Jul.js
 *
 *   # override branches (comma-separated, must match getConnectionByLocation keys)
 *   node tmp_generateRevenueReport_Jan_Jul.js "Navi Mumbai,Andheri,Thane,Vashi"
 *
 *   # override the window too:  <locations> <year> <startMonth> <endMonth>
 *   node tmp_generateRevenueReport_Jan_Jul.js "Andheri,Thane" 2026 1 7
 *
 * ── Output ──────────────────────────────────────────────────────────────────
 *   src/report/Monthwise_Revenue_2026_vs_2025_01-07.xlsx
 *   (filename is derived by the model from year / previousYear / start / end)
 *
 * DELETE THIS FILE once the workbook has been generated.
 * ---------------------------------------------------------------------------
 */

const {
  generateMonthwiseRevenueExcel,
} = require("../src/models/monthlyRevenueReportModel");

/* ── Config ──────────────────────────────────────────────────────────────── */

// Same four branches as the Jan–Jun revenue workbook. Note the model preserves
// this array's order for the By Location sheets (it does NOT sort by revenue,
// unlike the surgery report), so keep the order you want in the output.
const DEFAULT_LOCATIONS = ["Andheri", "Navi Mumbai", "Thane", "Vashi"];

const argLocations = (process.argv[2] || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const LOCATIONS = argLocations.length ? argLocations : DEFAULT_LOCATIONS;

const OPTIONS = {
  year: Number(process.argv[3]) || 2026,
  previousYear: Number(process.argv[3]) ? Number(process.argv[3]) - 1 : 2025,
  startMonth: Number(process.argv[4]) || 1,
  endMonth: Number(process.argv[5]) || 7, // ← July (was 6)
};

/* ── Run ─────────────────────────────────────────────────────────────────── */

(async () => {
  const t0 = Date.now();
  const inr = (n) => Math.round(Number(n) || 0).toLocaleString("en-IN");

  const monthCount = OPTIONS.endMonth - OPTIONS.startMonth + 1;

  console.log("──────────────────────────────────────────────────────────");
  console.log("Month-wise Total Revenue Report (temporary runner)");
  console.log(
    `Window   : ${OPTIONS.startMonth}–${OPTIONS.endMonth} | ` +
      `${OPTIONS.year} vs ${OPTIONS.previousYear}`,
  );
  console.log(`Branches : ${LOCATIONS.join(", ")}`);
  console.log(
    `Workload : ~${LOCATIONS.length * 2 * monthCount} summary calls ` +
      `in ${2 * monthCount} sequential steps — this one is slow, be patient.`,
  );
  console.log("──────────────────────────────────────────────────────────");

  try {
    const result = await generateMonthwiseRevenueExcel(LOCATIONS, OPTIONS);
    const { report } = result;
    const { current, previous, change } = report.totals;

    console.log(`\n✅ Workbook written: ${result.filePath}`);
    console.log("   Sheets follow the same layout as the Jan–Jun file.");

    // Quick sanity print so you can eyeball the numbers before circulating it.
    console.log(
      `\nTotals (${report.period.months}) ` +
        `— ${report.period.year} vs ${report.period.previousYear}:`,
    );
    console.log(
      `   OPD          ₹ ${inr(current.opd).padStart(14)}  vs ${inr(previous.opd).padStart(14)}`,
    );
    console.log(
      `   IPD billed   ₹ ${inr(current.ipdInvoice).padStart(14)}  vs ${inr(previous.ipdInvoice).padStart(14)}`,
    );
    console.log(
      `   Pharmacy     ₹ ${inr(current.pharmacy).padStart(14)}  vs ${inr(previous.pharmacy).padStart(14)}`,
    );
    console.log(`   ─────────────────────────────────────────────────────────`);
    console.log(
      `   GRAND TOTAL  ₹ ${inr(current.total).padStart(14)}  vs ${inr(previous.total).padStart(14)}` +
        `   (${change.pct === null ? "N/A" : change.pct + "%"})`,
    );
    console.log(
      `   [IPD cash collection, NOT in total: ₹ ${inr(current.ipdCollection)} vs ₹ ${inr(previous.ipdCollection)}]`,
    );

    console.log("\nMonth-wise grand total (₹):");
    report.months.forEach((m) => {
      console.log(
        `   ${m.monthName.padEnd(10)} ${inr(m.current.total).padStart(14)}` +
          `  vs ${inr(m.previous.total).padStart(14)}`,
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

    console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    // mysql pools keep the event loop alive — exit explicitly.
    process.exit(0);
  } catch (err) {
    console.error(
      "\n❌ Revenue report generation failed:",
      err?.message || err,
    );
    console.error(err?.stack || "");
    process.exit(1);
  }
})();
