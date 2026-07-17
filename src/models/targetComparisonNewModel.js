// targetComparisonModel.js
// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — new data sources + absolute dual targets + role gating.
//
// WHAT CHANGED
//   1. LAST YEAR now comes from the master table branch_monthly_actual
//      (branchMonthlyActualModel), summed over the period's months — NOT from
//      each branch's live DB. THIS YEAR still comes from the live location DB.
//   2. Targets are ABSOLUTE VALUES (branch_target_value), not percentages:
//         target = yearlyTarget * (monthsInPeriod / 12)
//      YoY and achievement % are derived from those.
//   3. Two target sets per branch:  'B' = Base,  'O' = Optimistic.
//   4. ROLE GATING: SuperAdmin receives both Base and Optimistic; every other
//      role receives Base only. The caller passes the user's role; the server
//      decides — the optimistic numbers are never sent to non-superadmins.
//
// RESPONSE SHAPES (superset of Phase 2 — old fields preserved)
//   branches: [{ id, name, thisYear, lastYear, yoy,
//                target,  ach,                      // Base (back-compat)
//                targetO, achO,                     // Optimistic (SuperAdmin only)
//                showOptimistic }]
//   detail params: [{ key, label, short, type, lastYear, thisYear, yoy,
//                     target,  ach,  targetPct,     // Base
//                     targetO, achO, targetPctO }]  // Optimistic (SuperAdmin only)
//   meta gains: { targetBasis, targetMonths, showOptimistic, role }
//
//   For non-superadmins the optimistic fields are simply absent, and
//   meta.showOptimistic = false, so the existing single-target UI renders
//   unchanged. targetPct is DERIVED for display (implied growth over last year).
// ─────────────────────────────────────────────────────────────────────────────

const { getLocationSummary } = require("./reportMailModel");
const { getConnectionByLocation } = require("../../databaseUtils");
const { financialYearOf } = require("./branchTargetModel");
const { getTargetValueMaps } = require("./branchTargetValueNewModel");
const { getMonthlyActuals } = require("./branchMonthlyActualNewModel");

// ─── ROLE ────────────────────────────────────────────────────────────────────
// Only SuperAdmin sees Optimistic targets. Accept a few spellings defensively.
function isSuperAdmin(role, subRole) {
  const norm = (v) =>
    String(v || "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]/g, "");
  return norm(role) === "superadmin" || norm(subRole) === "superadmin";
}

// ─── PARAMETER METADATA ──────────────────────────────────────────────────────
const PARAMS_META = [
  {
    key: "newPatients",
    label: "New Patients",
    short: "New Pat.",
    type: "count",
  },
  { key: "conversion", label: "Conversion", short: "Conv.", type: "percent" },
  { key: "sx", label: "No. of SX", short: "SX", type: "count" },
  { key: "avgIpd", label: "Avg IPD", short: "Avg IPD", type: "currency" },
  { key: "ipdRevenue", label: "IPD Revenue", short: "IPD", type: "currency" },
  {
    key: "pharmacy",
    label: "Pharmacy Revenue",
    short: "Pharmacy",
    type: "currency",
  },
  { key: "lab", label: "Lab Revenue", short: "Lab", type: "currency" },
  { key: "opd", label: "OPD Revenue", short: "OPD", type: "currency" },
  { key: "total", label: "Total Revenue", short: "Total", type: "currency" },
];

// Rate params are never prorated by the length of the period.
const RATE_PARAMS = new Set(["avgIpd", "conversion"]);

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
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const round2 = (n) =>
  Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
const roundByType = (type, n) =>
  type === "count" ? Math.round(Number(n) || 0) : round2(n);

const makeRunner =
  (connection) =>
  (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) =>
        err ? reject(err) : resolve(rows),
      ),
    );

// A branch is "configured" if it has a BASE target row (Base is the baseline
// every user sees; Optimistic is additive on top for SuperAdmin).
const splitByConfigured = (baseMap, locations) => ({
  configured: locations.filter((loc) => baseMap[loc]),
  skipped: locations.filter((loc) => !baseMap[loc]),
});

