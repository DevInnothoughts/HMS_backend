// src/models/utils/interbranch.js
// ─────────────────────────────────────────────────────────────────────────────
// One definition of the interbranch invoice rule, shared by every model that
// totals IPD invoices, so the IPD Invoice page and Target Comparison can never
// disagree.
//
// When a patient's OPD is at branch A (source) but the surgery happens at
// branch B (operating), the SAME invoice is written into both branch DBs:
//
//   operating branch B:  interbranch_id = 0            patient_location = 'A'
//   source branch A:     interbranch_id = <B's inv id> patient_location = 'B'
//
// The revenue belongs to the SOURCE branch. The operating branch's copy is
// listed but excluded from every total.
//
// Exception: DP Road is only ever an OPERATING branch, so an invoice whose
// patient_location is 'DP Road' is always the source branch's copy — counted,
// whatever its interbranch_id says.
// ─────────────────────────────────────────────────────────────────────────────

// Lowercase, trimmed names.
const ALWAYS_OPERATING_BRANCHES = ["dp road"];

const isAlwaysOperatingSql = (a = "i") =>
  `LOWER(TRIM(${a}.patient_location)) IN (${ALWAYS_OPERATING_BRANCHES.map(
    (b) => `'${b}'`,
  ).join(", ")})`;

/** 'operating' | 'source' | NULL (normal invoice) */
const interbranchRoleSql = (a = "i") => `
  CASE
    WHEN NULLIF(TRIM(${a}.patient_location), '') IS NULL THEN NULL
    WHEN ${isAlwaysOperatingSql(a)} THEN 'source'
    WHEN COALESCE(${a}.interbranch_id, 0) = 0 THEN 'operating'
    ELSE 'source'
  END`;

/** Boolean SQL: TRUE when the invoice counts toward THIS branch's figures. */
const countedSql = (a = "i") => `
  NOT (
    NULLIF(TRIM(${a}.patient_location), '') IS NOT NULL
    AND COALESCE(${a}.interbranch_id, 0) = 0
    AND NOT (${isAlwaysOperatingSql(a)})
  )`;

module.exports = {
  ALWAYS_OPERATING_BRANCHES,
  interbranchRoleSql,
  countedSql,
};
