/**
 * surgeryRevenueReportModel.js
 * ---------------------------------------------------------------------------
 * Month-wise, LOCATION-WISE surgery report: a 6-month window (default Jan–Jun
 * 2026) vs the same months of the previous year (default Jan–Jun 2025), split
 * per branch, plus an Excel export in the SheetJS style used in this codebase.
 *
 * It answers, per location AND for the group as a whole:
 *   1. Total surgeries and their revenue, current year vs previous.
 *   2. Break-up by surgery type (Piles, Fistula, Hernia, Fissure, ...) with the
 *      count AND revenue of each type.
 *   3. Sub-type break-up (from provisionalDiagnosis), both years (in JSON).
 *
 * ── How a "surgery" and its type are defined (matches DoctorPerformanceModel) ──
 * The `invoice` table is the IPD/surgery bill; revenue links to a case BY
 * patient_id. So:
 *   • surgery         = an IPD case = a patient with >= 1 non-deleted `invoice`
 *                       in that month (one patient-month = one surgery).
 *   • surgery revenue = SUM(invoice.totalamt) for those cases.
 *   • surgery type    = that patient's LATEST diagnosis.speciality in the window
 *                       (Piles / Fistula / Hernia / ...). IPD cases with no
 *                       diagnosis in the window are grouped as "Unspecified",
 *                       so the per-type numbers always sum back to the totals.
 *   • sub-types       = diagnosis.provisionalDiagnosis JSON, counted as distinct
 *                       surgical patients (no revenue split).
 *
 * Same tables, date bounds and speciality grouping as DoctorPerformanceModel,
 * so the figures reconcile with the Doctor Performance screen.
 *
 * Timezone note: invoice.creation_date is filtered/bucketed on the raw stored
 * value (as in DoctorPerformanceModel), so month boundaries match that report.
 * For strict IST bucketing wrap creation_date in CONVERT_TZ('+00:00','+05:30').
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   const {
 *     getMonthwiseSurgeryReport,
 *     generateMonthwiseSurgeryExcel,
 *   } = require("./surgeryRevenueReportModel");
 *
 *   const report = await getMonthwiseSurgeryReport(["Andheri", "Thane", "Vashi"]);
 *   const { filePath } = await generateMonthwiseSurgeryExcel(
 *     ["Andheri", "Thane", "Vashi"],
 *     { year: 2026, startMonth: 1, endMonth: 6 },
 *   );
 *
 * Express handlers: getMonthwiseSurgeryReportHandler(req),
 *                   generateMonthwiseSurgeryExcelHandler(req).
 * Location strings must match the branch keys used by getConnectionByLocation.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");

const reportsDir = path.join(__dirname, "..", "report");
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

const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function preferLabel(existing, candidate) {
  if (!existing) return candidate;
  if (!candidate) return existing;
  const eCap = /^[A-Z]/.test(existing);
  const cCap = /^[A-Z]/.test(candidate);
  return !eCap && cCap ? candidate : existing;
}

function parseProvisional(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  const s = raw.toString().trim();
  if (s === "" || s === "{}" || s.toLowerCase() === "null") return null;
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

function subTypesFor(provisional, speciality) {
  if (!provisional) return [];
  const target = speciality.toLowerCase();
  for (const key of Object.keys(provisional)) {
    if (key.toLowerCase() === target) {
      const val = provisional[key];
      if (!Array.isArray(val)) return [];
      const cleaned = val
        .map((v) => (v == null ? "" : v.toString().trim()))
        .filter((v) => v !== "");
      return [...new Set(cleaned)];
    }
  }
  return [];
}

/* ── SQL (mirrors DoctorPerformanceModel bounds) ──────────────────────────── */

const DIAGNOSIS_SQL = `
  SELECT d.patient_id, d.speciality, d.provisionalDiagnosis
  FROM diagnosis d
  WHERE d.date_diagnosis >= ? AND d.date_diagnosis <= ?
  ORDER BY d.patient_id, d.date_diagnosis
`;

const INVOICE_SQL = `
  SELECT
    patient_id,
    MONTH(creation_date) AS mon,
    SUM(COALESCE(totalamt, 0)) AS revenue,
    COUNT(*) AS invoiceCount
  FROM invoice
  WHERE creation_date >= ? AND creation_date <= ?
    AND is_deleted != 1
  GROUP BY patient_id, MONTH(creation_date)
`;