// ─── PERIOD LENGTH (months) — fractional, exact for whole months ─────────────
//   month → 1 (yearly/12), quarter → 3 (yearly/4), full FY → 12 (x1).
function monthsInRange(from, to) {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return 0;

  let months = 0;
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  for (;;) {
    const monthStart = new Date(Date.UTC(y, m, 1));
    const monthEnd = new Date(Date.UTC(y, m + 1, 0));
    const s = start > monthStart ? start : monthStart;
    const e = end < monthEnd ? end : monthEnd;
    if (e < s) break;
    months += ((e - s) / 86400000 + 1) / monthEnd.getUTCDate();
    if (monthEnd >= end) break;
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return months;
}

// ─── TARGETS: yearly absolutes → this period's targets ───────────────────────
function targetsForPeriod(v, months) {
  if (!v) return null;
  const f = months / 12;
  const scale = (n) => (n == null ? null : n * f);

  const sx = v.sxTarget;
  const np = v.newPatientsTarget;
  const avgIpd = v.avgIpdTarget;

  // Sheet defines IPD Revenue = SX x Avg IPD; derive it if the column is absent.
  const ipdRevYearly =
    v.ipdRevenueTarget != null
      ? v.ipdRevenueTarget
      : sx != null && avgIpd != null
        ? sx * avgIpd
        : null;

  return {
    newPatients: scale(np),
    conversion: np ? (sx / np) * 100 : null, // rate
    sx: scale(sx),
    avgIpd, // rate — not prorated
    ipdRevenue: scale(ipdRevYearly),
    pharmacy: scale(v.pharmacyTarget),
    lab: scale(v.labTarget),
    opd: scale(v.opdTarget),
    total: scale(v.totalTarget),
  };
}

// Consolidate several branches' YEARLY target rows into one.
function sumTargetValues(list) {
  const acc = {
    newPatientsTarget: 0,
    sxTarget: 0,
    totalTarget: 0,
    ipdWeighted: 0,
    ipdRevenueTarget: 0,
    pharmacyTarget: 0,
    labTarget: 0,
    opdTarget: 0,
  };
  let anyIpd = false,
    anyPh = false,
    anyLab = false,
    anyOpd = false;
  for (const v of list) {
    if (!v) continue;
    acc.newPatientsTarget += v.newPatientsTarget || 0;
    acc.sxTarget += v.sxTarget || 0;
    acc.totalTarget += v.totalTarget || 0;
    acc.ipdWeighted += (v.sxTarget || 0) * (v.avgIpdTarget || 0);
    if (v.ipdRevenueTarget != null) {
      anyIpd = true;
      acc.ipdRevenueTarget += v.ipdRevenueTarget;
    }
    if (v.pharmacyTarget != null) {
      anyPh = true;
      acc.pharmacyTarget += v.pharmacyTarget;
    }
    if (v.labTarget != null) {
      anyLab = true;
      acc.labTarget += v.labTarget;
    }
    if (v.opdTarget != null) {
      anyOpd = true;
      acc.opdTarget += v.opdTarget;
    }
  }
  return {
    newPatientsTarget: acc.newPatientsTarget,
    sxTarget: acc.sxTarget,
    avgIpdTarget: acc.sxTarget ? acc.ipdWeighted / acc.sxTarget : null,
    ipdRevenueTarget: anyIpd ? acc.ipdRevenueTarget : null,
    pharmacyTarget: anyPh ? acc.pharmacyTarget : null,
    labTarget: anyLab ? acc.labTarget : null,
    opdTarget: anyOpd ? acc.opdTarget : null,
    totalTarget: acc.totalTarget,
  };
}

// target / yoy / ach / implied targetPct for one absolute target.
function deriveOne(lastYear, thisYear, target) {
  if (target == null) return { target: null, ach: null, targetPct: null };
  const t = round2(target);
  const ach = t ? round2((thisYear / t) * 100) : 0;
  const targetPct = lastYear ? round2(((t - lastYear) / lastYear) * 100) : null;
  return { target: t, ach, targetPct };
}
const yoyOf = (lastYear, thisYear) =>
  lastYear ? round2(((thisYear - lastYear) / lastYear) * 100) : 0;

// ─── DATE-RANGE RESOLUTION ───────────────────────────────────────────────────
function shiftYearStr(dateStr, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr).trim());
  if (!m) {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) throw new Error(`Invalid date: ${dateStr}`);
    d.setFullYear(d.getFullYear() + delta);
    return d.toISOString().slice(0, 10);
  }
  const [, y, mo, da] = m;
  const year = Number(y) + delta;
  let day = Number(da);
  if (mo === "02" && day === 29) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    if (!leap) day = 28;
  }
  return `${year}-${mo}-${String(day).padStart(2, "0")}`;
}

