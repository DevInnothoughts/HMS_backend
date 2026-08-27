/**
 * tmp_generateLabReport_Jan_Jul.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * Month-wise, LOCATION-WISE LAB REVENUE:
 *
 *      Jan–Jul 2026   vs   Jan–Jul 2025
 *
 * Built on getDailyOPDCollectionV2's LAB definition, as requested.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  V2's LAB IS NOT V1's LAB — THIS MATTERS
 * ═══════════════════════════════════════════════════════════════════════════
 * The older getDailyOPDCollection / V1 hardcoded:
 *
 *     consultation = 'LAB'            ← one literal string
 *
 * V2 replaced that with a MASTER-TABLE-DRIVEN rule. LAB is now every
 * consultation flagged as such in the master DB:
 *
 *     hhc_appointments.consultationMasterData
 *     WHERE is_deleted = '0' AND consultation_type = 'LAB'
 *
 * matched against patient_itemreceipt.consultation on the NORMALIZED name —
 * REPLACE(LOWER(COALESCE(consultation,'')),' ','') — because the master table
 * and the receipts table disagree on spacing and case.
 *
 * So V2's LAB total is normally MUCH LARGER than V1's: it picks up every lab
 * consultation (blood tests, doppler, gastroscopy, ECG and so on), not just
 * rows literally spelled 'LAB'. If you compare this workbook against anything
 * built on the old rule, they will not agree, and V2 is the correct one.
 *
 * The master list lives on the "lead" connection, NOT the branch DB, so it is
 * fetched once here and reused for every branch and both years — matching
 * targetComparisonNewModel, which caches it for the same reason.
 *
 * ── Payment-mode buckets (verbatim from V2's MODE_SQL) ─────────────────────
 *     Cash   → payment_mode = 'Cash'
 *     Card   → payment_mode = 'Card'
 *     Online → payment_mode IN ('Online', 'UPI')
 *
 * ⚠ Note V2 dropped 'Paytm', which V1's lab-online bucket DID include. Any LAB
 *   row paid by Paytm (or Cheque, or anything else) therefore falls into NO
 *   bucket and is absent from V2's lab total. This script computes that
 *   residual as "Unbucketed" and reports it separately rather than folding it
 *   in — folding it in would silently disagree with the daily screen. If the
 *   residual is material, raise it; don't patch it here.
 *
 * ── No DP Road special case, deliberately ──────────────────────────────────
 * V1 and labCollectionModel route DP Road's lab through patient_receipt
 * (chargeCondition='LabTest'). V2's lab queries do NOT — they read
 * patient_itemreceipt for every branch. This script follows V2. The four
 * default branches don't include DP Road, so it makes no difference here, but
 * if you add DP Road the number will not match its daily screen.
 *
 * ── Dates ──────────────────────────────────────────────────────────────────
 * item_date is a DATE column, so month boundaries are exact — no timezone drift.
 *
 * ── Place this file at the PROJECT ROOT ────────────────────────────────────
 * (next to app.js / databaseUtils.js / dbconfig.js).
 *
 * ── Run ────────────────────────────────────────────────────────────────────
 *   node tmp_generateLabReport_Jan_Jul.js
 *   node tmp_generateLabReport_Jan_Jul.js "Navi Mumbai,Andheri,Thane,Vashi"
 *   node tmp_generateLabReport_Jan_Jul.js "Andheri,Thane" 2026 1 7
 *
 * ── Output ─────────────────────────────────────────────────────────────────
 *   src/report/Monthwise_Lab_2026_vs_2025_01-07.xlsx
 *
 * DELETE THIS FILE once the workbook has been generated.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");
const { getConnectionByLocation } = require("../databaseUtils");

/* ── Config ──────────────────────────────────────────────────────────────── */

// Same four branches, same order as the other Jan–Jun workbooks.
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

// The consultation master always lives on the "lead" connection (V2 + labCollectionModel).
const MASTER_DB_KEY = "lead";