/* ── Per (location, year) fetch + fold ────────────────────────────────────── */

async function collectLocationYear(loc, year, monthList) {
  const { getConnectionByLocation } = require("../../databaseUtils");
  const { connection } = getConnectionByLocation(loc);
  if (!connection) throw new Error(`Invalid location: ${loc}`);

  const run = (sql, params = []) =>
    new Promise((res, rej) =>
      connection.query(sql, params, (e, r) => (e ? rej(e) : res(r))),
    );

  const firstM = monthList[0];
  const lastM = monthList[monthList.length - 1];
  const start = `${year}-${pad2(firstM)}-01`;
  const endDay = new Date(year, lastM, 0).getDate();
  const end = `${year}-${pad2(lastM)}-${pad2(endDay)}`;

  const [diagRows, invRows] = await Promise.all([
    run(DIAGNOSIS_SQL, [start, end]),
    run(INVOICE_SQL, [`${start} 00:00:00`, `${end} 23:59:59`]),
  ]);

  const patientSpec = new Map();
  for (const d of diagRows) {
    const rawSpec = (d.speciality || "").toString().trim() || "Unspecified";
    patientSpec.set(d.patient_id, {
      label: rawSpec,
      key: rawSpec.toLowerCase(),
      subTypes: subTypesFor(parseProvisional(d.provisionalDiagnosis), rawSpec),
    });
  }
  const UNSPEC = { label: "Unspecified", key: "unspecified", subTypes: [] };

  const monthTotals = {};
  for (const m of monthList) monthTotals[m] = { surgeries: 0, revenue: 0 };

  const typeMonth = {};
  const ensureType = (key, label) => {
    if (!typeMonth[key]) {
      typeMonth[key] = { label, months: {} };
      for (const m of monthList)
        typeMonth[key].months[m] = { surgeries: 0, revenue: 0 };
    } else {
      typeMonth[key].label = preferLabel(typeMonth[key].label, label);
    }
    return typeMonth[key];
  };

  const invoicedPatients = new Set();

  for (const r of invRows) {
    const mon = Number(r.mon);
    if (!monthTotals[mon]) continue;
    const rev = Number(r.revenue) || 0;
    const spec = patientSpec.get(r.patient_id) || UNSPEC;

    monthTotals[mon].surgeries += 1;
    monthTotals[mon].revenue += rev;

    const t = ensureType(spec.key, spec.label);
    t.months[mon].surgeries += 1;
    t.months[mon].revenue += rev;

    invoicedPatients.add(r.patient_id);
  }

  const subTypes = {};
  for (const pid of invoicedPatients) {
    const spec = patientSpec.get(pid);
    if (!spec || !spec.subTypes.length) continue;
    if (!subTypes[spec.key])
      subTypes[spec.key] = { label: spec.label, subs: {} };
    else
      subTypes[spec.key].label = preferLabel(
        subTypes[spec.key].label,
        spec.label,
      );
    for (const st of spec.subTypes) {
      const raw = st.toString().trim();
      if (!raw) continue;
      const sk = raw.toLowerCase();
      if (!subTypes[spec.key].subs[sk])
        subTypes[spec.key].subs[sk] = { label: raw, count: 0 };
      else
        subTypes[spec.key].subs[sk].label = preferLabel(
          subTypes[spec.key].subs[sk].label,
          raw,
        );
      subTypes[spec.key].subs[sk].count += 1;
    }
  }

  return { monthTotals, typeMonth, subTypes };
}

function emptyYearAgg(monthList) {
  const monthTotals = {};
  for (const m of monthList) monthTotals[m] = { surgeries: 0, revenue: 0 };
  return { monthTotals, typeMonth: {}, subTypes: {} };
}

