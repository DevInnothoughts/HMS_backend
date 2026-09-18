/**
 * tmp_generateFeedbackReport.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * All-branch patient feedback workbook for a date range.
 *
 *      Summary        one row per branch + an ALL BRANCHES total
 *      <Branch>       one sheet per branch: responses, then awaiting patients
 *
 * Same cell styling as the in-app export (src/screens/feedbackExcel.js), so the
 * two files read as the same family of document.
 *
 * ── Place this file in temp/ ────────────────────────────────────────────────
 * (alongside tmp_generateOpdReport_Jan_Jul.js etc.) because it requires
 * ../src/models/overview/ipdFeedbackModel, which resolves ../../databaseUtils
 * from src/models.
 *
 * ── ⚠️ REQUIRES xlsx-js-style, NOT xlsx ─────────────────────────────────────
 *      npm i xlsx-js-style
 *
 * The other temp runners use plain `xlsx`, which accepts the `s` (style)
 * property and then throws it away on write — the workbook comes out entirely
 * unformatted, with no error and no warning. xlsx-js-style is a drop-in fork of
 * the same API that honours it. If you would rather not add the dependency,
 * strip every `mk(value, STYLE)` back to a bare value and accept a plain grid.
 *
 * ── Call it from app.js ─────────────────────────────────────────────────────
 *   const {
 *     generateAllBranchFeedbackExcel,
 *   } = require("./temp/tmp_generateFeedbackReport");
 *
 *   generateAllBranchFeedbackExcel({ from: "2026-08-01", to: "2026-08-29" })
 *     .then(r => console.log("Feedback workbook:", r.filePath))
 *     .catch(e => console.error("Feedback workbook failed:", e.message));
 *
 * It runs once at boot and writes a file — it does NOT hold the server up, and
 * a failure is logged rather than thrown, so a bad branch cannot stop app.js
 * from starting. REMOVE THOSE LINES once you have the workbook.
 *
 * ── Or run it standalone ────────────────────────────────────────────────────
 *   node temp/tmp_generateFeedbackReport.js 2026-08-01 2026-08-29
 *   node temp/tmp_generateFeedbackReport.js 2026-08-01 2026-08-29 "Thane,Andheri"
 *
 * ── Output ──────────────────────────────────────────────────────────────────
 *   src/report/Patient_Feedback_AllBranches_<from>_to_<to>.xlsx
 *
 * ⚠️  This workbook contains patient names, phone numbers and their feedback.
 *     Share it only over approved channels, and delete both the script and the
 *     file when done.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx-js-style");

const { locations } = require("../databaseUtils");
const { getIpdFeedback } = require("../src/models/overview/ipdFeedbackModel");

/* ── Config ──────────────────────────────────────────────────────────────── */

// Branches are read a few at a time. Each is its own database with a pool
// capped at 5 connections, so firing forty at once just queues them behind each
// other and risks timeouts on the slowest.
const BATCH = 4;

const reportsDir = path.join(__dirname, "..", "src", "report");

// databaseUtils exports only getConnectionByLocation — the branch names live in
// a switch, not an array. The other temp runners declare their own list for the
// same reason. Kept in sync by hand; note "DP Road" is commented out upstream.
const ALL_LOCATIONS = [
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

/* ── Palette — identical to the in-app export ────────────────────────────── */

const INK = "0F1A16";
const BRAND = "14603F";
const BAND_HEAD = "2A4438";
const GREEN = "1E7A5A";
const GREEN_SOFT = "E7F2EC";
const AMBER = "B26A00";
const AMBER_SOFT = "FBF0DD";
const RED = "B3382B";
const RED_SOFT = "F8E6E3";
const GREY = "9AA5B1";
const ZEBRA = "F7F9F8";

const THIN = { style: "thin", color: { rgb: "D9E0DC" } };
const BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };

const mk = (v, s) => ({ v, s });

