// src/models/utils/insuranceNames.js
// ─────────────────────────────────────────────────────────────────────────────
// Resolves company ids to names against the insurance master.
//
// ⚠️ THIS IS A COPY, NOT A REFACTOR
// ─────────────────────────────────
// reportModel.js keeps its own resolveInsuranceNames and is NOT touched — the
// DSR and IPD reports run on it today and must not move. The logic below is the
// same, generalised to resolve several id columns in one pass.
//
// The duplication is deliberate and temporary. When there is time to regression
// test the reports, reportModel should import from here and delete its copy.
// Until then: a change to the cutover rule must be made in BOTH files.
//
// THE CUTOVER
// ───────────
// Until 30 Jun 2026 each branch DB kept its own `insurance_company` table, so
// invoice.insurancecompany and invoice.tpa held BRANCH-LOCAL ids. From
// 01 Jul 2026 the master `insuranceMasterData` in hhc_appointments is the single
// source of truth. The id spaces are unrelated, so each row is routed by its own
// date — a range spanning the cutover needs both maps at once.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../../databaseUtils");

const INSURANCE_MASTER_CUTOVER = "2026-07-01"; // inclusive, IST

// Including the legacy `comapny_id` spelling — it is the same in both tables.
const ID_COL = "comapny_id";
const NAME_COL = "companyname";

// An id missing from the expected table falls back to the other. Around the
// cutover a branch may still write a legacy id for a day or two, and the right
// name beats a blank. Set false for strict date-only routing.
const LOOKUP_FALLBACK = true;

const queryPool = (pool, sql, params = []) =>
  new Promise((resolve, reject) =>
    pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))),
  );

// id → name for one table. Never throws: a missing table or an unreachable
// master DB degrades to blank names rather than killing the caller.
const loadMap = async (pool, table) => {
  const map = new Map();
  if (!pool) return map;
  try {
    const rows = await queryPool(
      pool,
      `SELECT ${ID_COL} AS id, ${NAME_COL} AS name FROM ${table}`,
    );
    rows.forEach((r) => {
      if (r.id !== null && r.id !== undefined) map.set(String(r.id), r.name);
    });
  } catch (err) {
    console.error(`Insurance lookup failed for ${table}:`, err.message);
  }
  return map;
};

/**
 * Adds a resolved NAME for each id column, under `<key>_name`.
 *
 * ⚠️ Names are added as NEW keys — the raw ids are left untouched. reportModel's
 * version overwrites in place because its callers build Excel headers from the
 * row keys; here nothing may change shape, so nothing does.
 *
 * Insurer and TPA share one id space, so both resolve against ONE pair of maps
 * loaded once — resolving each separately would double the master-DB trips.
 *
 * @param rows        result rows
 * @param branchPool  the branch connection the rows came from
 * @param dateKey     row key holding the invoice date as 'YYYY-MM-DD'
 * @param idKeys      row keys holding raw ids
 */
async function addCompanyNames(rows, branchPool, dateKey, idKeys = []) {
  if (!rows || !rows.length || !idKeys.length) return rows;

  const hasId = (r, k) =>
    r[k] !== null && r[k] !== undefined && r[k] !== "" && Number(r[k]) !== 0;

  if (!rows.some((r) => idKeys.some((k) => hasId(r, k)))) {
    rows.forEach((r) => idKeys.forEach((k) => (r[`${k}_name`] = null)));
    return rows;
  }

  const isLegacy = (r) =>
    String(r[dateKey] || "").slice(0, 10) < INSURANCE_MASTER_CUTOVER;

  const needLegacy =
    LOOKUP_FALLBACK ||
    rows.some((r) => isLegacy(r) && idKeys.some((k) => hasId(r, k)));
  const needMaster =
    LOOKUP_FALLBACK ||
    rows.some((r) => !isLegacy(r) && idKeys.some((k) => hasId(r, k)));

  const masterPool = needMaster
    ? getConnectionByLocation("lead")?.connection
    : null;

  const [legacyMap, masterMap] = await Promise.all([
    needLegacy ? loadMap(branchPool, "insurance_company") : new Map(),
    needMaster ? loadMap(masterPool, "insuranceMasterData") : new Map(),
  ]);

  rows.forEach((row) => {
    const legacy = isLegacy(row);
    const primary = legacy ? legacyMap : masterMap;
    const secondary = legacy ? masterMap : legacyMap;

    idKeys.forEach((k) => {
      if (!hasId(row, k)) {
        row[`${k}_name`] = null;
        return;
      }
      const key = String(row[k]);
      row[`${k}_name`] =
        primary.get(key) ??
        (LOOKUP_FALLBACK ? (secondary.get(key) ?? null) : null);
    });
  });

  return rows;
}

module.exports = { addCompanyNames, INSURANCE_MASTER_CUTOVER };