function mergeYear(agg, part, monthList) {
  for (const m of monthList) {
    agg.monthTotals[m].surgeries += part.monthTotals[m].surgeries;
    agg.monthTotals[m].revenue += part.monthTotals[m].revenue;
  }
  for (const key of Object.keys(part.typeMonth)) {
    const src = part.typeMonth[key];
    if (!agg.typeMonth[key]) {
      agg.typeMonth[key] = { label: src.label, months: {} };
      for (const m of monthList)
        agg.typeMonth[key].months[m] = { surgeries: 0, revenue: 0 };
    } else {
      agg.typeMonth[key].label = preferLabel(
        agg.typeMonth[key].label,
        src.label,
      );
    }
    for (const m of monthList) {
      agg.typeMonth[key].months[m].surgeries += src.months[m].surgeries;
      agg.typeMonth[key].months[m].revenue += src.months[m].revenue;
    }
  }
  for (const key of Object.keys(part.subTypes)) {
    const src = part.subTypes[key];
    if (!agg.subTypes[key]) agg.subTypes[key] = { label: src.label, subs: {} };
    else
      agg.subTypes[key].label = preferLabel(agg.subTypes[key].label, src.label);
    for (const sk of Object.keys(src.subs)) {
      const s = src.subs[sk];
      if (!agg.subTypes[key].subs[sk])
        agg.subTypes[key].subs[sk] = { label: s.label, count: 0 };
      else
        agg.subTypes[key].subs[sk].label = preferLabel(
          agg.subTypes[key].subs[sk].label,
          s.label,
        );
      agg.subTypes[key].subs[sk].count += s.count;
    }
  }
}

/* ── small reducers over a collect() result ───────────────────────────────── */

function windowTotals(monthTotals, monthList) {
  return monthList.reduce(
    (a, m) => {
      a.surgeries += monthTotals[m].surgeries;
      a.revenue += monthTotals[m].revenue;
      return a;
    },
    { surgeries: 0, revenue: 0 },
  );
}

function monthlyArray(monthTotals, monthList) {
  return monthList.map((m) => ({
    month: m,
    monthName: MONTH_NAMES[m - 1],
    surgeries: monthTotals[m].surgeries,
    revenue: round2(monthTotals[m].revenue),
  }));
}

const zeroMonthly = (monthList) =>
  monthList.map((m) => ({
    month: m,
    monthName: MONTH_NAMES[m - 1],
    surgeries: 0,
    revenue: 0,
  }));

// { typeKey: { label, surgeries, revenue } } window totals from a collect() result.
function typesWindow(part, monthList) {
  const out = {};
  if (!part) return out;
  for (const key of Object.keys(part.typeMonth)) {
    const tm = part.typeMonth[key];
    const s = windowTotals(tm.months, monthList);
    out[key] = {
      label: tm.label,
      surgeries: s.surgeries,
      revenue: round2(s.revenue),
    };
  }
  return out;
}

/* ── Main entry point ─────────────────────────────────────────────────────── */