const argLocations = (process.argv[2] || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const LOCATIONS = argLocations.length ? argLocations : DEFAULT_LOCATIONS;

const YEAR = Number(process.argv[3]) || 2026;
const PREVIOUS_YEAR = YEAR - 1;
const START_MONTH = Number(process.argv[4]) || 1;
const END_MONTH = Number(process.argv[5]) || 7; // ← July

/* ── Shared helpers ──────────────────────────────────────────────────────── */

const reportsDir = path.join(__dirname, "src", "report");
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const pad2 = (n) => String(n).padStart(2, "0");
const round2 = (n) =>
  Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

const pctChange = (cur, prev) =>
  prev > 0 ? round2(((cur - prev) / prev) * 100) : cur > 0 ? null : 0;

const NUM_FMT = '#,##0;(#,##0);"-"';
const PCT_FMT = '0.0%;(0.0%);"-"';

function pctFraction(cur, prev) {
  if (prev > 0) return (cur - prev) / prev;
  return cur > 0 ? null : 0;
}

function formatColumn(ws, colIdx, firstRow, lastRow, fmt) {
  for (let r = firstRow; r <= lastRow; r++) {
    const addr = xlsx.utils.encode_cell({ r, c: colIdx });
    const cell = ws[addr];
    if (cell && cell.t === "n") cell.z = fmt;
  }
}

const runOn = (connection, sql, params = []) =>
  new Promise((res, rej) =>
    connection.query(sql, params, (e, r) => (e ? rej(e) : res(r))),
  );

// Mirrors SQL's REPLACE(LOWER(x), ' ', '') — V2's normalizeName, verbatim.
const normalizeName = (v) =>
  String(v ?? "")
    .toLowerCase()
    .split(" ")
    .join("");

/* ── LAB consultation master (fetched ONCE) ─────────────────────────────── */

async function getLabConsultations() {
  const { connection } = getConnectionByLocation(MASTER_DB_KEY);
  if (!connection) {
    throw new Error(
      `Master database connection ("${MASTER_DB_KEY}") not available — ` +
        `V2's LAB definition cannot be resolved without it.`,
    );
  }

  const rows = await runOn(
    connection,
    `SELECT consultation_name, consultation_type
       FROM consultationMasterData
      WHERE is_deleted = '0'
      ORDER BY consultation_name`,
  );

  // Drop blanks, keep LAB only, de-duplicate on the normalized name (V2 rules).
  const seen = new Set();
  const list = [];
  for (const r of rows) {
    const name = (r.consultation_name || "").trim();
    if (!name) continue;
    const type = String(r.consultation_type ?? "")
      .trim()
      .toUpperCase();
    if (type !== "LAB") continue;
    const key = normalizeName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ name, norm: key });
  }
  return list;
}

/* ── SQL ─────────────────────────────────────────────────────────────────── */

// COALESCE keeps NULL-consultation rows out of the LAB set — V2's NORM_COL.
const NORM_COL = "REPLACE(LOWER(COALESCE(consultation, '')), ' ', '')";

// V2's MODE_SQL, verbatim. Note: no 'Paytm' — see the header note.
const MODE_SQL = {
  Cash: "payment_mode = 'Cash'",
  Card: "payment_mode = 'Card'",
  Online: "payment_mode IN ('Online', 'UPI')",
};

// Month × mode in one pass, rather than V2's three separate single-day queries.
function labByMonthSql(placeholders) {
  return `
    SELECT
      MONTH(item_date) AS mon,
      COALESCE(SUM(CASE WHEN ${MODE_SQL.Cash}   THEN total ELSE 0 END), 0) AS cash,
      COALESCE(SUM(CASE WHEN ${MODE_SQL.Card}   THEN total ELSE 0 END), 0) AS card,
      COALESCE(SUM(CASE WHEN ${MODE_SQL.Online} THEN total ELSE 0 END), 0) AS online,
      COALESCE(SUM(total), 0) AS all_modes,
      COUNT(*) AS rows_cnt
    FROM patient_itemreceipt
    WHERE item_date >= ? AND item_date <= ?
      AND is_deleted != 1
      AND ${NORM_COL} IN (${placeholders})
    GROUP BY MONTH(item_date)
  `;
}

