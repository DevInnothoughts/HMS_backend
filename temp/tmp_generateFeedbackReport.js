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
 * ── Calculations — identical to the Patient Feedback screen ─────────────────
 *   Per patient
 *     Recommend score  0–10, from ipdFeedback (recommendScore / netPromoterScore
 *                      / nps — same field order as ipdFeedbackModel)
 *     Band             9–10 promoter · 7–8 passive · 0–6 detractor
 *     PSI %            totalScoreAchieved ÷ maxPossibleScore × 100, rounded
 *                      (never the stored `psi`, which is the raw score)
 *   Per branch
 *     NPS              computeNps(summary.scoreCounts, summary.operated) — the
 *                      same function as src/design/components/NpsBlock.js:
 *                      %promoters − %detractors over the 0–10 distribution,
 *                      with a 95% ± margin and finite-population correction
 *     Avg PSI          mean of per-patient PSI % (patients who have a PSI)
 *     Response rate    responses ÷ operated
 *   All branches
 *     NPS              computeNps on the POOLED score distribution, population
 *                      = total operated — never an average of branch NPS
 *     Avg PSI          mean of every patient's PSI % across all branches —
 *                      the same rule as a branch, applied to the pooled set
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

/* ── NPS — a line-for-line port of NpsBlock.computeNps ──────────────────── */
// The app's version lives in React Native code this script cannot require.
// Keep the two identical: if one changes, change the other, or the workbook and
// the screen will show different numbers for the same branch.
//
//   counts      11 counts, index = score 0–10
//   population  how many COULD have responded (operated), for the correction
const computeNps = (counts = [], population = null) => {
  const c = Array.from({ length: 11 }, (_, i) => Number(counts[i]) || 0);
  const n = c.reduce((a, b) => a + b, 0);
  if (n === 0) return null;

  const detractors = c.slice(0, 7).reduce((a, b) => a + b, 0);
  const passives = c[7] + c[8];
  const promoters = c[9] + c[10];

  const p = promoters / n;
  const d = detractors / n;
  const nps = (p - d) * 100;

  // Variance of (promoter − detractor) as a single random variable.
  const variance = p + d - Math.pow(p - d, 2);
  let se = Math.sqrt(Math.max(variance, 0) / n);

  // Finite population correction — surveying most of a small population
  // genuinely leaves less room for error.
  if (population && population > n && population > 1) {
    se *= Math.sqrt((population - n) / (population - 1));
  }

  return {
    n,
    population,
    detractors,
    passives,
    promoters,
    detractorPct: d * 100,
    passivePct: (passives / n) * 100,
    promoterPct: p * 100,
    nps,
    margin: 1.96 * se * 100, // 95%
    counts: c,
  };
};

// Avg PSI exactly as ipdFeedbackModel computes summary.psiAvg: the mean of the
// per-patient PSI % over patients who HAVE one. Used for the pooled total, where
// there is no model summary to read.
const avgPsi = (patients) => {
  const v = patients.filter((p) => p.psiPct != null).map((p) => p.psiPct);
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
};

// Signed display, as the screen shows it: +62, 0, −15.
const npsText = (v) => (v == null ? null : Math.round(v));

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const BAND_LABEL = {
  promoter: "Promoter",
  passive: "Passive",
  detractor: "Detractor",
};