async function getMonthwiseSurgeryReport(locations, options = {}) {
  if (!Array.isArray(locations) || locations.length === 0) {
    const err = new Error(
      "`locations` must be a non-empty array of branch names.",
    );
    err.status = 400;
    throw err;
  }

  const year = Number(options.year) || 2026;
  const previousYear = Number(options.previousYear) || year - 1;
  const startMonth = Number(options.startMonth) || 1;
  const endMonth = Number(options.endMonth) || 6;
  if (endMonth < startMonth) {
    const err = new Error("`endMonth` cannot be earlier than `startMonth`.");
    err.status = 400;
    throw err;
  }

  const monthList = [];
  for (let m = startMonth; m <= endMonth; m++) monthList.push(m);

  const failures = [];
  const failed = new Set();
  const aggByYear = {
    [year]: emptyYearAgg(monthList),
    [previousYear]: emptyYearAgg(monthList),
  };
  const perLoc = {}; // loc -> { [year]: collectResult, [previousYear]: collectResult }
  for (const loc of locations) perLoc[loc] = {};

  async function collect(loc, yr) {
    if (failed.has(loc)) return;
    try {
      const part = await collectLocationYear(loc, yr, monthList);
      mergeYear(aggByYear[yr], part, monthList);
      perLoc[loc][yr] = part;
    } catch (e) {
      failed.add(loc);
      failures.push({ location: loc, error: e?.message || String(e) });
    }
  }

  for (const yr of [year, previousYear]) {
    await Promise.all(locations.map((loc) => collect(loc, yr)));
  }

  const aggY = aggByYear[year];
  const aggP = aggByYear[previousYear];

  // ── Group-level monthly totals ──
  const months = monthList.map((m) => {
    const c = aggY.monthTotals[m];
    const p = aggP.monthTotals[m];
    return {
      month: m,
      monthName: MONTH_NAMES[m - 1],
      current: {
        year,
        surgeries: c.surgeries,
        revenue: round2(c.revenue),
        avgRevenue: c.surgeries ? round2(c.revenue / c.surgeries) : 0,
      },
      previous: {
        year: previousYear,
        surgeries: p.surgeries,
        revenue: round2(p.revenue),
        avgRevenue: p.surgeries ? round2(p.revenue / p.surgeries) : 0,
      },
      change: {
        surgeries: {
          amount: c.surgeries - p.surgeries,
          pct: pctChange(c.surgeries, p.surgeries),
        },
        revenue: {
          amount: round2(c.revenue - p.revenue),
          pct: pctChange(c.revenue, p.revenue),
        },
      },
    };
  });

  const cT = windowTotals(aggY.monthTotals, monthList);
  const pT = windowTotals(aggP.monthTotals, monthList);
  const totals = {
    current: {
      year,
      surgeries: cT.surgeries,
      revenue: round2(cT.revenue),
      avgRevenue: cT.surgeries ? round2(cT.revenue / cT.surgeries) : 0,
    },
    previous: {
      year: previousYear,
      surgeries: pT.surgeries,
      revenue: round2(pT.revenue),
      avgRevenue: pT.surgeries ? round2(pT.revenue / pT.surgeries) : 0,
    },
    change: {
      surgeries: {
        amount: cT.surgeries - pT.surgeries,
        pct: pctChange(cT.surgeries, pT.surgeries),
      },
      revenue: {
        amount: round2(cT.revenue - pT.revenue),
        pct: pctChange(cT.revenue, pT.revenue),
      },
    },
  };

  // ── Group-level break-up by surgery type ──
  const typeKeys = new Set([
    ...Object.keys(aggY.typeMonth),
    ...Object.keys(aggP.typeMonth),
  ]);
  const surgeryTypes = [...typeKeys]
    .map((key) => {
      const cy = aggY.typeMonth[key];
      const py = aggP.typeMonth[key];
      const label =
        preferLabel(cy && cy.label, py && py.label) ||
        (cy ? cy.label : py.label);
      const c = cy
        ? windowTotals(cy.months, monthList)
        : { surgeries: 0, revenue: 0 };
      const p = py
        ? windowTotals(py.months, monthList)
        : { surgeries: 0, revenue: 0 };

      const monthlyCurrent = monthList.map((m) => ({
        month: m,
        monthName: MONTH_NAMES[m - 1],
        surgeries: cy ? cy.months[m].surgeries : 0,
        revenue: cy ? round2(cy.months[m].revenue) : 0,
      }));
      const monthlyPrevious = monthList.map((m) => ({
        month: m,
        monthName: MONTH_NAMES[m - 1],
        surgeries: py ? py.months[m].surgeries : 0,
        revenue: py ? round2(py.months[m].revenue) : 0,
      }));

      const subKeys = new Set([
        ...Object.keys((aggY.subTypes[key] && aggY.subTypes[key].subs) || {}),
        ...Object.keys((aggP.subTypes[key] && aggP.subTypes[key].subs) || {}),
      ]);
      const subTypes = [...subKeys]
        .map((sk) => {
          const cSub = aggY.subTypes[key] && aggY.subTypes[key].subs[sk];
          const pSub = aggP.subTypes[key] && aggP.subTypes[key].subs[sk];
          const sLabel =
            preferLabel(cSub && cSub.label, pSub && pSub.label) ||
            (cSub ? cSub.label : pSub.label);
          const cCount = (cSub && cSub.count) || 0;
          const pCount = (pSub && pSub.count) || 0;
          return {
            name: capFirst(sLabel),
            current: { year, surgeries: cCount },
            previous: { year: previousYear, surgeries: pCount },
            change: { amount: cCount - pCount, pct: pctChange(cCount, pCount) },
          };
        })
        .sort((a, b) => b.current.surgeries - a.current.surgeries);

      return {
        key,
        type: capFirst(label),
        current: { year, surgeries: c.surgeries, revenue: round2(c.revenue) },
        previous: {
          year: previousYear,
          surgeries: p.surgeries,
          revenue: round2(p.revenue),
        },
        change: {
          surgeries: {
            amount: c.surgeries - p.surgeries,
            pct: pctChange(c.surgeries, p.surgeries),
          },
          revenue: {
            amount: round2(c.revenue - p.revenue),
            pct: pctChange(c.revenue, p.revenue),
          },
        },
        monthlyCurrent,
        monthlyPrevious,
        subTypes,
      };
    })
    .sort(
      (a, b) =>
        b.current.revenue - a.current.revenue ||
        b.current.surgeries - a.current.surgeries,
    );

  // Stable type column order for the location × type sheets.
  const typeOrder = surgeryTypes.map((t) => ({ key: t.key, label: t.type }));

  // ── Per-location breakdown ──
  const byLocation = locations
    .map((loc) => {
      const cur = perLoc[loc][year];
      const prev = perLoc[loc][previousYear];
      if (!cur && !prev) return null; // fully failed → see locationsFailed
      const cWin = cur
        ? windowTotals(cur.monthTotals, monthList)
        : { surgeries: 0, revenue: 0 };
      const pWin = prev
        ? windowTotals(prev.monthTotals, monthList)
        : { surgeries: 0, revenue: 0 };
      return {
        location: loc,
        current: {
          year,
          surgeries: cWin.surgeries,
          revenue: round2(cWin.revenue),
        },
        previous: {
          year: previousYear,
          surgeries: pWin.surgeries,
          revenue: round2(pWin.revenue),
        },
        change: {
          surgeries: {
            amount: cWin.surgeries - pWin.surgeries,
            pct: pctChange(cWin.surgeries, pWin.surgeries),
          },
          revenue: {
            amount: round2(cWin.revenue - pWin.revenue),
            pct: pctChange(cWin.revenue, pWin.revenue),
          },
        },
        monthlyCurrent: cur
          ? monthlyArray(cur.monthTotals, monthList)
          : zeroMonthly(monthList),
        monthlyPrevious: prev
          ? monthlyArray(prev.monthTotals, monthList)
          : zeroMonthly(monthList),
        typesCurrent: typesWindow(cur, monthList),
        typesPrevious: typesWindow(prev, monthList),
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        b.current.revenue - a.current.revenue ||
        b.current.surgeries - a.current.surgeries,
    );

  return {
    generatedAt: new Date().toISOString(),
    definition:
      "Surgery = an IPD invoice case (invoice.totalamt) in the month; type = the patient's " +
      "latest diagnosis.speciality; undiagnosed IPD cases are grouped as 'Unspecified'. " +
      "Revenue = SUM(invoice.totalamt). Reconciles with the Doctor Performance report.",
    period: {
      year,
      previousYear,
      months: `${MONTH_NAMES[startMonth - 1]}–${MONTH_NAMES[endMonth - 1]}`,
      startMonth,
      endMonth,
      monthList,
      monthNames: monthList.map((m) => MONTH_NAMES[m - 1]),
    },
    locationsRequested: locations,
    locationsFailed: failures,
    months,
    totals,
    surgeryTypes,
    typeOrder,
    byLocation,
  };
}

/* ===========================================================================
 * Excel export (SheetJS)
 * ======================================================================== */

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

// Comparison sheet shared by Month / Type / Location (same 8 columns).
// The Total row is summed from the visible rows.
function buildComparisonSheet(
  report,
  kind /* 'month' | 'type' | 'location' */,
) {
  const { year: Y, previousYear: P, months: ML } = report.period;
  const cfg = {
    month: {
      first: "Month",
      rows: report.months,
      label: (r) => r.monthName,
      title: `Monthly Surgeries & Revenue — ${P} vs ${Y} (${ML})`,
      totalLabel: `Total (${ML})`,
      w: 16,
    },
    type: {
      first: "Surgery Type",
      rows: report.surgeryTypes,
      label: (r) => r.type,
      title: `Surgery Break-up by Type — ${P} vs ${Y} (${ML})`,
      totalLabel: "Total",
      w: 22,
    },
    location: {
      first: "Location",
      rows: report.byLocation,
      label: (r) => r.location,
      title: `Surgeries & Revenue by Location — ${P} vs ${Y} (${ML})`,
      totalLabel: "Grand Total",
      w: 22,
    },
  }[kind];

  const header = [
    cfg.first,
    `Surgeries ${Y}`,
    `Surgeries ${P}`,
    "Δ Surgeries",
    `Revenue (₹) ${Y}`,
    `Revenue (₹) ${P}`,
    "Δ Revenue (₹)",
    "Δ Revenue (%)",
  ];
  const aoa = [[cfg.title], [], header];

  const rowFor = (label, c, p) => [
    label,
    c.surgeries,
    p.surgeries,
    c.surgeries - p.surgeries,
    c.revenue,
    p.revenue,
    round2(c.revenue - p.revenue),
    pctFraction(c.revenue, p.revenue) ?? "N/A",
  ];

  const t = { cs: 0, cr: 0, ps: 0, pr: 0 };
  cfg.rows.forEach((r) => {
    aoa.push(rowFor(cfg.label(r), r.current, r.previous));
    t.cs += r.current.surgeries;
    t.cr += r.current.revenue;
    t.ps += r.previous.surgeries;
    t.pr += r.previous.revenue;
  });
  aoa.push(
    rowFor(
      cfg.totalLabel,
      { surgeries: t.cs, revenue: round2(t.cr) },
      { surgeries: t.ps, revenue: round2(t.pr) },
    ),
  );

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }];
  ws["!cols"] = [
    { wch: cfg.w },
    { wch: 14 },
    { wch: 14 },
    { wch: 12 },
    { wch: 16 },
    { wch: 16 },
    { wch: 15 },
    { wch: 13 },
  ];

  const fr = 3;
  const lr = 3 + cfg.rows.length;
  [1, 2, 3, 4, 5, 6].forEach((c) => formatColumn(ws, c, fr, lr, NUM_FMT));
  formatColumn(ws, 7, fr, lr, PCT_FMT);
  return ws;
}

