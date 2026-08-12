// targetComparisonModel.js
// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3.1 — dual targets with a ROLE-DEPENDENT PRIMARY SET.
//
// TARGET SETS  'B' = Base,  'O' = Optimistic  (branch_target_value)
//
//   SuperAdmin      → primary = Base,       secondary = Optimistic
//                     (target/ach = Base, targetO/achO = Optimistic — unchanged)
//   Everyone else   → primary = OPTIMISTIC, no secondary
//                     (target/ach = Optimistic; targetO/achO absent)
//
// Because the primary set is always written into the existing target/ach/
// targetPct fields, the single-target UI needs no structural change — it just
// renders whichever set the server decided this user is entitled to.
//
// RESPONSE SHAPES
//   branches: [{ id, name, thisYear, lastYear, yoy,
//                target, ach, targetSet,          // primary ('B' or 'O')
//                targetO, achO,                   // SuperAdmin only
//                showOptimistic }]
//   detail params: [{ ..., target, ach, targetPct, targetSet,
//                     targetO, achO, targetPctO }] // SuperAdmin only
//   meta gains: { targetSet, primaryLabel, secondaryLabel, showOptimistic }
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

// ─── PRIMARY TARGET SET ──────────────────────────────────────────────────────
// SuperAdmin sees both columns (Base primary + Optimistic secondary).
// All other roles see Optimistic ONLY, delivered in the primary fields.

// Column header shown to non-superadmins. Set to "Optimistic" if you want the
// set named explicitly in the UI; "Target" keeps the two-tier scheme internal.
const PRIMARY_LABEL_FOR_USERS = "Target";

// If a branch has a Base row but no Optimistic row, fall back to Base rather
// than showing "no target set". Flip to false to show a dash instead.
const FALLBACK_TO_BASE_WHEN_NO_OPTIMISTIC = true;

/**
 * pickPrimaryYearly(loc, baseMap, optMap, showOptimistic)
 * → { yearly, set: 'B'|'O', fellBack }
 */
function pickPrimaryYearly(loc, baseMap, optMap, showOptimistic) {
  if (showOptimistic) {
    return { yearly: baseMap[loc] || null, set: "B", fellBack: false };
  }
  const o = optMap[loc];
  if (o) return { yearly: o, set: "O", fellBack: false };
  if (FALLBACK_TO_BASE_WHEN_NO_OPTIMISTIC && baseMap[loc]) {
    return { yearly: baseMap[loc], set: "B", fellBack: true };
  }
  return { yearly: null, set: "O", fellBack: false };
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

// Lab revenue for the period, matching dailyOPDModel's lab-collection logic:
//   • DP Road      → patient_receipt, chargeCondition='LabTest', receipt_date, totalamt
//   • every other  → patient_itemreceipt, consultation='LAB', item_date, total
// Uses the same is_deleted != 1 filter and inclusive date bounds as the actuals.
async function getLabRevenue(location, from, to) {
  const { connection } = getConnectionByLocation(location);
  if (!connection) throw new Error(`Invalid location: ${location}`);
  const run = makeRunner(connection);

  let sql;
  if (location === "DP Road") {
    sql = `
      SELECT COALESCE(SUM(pr.totalamt), 0) AS labTotal
      FROM patient_receipt pr
      WHERE pr.chargeCondition = 'LabTest'
        AND pr.receipt_date >= ? AND pr.receipt_date <= ?
        AND pr.is_deleted != 1`;
  } else {
    sql = `
      SELECT COALESCE(SUM(ip.total), 0) AS labTotal
      FROM patient_itemreceipt ip
      WHERE ip.consultation = 'LAB'
        AND ip.item_date >= ? AND ip.item_date <= ?
        AND ip.is_deleted != 1`;
  }

  const [row] = await run(sql, [`${from} 00:00:00`, `${to} 23:59:59`]);
  return Number(row?.labTotal) || 0;
}

// ─── LAB REVENUE (this year) ─────────────────────────────────────────────────
// Mirrors getDailyOPDCollectionV2's OPD/LAB split: the master table
// consultationMasterData decides which consultations are LAB, matched on the
// normalized name (lowercase, spaces stripped) exactly as V2 does.
//
// The payment-mode filter is deliberately identical to getLocationSummary's
// three OPD queries ('Cash', 'Card', 'Online'/'UPI'), so what this returns is
// precisely the LAB slice of summary.opd.total — subtracting it is exact.
const MASTER_DB_KEY = "lead";

const normalizeName = (v) =>
  String(v ?? "")
    .toLowerCase()
    .split(" ")
    .join("");

// The master consultation list is small, shared and rarely edited, but the
// branch loop hits this 40x per request — cache it briefly.
let _labNamesCache = { at: 0, names: null };
const LAB_NAMES_TTL_MS = 5 * 60 * 1000;

async function getLabConsultationNames() {
  const now = Date.now();
  if (_labNamesCache.names && now - _labNamesCache.at < LAB_NAMES_TTL_MS) {
    return _labNamesCache.names;
  }

  const { connection } = getConnectionByLocation(MASTER_DB_KEY);
  if (!connection) throw new Error(`No connection for "${MASTER_DB_KEY}" DB`);
  const run = makeRunner(connection);

  const rows = await run(
    `SELECT consultation_name, consultation_type
       FROM consultationMasterData
      WHERE is_deleted = '0'`,
  );

  // Drop blanks, keep LAB only, de-duplicate on the normalized name (V2 rules).
  const seen = new Set();
  const names = [];
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
    names.push(key);
  }

  _labNamesCache = { at: now, names };
  return names;
}