// Per-consultation totals, so the lab mix is visible rather than one lump sum.
function labByConsultationSql(placeholders) {
  return `
    SELECT
      ${NORM_COL} AS norm,
      COALESCE(SUM(CASE WHEN ${MODE_SQL.Cash}   THEN total ELSE 0 END), 0)
      + COALESCE(SUM(CASE WHEN ${MODE_SQL.Card}   THEN total ELSE 0 END), 0)
      + COALESCE(SUM(CASE WHEN ${MODE_SQL.Online} THEN total ELSE 0 END), 0) AS bucketed,
      COUNT(*) AS rows_cnt
    FROM patient_itemreceipt
    WHERE item_date >= ? AND item_date <= ?
      AND is_deleted != 1
      AND ${NORM_COL} IN (${placeholders})
    GROUP BY ${NORM_COL}
  `;
}

/* ── Per (location, year) fetch ──────────────────────────────────────────── */

const emptyBucket = () => ({ Cash: 0, Card: 0, Online: 0, Unbucketed: 0 });

async function collectLocationYear(loc, year, monthList, labList) {
  const { connection } = getConnectionByLocation(loc);
  if (!connection) throw new Error(`Invalid location: ${loc}`);

  const firstM = monthList[0];
  const lastM = monthList[monthList.length - 1];
  const start = `${year}-${pad2(firstM)}-01`;
  const endDay = new Date(year, lastM, 0).getDate();
  const end = `${year}-${pad2(lastM)}-${pad2(endDay)}`;

  const norms = labList.map((c) => c.norm);
  const placeholders = norms.map(() => "?").join(", ");
  const params = [start, end, ...norms];

  const [monthRows, consultRows] = await Promise.all([
    runOn(connection, labByMonthSql(placeholders), params),
    runOn(connection, labByConsultationSql(placeholders), params),
  ]);

  const monthTotals = {};
  for (const m of monthList) monthTotals[m] = emptyBucket();
  let rowsCnt = 0;

  for (const r of monthRows) {
    const mon = Number(r.mon);
    if (!monthTotals[mon]) continue;
    const cash = Number(r.cash) || 0;
    const card = Number(r.card) || 0;
    const online = Number(r.online) || 0;
    const allModes = Number(r.all_modes) || 0;
    monthTotals[mon].Cash += cash;
    monthTotals[mon].Card += card;
    monthTotals[mon].Online += online;
    // Anything not caught by V2's three buckets — Paytm, Cheque, blanks.
    monthTotals[mon].Unbucketed += allModes - (cash + card + online);
    rowsCnt += Number(r.rows_cnt) || 0;
  }

  const byConsultation = {};
  for (const r of consultRows) {
    byConsultation[r.norm] = {
      bucketed: Number(r.bucketed) || 0,
      rows: Number(r.rows_cnt) || 0,
    };
  }

  return { monthTotals, byConsultation, rowsCnt };
}

/* ── Reducers ────────────────────────────────────────────────────────────── */

const addBucket = (a, b) => {
  a.Cash += b.Cash;
  a.Card += b.Card;
  a.Online += b.Online;
  a.Unbucketed += b.Unbucketed;
};

function emptyMonthTotals(monthList) {
  const m = {};
  for (const mm of monthList) m[mm] = emptyBucket();
  return m;
}

function mergeMonthTotals(agg, part, monthList) {
  for (const m of monthList) addBucket(agg[m], part.monthTotals[m]);
}

