/**
 * tmp_generateConversionReport_Jun_Aug.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * Branch-wise NEW PATIENT → SURGERY CONVERSION
 *      1 Jun 2026 → 31 Aug 2026
 *
 * Numbers only — no previous-year comparison.
 *
 * ── Definitions — identical to the Target Comparison screen ────────────────
 * (targetComparisonNewModel.getNewPatientCount / getIpdInvoiceActuals), so
 * these figures reconcile with what the app shows for the same dates.
 *
 *   New patients  appointment rows: patient_type='New' AND is_deleted!=1
 *                 AND executivechk=2, appointment_timestamp in range.
 *                 (Rows, not distinct people — same as the app.)
 *
 *   Surgeries     IPD invoices: is_deleted!=1, creation_date in range, with
 *                 the INTERBRANCH RULE applied (utils/interbranch.countedSql —
 *                 required below, not copied, so it stays in step). Cases
 *                 operated here for another branch count at the source
 *                 branch and are shown separately in their own column.
 *
 *   Conversion %  Surgeries ÷ New patients for the period.
 *
 * ⚠ This is a PERIOD ratio, not a cohort: a surgery in June can belong to a
 *   patient who first came in May, and a June new patient may be operated in
 *   September. It is the same ratio the app's "Conversion" figure uses.
 *
 * ── Branches ────────────────────────────────────────────────────────────────
 *   targetComparisonNewModel DEFAULT_LOCATIONS (copied — not exported there).
 *   A branch that fails is still listed with the reason in the Note column
 *   and left out of the total.
 *
 * ── Place ───────────────────────────────────────────────────────────────────
 *   In temp/ (beside the other tmp_ scripts). Paths resolve from the project
 *   root one level up.
 *
 * ── Run ─────────────────────────────────────────────────────────────────────
 *   node temp/tmp_generateConversionReport_Jun_Aug.js
 *   node temp/tmp_generateConversionReport_Jun_Aug.js "Baner,Undri"
 *   node temp/tmp_generateConversionReport_Jun_Aug.js "" 2026-06-01 2026-08-31
 *
 * ── Output ──────────────────────────────────────────────────────────────────
 *   src/report/New_to_Surgery_Conversion_2026-06-01_to_2026-08-31.xlsx
 *
 * DELETE THIS FILE once the workbook has been generated.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");

const ROOT = path.resolve(__dirname, "..");
const { getConnectionByLocation } = require(path.join(ROOT, "databaseUtils"));
const { countedSql } = require(
  path.join(ROOT, "src", "models", "utils", "interbranch"),
);

/* ── Config ──────────────────────────────────────────────────────────────── */

// Copied from targetComparisonNewModel.js DEFAULT_LOCATIONS.
const DEFAULT_LOCATIONS = [
  "DP Road",
  "Andheri",
  "Baner",
  "Belgavi",
  "Chakan",
  "Chinchwad",
  "Dighi",
  "Gurgaon Sector 14",
  "Gurgaon Sector 49",
  "Hinjewadi",
  "HSR",
  "Hyderabad",
  "Indiranagar",
  "JP Nagar",
  "Kalaburagi",
  "Latur",
  "Ludhiana",
  "Lucknow",
  "Mysore",
  "Nashik",
  "Navi Mumbai",
  "Salunke Vihar",
  "Sahakar Nagar",
  "Secunderabad",
  "Surat",
  "Thane",
  "Undri",
  "Vashi",
  "Rajaji Nagar",
  "Sarjapura",
  "Katraj",
  "Ahmedabad",
  "Mohali",
  "Aurangabad",
  "Whitefield",
  "Hadapsar",
  "Kalyan",
  "Bopal",
  "Electronic City",
  "RR Nagar",
  "Adajan",
  "Raipur",
];