const ST_TITLE = {
  font: { bold: true, sz: 15, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: INK } },
  alignment: { horizontal: "left", vertical: "center" },
};
const ST_SUBTITLE = {
  font: { sz: 10, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: BAND_HEAD } },
  alignment: { horizontal: "left", vertical: "center" },
};
const ST_HEAD = {
  font: { bold: true, sz: 10, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: BRAND } },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
  border: BORDER,
};
const ST_GROUP = {
  font: { bold: true, sz: 10, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: BAND_HEAD } },
  alignment: { horizontal: "center", vertical: "center" },
  border: BORDER,
};
const ST_LABEL = {
  font: { sz: 10, color: { rgb: "16211D" } },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER,
};
const ST_LABEL_ALT = { ...ST_LABEL, fill: { fgColor: { rgb: ZEBRA } } };
const ST_TOTAL = {
  font: { bold: true, sz: 10, color: { rgb: "16211D" } },
  fill: { fgColor: { rgb: "EDF2EF" } },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER,
};
const ST_TOTAL_NUM = {
  ...ST_TOTAL,
  alignment: { horizontal: "center", vertical: "center" },
};
const ST_NOTE = {
  font: { italic: true, sz: 9, color: { rgb: "6C7C75" } },
  alignment: { horizontal: "left", vertical: "center", wrapText: true },
};
const ST_DASH = {
  font: { sz: 10, color: { rgb: GREY } },
  alignment: { horizontal: "center", vertical: "center" },
  border: BORDER,
};

const centred = (extra = {}) => ({
  font: { sz: 10 },
  alignment: { horizontal: "center", vertical: "center" },
  border: BORDER,
  ...extra,
});

const scoreStyle = (v, alt) => {
  if (v == null)
    return alt ? { ...ST_DASH, fill: { fgColor: { rgb: ZEBRA } } } : ST_DASH;
  const [fg, bg] =
    v >= 9
      ? [GREEN, GREEN_SOFT]
      : v >= 7
        ? [AMBER, AMBER_SOFT]
        : [RED, RED_SOFT];
  return {
    font: { bold: true, sz: 10, color: { rgb: fg } },
    fill: { fgColor: { rgb: bg } },
    alignment: { horizontal: "center", vertical: "center" },
    border: BORDER,
  };
};

const psiStyle = (v, alt) => {
  if (v == null)
    return alt ? { ...ST_DASH, fill: { fgColor: { rgb: ZEBRA } } } : ST_DASH;
  const [fg, bg] =
    v >= 85
      ? [GREEN, GREEN_SOFT]
      : v >= 70
        ? [AMBER, AMBER_SOFT]
        : [RED, RED_SOFT];
  return {
    numFmt: '0"%"',
    font: { bold: true, sz: 10, color: { rgb: fg } },
    fill: { fgColor: { rgb: bg } },
    alignment: { horizontal: "center", vertical: "center" },
    border: BORDER,
  };
};

const ratingStyle = (v, alt) => {
  if (v == null)
    return alt ? { ...ST_DASH, fill: { fgColor: { rgb: ZEBRA } } } : ST_DASH;
  const bg =
    v >= 5 ? GREEN_SOFT : v >= 4 ? "F0F6F2" : v >= 3 ? AMBER_SOFT : RED_SOFT;
  const fg = v >= 4 ? GREEN : v >= 3 ? AMBER : RED;
  return {
    font: { bold: v <= 2, sz: 10, color: { rgb: fg } },
    fill: { fgColor: { rgb: bg } },
    alignment: { horizontal: "center", vertical: "center" },
    border: BORDER,
  };
};