// V2: labTotalAmt = labCashAmt + labCardAmt + labOnlineAmt.
// Unbucketed is carried alongside but NEVER added, matching V2.
function shape(b, yr) {
  const cash = b.Cash;
  const card = b.Card;
  const online = b.Online;
  return {
    year: yr,
    cash: round2(cash),
    card: round2(card),
    online: round2(online),
    total: round2(cash + card + online), // ← V2's labTotalAmt
    unbucketed: round2(b.Unbucketed),
  };
}

function windowBucket(monthTotals, monthList) {
  const acc = emptyBucket();
  for (const m of monthList) addBucket(acc, monthTotals[m]);
  return acc;
}

function monthlyArray(monthTotals, monthList, yr) {
  return monthList.map((m) => ({
    month: m,
    monthName: MONTH_NAMES[m - 1],
    ...shape(monthTotals[m], yr),
  }));
}

const zeroMonthly = (monthList, yr) =>
  monthList.map((m) => ({
    month: m,
    monthName: MONTH_NAMES[m - 1],
    ...shape(emptyBucket(), yr),
  }));

/* ── Main data build ─────────────────────────────────────────────────────── */

async function getMonthwiseLab(locations, options = {}) {
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new Error("`locations` must be a non-empty array of branch names.");
  }

  const year = Number(options.year) || 2026;
  const previousYear = Number(options.previousYear) || year - 1;
  const startMonth = Number(options.startMonth) || 1;
  const endMonth = Number(options.endMonth) || 7;
  if (endMonth < startMonth) {
    throw new Error("`endMonth` cannot be earlier than `startMonth`.");
  }

  const monthList = [];
  for (let m = startMonth; m <= endMonth; m++) monthList.push(m);

  // Fetch the LAB master ONCE — it's shared, small, and identical per branch.
  const labList = await getLabConsultations();
  if (!labList.length) {
    // V2's `1 = 0` branch: nothing is LAB, so every total would be zero.
    // Fail loudly rather than shipping a workbook full of zeros.
    throw new Error(
      "No consultations with consultation_type='LAB' found in " +
        "consultationMasterData (is_deleted='0'). V2 would report lab as 0 for " +
        "every branch. Check the master data before re-running.",
    );
  }

  const failures = [];
  const failed = new Set();
  const aggByYear = {
    [year]: emptyMonthTotals(monthList),
    [previousYear]: emptyMonthTotals(monthList),
  };
  const perLoc = {};
  for (const loc of locations) perLoc[loc] = {};
  const consultAgg = { [year]: {}, [previousYear]: {} };
  let rowsCnt = 0;

  async function collect(loc, yr) {
    if (failed.has(loc)) return;
    try {
      const part = await collectLocationYear(loc, yr, monthList, labList);
      mergeMonthTotals(aggByYear[yr], part, monthList);
      perLoc[loc][yr] = part;
      rowsCnt += part.rowsCnt;
      for (const [norm, v] of Object.entries(part.byConsultation)) {
        if (!consultAgg[yr][norm])
          consultAgg[yr][norm] = { bucketed: 0, rows: 0 };
        consultAgg[yr][norm].bucketed += v.bucketed;
        consultAgg[yr][norm].rows += v.rows;
      }
    } catch (e) {
      failed.add(loc);
      failures.push({ location: loc, error: e?.message || String(e) });
    }
  }

  // Two queries per (branch, year), parallel across branches.
  for (const yr of [year, previousYear]) {
    await Promise.all(locations.map((loc) => collect(loc, yr)));
  }

  const aggY = aggByYear[year];
  const aggP = aggByYear[previousYear];

  const changeOf = (c, p) => ({
    total: {
      amount: round2(c.total - p.total),
      pct: pctChange(c.total, p.total),
    },
  });

  const months = monthList.map((m) => {
    const c = shape(aggY[m], year);
    const p = shape(aggP[m], previousYear);
    return {
      month: m,
      monthName: MONTH_NAMES[m - 1],
      current: c,
      previous: p,
      change: changeOf(c, p),
    };
  });

  const cT = shape(windowBucket(aggY, monthList), year);
  const pT = shape(windowBucket(aggP, monthList), previousYear);
  const totals = { current: cT, previous: pT, change: changeOf(cT, pT) };

  const byLocation = locations
    .map((loc) => {
      const cur = perLoc[loc][year];
      const prev = perLoc[loc][previousYear];
      if (!cur && !prev) return null;
      const c = shape(
        cur ? windowBucket(cur.monthTotals, monthList) : emptyBucket(),
        year,
      );
      const p = shape(
        prev ? windowBucket(prev.monthTotals, monthList) : emptyBucket(),
        previousYear,
      );
      return {
        location: loc,
        current: c,
        previous: p,
        change: changeOf(c, p),
        monthlyCurrent: cur
          ? monthlyArray(cur.monthTotals, monthList, year)
          : zeroMonthly(monthList, year),
        monthlyPrevious: prev
          ? monthlyArray(prev.monthTotals, monthList, previousYear)
          : zeroMonthly(monthList, previousYear),
      };
    })
    .filter(Boolean);
  // Order preserved so rows line up with the other workbooks.

  // Lab mix, by display name, current year descending.
  const nameByNorm = {};
  for (const c of labList) nameByNorm[c.norm] = c.name;
  const consultationRows = Object.keys({
    ...consultAgg[year],
    ...consultAgg[previousYear],
  })
    .map((norm) => ({
      name: nameByNorm[norm] || norm,
      current: round2(consultAgg[year][norm]?.bucketed || 0),
      previous: round2(consultAgg[previousYear][norm]?.bucketed || 0),
      rows:
        (consultAgg[year][norm]?.rows || 0) +
        (consultAgg[previousYear][norm]?.rows || 0),
    }))
    .sort((a, b) => b.current - a.current || a.name.localeCompare(b.name));

  return {
    generatedAt: new Date().toISOString(),
    period: {
      year,
      previousYear,
      months: `${MONTH_NAMES[startMonth - 1]}–${MONTH_NAMES[endMonth - 1]}`,
      startMonth,
      endMonth,
      monthList,
      monthNames: monthList.map((m) => MONTH_NAMES[m - 1]),
    },
    labConsultationCount: labList.length,
    labConsultationNames: labList.map((c) => c.name),
    locationsRequested: locations,
    locationsFailed: failures,
    months,
    totals,
    byLocation,
    consultationRows,
    rowsCnt,
  };
}

