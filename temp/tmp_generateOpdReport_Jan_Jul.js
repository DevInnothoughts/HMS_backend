/**
 * tmp_generateOpdReport_Jan_Jul.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * One-off runner for the month-wise OPD report, widened to Jan–JULY:
 *
 *      Jan–Jul 2026   vs   Jan–Jul 2025
 *
 * Same workbook layout as Monthwise_OPD_2026_vs_2025_01-06.xlsx — this only
 * changes the window (endMonth 6 → 7). No model code is touched:
 * getMonthwiseOpdReport already takes { year, previousYear, startMonth,
 * endMonth }, and every sheet builder reads period.monthList / monthNames, so
 * July flows through Monthly Totals, Location Summary and all four
 * Location × Month matrices automatically.
 *
 * OPD is read from `patient_itemreceipt` bucketed on MONTH(item_date):
 *   OPD Number  = COUNT(DISTINCT receipt_id)
 *   OPD Revenue = SUM(total)
 * item_date is a DATE column, so July's boundary is exact — no timezone drift.
 *
 * ── Place this file at the PROJECT ROOT ──────────────────────────────────────
 * (next to app.js / databaseUtils.js / dbconfig.js), because it requires
 * ./src/models/opdRevenueReportModel, which resolves ../../databaseUtils
 * from src/models.
 *
 * ── Run ─────────────────────────────────────────────────────────────────────
 *   node tmp_generateOpdReport_Jan_Jul.js
 *
 *   # override branches (comma-separated, must match getConnectionByLocation keys)
 *   node tmp_generateOpdReport_Jan_Jul.js "Navi Mumbai,Andheri,Thane,Vashi"
 *
 *   # override the window too:  <locations> <year> <startMonth> <endMonth>
 *   node tmp_generateOpdReport_Jan_Jul.js "Andheri,Thane" 2026 1 7
 *
 * ── Output ──────────────────────────────────────────────────────────────────
 *   src/report/Monthwise_OPD_2026_vs_2025_01-07.xlsx
 *   (filename is derived by the model from year / previousYear / start / end)
 *
 * DELETE THIS FILE once the workbook has been generated.
 * ---------------------------------------------------------------------------
 */

const {
  generateMonthwiseOpdExcel,
} = require("../src/models/opdRevenueReportModel");

/* ── Config ──────────────────────────────────────────────────────────────── */

// Same four branches as the Jan–Jun OPD workbook, so the two files line up.
// Keep the strings exactly as getConnectionByLocation expects them.
const DEFAULT_LOCATIONS = ["Navi Mumbai", "Andheri", "Thane", "Vashi"];

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
  const inr = (n) => Number(n || 0).toLocaleString("en-IN");

  console.log("──────────────────────────────────────────────────────────");
  console.log("Month-wise OPD Report (temporary runner)");
  console.log(
    `Window   : ${OPTIONS.startMonth}–${OPTIONS.endMonth} | ` +
      `${OPTIONS.year} vs ${OPTIONS.previousYear}`,
  );
  console.log(`Branches : ${LOCATIONS.join(", ")}`);
  console.log("──────────────────────────────────────────────────────────");

  try {
    const result = await generateMonthwiseOpdExcel(LOCATIONS, OPTIONS);
    const { report } = result;
    const { current, previous } = report.totals;

    console.log(`\n✅ Workbook written: ${result.filePath}`);
    console.log("   Sheets follow the same layout as the Jan–Jun file.");

    // Quick sanity print so you can eyeball the numbers before circulating it.
    console.log(
      `\nTotals (${report.period.months}) ` +
        `— ${report.period.year} vs ${report.period.previousYear}:`,
    );
    console.log(
      `   OPD Number : ${inr(current.count)}  vs  ${inr(previous.count)}` +
        `   (Δ ${current.count - previous.count})`,
    );
    console.log(
      `   OPD Revenue ₹ : ${inr(current.revenue)}  vs  ${inr(previous.revenue)}`,
    );
    console.log(
      `   Avg / OPD ₹   : ${inr(current.avgRevenue)}  vs  ${inr(previous.avgRevenue)}`,
    );

    console.log("\nMonth-wise OPD number:");
    report.months.forEach((m) => {
      console.log(
        `   ${m.monthName.padEnd(10)} ${String(m.current.count).padStart(7)}` +
          `  vs ${String(m.previous.count).padStart(7)}`,
      );
    });

    if (report.locationsFailed?.length) {
      console.warn("\n⚠️  Skipped branches (see 'Skipped Locations' sheet):");
      report.locationsFailed.forEach((f) =>
        console.warn(`   • ${f.location}: ${f.error}`),
      );
    }

    console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    // mysql pools keep the event loop alive — exit explicitly.
    process.exit(0);
  } catch (err) {
    console.error("\n❌ OPD report generation failed:", err?.message || err);
    console.error(err?.stack || "");
    process.exit(1);
  }
})();