// Location × Month matrix (counts or revenue), for one year.
function buildLocationMonthSheet(
  report,
  metric /* 'surgeries'|'revenue' */,
  which /* 'current'|'previous' */,
  yr,
) {
  const monthNames = report.period.monthNames;
  const isRev = metric === "revenue";
  const title = `${isRev ? "Surgery Revenue (₹)" : "Number of Surgeries"} by Location × Month — ${yr} (${report.period.months})`;
  const header = ["Location", ...monthNames, isRev ? "Total (₹)" : "Total"];
  const aoa = [[title], [], header];
  const key = which === "current" ? "monthlyCurrent" : "monthlyPrevious";

  const colSums = new Array(monthNames.length).fill(0);
  let grand = 0;
  report.byLocation.forEach((loc) => {
    const vals = loc[key].map((mm) => (isRev ? mm.revenue : mm.surgeries) || 0);
    const rowTotal = vals.reduce((a, b) => a + b, 0);
    vals.forEach((v, i) => (colSums[i] += v));
    grand += rowTotal;
    aoa.push([loc.location, ...vals, rowTotal]);
  });
  aoa.push(["Grand Total", ...colSums, grand]);

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }];
  ws["!cols"] = [
    { wch: 22 },
    ...monthNames.map(() => ({ wch: 13 })),
    { wch: 15 },
  ];
  const fr = 3;
  const lr = 3 + report.byLocation.length;
  for (let c = 1; c < header.length; c++) formatColumn(ws, c, fr, lr, NUM_FMT);
  return ws;
}