// NPS runs −100 to +100, so it needs its own scale. The 9/7 thresholds that
// band an individual recommend score do not apply to it.
const npsStyle = (v) => {
  if (v == null) return ST_DASH;
  const [fg, bg] =
    v >= 50
      ? [GREEN, GREEN_SOFT]
      : v >= 0
        ? [AMBER, AMBER_SOFT]
        : [RED, RED_SOFT];
  return {
    font: { bold: true, sz: 10, color: { rgb: fg } },
    fill: { fgColor: { rgb: bg } },
    alignment: { horizontal: "center", vertical: "center" },
    border: BORDER,
  };
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const BAND_LABEL = {
  promoter: "Promoter",
  passive: "Passive",
  detractor: "Detractor",
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const fmtDate = (d) => {
  if (!d) return "";
  const [y, m, day] = String(d).slice(0, 10).split("-");
  return m ? `${Number(day)} ${MONTHS[Number(m) - 1]} ${y}` : String(d);
};

// Excel sheet names: 31 characters max, and none of : \ / ? * [ ]
const sheetName = (name, used) => {
  const base =
    String(name)
      .replace(/[:\\/?*[\]]/g, "-")
      .slice(0, 28)
      .trim() || "Branch";
  let candidate = base;
  let i = 2;
  while (used.has(candidate)) candidate = `${base.slice(0, 26)}-${i++}`;
  used.add(candidate);
  return candidate;
};

/* ── Summary sheet ───────────────────────────────────────────────────────── */

function summarySheet(results, from, to) {
  const head = [
    "Branch",
    "Operated",
    "Responses",
    "Response %",
    "NPS",
    "Promoters",
    "Passives",
    "Detractors",
    "Avg PSI",
  ];

  const rows = [
    [mk("Patient Feedback — All Branches", ST_TITLE)],
    [mk(`${fmtDate(from)} to ${fmtDate(to)}`, ST_SUBTITLE)],
    [],
    head.map((h) => mk(h, ST_HEAD)),
  ];

  const tot = {
    operated: 0,
    responses: 0,
    promoters: 0,
    passives: 0,
    detractors: 0,
    psiSum: 0,
    psiCount: 0,
  };

  results
    .filter((r) => r.ok)
    .sort((a, b) => a.branch.localeCompare(b.branch))
    .forEach((r, i) => {
      const s = r.data.summary;
      const alt = i % 2 === 1;
      const base = alt ? ST_LABEL_ALT : ST_LABEL;
      const ctr = centred(alt ? { fill: { fgColor: { rgb: ZEBRA } } } : {});

      tot.operated += s.operated || 0;
      tot.responses += s.responses || 0;
      tot.promoters += s.promoters || 0;
      tot.passives += s.passives || 0;
      tot.detractors += s.detractors || 0;
      if (s.psiAvg != null) {
        // Weighted by responses — a branch with two replies should not swing
        // the group average as hard as one with sixty.
        tot.psiSum += s.psiAvg * (s.responses || 0);
        tot.psiCount += s.responses || 0;
      }

      rows.push([
        mk(r.branch, base),
        mk(s.operated ?? 0, ctr),
        mk(s.responses ?? 0, ctr),
        s.responseRatePct == null
          ? mk("—", ST_DASH)
          : mk(s.responseRatePct, { ...ctr, numFmt: '0"%"' }),
        s.nps == null ? mk("—", ST_DASH) : mk(s.nps, npsStyle(s.nps)),
        mk(s.promoters ?? 0, ctr),
        mk(s.passives ?? 0, ctr),
        mk(s.detractors ?? 0, ctr),
        s.psiAvg == null
          ? mk("—", ST_DASH)
          : mk(s.psiAvg, psiStyle(s.psiAvg, alt)),
      ]);
    });

  // Group NPS is recomputed from the POOLED bands. Averaging branch NPS values
  // would weight a 3-response branch the same as a 60-response one.
  const n = tot.promoters + tot.passives + tot.detractors;
  const groupNps =
    n > 0 ? Math.round(((tot.promoters - tot.detractors) / n) * 100) : null;
  const groupPsi =
    tot.psiCount > 0 ? Math.round(tot.psiSum / tot.psiCount) : null;

  rows.push([
    mk("ALL BRANCHES", ST_TOTAL),
    mk(tot.operated, ST_TOTAL_NUM),
    mk(tot.responses, ST_TOTAL_NUM),
    tot.operated > 0
      ? mk(Math.round((tot.responses / tot.operated) * 100), {
          ...ST_TOTAL_NUM,
          numFmt: '0"%"',
        })
      : mk("—", ST_DASH),
    groupNps == null ? mk("—", ST_DASH) : mk(groupNps, npsStyle(groupNps)),
    mk(tot.promoters, ST_TOTAL_NUM),
    mk(tot.passives, ST_TOTAL_NUM),
    mk(tot.detractors, ST_TOTAL_NUM),
    groupPsi == null ? mk("—", ST_DASH) : mk(groupPsi, psiStyle(groupPsi)),
  ]);

  rows.push([]);
  rows.push([
    mk(
      "NPS = % promoters − % detractors, pooled across branches rather than averaged. " +
        "PSI = total score achieved ÷ maximum possible × 100, weighted by responses. " +
        "Bands: promoter 9–10, passive 7–8, detractor 0–6.",
      ST_NOTE,
    ),
  ]);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    rows.push([]);
    rows.push([
      mk("Branches that could not be read", ST_GROUP),
      mk("Reason", ST_GROUP),
    ]);
    failed.forEach((f) =>
      rows.push([mk(f.branch, ST_LABEL), mk(f.error, ST_LABEL)]),
    );
  }

  const ws = xlsx.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 26 },
    { wch: 10 },
    { wch: 11 },
    { wch: 11 },
    { wch: 8 },
    { wch: 11 },
    { wch: 10 },
    { wch: 11 },
    { wch: 10 },
  ];
  ws["!rows"] = [{ hpt: 26 }, { hpt: 18 }];
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 8 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 8 } },
  ];
  ws["!freeze"] = { xSplit: 1, ySplit: 4 };
  return ws;
}

