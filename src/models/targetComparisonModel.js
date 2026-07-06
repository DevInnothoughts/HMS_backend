// targetComparisonModel.js
// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — real MySQL-backed implementation.
//
// Response shapes are IDENTICAL to the Phase-1 dummy version, so the React
// Native screens (TargetComparisonScreen / BranchTargetDetailScreen) need no
// structural change — only the data source switches from local builders to
// these two endpoints.
//
// Metric sources
// --------------
//   Revenue is taken straight from the existing getLocationSummary():
//        Total Revenue  = summary.grandTotal      (OPD + IPD invoice + Pharmacy,
//                                                   IPD *collection* excluded — req 1)
//        IPD Revenue    = summary.ipdInvoice.total (all statuses incl. Charity — req 4)
//        Pharmacy       = summary.pharmacy.total   (total only — req 5)
//        OPD Revenue    = summary.opd.total        (total only — req 7)
//     Reusing it means these figures match your other reports exactly.
//   Lab Revenue   = 0                               (req 6 — kept zero)
//   New Patients  = COUNT of 'New' appointment rows in the period (req 2)
//   No. of SX     = distinct New-Patient ids that have an invoice with
//                   creation_date >= the period's `from` date (req 3)
//   Avg IPD       = IPD invoice total / IPD invoice count (same filter, incl. Charity)
//   Conversion    = SX / New Patients * 100 (derived)
//   target %      = read per-branch + financial-year from the master DB
//                   `branch_target` table; falls back to the prototype
//                   defaults below if the table/row/connection is unavailable.
//
//   Consolidation ("all") sums RAW components across the requested locations,
//   then recomputes the ratio metrics (conversion, avgIpd) from the summed
//   components — never an average-of-averages.
// ─────────────────────────────────────────────────────────────────────────────

const { getLocationSummary } = require("./reportMailModel");
const { getConnectionByLocation } = require("../../databaseUtils");
const { getTargetMap, financialYearOf } = require("./branchTargetModel");

// ─── PARAMETER METADATA ──────────────────────────────────────────────────────
// label/short/type drive the UI formatting. There are NO default target %s:
// every target comes from the branch_target table or it is null (see resolvePct).
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

// Fallback location list (used only when branch="all" and the frontend sends
// no `locations`). TODO: centralize — this duplicates app.js's `locations`.
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

// ─── SMALL HELPERS ───────────────────────────────────────────────────────────
const round2 = (n) =>
  Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
const roundByType = (type, n) =>
  type === "count" ? Math.round(Number(n) || 0) : round2(n);

// Target % strictly from branch_target. Returns the stored number (0 allowed)
// or null when not configured — never a default.
const resolvePct = (targetMap, branchKey, paramKey) => {
  const row = targetMap[branchKey];
  const v = row ? row[paramKey] : undefined;
  return v == null ? null : v;
};

// Only branches that have a row in branch_target (for the resolved FY) are
// processed. Splits the requested list into configured (kept) and skipped.
const splitByConfigured = (targetMap, locations) => ({
  configured: locations.filter((loc) => targetMap[loc]),
  skipped: locations.filter((loc) => !targetMap[loc]),
});

// Promisified query against a (pool) connection — same access pattern as
// getLocationSummary in reportMailModel.
const makeRunner =
  (connection) =>
  (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) =>
        err ? reject(err) : resolve(rows),
      ),
    );

// Derive target / yoy / ach for one lastYear/thisYear pair.
// targetPct null (no configured target) → target and ach are null; YoY still
// comes from the actuals.
function deriveMetrics(lastYear, thisYear, targetPct) {
  const yoy = lastYear ? round2(((thisYear - lastYear) / lastYear) * 100) : 0;
  if (targetPct == null) return { target: null, yoy, ach: null };
  const target = round2(lastYear * (1 + targetPct / 100));
  const ach = target ? round2((thisYear / target) * 100) : 0;
  return { target, yoy, ach };
}

// ─── DATE-RANGE RESOLUTION ───────────────────────────────────────────────────
// Frontend sends an explicit this-year range (`from`,`to`, "YYYY-MM-DD").
// Last-year range = the same window shifted back one year (same period prior
// year), overridable via fromLastYear/toLastYear.
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
    if (!leap) day = 28; // clamp Feb 29 in non-leap years
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

