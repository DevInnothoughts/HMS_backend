/**
 * tmp_generateApprovalStatusReport_Jun_Aug.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * Branch-wise DAILY SIGN-OFF COUNTS from the `approval` table:
 *
 *      Partner (user1)  and  Cluster Head (user2)
 *      1 Jun 2026 → 31 Aug 2026  (92 days)
 *
 * Numbers only — no previous-year comparison.
 *
 * ── Rule ────────────────────────────────────────────────────────────────────
 *   user1 IS NOT NULL  → Partner approved that day
 *   user2 IS NOT NULL  → Cluster Head approved that day
 *
 *   Not approved = days in the period − approved days.
 *
 *   approvalModel.addApprovalDetails only INSERTs a row for a date when
 *   someone signs off, so a day nobody touched has NO ROW at all. Counting
 *   only rows with NULLs would miss those days; counting from the calendar
 *   catches them. A date is counted once even if it somehow has two rows
 *   (approved if any of its rows has the value).
 *
 * ── Branches ────────────────────────────────────────────────────────────────
 *   The same list targetComparisonNewModel uses for "all branches"
 *   (DEFAULT_LOCATIONS — not exported there, so copied below). A branch whose
 *   DB can't be reached or has no `approval` table is still listed, with the
 *   error in the Note column, so a missing branch is visible, not silent.
 *
 * ── Place ───────────────────────────────────────────────────────────────────
 *   In temp/ (beside the other tmp_ scripts). Paths resolve from the project
 *   root one level up.
 *
 * ── Run ─────────────────────────────────────────────────────────────────────
 *   node temp/tmp_generateApprovalStatusReport_Jun_Aug.js
 *   node temp/tmp_generateApprovalStatusReport_Jun_Aug.js "Baner,Undri"
 *   node temp/tmp_generateApprovalStatusReport_Jun_Aug.js "" 2026-06-01 2026-08-31
 *
 * ── Output ──────────────────────────────────────────────────────────────────
 *   src/report/Approval_Status_2026-06-01_to_2026-08-31.xlsx
 *
 * DELETE THIS FILE once the workbook has been generated.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");

const ROOT = path.resolve(__dirname, "..");
const { getConnectionByLocation } = require(path.join(ROOT, "databaseUtils"));

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

// Inclusive day count. Jun 1 → Aug 31 = 30 + 31 + 31 = 92.
const DAYS =
  Math.round(
    (Date.parse(`${TO}T00:00:00Z`) - Date.parse(`${FROM}T00:00:00Z`)) /
      86400000,
  ) + 1;

const reportsDir = path.join(ROOT, "src", "report");
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

/* ── SQL ─────────────────────────────────────────────────────────────────── */

// DATE_FORMAT normalises the key whether `date` is a DATE or a 'YYYY-MM-DD'
// VARCHAR (approvalModel writes it as that string), so the driver never hands
// back a JS Date shifted by the server timezone.
const APPROVAL_SQL = `
  SELECT
    DATE_FORMAT(\`date\`, '%Y-%m-%d') AS d,
    MAX(CASE WHEN user1 IS NOT NULL THEN 1 ELSE 0 END) AS partner,
    MAX(CASE WHEN user2 IS NOT NULL THEN 1 ELSE 0 END) AS clusterHead
  FROM approval
  WHERE \`date\` BETWEEN ? AND ?
  GROUP BY DATE_FORMAT(\`date\`, '%Y-%m-%d')
`;

/* ── Per-branch fetch ────────────────────────────────────────────────────── */

async function collectBranch(loc) {
  const { connection } = getConnectionByLocation(loc);
  if (!connection) throw new Error("no DB connection for this name");

  const rows = await new Promise((res, rej) =>
    connection.query(APPROVAL_SQL, [FROM, TO], (e, r) =>
      e ? rej(e) : res(r),
    ),
  );

  let partner = 0;
  let clusterHead = 0;
  for (const r of rows) {
    // Belt and braces: ignore anything the BETWEEN let through outside range.
    if (!r.d || r.d < FROM || r.d > TO) continue;
    if (Number(r.partner) === 1) partner++;
    if (Number(r.clusterHead) === 1) clusterHead++;
  }
  return { partner, clusterHead };
}

/* ── Workbook ────────────────────────────────────────────────────────────── */

const HEADERS = [
  "Branch",
  "Days in period",
  "Partner — Approved",
  "Partner — Not approved",
  "Cluster Head — Approved",
  "Cluster Head — Not approved",
  "Note",
];

function buildWorkbook(results) {
  const ok = results.filter((r) => !r.error);
  const sum = (k) => ok.reduce((a, r) => a + r[k], 0);

  const aoa = [
    [`Partner & Cluster Head approval status — ${FROM} to ${TO}`],
    [
      "Approved = user1 (Partner) / user2 (Cluster Head) is not NULL for that date. " +
        "Not approved = days in period − approved days (includes days with no approval row).",
    ],
    [],
    HEADERS,
    ...results.map((r) =>
      r.error
        ? [r.branch, DAYS, null, null, null, null, `Not counted: ${r.error}`]
        : [
            r.branch,
            DAYS,
            r.partner,
            DAYS - r.partner,
            r.clusterHead,
            DAYS - r.clusterHead,
            "",
          ],
    ),
    [
      `Total (${ok.length} branch${ok.length === 1 ? "" : "es"})`,
      DAYS * ok.length,
      sum("partner"),
      DAYS * ok.length - sum("partner"),
      sum("clusterHead"),
      DAYS * ok.length - sum("clusterHead"),
      "",
    ],
  ];

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 24 },
    { wch: 15 },
    { wch: 20 },
    { wch: 24 },
    { wch: 24 },
    { wch: 28 },
    { wch: 44 },
  ];
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 6 } },
  ];
  // Freeze above the first branch row so headers stay visible.
  ws["!views"] = [{ state: "frozen", ySplit: 4 }];

  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, "Approval Status");
  return wb;
}

/* ── Main ────────────────────────────────────────────────────────────────── */

(async () => {
  console.log(
    `Approval status ${FROM} → ${TO} (${DAYS} days), ${LOCATIONS.length} branches`,
  );

  const results = [];
  // One branch at a time — ~40 pools, no need to open them all at once.
  for (const branch of LOCATIONS) {
    try {
      const r = await collectBranch(branch);
      results.push({ branch, ...r });
      console.log(
        `  ✓ ${branch.padEnd(20)} partner ${String(r.partner).padStart(3)} / ${DAYS}` +
          `   cluster head ${String(r.clusterHead).padStart(3)} / ${DAYS}`,
      );
    } catch (e) {
      results.push({ branch, error: e.message });
      console.log(`  ✗ ${branch.padEnd(20)} ${e.message}`);
    }
  }

  const file = path.join(reportsDir, `Approval_Status_${FROM}_to_${TO}.xlsx`);
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