function resolveRanges(opts) {
  const { from, to } = opts;
  if (!from || !to) {
    const e = new Error("`from` and `to` (YYYY-MM-DD) are required");
    e.status = 400;
    throw e;
  }
  const fromLY = opts.fromLastYear || shiftYearStr(from, -1);
  const toLY = opts.toLastYear || shiftYearStr(to, -1);
  return { fromTY: from, toTY: to, fromLY, toLY };
}

function buildMeta(r, extra = {}) {
  return {
    periodLabel: `${r.fromTY} to ${r.toTY} vs ${r.fromLY} to ${r.toLY}`,
    range: {
      from: r.fromTY,
      to: r.toTY,
      fromLastYear: r.fromLY,
      toLastYear: r.toLY,
    },
    ...extra,
  };
}

// ─── ACTUALS: THIS YEAR from the live location DB (unchanged) ─────────────────
async function getNewPatientCount(location, from, to) {
  const { connection } = getConnectionByLocation(location);
  if (!connection) throw new Error(`Invalid location: ${location}`);
  const run = makeRunner(connection);
  const [row] = await run(
    `SELECT COUNT(patient_type) AS newpatient
       FROM appointment
      WHERE appointment_timestamp BETWEEN ? AND ?
        AND patient_type = 'New' AND is_deleted != 1 AND executivechk = 2`,
    [from, to],
  );
  return Number(row?.newpatient) || 0;
}

async function getIpdInvoiceCount(location, from, to) {
  const { connection } = getConnectionByLocation(location);
  if (!connection) throw new Error(`Invalid location: ${location}`);
  const run = makeRunner(connection);
  const [row] = await run(
    `SELECT COUNT(*) AS cnt FROM invoice
      WHERE creation_date >= ? AND creation_date <= ? AND is_deleted != 1`,
    [`${from} 00:00:00`, `${to} 23:59:59`],
  );
  return Number(row?.cnt) || 0;
}

// THIS-YEAR raw components from the live branch DB.
async function getThisYearRaw(location, from, to) {
  const summary = await getLocationSummary(location, from, to);
  const [newPatients, ipdInvoiceCount] = await Promise.all([
    getNewPatientCount(location, from, to),
    getIpdInvoiceCount(location, from, to),
  ]);
  return {
    newPatients,
    ipdInvoiceTotal: Number(summary?.ipdInvoice?.total) || 0,
    ipdInvoiceCount,
    pharmacyTotal: Number(summary?.pharmacy?.total) || 0,
    opdTotal: Number(summary?.opd?.total) || 0,
    labTotal: 0,
  };
}

// LAST-YEAR raw components from the MASTER monthly table.
async function getLastYearRaw(location, fromLY, toLY) {
  return getMonthlyActuals(location, fromLY, toLY);
}

function sumRaw(list) {
  return list.reduce(
    (a, r) => ({
      newPatients: a.newPatients + (r.newPatients || 0),
      ipdInvoiceTotal: a.ipdInvoiceTotal + (r.ipdInvoiceTotal || 0),
      ipdInvoiceCount: a.ipdInvoiceCount + (r.ipdInvoiceCount || 0),
      pharmacyTotal: a.pharmacyTotal + (r.pharmacyTotal || 0),
      opdTotal: a.opdTotal + (r.opdTotal || 0),
      labTotal: a.labTotal + (r.labTotal || 0),
    }),
    {
      newPatients: 0,
      ipdInvoiceTotal: 0,
      ipdInvoiceCount: 0,
      pharmacyTotal: 0,
      opdTotal: 0,
      labTotal: 0,
    },
  );
}