/* ── Excel builders ──────────────────────────────────────────────────────── */

function buildComparisonSheet(report, kind /* 'month' | 'location' */) {
  const { year: Y, previousYear: P, months: ML } = report.period;
  const cfg = {
    month: {
      first: "Month",
      rows: report.months,
      label: (r) => r.monthName,
      title: `Monthly Lab Revenue — ${P} vs ${Y} (${ML})`,
      totalLabel: `Total (${ML})`,
      w: 16,
    },
    location: {
      first: "Location",
      rows: report.byLocation,
      label: (r) => r.location,
      title: `Lab Revenue by Location — ${P} vs ${Y} (${ML})`,
      totalLabel: "Grand Total",
      w: 22,
    },
  }[kind];

  const header = [
    cfg.first,
    `Lab (₹) ${Y}`,
    `Lab (₹) ${P}`,
    "Δ (₹)",
    "Δ (%)",
    `Cash ${Y}`,
    `Card ${Y}`,
    `Online ${Y}`,
    `Unbucketed — excluded ${Y}`,
  ];
  const aoa = [
    [cfg.title],
    [
      "LAB per getDailyOPDCollectionV2: consultationMasterData type='LAB'. " +
        "Total = Cash + Card + Online. 'Unbucketed' (Paytm/Cheque/other) is NOT included.",
    ],
    header,
  ];

  const rowFor = (label, c, p) => [
    label,
    c.total,
    p.total,
    round2(c.total - p.total),
    pctFraction(c.total, p.total) ?? "N/A",
    c.cash,
    c.card,
    c.online,
    c.unbucketed,
  ];

  const t = { c: 0, p: 0, cash: 0, card: 0, on: 0, ub: 0 };
  cfg.rows.forEach((r) => {
    aoa.push(rowFor(cfg.label(r), r.current, r.previous));
    t.c += r.current.total;
    t.p += r.previous.total;
    t.cash += r.current.cash;
    t.card += r.current.card;
    t.on += r.current.online;
    t.ub += r.current.unbucketed;
  });
  aoa.push(
    rowFor(
      cfg.totalLabel,
      {
        total: round2(t.c),
        cash: round2(t.cash),
        card: round2(t.card),
        online: round2(t.on),
        unbucketed: round2(t.ub),
      },
      { total: round2(t.p) },
    ),
  );

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: header.length - 1 } },
  ];
  ws["!cols"] = [
    { wch: cfg.w },
    { wch: 15 },
    { wch: 15 },
    { wch: 14 },
    { wch: 10 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 24 },
  ];

  const fr = 3;
  const lr = 3 + cfg.rows.length;
  [1, 2, 3, 5, 6, 7, 8].forEach((c) => formatColumn(ws, c, fr, lr, NUM_FMT));
  formatColumn(ws, 4, fr, lr, PCT_FMT);
  return ws;
}