// ─── NEW METRIC QUERIES ──────────────────────────────────────────────────────

// New Patients: count of 'New' appointment rows in the period.
// appointment_timestamp is a DATE column → date-only BETWEEN bounds.
async function getNewPatientCount(location, from, to) {
  const { connection } = getConnectionByLocation(location);
  if (!connection) throw new Error(`Invalid location: ${location}`);
  const run = makeRunner(connection);

  const [row] = await run(
    `SELECT COUNT(patient_type) AS newpatient
       FROM appointment
      WHERE appointment_timestamp BETWEEN ? AND ?
        AND patient_type = 'New'
        AND is_deleted != 1
        AND executivechk = 2`,
    [from, to],
  );
  return Number(row?.newpatient) || 0;
}

// IPD invoice COUNT over the SAME filter getLocationSummary uses for
// ipdInvoice.total (all statuses incl. Charity, is_deleted != 1). This is the
// "total number of surgeries in the period" (No. of SX) and also the divisor
// for Avg IPD = ipdInvoice.total / count, so the two stay consistent
// (matches the spreadsheet: SX = IPD Revenue / Avg IPD).
async function getIpdInvoiceCount(location, from, to) {
  const { connection } = getConnectionByLocation(location);
  if (!connection) throw new Error(`Invalid location: ${location}`);
  const run = makeRunner(connection);
  const [row] = await run(
    `SELECT COUNT(*) AS cnt
       FROM invoice
      WHERE creation_date >= ? AND creation_date <= ?
        AND is_deleted != 1`,
    [`${from} 00:00:00`, `${to} 23:59:59`],
  );
  return Number(row?.cnt) || 0;
}