/* ── Per-branch sheet ────────────────────────────────────────────────────── */

function branchSheet(data) {
  const patients = data.patients || [];
  const responders = patients.filter((p) => p.responded);
  const pending = patients.filter((p) => !p.responded);

  // Question columns are read off the first response rather than hardcoded, so
  // an added question appears in the export without a code change here.
  const groups = responders[0]?.answers || [];
  const qCols = groups.flatMap((g) =>
    g.items.map((i) => ({ ...i, group: g.title })),
  );

  const head = [
    "Patient",
    "UID",
    "Phone",
    "Age",
    "Sex",
    "Surgery date",
    "Surgeon",
    "Room type",
    "Score",
    "Band",
    "PSI",
    "Achieved",
    "Max",
    ...qCols.map((c) => c.label),
  ];

  const bandRow = [
    ...Array(13).fill(mk("", ST_GROUP)),
    ...qCols.map((c) => mk(c.group, ST_GROUP)),
  ];

  const rows = [
    [mk("RESPONSES", ST_GROUP)],
    bandRow,
    head.map((h) => mk(h, ST_HEAD)),
  ];

  responders.forEach((p, idx) => {
    const alt = idx % 2 === 1;
    const base = alt ? ST_LABEL_ALT : ST_LABEL;
    const ctr = centred(alt ? { fill: { fgColor: { rgb: ZEBRA } } } : {});
    const answers = {};
    (p.answers || []).forEach((g) =>
      g.items.forEach((i) => (answers[i.key] = i.value)),
    );

    rows.push([
      mk(p.name || "", base),
      mk(p.uidNo || "", base),
      mk(p.phone || "", base),
      mk(p.age ?? "", ctr),
      mk(p.sex || "", ctr),
      mk(fmtDate(p.surgeryDate), ctr),
      mk(p.surgeon || "", base),
      mk(p.roomType || "", base),
      p.recommendScore == null
        ? mk("—", ST_DASH)
        : mk(p.recommendScore, scoreStyle(p.recommendScore, alt)),
      mk(p.band ? BAND_LABEL[p.band] : "—", ctr),
      p.psiPct == null
        ? mk("—", ST_DASH)
        : mk(p.psiPct, psiStyle(p.psiPct, alt)),
      mk(p.totalScoreAchieved ?? "", ctr),
      mk(p.maxPossibleScore ?? "", ctr),
      ...qCols.map((c) =>
        answers[c.key] == null
          ? mk("—", ST_DASH)
          : mk(answers[c.key], ratingStyle(answers[c.key], alt)),
      ),
    ]);
  });

  if (!responders.length) {
    rows.push([mk("No responses in this period.", ST_LABEL)]);
  }

  // Awaiting sits BELOW the responses on the same tab, so one branch is one
  // sheet. Its own header band stops the two blocks reading as one table.
  rows.push([]);
  rows.push([mk("AWAITING RESPONSE", ST_GROUP)]);
  rows.push(
    ["Patient", "UID", "Phone", "Surgery date", "Surgeon", "Room type"].map(
      (h) => mk(h, ST_HEAD),
    ),
  );

  pending.forEach((p, i) => {
    const alt = i % 2 === 1;
    const base = alt ? ST_LABEL_ALT : ST_LABEL;
    const ctr = centred(alt ? { fill: { fgColor: { rgb: ZEBRA } } } : {});
    rows.push([
      mk(p.name || "", base),
      mk(p.uidNo || "", base),
      mk(p.phone || "", base),
      mk(fmtDate(p.surgeryDate), ctr),
      mk(p.surgeon || "", base),
      mk(p.roomType || "", base),
    ]);
  });

  if (!pending.length) {
    rows.push([mk("Every operated patient responded.", ST_LABEL)]);
  }

  const ws = xlsx.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 24 },
    { wch: 14 },
    { wch: 13 },
    { wch: 6 },
    { wch: 6 },
    { wch: 13 },
    { wch: 20 },
    { wch: 13 },
    { wch: 7 },
    { wch: 11 },
    { wch: 7 },
    { wch: 9 },
    { wch: 6 },
    ...qCols.map(() => ({ wch: 11 })),
  ];
  ws["!freeze"] = { xSplit: 2, ySplit: 3 };
  ws["!rows"] = [{ hpt: 18 }, { hpt: 18 }, { hpt: 30 }];
  return ws;
}