function buildLocationMonthSheet(report, which /* 'current'|'previous' */, yr) {
  const monthNames = report.period.monthNames;
  const title = `Lab Revenue (₹) by Location × Month — ${yr} (${report.period.months})`;
  const header = ["Location", ...monthNames, "Total (₹)"];
  const aoa = [[title], [], header];
  const key = which === "current" ? "monthlyCurrent" : "monthlyPrevious";

  const colSums = new Array(monthNames.length).fill(0);
  let grand = 0;
  report.byLocation.forEach((loc) => {
    const vals = loc[key].map((mm) => mm.total || 0);
    const rowTotal = vals.reduce((a, b) => a + b, 0);
    vals.forEach((v, i) => (colSums[i] += v));
    grand += rowTotal;
    aoa.push([loc.location, ...vals.map(round2), round2(rowTotal)]);
  });
  aoa.push(["Grand Total", ...colSums.map(round2), round2(grand)]);

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }];
  ws["!cols"] = [
    { wch: 22 },
    ...monthNames.map(() => ({ wch: 14 })),
    { wch: 16 },
  ];
  const fr = 3;
  const lr = 3 + report.byLocation.length;
  for (let c = 1; c < header.length; c++) formatColumn(ws, c, fr, lr, NUM_FMT);
  return ws;
}

// The lab mix — which tests actually drive the number.
function buildConsultationSheet(report) {
  const { year: Y, previousYear: P, months: ML } = report.period;
  const header = [
    "Lab Consultation",
    `Revenue (₹) ${Y}`,
    `Revenue (₹) ${P}`,
    "Δ (₹)",
    "Δ (%)",
  ];
  const aoa = [
    [`Lab revenue by consultation — ${P} vs ${Y} (${ML})`],
    [
      `From consultationMasterData where consultation_type='LAB' ` +
        `(${report.labConsultationCount} configured). Zero-revenue entries are listed too, ` +
        `so you can see what's configured but never billed.`,
    ],
    header,
  ];

  let tc = 0;
  let tp = 0;
  report.consultationRows.forEach((r) => {
    aoa.push([
      r.name,
      r.current,
      r.previous,
      round2(r.current - r.previous),
      pctFraction(r.current, r.previous) ?? "N/A",
    ]);
    tc += r.current;
    tp += r.previous;
  });
  aoa.push([
    "Total",
    round2(tc),
    round2(tp),
    round2(tc - tp),
    pctFraction(tc, tp) ?? "N/A",
  ]);

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: header.length - 1 } },
  ];
  ws["!cols"] = [
    { wch: 34 },
    { wch: 17 },
    { wch: 17 },
    { wch: 14 },
    { wch: 10 },
  ];
  const fr = 3;
  const lr = 3 + report.consultationRows.length;
  [1, 2, 3].forEach((c) => formatColumn(ws, c, fr, lr, NUM_FMT));
  formatColumn(ws, 4, fr, lr, PCT_FMT);
  return ws;
}