const argLocations = (process.argv[2] || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const LOCATIONS = argLocations.length ? argLocations : DEFAULT_LOCATIONS;

const FROM = process.argv[3] || "2026-06-01";
const TO = process.argv[4] || "2026-08-31";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
if (!ISO.test(FROM) || !ISO.test(TO) || FROM > TO) {
  console.error(`Bad date range: ${FROM} → ${TO} (expected YYYY-MM-DD)`);
  process.exit(1);
}

const reportsDir = path.join(ROOT, "src", "report");
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

/* ── SQL — byte-for-byte the Target Comparison filters ───────────────────── */

const NEW_PATIENT_SQL = `
  SELECT COUNT(patient_type) AS newpatient
    FROM appointment
   WHERE appointment_timestamp BETWEEN ? AND ?
     AND patient_type = 'New' AND is_deleted != 1 AND executivechk = 2
`;

const counted = countedSql("i");
const SURGERY_SQL = `
  SELECT
    SUM(CASE WHEN ${counted} THEN 1 ELSE 0 END) AS cnt,
    SUM(CASE WHEN ${counted} THEN 0 ELSE 1 END) AS ib_cnt
  FROM invoice i
  WHERE i.creation_date >= ? AND i.creation_date <= ? AND i.is_deleted != 1
`;

/* ── Per-branch fetch ────────────────────────────────────────────────────── */

async function collectBranch(loc) {
  const { connection } = getConnectionByLocation(loc);
  if (!connection) throw new Error("no DB connection for this name");

  const run = (sql, params) =>
    new Promise((res, rej) =>
      connection.query(sql, params, (e, r) => (e ? rej(e) : res(r))),
    );

  const [[np], [sx]] = await Promise.all([
    run(NEW_PATIENT_SQL, [FROM, TO]),
    run(SURGERY_SQL, [`${FROM} 00:00:00`, `${TO} 23:59:59`]),
  ]);

  return {
    newPatients: Number(np?.newpatient) || 0,
    surgeries: Number(sx?.cnt) || 0,
    interbranch: Number(sx?.ib_cnt) || 0,
  };
}

/* ── Workbook ────────────────────────────────────────────────────────────── */

const HEADERS = [
  "Branch",
  "New patients",
  "Surgeries",
  "Conversion %",
  "Interbranch surgeries (excluded)",
  "Note",
];

// As a FRACTION for Excel's percent format; null when there are no new
// patients (no divide-by-zero, shown blank).
const conv = (sx, np) => (np > 0 ? sx / np : null);

function buildWorkbook(results) {
  const ok = results.filter((r) => !r.error);
  const sum = (k) => ok.reduce((a, r) => a + r[k], 0);
  const totNp = sum("newPatients");
  const totSx = sum("surgeries");

  const aoa = [
    [`New patient → surgery conversion — ${FROM} to ${TO}`],
    [
      "Same definitions as the Target Comparison screen. Conversion = surgeries ÷ new patients in the period " +
        "(a period ratio, not a cohort). Interbranch cases operated here count at the source branch.",
    ],
    [],
    HEADERS,
    ...results.map((r) =>
      r.error
        ? [r.branch, null, null, null, null, `Not counted: ${r.error}`]
        : [
            r.branch,
            r.newPatients,
            r.surgeries,
            conv(r.surgeries, r.newPatients),
            r.interbranch,
            r.newPatients === 0 ? "No new patients in period" : "",
          ],
    ),
    [
      `Total (${ok.length} branch${ok.length === 1 ? "" : "es"})`,
      totNp,
      totSx,
      conv(totSx, totNp),
      sum("interbranch"),
      "",
    ],
  ];

  const ws = xlsx.utils.aoa_to_sheet(aoa);

  // Number formats: counts with thousands separators, conversion as %.
  const firstData = 4;
  const lastData = aoa.length - 1;
  for (let r = firstData; r <= lastData; r++) {
    for (const c of [1, 2, 4]) {
      const cell = ws[xlsx.utils.encode_cell({ r, c })];
      if (cell && cell.t === "n") cell.z = "#,##0";
    }
    const pc = ws[xlsx.utils.encode_cell({ r, c: 3 })];
    if (pc && pc.t === "n") pc.z = "0.0%";
  }

  ws["!cols"] = [
    { wch: 24 },
    { wch: 14 },
    { wch: 12 },
    { wch: 14 },
    { wch: 30 },
    { wch: 44 },
  ];
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 5 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 5 } },
  ];
  ws["!views"] = [{ state: "frozen", ySplit: 4 }];

  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, "Conversion");
  return wb;
}

/* ── Main ────────────────────────────────────────────────────────────────── */

(async () => {
  console.log(
    `New → surgery conversion ${FROM} → ${TO}, ${LOCATIONS.length} branches`,
  );

  const results = [];
  for (const branch of LOCATIONS) {
    try {
      const r = await collectBranch(branch);
      results.push({ branch, ...r });
      const c = conv(r.surgeries, r.newPatients);
      console.log(
        `  ✓ ${branch.padEnd(20)} new ${String(r.newPatients).padStart(5)}` +
          `   sx ${String(r.surgeries).padStart(4)}` +
          `   ${c == null ? '  —  ' : (c * 100).toFixed(1).padStart(5) + '%'}` +
          (r.interbranch ? `   (+${r.interbranch} IB excl.)` : ""),
      );
    } catch (e) {
      results.push({ branch, error: e.message });
      console.log(`  ✗ ${branch.padEnd(20)} ${e.message}`);
    }
  }

  const file = path.join(
    reportsDir,
    `New_to_Surgery_Conversion_${FROM}_to_${TO}.xlsx`,
  );
  xlsx.writeFile(buildWorkbook(results), file);

  const failed = results.filter((r) => r.error).length;
  console.log(`\nWritten: ${file}`);
  if (failed) console.log(`⚠ ${failed} branch(es) not counted — see Note column.`);

  // The DB pools keep the event loop alive; exit explicitly.
  process.exit(0);
})().catch((e) => {
  console.error("Failed:", e);
  process.exit(1);
});