// ─── RAW COMPONENTS PER LOCATION (one period) ────────────────────────────────
async function getLocationRaw(location, from, to) {
  const summary = await getLocationSummary(location, from, to);

  const [newPatients, ipdInvoiceCount] = await Promise.all([
    getNewPatientCount(location, from, to),
    getIpdInvoiceCount(location, from, to),
  ]);

  return {
    newPatients,
    ipdInvoiceTotal: Number(summary?.ipdInvoice?.total) || 0,
    ipdInvoiceCount, // = No. of SX (total surgeries in period)
    pharmacyTotal: Number(summary?.pharmacy?.total) || 0,
    opdTotal: Number(summary?.opd?.total) || 0,
    labTotal: 0, // req 6
  };
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

// Convert raw components → the 9 parameter actuals the UI expects.
function rawToActuals(raw) {
  const newPatients = raw.newPatients;
  const sx = raw.ipdInvoiceCount; // total surgeries in the period (all patients)
  const conversion = newPatients ? (sx / newPatients) * 100 : 0; // total SX / new patients
  const avgIpd = raw.ipdInvoiceCount
    ? raw.ipdInvoiceTotal / raw.ipdInvoiceCount
    : 0;
  const ipdRevenue = raw.ipdInvoiceTotal;
  const pharmacy = raw.pharmacyTotal;
  const lab = raw.labTotal || 0;
  const opd = raw.opdTotal;
  const total = opd + ipdRevenue + pharmacy + lab; // req 1
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

// ─── EXPORTED SERVICE FUNCTIONS ──────────────────────────────────────────────

/**
 * getComparisonBranchList(opts)
 * opts = { locations[], from, to, fromLastYear?, toLastYear? }
 *
 * Lightweight per-branch Total Revenue list for the overview screen.
 * Only revenue is needed, so this skips patient/SX queries
 * (uses getLocationSummary.grandTotal).
 *
 * → { meta, branches: [{ id, name, thisYear, lastYear, yoy, ach, target }] }
 */
const getComparisonBranchList = async (opts) => {
  const r = resolveRanges(opts);
  const fy = financialYearOf(r.fromTY);
  const targetMap = await getTargetMap(fy);
  const requested = opts.locations?.length ? opts.locations : DEFAULT_LOCATIONS;
  const { configured: targets, skipped } = splitByConfigured(
    targetMap,
    requested,
  );

  const branches = await Promise.all(
    targets.map(async (loc) => {
      try {
        const [tyS, lyS] = await Promise.all([
          getLocationSummary(loc, r.fromTY, r.toTY),
          getLocationSummary(loc, r.fromLY, r.toLY),
        ]);
        const thisYear = Math.round(Number(tyS?.grandTotal) || 0);
        const lastYear = Math.round(Number(lyS?.grandTotal) || 0);
        const pct = resolvePct(targetMap, loc, "total");
        const { target, yoy, ach } = deriveMetrics(lastYear, thisYear, pct);
        return { id: loc, name: loc, thisYear, lastYear, yoy, ach, target };
      } catch (e) {
        console.error(`branch list failed for ${loc}:`, e.message);
        // Always return numeric fields so the RN list never crashes on
        // undefined (.toFixed / fmtCompact); surface the failure via `error`.
        return {
          id: loc,
          name: loc,
          thisYear: 0,
          lastYear: 0,
          yoy: 0,
          ach: 0,
          target: 0,
          error: e.message,
        };
      }
    }),
  );

  return { meta: buildMeta(r, { fy, skipped }), branches };
};

/**
 * getComparisonDetail(opts)
 * opts = { branch, locations[]?, from, to, fromLastYear?, toLastYear? }
 *
 * Full parameter-level comparison for one branch, or consolidated across
 * `locations` when branch === "all" (targets read from branch_name 'ALL').
 *
 * → { meta, params: [{ key, label, short, type, targetPct, lastYear, thisYear, target, yoy, ach }] }
 */
const getComparisonDetail = async (opts) => {
  const r = resolveRanges(opts);
  const branchId = opts.branch || "all";
  const fy = financialYearOf(r.fromTY);
  const targetMap = await getTargetMap(fy);
  const branchKey = branchId === "all" ? "ALL" : branchId;

  let branchName;
  let tyRaw;
  let lyRaw;
  const warnings = [];

  if (branchId === "all") {
    const requested = opts.locations?.length
      ? opts.locations
      : DEFAULT_LOCATIONS;
    const { configured: targets, skipped } = splitByConfigured(
      targetMap,
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
            getLocationRaw(loc, r.fromTY, r.toTY),
            getLocationRaw(loc, r.fromLY, r.toLY),
          ]);
          tyList.push(t);
          lyList.push(l);
        } catch (e) {
          console.error(`detail(all) failed for ${loc}:`, e.message);
          warnings.push({ location: loc, error: e.message });
        }
      }),
    );
    tyRaw = sumRaw(tyList);
    lyRaw = sumRaw(lyList);
    branchName = "All Branches";
  } else {
    branchName = branchId;
    if (!targetMap[branchId]) {
      const err = new Error(
        `No target configured for "${branchId}" in FY ${fy}`,
      );
      err.status = 404;
      throw err;
    }
    try {
      [tyRaw, lyRaw] = await Promise.all([
        getLocationRaw(branchId, r.fromTY, r.toTY),
        getLocationRaw(branchId, r.fromLY, r.toLY),
      ]);
    } catch (e) {
      const err = new Error(
        `Target comparison failed for ${branchId}: ${e.message}`,
      );
      err.status = 404;
      throw err;
    }
  }

  const tyA = rawToActuals(tyRaw);
  const lyA = rawToActuals(lyRaw);

  const params = PARAMS_META.map((p) => {
    const pct = resolvePct(targetMap, branchKey, p.key);
    const lastYear = roundByType(p.type, lyA[p.key]);
    const thisYear = roundByType(p.type, tyA[p.key]);
    const { target, yoy, ach } = deriveMetrics(lastYear, thisYear, pct);
    return {
      key: p.key,
      label: p.label,
      short: p.short,
      type: p.type,
      targetPct: pct,
      lastYear,
      thisYear,
      target,
      yoy,
      ach,
    };
  });

  return {
    meta: buildMeta(r, { branchId, branchName, fy, warnings }),
    params,
  };
};

module.exports = {
  getComparisonBranchList,
  getComparisonDetail,
};