async function getLabRevenue(location, from, to) {
  const labNormNames = await getLabConsultationNames();
  if (!labNormNames.length) return 0; // V2's `1 = 0` branch → no LAB configured

  const { connection } = getConnectionByLocation(location);
  if (!connection) throw new Error(`Invalid location: ${location}`);
  const run = makeRunner(connection);

  // COALESCE keeps NULL-consultation rows out of the LAB set (V2's NORM_COL).
  const NORM_COL = "REPLACE(LOWER(COALESCE(consultation, '')), ' ', '')";
  const placeholders = labNormNames.map(() => "?").join(", ");

  const [row] = await run(
    `SELECT COALESCE(SUM(total), 0) AS Total
       FROM patient_itemreceipt
      WHERE item_date BETWEEN ? AND ?
        AND is_deleted != 1
        AND payment_mode IN ('Cash', 'Card', 'Online', 'UPI')
        AND ${NORM_COL} IN (${placeholders})`,
    [from, to, ...labNormNames],
  );

  return Number(row?.Total) || 0;
}

// THIS-YEAR raw components from the live branch DB.
async function getThisYearRaw(location, from, to) {
  const summary = await getLocationSummary(location, from, to);
  const [newPatients, ipdInvoiceCount, labTotal] = await Promise.all([
    getNewPatientCount(location, from, to),
    getIpdInvoiceCount(location, from, to),
    // Degrade safely: if the master lookup fails, lab = 0 leaves OPD gross and
    // `total` still correct — only the LAB row under-reports.
    getLabRevenue(location, from, to).catch((e) => {
      console.error(`lab revenue failed for ${location}:`, e.message);
      return 0;
    }),
  ]);

  return {
    newPatients,
    ipdInvoiceTotal: Number(summary?.ipdInvoice?.total) || 0,
    ipdInvoiceCount,
    pharmacyTotal: Number(summary?.pharmacy?.total) || 0,
    // summary.opd.total includes LAB — net it out so the LAB parameter stands
    // alone and rawToActuals' `opd + ipd + pharmacy + lab` counts it once.
    opdTotal: (Number(summary?.opd?.total) || 0) - labTotal,
    labTotal,
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

        const picked = pickPrimaryYearly(loc, baseMap, optMap, showOptimistic);
        const primaryT = targetsForPeriod(picked.yearly, months);
        const primary = deriveOne(lastYear, thisYear, primaryT?.total ?? null);

        const out = {
          id: loc,
          name: loc,
          thisYear,
          lastYear,
          yoy,
          target: primary.target,
          ach: primary.ach,
          targetSet: picked.set,
          showOptimistic,
          lastYearMissing: (lyRaw._found || 0) === 0,
          targetFellBackToBase: picked.fellBack || undefined,
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
          target: null, // was 0 — null renders as "—" not a red 0%
          ach: null,
          targetSet: showOptimistic ? "B" : "O",
          targetO: showOptimistic ? null : undefined,
          achO: showOptimistic ? null : undefined,
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
      targetSet: showOptimistic ? "B" : "O",
      primaryLabel: showOptimistic ? "Base" : PRIMARY_LABEL_FOR_USERS,
      secondaryLabel: showOptimistic ? "Optimistic" : null,
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

  let branchName, tyRaw, lyRaw, primaryYearly, optYearly;
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
    const picks = targets.map((loc) =>
      pickPrimaryYearly(loc, baseMap, optMap, showOptimistic),
    );
    picks.forEach((p, i) => {
      if (p.fellBack) {
        warnings.push({
          location: targets[i],
          target: "no optimistic row — base target used",
        });
      }
    });

    primarySet = showOptimistic ? "B" : "O";
    primaryYearly = targets.length
      ? sumTargetValues(picks.map((p) => p.yearly).filter(Boolean))
      : null;
    optYearly =
      showOptimistic && targets.length
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
    const picked = pickPrimaryYearly(branchId, baseMap, optMap, showOptimistic);
    if (picked.fellBack) {
      warnings.push({
        location: branchId,
        target: "no optimistic row — base target used",
      });
    }
    primarySet = picked.set;
    primaryYearly = picked.yearly;
    optYearly = showOptimistic ? optMap[branchId] || null : null;
  }

  const tyA = rawToActuals(tyRaw);
  const lyA = rawToActuals(lyRaw);
  const primaryP = targetsForPeriod(primaryYearly, months) || {};
  const optP = showOptimistic ? targetsForPeriod(optYearly, months) || {} : {};

  const params = PARAMS_META.map((p) => {
    const lastYear = roundByType(p.type, lyA[p.key]);
    const thisYear = roundByType(p.type, tyA[p.key]);
    const yoy = yoyOf(lastYear, thisYear);

    let pt = primaryP[p.key];
    if (pt != null) pt = roundByType(p.type, pt);
    const prim = deriveOne(lastYear, thisYear, pt);

    const row = {
      key: p.key,
      label: p.label,
      short: p.short,
      type: p.type,
      isRate: RATE_PARAMS.has(p.key),
      lastYear,
      thisYear,
      yoy,
      target: prim.target,
      ach: prim.ach,
      targetPct: prim.targetPct,
      targetSet: primarySet,
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
      targetSet: primarySet,
      primaryLabel: showOptimistic ? "Base" : PRIMARY_LABEL_FOR_USERS,
      secondaryLabel: showOptimistic ? "Optimistic" : null,
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
  pickPrimaryYearly,
};