/* ── Main ────────────────────────────────────────────────────────────────── */

/**
 * generateAllBranchFeedbackExcel({ from, to, locations })
 * → { filePath, fileName, branchesProcessed, branchesRequested, failed }
 *
 * `locations` defaults to every branch in databaseUtils. Pass a subset to
 * narrow it. Unknown names are dropped rather than reaching
 * getConnectionByLocation.
 */
async function generateAllBranchFeedbackExcel(options = {}) {
  const { from, to } = options;

  if (!from || !to) throw new Error("from and to are required (YYYY-MM-DD)");
  if (from > to) throw new Error("`from` cannot be after `to`");

  const wanted =
    Array.isArray(options.locations) && options.locations.length
      ? options.locations.filter((l) => ALL_LOCATIONS.includes(l))
      : ALL_LOCATIONS.slice();

  if (!wanted.length) throw new Error("No valid locations to read");

  const results = [];
  for (let i = 0; i < wanted.length; i += BATCH) {
    const slice = wanted.slice(i, i + BATCH);
    const settled = await Promise.all(
      slice.map(async (branch) => {
        try {
          const data = await getIpdFeedback({ location: branch, from, to });
          return { branch, ok: true, data };
        } catch (err) {
          // One unreachable database must not cost the other thirty-nine.
          console.error(`  ✗ ${branch}: ${err.message}`);
          return { branch, ok: false, error: err.message };
        }
      }),
    );
    results.push(...settled);
    console.log(`  … ${results.length}/${wanted.length} branches read`);
  }

  const good = results.filter((r) => r.ok);
  if (!good.length) throw new Error("No branch returned any feedback data");

  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, summarySheet(results, from, to), "Summary");

  const used = new Set(["Summary"]);
  good
    .sort((a, b) => a.branch.localeCompare(b.branch))
    .forEach((r) => {
      xlsx.utils.book_append_sheet(
        wb,
        branchSheet(r.data),
        sheetName(r.branch, used),
      );
    });

  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const fileName = `Patient_Feedback_AllBranches_${from}_to_${to}.xlsx`;
  const filePath = path.join(reportsDir, fileName);
  xlsx.writeFile(wb, filePath);

  return {
    filePath,
    fileName,
    branchesProcessed: good.length,
    branchesRequested: wanted.length,
    failed: results
      .filter((r) => !r.ok)
      .map((r) => ({ location: r.branch, error: r.error })),
  };
}

module.exports = { generateAllBranchFeedbackExcel };

/* ── Standalone runner ───────────────────────────────────────────────────── */
// Only fires when the file is run directly, so requiring it from app.js does
// nothing until the function is called.
if (require.main === module) {
  const from = process.argv[2];
  const to = process.argv[3];
  const argLocations = (process.argv[4] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  (async () => {
    const t0 = Date.now();
    console.log("──────────────────────────────────────────────────────────");
    console.log("All-Branch Patient Feedback (temporary runner)");
    console.log(`Window   : ${from} → ${to}`);
    console.log(
      `Branches : ${argLocations.length ? argLocations.join(", ") : "all"}`,
    );
    console.log("──────────────────────────────────────────────────────────");

    try {
      const r = await generateAllBranchFeedbackExcel({
        from,
        to,
        locations: argLocations,
      });
      console.log(`\n✅ Workbook written: ${r.filePath}`);
      console.log(
        `   ${r.branchesProcessed} of ${r.branchesRequested} branches, ` +
          `${Math.round((Date.now() - t0) / 1000)}s`,
      );
      r.failed.forEach((f) => console.log(`   ✗ ${f.location}: ${f.error}`));
      // The mysql pools keep the event loop alive, so without this the process
      // hangs after writing the file and looks like it failed.
      process.exit(r.failed.length ? 1 : 0);
    } catch (err) {
      console.error(`\n❌ ${err.message}`);
      process.exit(2);
    }
  })();
}