function buildWorkbook(report) {
  const { year, previousYear } = report.period;
  const wb = xlsx.utils.book_new();

  xlsx.utils.book_append_sheet(
    wb,
    buildComparisonSheet(report, "month"),
    "Monthly Totals",
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildComparisonSheet(report, "location"),
    "Location Summary",
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationMonthSheet(report, "current", year),
    `Lab by Loc ${year}`,
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationMonthSheet(report, "previous", previousYear),
    `Lab by Loc ${previousYear}`,
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildConsultationSheet(report),
    "By Consultation",
  );

  const notes = [
    ["Lab revenue — definition (getDailyOPDCollectionV2)"],
    [],
    [
      "LAB set",
      `consultationMasterData (on the "${MASTER_DB_KEY}" DB) where is_deleted='0' ` +
        `AND consultation_type='LAB' — ${report.labConsultationCount} consultations`,
    ],
    [
      "Matching",
      "patient_itemreceipt.consultation matched on REPLACE(LOWER(COALESCE(consultation,'')),' ','')",
    ],
    [
      "Amount",
      "SUM(patient_itemreceipt.total), is_deleted != 1, bucketed on MONTH(item_date)",
    ],
    [],
    ["Cash bucket", MODE_SQL.Cash],
    ["Card bucket", MODE_SQL.Card],
    ["Online bucket", MODE_SQL.Online],
    ["Total", "Cash + Card + Online (V2's labTotalAmt)"],
    [
      "⚠ Unbucketed",
      "V2's three buckets omit Paytm, Cheque and blanks. Those rows are LAB but " +
        "reach no bucket, so they are absent from V2's total. Shown separately here, " +
        "never added in — adding them would disagree with the daily screen.",
    ],
    [
      "⚠ Not V1's LAB",
      "V1 used a literal consultation='LAB'. V2's master-driven set is much broader, " +
        "so this total will exceed anything built on the old rule. V2 is correct.",
    ],
    [
      "⚠ No DP Road case",
      "V1/labCollectionModel route DP Road lab through patient_receipt " +
        "(chargeCondition='LabTest'); V2 does not, and neither does this report.",
    ],
    [],
    ["LAB consultations configured", report.labConsultationNames.join(", ")],
    ["Receipt rows matched", report.rowsCnt],
    ["Generated at", report.generatedAt],
  ];
  const nws = xlsx.utils.aoa_to_sheet(notes);
  nws["!cols"] = [{ wch: 30 }, { wch: 100 }];
  xlsx.utils.book_append_sheet(wb, nws, "Definition");

  if (report.locationsFailed && report.locationsFailed.length) {
    const aoa = [
      ["Skipped Location", "Reason"],
      ...report.locationsFailed.map((f) => [f.location, f.error]),
    ];
    const ws = xlsx.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 24 }, { wch: 55 }];
    xlsx.utils.book_append_sheet(wb, ws, "Skipped Locations");
  }

  return wb;
}

/* ── Run ─────────────────────────────────────────────────────────────────── */

