/**
 * tmp_generateSurgeryReport_Jan_Jul.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * One-off runner for the month-wise surgery report, widened to Jan–JULY:
 *
 *      Jan–Jul 2026   vs   Jan–Jul 2025
 *
 * Same workbook layout as Monthwise_Surgeries_2026_vs_2025_01-06.xlsx, now with
 * the INTERBRANCH rule applied (options.interbranch = true):
 *
 *   An interbranch surgery has the same invoice in two branch DBs; it belongs
 *   to the SOURCE branch. The operating branch's copy is excluded — the same
 *   rule the app uses (src/models/utils/interbranch.js; DP Road always
 *   counted). Every surgery count and revenue figure is therefore NET, and an
 *   interbranch surgery is counted once across the group instead of twice.
 *
 * Where the difference is shown:
 *   Monthly Totals / Location Summary   + IB excl. surgeries & revenue, both years
 *   Interbranch <year> (×2, new)        location × month: excluded # and ₹
 *   By Surgery Type / Loc-Type sheets   net only (excluded cases carry no type)
 *   Gross = net + excluded, exactly, for surgeries and revenue.
 *
 * ── Place this file in temp/ ─────────────────────────────────────────────────
 * It requires ../src/models/surgeryRevenueReportModel (and, through it,
 * src/models/utils/interbranch.js and databaseUtils).
 *
 * ── Run ─────────────────────────────────────────────────────────────────────
 *   node temp/tmp_generateSurgeryReport_Jan_Jul.js
 *
 *   # override branches (comma-separated, must match getConnectionByLocation keys)
 *   node temp/tmp_generateSurgeryReport_Jan_Jul.js "Navi Mumbai,Andheri,Thane,Vashi"
 *
 *   # override the window too:  <locations> <year> <startMonth> <endMonth>
 *   node temp/tmp_generateSurgeryReport_Jan_Jul.js "Andheri,Thane" 2026 1 7
 *
 * ── Output ──────────────────────────────────────────────────────────────────
 *   src/report/Monthwise_Surgeries_2026_vs_2025_01-07_IPDnet.xlsx
 *   (_IPDnet marks the interbranch-adjusted file, so it never overwrites the
 *   earlier gross workbook)
 *
 * DELETE THIS FILE once the workbook has been generated.
 * ---------------------------------------------------------------------------
 */

const {
  generateMonthwiseSurgeryExcel,
} = require("../src/models/surgeryRevenueReportModel");

/* ── Config ──────────────────────────────────────────────────────────────── */

// Same four branches as the Jan–Jun workbook, so the two files are comparable.
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
  endMonth: Number(process.argv[5]) || 7, // ← July (was 6)
  interbranch: true, // exclude operating-branch copies; report them apart
};

/* ── Run ─────────────────────────────────────────────────────────────────── */

(async () => {
  const t0 = Date.now();

  console.log("──────────────────────────────────────────────────────────");
  console.log(
    "Month-wise Surgery Report — net of interbranch (temporary runner)",
  );
  console.log(
    `Window   : ${OPTIONS.startMonth}–${OPTIONS.endMonth} | ` +
      `${OPTIONS.year} vs ${OPTIONS.previousYear}`,
  );
  console.log(`Branches : ${LOCATIONS.join(", ")}`);
  console.log("──────────────────────────────────────────────────────────");

  try {
    const result = await generateMonthwiseSurgeryExcel(LOCATIONS, OPTIONS);
    const { report } = result;
    const { current, previous } = report.totals;

    console.log(`\n✅ Workbook written: ${result.filePath}`);
    console.log(
      `   Same layout as the Jan–Jun file, net of interbranch, plus ` +
        `IB columns and 'Interbranch ${report.period.year}/${report.period.previousYear}' sheets.`,
    );

    // Quick sanity print so you can eyeball the numbers before mailing it out.
    console.log(
      `\nTotals (${report.period.months}) ` +
        `— ${report.period.year} vs ${report.period.previousYear}:`,
    );
    const inr = (n) => Math.round(Number(n) || 0).toLocaleString("en-IN");
    const ci = current.interbranch || { surgeries: 0, revenue: 0 };
    const pi = previous.interbranch || { surgeries: 0, revenue: 0 };
    console.log(
      `   Surgeries (net) : ${current.surgeries}  vs  ${previous.surgeries}` +
        `   (Δ ${current.surgeries - previous.surgeries})`,
    );
    console.log(
      `   Revenue ₹ (net) : ${inr(current.revenue)}  vs  ${inr(previous.revenue)}`,
    );
    console.log(
      `   Interbranch excl: ${ci.surgeries} SX · ₹ ${inr(ci.revenue)}` +
        `  vs  ${pi.surgeries} SX · ₹ ${inr(pi.revenue)}`,
    );
    console.log(
      `   [gross would be ${current.surgeries + ci.surgeries} SX · ₹ ${inr(current.revenue + ci.revenue)}` +
        `  vs  ${previous.surgeries + pi.surgeries} SX · ₹ ${inr(previous.revenue + pi.revenue)}]`,
    );

    console.log("\nMonth-wise surgeries (net)   [interbranch excluded]:");
    report.months.forEach((m) => {
      console.log(
        `   ${m.monthName.padEnd(10)} ${String(m.current.surgeries).padStart(5)}` +
          `  vs ${String(m.previous.surgeries).padStart(5)}` +
          `   [${m.current.interbranch?.surgeries || 0} vs ${m.previous.interbranch?.surgeries || 0}]`,
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
    console.error("\n❌ Report generation failed:", err?.message || err);
    console.error(err?.stack || "");
    process.exit(1);
  }
})();