function rawToActuals(raw) {
  const newPatients = raw.newPatients;
  const sx = raw.ipdInvoiceCount;
  const conversion = newPatients ? (sx / newPatients) * 100 : 0;
  const avgIpd = raw.ipdInvoiceCount
    ? raw.ipdInvoiceTotal / raw.ipdInvoiceCount
    : 0;
  const ipdRevenue = raw.ipdInvoiceTotal;
  const pharmacy = raw.pharmacyTotal;
  const lab = raw.labTotal || 0;
  const opd = raw.opdTotal;
  const total = opd + ipdRevenue + pharmacy + lab;
  return {
    newPatients,
    conversion,
    sx,
    avgIpd,
    ipdRevenue,
    pharmacy,
    lab,
    opd,
    total,
  };
}

// ─── BRANCH LIST (overview) ──────────────────────────────────────────────────
const getComparisonBranchList = async (opts) => {
  const r = resolveRanges(opts);
  const fy = financialYearOf(r.fromTY);
  const months = monthsInRange(r.fromTY, r.toTY);
  const showOptimistic = isSuperAdmin(opts.role, opts.subRole);

  const { B: baseMap, O: optMap } = await getTargetValueMaps(fy);

  const requested = opts.locations?.length ? opts.locations : DEFAULT_LOCATIONS;
  const { configured: targets, skipped } = splitByConfigured(
    baseMap,
    requested,
  );

  const branches = await Promise.all(
    targets.map(async (loc) => {
      try {
        const [tyRaw, lyRaw] = await Promise.all([
          getThisYearRaw(loc, r.fromTY, r.toTY),
          getLastYearRaw(loc, r.fromLY, r.toLY),
        ]);
        const thisYear = Math.round(rawToActuals(tyRaw).total);
        const lastYear = Math.round(rawToActuals(lyRaw).total);
        const yoy = yoyOf(lastYear, thisYear);

        const baseT = targetsForPeriod(baseMap[loc], months);
        const base = deriveOne(lastYear, thisYear, baseT?.total ?? null);

        const out = {
          id: loc,
          name: loc,
          thisYear,
          lastYear,
          yoy,
          target: base.target,
          ach: base.ach,
          showOptimistic,
          lastYearMissing: (lyRaw._found || 0) === 0,
        };
        if (showOptimistic) {
          const optT = targetsForPeriod(optMap[loc], months);
          const opt = deriveOne(lastYear, thisYear, optT?.total ?? null);
          out.targetO = opt.target;
          out.achO = opt.ach;
        }
        return out;
      } catch (e) {
        console.error(`branch list failed for ${loc}:`, e.message);
        return {
          id: loc,
          name: loc,
          thisYear: 0,
          lastYear: 0,
          yoy: 0,
          target: 0,
          ach: 0,
          targetO: showOptimistic ? 0 : undefined,
          achO: showOptimistic ? 0 : undefined,
          showOptimistic,
          error: e.message,
        };
      }
    }),
  );

  return {
    meta: buildMeta(r, {
      fy,
      skipped,
      showOptimistic,
      role: showOptimistic ? "SuperAdmin" : "user",
      targetBasis: "yearly x (months/12)",
      targetMonths: round2(months),
      lastYearSource: "branch_monthly_actual (master)",
    }),
    branches,
  };
};