(async () => {
  const t0 = Date.now();
  const inr = (n) => Math.round(Number(n) || 0).toLocaleString("en-IN");

  console.log("──────────────────────────────────────────────────────────");
  console.log("Month-wise Lab Revenue Report (temporary runner)");
  console.log(
    `Window   : ${START_MONTH}–${END_MONTH} | ${YEAR} vs ${PREVIOUS_YEAR}`,
  );
  console.log(`Branches : ${LOCATIONS.join(", ")}`);
  console.log(
    `LAB rule : consultationMasterData type='LAB' (V2), via "${MASTER_DB_KEY}" DB`,
  );
  console.log("──────────────────────────────────────────────────────────");

  try {
    const report = await getMonthwiseLab(LOCATIONS, {
      year: YEAR,
      previousYear: PREVIOUS_YEAR,
      startMonth: START_MONTH,
      endMonth: END_MONTH,
    });

    console.log(
      `\nLAB consultations configured: ${report.labConsultationCount}` +
        `  →  ${report.labConsultationNames.slice(0, 8).join(", ")}` +
        `${report.labConsultationCount > 8 ? ", …" : ""}`,
    );

    const wb = buildWorkbook(report);
    const fileName =
      `Monthwise_Lab_${YEAR}_vs_${PREVIOUS_YEAR}_` +
      `${pad2(START_MONTH)}-${pad2(END_MONTH)}.xlsx`;
    const filePath = path.join(reportsDir, fileName);
    xlsx.writeFile(wb, filePath);

    const { current, previous, change } = report.totals;

    console.log(`\n✅ Workbook written: ${filePath}`);

    console.log(
      `\nTotals (${report.period.months}) — ${YEAR} vs ${PREVIOUS_YEAR}:`,
    );
    console.log(
      `   Cash   ₹ ${inr(current.cash).padStart(14)}  vs ${inr(previous.cash).padStart(14)}`,
    );
    console.log(
      `   Card   ₹ ${inr(current.card).padStart(14)}  vs ${inr(previous.card).padStart(14)}`,
    );
    console.log(
      `   Online ₹ ${inr(current.online).padStart(14)}  vs ${inr(previous.online).padStart(14)}`,
    );
    console.log(`   ───────────────────────────────────────────────────`);
    console.log(
      `   TOTAL  ₹ ${inr(current.total).padStart(14)}  vs ${inr(previous.total).padStart(14)}` +
        `   (${change.total.pct === null ? "N/A" : change.total.pct + "%"})`,
    );

    console.log("\nMonth-wise lab revenue (₹):");
    report.months.forEach((m) => {
      console.log(
        `   ${m.monthName.padEnd(10)} ${inr(m.current.total).padStart(14)}` +
          `  vs ${inr(m.previous.total).padStart(14)}`,
      );
    });

    console.log("\nTop lab consultations (₹, current year):");
    report.consultationRows.slice(0, 8).forEach((r) => {
      console.log(`   ${r.name.padEnd(30)} ${inr(r.current).padStart(12)}`);
    });

    // The most likely way this report quietly differs from expectations.
    if (current.unbucketed > 0 || previous.unbucketed > 0) {
      const pct =
        current.total > 0
          ? ((current.unbucketed / current.total) * 100).toFixed(2)
          : "0";
      console.warn(
        `\n⚠️  LAB revenue in a payment mode outside Cash/Card/Online/UPI ` +
          `(e.g. Paytm, Cheque) is EXCLUDED from the totals above, because V2's ` +
          `three buckets don't cover it:`,
      );
      console.warn(
        `      ${YEAR}: ₹${inr(current.unbucketed)}   ` +
          `${PREVIOUS_YEAR}: ₹${inr(previous.unbucketed)}   — ${pct}% of the ${YEAR} total`,
      );
      console.warn(
        `   → V1's lab-online bucket DID include Paytm; V2 dropped it. If this is ` +
          `material, raise it upstream rather than patching this script.`,
      );
    } else {
      console.log(
        `\n✓ No lab revenue outside the three buckets — nothing dropped.`,
      );
    }

    if (report.locationsFailed?.length) {
      console.warn("\n⚠️  Skipped branches (see 'Skipped Locations' sheet):");
      report.locationsFailed.forEach((f) =>
        console.warn(`   • ${f.location}: ${f.error}`),
      );
    }

    console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Lab report failed:", err?.message || err);
    console.error(err?.stack || "");
    process.exit(1);
  }
})();
