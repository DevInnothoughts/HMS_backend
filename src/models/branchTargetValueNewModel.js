// branchTargetValueModel.js
// ─────────────────────────────────────────────────────────────────────────────
// Absolute YEARLY targets, both sets, from the master DB.
//   target_set 'B' = Base target
//   target_set 'O' = Optimistic target
//
// Table `branch_target_value` (one row per branch / fy / set), mirroring
// Branch_Target.csv. Values are yearly absolutes; the comparison model prorates
// them (month = /12, quarter = /4, year = x1). avg_ipd is a per-case rate and
// must never be prorated.
//
// getTargetValueMaps(fy)
//   → { B: { [branch]: {...} }, O: { [branch]: {...} } }
//   Each row: { newPatientsTarget, sxTarget, avgIpdTarget, ipdRevenueTarget,
//               pharmacyTarget, labTarget, opdTarget, totalTarget }
//   Returns { B:{}, O:{} } on any failure so callers degrade gracefully.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../databaseUtils");

const MASTER_DB_KEY = "lead";

const makeRunner =
  (connection) =>
  (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) =>
        err ? reject(err) : resolve(rows),
      ),
    );

// DECIMAL columns arrive as strings; NULL must stay null (0 is a real target).
const numOrNull = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};

function shapeRow(r) {
  return {
    newPatientsTarget: numOrNull(r.new_patients_target),
    sxTarget: numOrNull(r.sx_target),
    avgIpdTarget: numOrNull(r.avg_ipd_target),
    ipdRevenueTarget: numOrNull(r.ipd_revenue_target),
    pharmacyTarget: numOrNull(r.pharmacy_target),
    labTarget: numOrNull(r.lab_target),
    opdTarget: numOrNull(r.opd_target),
    totalTarget: numOrNull(r.total_target),
  };
}

async function getTargetValueMaps(fy) {
  const out = { B: {}, O: {} };
  try {
    const { connection } = getConnectionByLocation(MASTER_DB_KEY);
    if (!connection) throw new Error(`No connection for "${MASTER_DB_KEY}" DB`);
    const run = makeRunner(connection);

    const rows = await run(
      `SELECT branch_name, target_set,
              new_patients_target, sx_target, avg_ipd_target,
              ipd_revenue_target, pharmacy_target, lab_target,
              opd_target, total_target
         FROM branch_target_value
        WHERE fy = ? AND target_set IN ('B','O')`,
      [fy],
    );

    for (const r of rows) {
      const set = r.target_set === "O" ? "O" : "B";
      out[set][r.branch_name] = shapeRow(r);
    }
    return out;
  } catch (e) {
    console.error(`branch_target_value lookup failed for FY ${fy}:`, {
      code: e?.code,
      message: e?.sqlMessage || e?.message,
    });
    return out; // { B:{}, O:{} }
  }
}

module.exports = { getTargetValueMaps };