// Location × Surgery-Type matrix (counts or revenue), for one year.
function buildLocationTypeSheet(
  report,
  metric /* 'surgeries'|'revenue' */,
  which /* 'current'|'previous' */,
  yr,
) {
  const typeOrder = report.typeOrder;
  const isRev = metric === "revenue";
  const title = `${isRev ? "Surgery Revenue (₹)" : "Number of Surgeries"} by Location × Type — ${yr} (${report.period.months})`;
  const header = [
    "Location",
    ...typeOrder.map((t) => t.label),
    isRev ? "Total (₹)" : "Total",
  ];
  const aoa = [[title], [], header];
  const bag = which === "current" ? "typesCurrent" : "typesPrevious";

  const colSums = new Array(typeOrder.length).fill(0);
  let grand = 0;
  report.byLocation.forEach((loc) => {
    const vals = typeOrder.map((t) => {
      const cell = loc[bag][t.key];
      return cell ? (isRev ? cell.revenue : cell.surgeries) || 0 : 0;
    });
    const rowTotal = vals.reduce((a, b) => a + b, 0);
    vals.forEach((v, i) => (colSums[i] += v));
    grand += rowTotal;
    aoa.push([loc.location, ...vals, rowTotal]);
  });
  aoa.push(["Grand Total", ...colSums, grand]);

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }];
  ws["!cols"] = [
    { wch: 22 },
    ...typeOrder.map(() => ({ wch: 15 })),
    { wch: 15 },
  ];
  const fr = 3;
  const lr = 3 + report.byLocation.length;
  for (let c = 1; c < header.length; c++) formatColumn(ws, c, fr, lr, NUM_FMT);
  return ws;
}