// ─── DETAIL ──────────────────────────────────────────────────────────────────
const getComparisonDetail = async (opts) => {
  const r = resolveRanges(opts);
  const branchId = opts.branch || "all";
  const fy = financialYearOf(r.fromTY);
  const months = monthsInRange(r.fromTY, r.toTY);
  const showOptimistic = isSuperAdmin(opts.role, opts.subRole);

  const { B: baseMap, O: optMap } = await getTargetValueMaps(fy);

  let branchName, tyRaw, lyRaw, baseYearly, optYearly;
  const warnings = [];

  if (branchId === "all") {
    const requested = opts.locations?.length
      ? opts.locations
      : DEFAULT_LOCATIONS;
    const { configured: targets, skipped } = splitByConfigured(
      baseMap,
      requested,
    );
    skipped.forEach((loc) =>
      warnings.push({ location: loc, skipped: "no target configured" }),
    );

    const tyList = [];
    const lyList = [];
    await Promise.all(
      targets.map(async (loc) => {
        try {
          const [t, l] = await Promise.all([
            getThisYearRaw(loc, r.fromTY, r.toTY),
            getLastYearRaw(loc, r.fromLY, r.toLY),
          ]);
          tyList.push(t);
          lyList.push(l);
          if ((l._found || 0) === 0)
            warnings.push({ location: loc, lastYear: "no master data" });
        } catch (e) {
          console.error(`detail(all) failed for ${loc}:`, e.message);
          warnings.push({ location: loc, error: e.message });
        }
      }),
    );

    tyRaw = sumRaw(tyList);
    lyRaw = sumRaw(lyList);
    baseYearly = targets.length
      ? sumTargetValues(targets.map((loc) => baseMap[loc]))
      : null;
    optYearly = targets.length
      ? sumTargetValues(targets.map((loc) => optMap[loc]).filter(Boolean))
      : null;
    branchName = "All Branches";
  } else {
    branchName = branchId;
    if (!baseMap[branchId]) {
      const err = new Error(
        `No target configured for "${branchId}" in FY ${fy}`,
      );
      err.status = 404;
      throw err;
    }
    try {
      [tyRaw, lyRaw] = await Promise.all([
        getThisYearRaw(branchId, r.fromTY, r.toTY),
        getLastYearRaw(branchId, r.fromLY, r.toLY),
      ]);
    } catch (e) {
      const err = new Error(
        `Target comparison failed for ${branchId}: ${e.message}`,
      );
      err.status = 404;
      throw err;
    }
    if ((lyRaw._found || 0) === 0)
      warnings.push({ location: branchId, lastYear: "no master data" });
    baseYearly = baseMap[branchId];
    optYearly = optMap[branchId] || null;
  }

  const tyA = rawToActuals(tyRaw);
  const lyA = rawToActuals(lyRaw);
  const baseP = targetsForPeriod(baseYearly, months) || {};
  const optP = showOptimistic ? targetsForPeriod(optYearly, months) || {} : {};

  const params = PARAMS_META.map((p) => {
    const lastYear = roundByType(p.type, lyA[p.key]);
    const thisYear = roundByType(p.type, tyA[p.key]);
    const yoy = yoyOf(lastYear, thisYear);

    let bt = baseP[p.key];
    if (bt != null) bt = roundByType(p.type, bt);
    const base = deriveOne(lastYear, thisYear, bt);

    const row = {
      key: p.key,
      label: p.label,
      short: p.short,
      type: p.type,
      isRate: RATE_PARAMS.has(p.key),
      lastYear,
      thisYear,
      yoy,
      target: base.target,
      ach: base.ach,
      targetPct: base.targetPct,
    };

    if (showOptimistic) {
      let ot = optP[p.key];
      if (ot != null) ot = roundByType(p.type, ot);
      const opt = deriveOne(lastYear, thisYear, ot);
      row.targetO = opt.target;
      row.achO = opt.ach;
      row.targetPctO = opt.targetPct;
    }
    return row;
  });

  return {
    meta: buildMeta(r, {
      branchId,
      branchName,
      fy,
      warnings,
      showOptimistic,
      role: showOptimistic ? "SuperAdmin" : "user",
      targetBasis: "yearly x (months/12)",
      targetMonths: round2(months),
      lastYearSource: "branch_monthly_actual (master)",
    }),
    params,
  };
};

module.exports = {
  getComparisonBranchList,
  getComparisonDetail,
  monthsInRange,
  targetsForPeriod,
  sumTargetValues,
  isSuperAdmin,
};