// Per-patient band — the thresholds computeNps uses (0–6 / 7–8 / 9–10).
const bandOf = (v) => {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return null;
  return n >= 9 ? "promoter" : n >= 7 ? "passive" : "detractor";
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
    "± (95%)",
    "Promoters",
    "Promoter %",
    "Passives",
    "Passive %",
    "Detractors",
    "Detractor %",
    "Avg PSI",
  ];
  const LAST = head.length - 1;

  const rows = [
    [mk("Patient Feedback — All Branches", ST_TITLE)],
    [mk(`${fmtDate(from)} to ${fmtDate(to)}`, ST_SUBTITLE)],
    [],
    head.map((h) => mk(h, ST_HEAD)),
  ];

  // Pooled across branches: the raw 0–10 distribution and every patient, so the
  // total is computed by the same rules as a branch rather than averaged.
  const pooledCounts = Array(11).fill(0);
  const pooledPatients = [];
  let pooledOperated = 0;

  const pctCell = (v, style) =>
    v == null
      ? mk("—", ST_DASH)
      : mk(Math.round(v) / 100, { ...style, numFmt: "0%" });

  const npsRow = (label, nps, operated, psi, alt, isTotal) => {
    const base = isTotal ? ST_TOTAL : alt ? ST_LABEL_ALT : ST_LABEL;
    const ctr = isTotal
      ? ST_TOTAL_NUM
      : centred(alt ? { fill: { fgColor: { rgb: ZEBRA } } } : {});
    const responses = nps?.n ?? 0;
    return [
      mk(label, base),
      mk(operated, ctr),
      mk(responses, ctr),
      operated > 0
        ? mk(Math.round((responses / operated) * 100), {
            ...ctr,
            numFmt: '0"%"',
          })
        : mk("—", ST_DASH),
      nps == null ? mk("—", ST_DASH) : mk(npsText(nps.nps), npsStyle(nps.nps)),
      nps == null
        ? mk("—", ST_DASH)
        : mk(`± ${Math.round(nps.margin)}`, {
            ...ctr,
            font: { sz: 10, color: { rgb: "6C7C75" } },
          }),
      mk(nps?.promoters ?? 0, ctr),
      pctCell(nps?.promoterPct, ctr),
      mk(nps?.passives ?? 0, ctr),
      pctCell(nps?.passivePct, ctr),
      mk(nps?.detractors ?? 0, ctr),
      pctCell(nps?.detractorPct, ctr),
      psi == null ? mk("—", ST_DASH) : mk(psi, psiStyle(psi, alt && !isTotal)),
    ];
  };

  results
    .filter((r) => r.ok)
    .sort((a, b) => a.branch.localeCompare(b.branch))
    .forEach((r, i) => {
      const s = r.data.summary || {};
      const operated = s.operated || 0;
      const nps = computeNps(s.scoreCounts, operated);

      (s.scoreCounts || []).forEach(
        (c, k) => (pooledCounts[k] += Number(c) || 0),
      );
      pooledPatients.push(...(r.data.patients || []));
      pooledOperated += operated;

      // Branch Avg PSI straight from the model — the figure the screen shows.
      rows.push(
        npsRow(r.branch, nps, operated, s.psiAvg ?? null, i % 2 === 1, false),
      );
    });

  const groupNps = computeNps(pooledCounts, pooledOperated);
  const groupPsi = avgPsi(pooledPatients);
  rows.push(
    npsRow("ALL BRANCHES", groupNps, pooledOperated, groupPsi, false, true),
  );

  rows.push([]);
  rows.push([
    mk(
      "NPS = % promoters (9–10) − % detractors (0–6) over the 0–10 recommend-score " +
        "distribution; passives (7–8) count in the total but not the score. " +
        "± is the 95% confidence interval, corrected for the number operated. " +
        "PSI = total score achieved ÷ maximum possible × 100 per patient; Avg PSI is " +
        "the mean over patients who have one. ALL BRANCHES pools every response and " +
        "every patient — it is not an average of the branch rows. " +
        "Same calculations as the Patient Feedback screen.",
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
    { wch: 9 },
    { wch: 10 },
    { wch: 11 },
    { wch: 9 },
    { wch: 10 },
    { wch: 11 },
    { wch: 11 },
    { wch: 10 },
  ];
  ws["!rows"] = [{ hpt: 26 }, { hpt: 18 }];
  const noteRow = rows.findIndex(
    (r) => r[0]?.v && String(r[0].v).startsWith("NPS = %"),
  );
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: LAST } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: LAST } },
    ...(noteRow >= 0
      ? [{ s: { r: noteRow, c: 0 }, e: { r: noteRow, c: LAST } }]
      : []),
  ];
  if (noteRow >= 0) ws["!rows"][noteRow] = { hpt: 54 };
  ws["!freeze"] = { xSplit: 1, ySplit: 4 };
  return ws;
}

/* ── Per-branch sheet ────────────────────────────────────────────────────── */