/** Build the full location-wise workbook from an already-computed report. */
function buildMonthwiseSurgeryWorkbook(report) {
  const { year } = report.period;
  const wb = xlsx.utils.book_new();

  // Group-level context
  xlsx.utils.book_append_sheet(
    wb,
    buildComparisonSheet(report, "month"),
    "Monthly Totals",
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildComparisonSheet(report, "type"),
    "By Surgery Type",
  );

  // Location-wise
  xlsx.utils.book_append_sheet(
    wb,
    buildComparisonSheet(report, "location"),
    "Location Summary",
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationMonthSheet(report, "surgeries", "current", year),
    `Surg by Loc-Month ${year}`,
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationMonthSheet(report, "revenue", "current", year),
    `Rev by Loc-Month ${year}`,
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationTypeSheet(report, "surgeries", "current", year),
    `Surg by Loc-Type ${year}`,
  );
  xlsx.utils.book_append_sheet(
    wb,
    buildLocationTypeSheet(report, "revenue", "current", year),
    `Rev by Loc-Type ${year}`,
  );

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

async function generateMonthwiseSurgeryExcel(locations, options = {}) {
  const report = await getMonthwiseSurgeryReport(locations, options);
  const wb = buildMonthwiseSurgeryWorkbook(report);

  const { year, previousYear, startMonth, endMonth } = report.period;
  const fileName = `Monthwise_Surgeries_${year}_vs_${previousYear}_${pad2(startMonth)}-${pad2(endMonth)}.xlsx`;
  const filePath = path.join(reportsDir, fileName);
  xlsx.writeFile(wb, filePath);

  return {
    success: true,
    filePath,
    fileName,
    branchesRequested: report.locationsRequested.length,
    locationsFailed: report.locationsFailed,
    report,
  };
}

/* ── Express adapters ─────────────────────────────────────────────────────── */

function extractParams(req) {
  const raw =
    (req.body && req.body.locations) ??
    (req.query && req.query.locations) ??
    null;

  let locations = raw;
  if (typeof raw === "string") {
    locations = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const options = {};
  if (req.query) {
    if (req.query.year) options.year = Number(req.query.year);
    if (req.query.previousYear)
      options.previousYear = Number(req.query.previousYear);
    if (req.query.startMonth) options.startMonth = Number(req.query.startMonth);
    if (req.query.endMonth) options.endMonth = Number(req.query.endMonth);
  }
  return { locations, options };
}

const getMonthwiseSurgeryReportHandler = async (req) => {
  const { locations, options } = extractParams(req);
  return getMonthwiseSurgeryReport(locations, options);
};

const generateMonthwiseSurgeryExcelHandler = async (req) => {
  const { locations, options } = extractParams(req);
  return generateMonthwiseSurgeryExcel(locations, options);
};

module.exports = {
  getMonthwiseSurgeryReport,
  getMonthwiseSurgeryReportHandler,
  buildMonthwiseSurgeryWorkbook,
  generateMonthwiseSurgeryExcel,
  generateMonthwiseSurgeryExcelHandler,
};