function branchSheet(data, branch) {
  const patients = data.patients || [];
  const responders = patients.filter((p) => p.responded);
  const pending = patients.filter((p) => !p.responded);

  // Branch figures — same inputs and function as the Patient Feedback screen.
  const s = data.summary || {};
  const nps = computeNps(s.scoreCounts, s.operated);

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
    "Recommend (0–10)",
    "Band",
    "PSI %",
    "Achieved",
    "Max",
    ...qCols.map((c) => c.label),
  ];

  const bandRow = [
    ...Array(13).fill(mk("", ST_GROUP)),
    ...qCols.map((c) => mk(c.group, ST_GROUP)),
  ];

  const metric = (label, value, style, alt) => [
    mk(label, alt ? ST_LABEL_ALT : ST_LABEL),
    value == null ? mk("—", ST_DASH) : mk(value, style),
  ];
  const ctrA = (alt) =>
    centred(alt ? { fill: { fgColor: { rgb: ZEBRA } } } : {});
  const pctOf = (v) => (v == null ? null : Math.round(v) / 100);

  const top = [
    [mk(`Patient Feedback — ${branch}`, ST_TITLE)],
    [
      mk(
        `${fmtDate(data.meta?.from)} to ${fmtDate(data.meta?.to)}`,
        ST_SUBTITLE,
      ),
    ],
    [],
    [mk("BRANCH SUMMARY", ST_GROUP), mk("", ST_GROUP), mk("", ST_GROUP)],
    metric("Patients operated", s.operated ?? 0, ctrA(false), false),
    metric("Responses received", s.responses ?? 0, ctrA(true), true),
    metric(
      "Response rate",
      s.responseRatePct ?? null,
      { ...ctrA(false), numFmt: '0"%"' },
      false,
    ),
    [
      mk("NPS", ST_LABEL_ALT),
      nps == null ? mk("—", ST_DASH) : mk(npsText(nps.nps), npsStyle(nps.nps)),
      nps == null
        ? mk("", ST_LABEL_ALT)
        : mk(`± ${Math.round(nps.margin)}`, {
            ...ctrA(true),
            font: { sz: 10, color: { rgb: "6C7C75" } },
          }),
    ],
    [
      mk("Promoters (9–10)", ST_LABEL),
      mk(nps?.promoters ?? 0, ctrA(false)),
      nps == null
        ? mk("", ST_LABEL)
        : mk(pctOf(nps.promoterPct), { ...ctrA(false), numFmt: "0%" }),
    ],
    [
      mk("Passives (7–8)", ST_LABEL_ALT),
      mk(nps?.passives ?? 0, ctrA(true)),
      nps == null
        ? mk("", ST_LABEL_ALT)
        : mk(pctOf(nps.passivePct), { ...ctrA(true), numFmt: "0%" }),
    ],
    [
      mk("Detractors (0–6)", ST_LABEL),
      mk(nps?.detractors ?? 0, ctrA(false)),
      nps == null
        ? mk("", ST_LABEL)
        : mk(pctOf(nps.detractorPct), { ...ctrA(false), numFmt: "0%" }),
    ],
    metric(
      "Avg PSI",
      s.psiAvg ?? null,
      s.psiAvg == null ? ST_DASH : psiStyle(s.psiAvg, true),
      true,
    ),
    [],
    // The distribution the score is built from — the same NPS can come from
    // everyone at 8 or half at 10 and half at 4.
    [
      mk("RESPONSES BY SCORE", ST_GROUP),
      mk("Count", ST_GROUP),
      mk("Share", ST_GROUP),
    ],
    ...(nps
      ? nps.counts.map((count, score) => {
          const alt = score % 2 === 1;
          return [
            mk(String(score), alt ? ST_LABEL_ALT : ST_LABEL),
            mk(count, {
              ...ctrA(alt),
              font: {
                bold: count > 0,
                sz: 10,
                color: { rgb: score >= 9 ? GREEN : score >= 7 ? AMBER : RED },
              },
            }),
            mk(count > 0 ? count / nps.n : 0, { ...ctrA(alt), numFmt: "0%" }),
          ];
        })
      : [[mk("No responses", ST_LABEL)]]),
    [],
  ];
  const headerRow = top.length + 2; // index of the column-header row below

  const rows = [
    ...top,
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
      mk(
        bandOf(p.recommendScore) ? BAND_LABEL[bandOf(p.recommendScore)] : "—",
        ctr,
      ),
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
  // Freeze through the response-table header so names stay in view.
  ws["!freeze"] = { xSplit: 2, ySplit: headerRow + 1 };
  ws["!rows"] = [{ hpt: 26 }, { hpt: 18 }];
  ws["!rows"][headerRow] = { hpt: 30 };
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 7 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 7 } },
  ];
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
        branchSheet(r.data, r.branch),
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
