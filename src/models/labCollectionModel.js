/**
 * labCollectionModel.js
 * ---------------------------------------------------------------------------
 * OPD / LAB collection split for the date-range collection reports.
 *
 * The LAB definition here is the SAME one getDailyOPDCollectionV2 uses, so the
 * daily approval report and this range report always agree:
 *
 *   LAB  = patient_itemreceipt rows whose `consultation` matches a row in
 *          consultationMasterData with consultation_type = 'LAB'
 *   OPD  = every other non-deleted patient_itemreceipt row
 *
 * Matching is on the normalized name — REPLACE(LOWER(COALESCE(x,'')),' ','') —
 * exactly as in dailyOPDModel, because the master table and the receipt table
 * disagree on spacing and case. COALESCE matters: without it, rows with a NULL
 * consultation make `NOT IN (...)` evaluate to NULL and silently vanish from
 * the OPD side.
 *
 * Because both sections are cut from one rule, opdTotal + labTotal always
 * reconciles to what the old un-split report returned.
 *
 * DP Road exception: lab there is billed into `patient_receipt`
 * (chargeCondition = 'LabTest'), not patient_itemreceipt — the same special
 * case the old getOPDCollectionV3 carried. Those rows are folded into the LAB
 * section and their receipt_ids excluded from OPD. Verify this against a day
 * you can reconcile by hand before trusting the DP Road numbers.
 *
 * Usage (Express):
 *   GET /OPDCollection/v4?location=Baner&from=2026-04-01&to=2026-04-30&section=LAB
 *   GET /OPDCollection/v4?location=Baner&from=2026-04-01&to=2026-04-30&section=OPD
 *
 * Response shape is identical to getOPDCollectionV3 so the report screen can be
 * reused as-is, with one addition — `consultationList`, the groups actually
 * present, so the screen can build its filter chips dynamically instead of
 * hardcoding a statusList.
 * ---------------------------------------------------------------------------
 */

const { getConnectionByLocation } = require("../../databaseUtils");

const MASTER_DB_KEY = "lead";

/* ── helpers ──────────────────────────────────────────────────────────────── */

const run = (connection, sql, params = []) =>
  new Promise((resolve, reject) =>
    connection.query(sql, params, (err, rows) =>
      err ? reject(err) : resolve(rows),
    ),
  );

// Mirrors SQL's REPLACE(LOWER(x), ' ', '')
const normalizeName = (v) =>
  String(v ?? "")
    .toLowerCase()
    .split(" ")
    .join("");

// UPI is reported as Online everywhere else in this codebase.
const normalizeMode = (mode) => {
  const m = String(mode ?? "").trim();
  if (/^upi$/i.test(m)) return "Online";
  if (/^online$/i.test(m)) return "Online";
  if (/^cash$/i.test(m)) return "Cash";
  if (/^card$/i.test(m)) return "Card";
  if (/^cheque$/i.test(m)) return "Cheque";
  return m || "Other";
};

const PAYMENT_MODES = ["Cash", "Card", "Online", "Cheque"];

/**
 * The LAB consultation names from the master DB, normalized and de-duplicated.
 * Returns [] when nothing is configured — callers then treat LAB as empty
 * rather than guessing, which keeps OPD identical to the old behaviour.
 */
async function getLabConsultationNames(masterConnection) {
  const rows = await run(
    masterConnection,
    `SELECT consultation_name
       FROM consultationMasterData
      WHERE is_deleted = '0'
        AND UPPER(TRIM(consultation_type)) = 'LAB'`,
  );

  const seen = new Set();
  const names = [];
  for (const row of rows) {
    const name = (row.consultation_name || "").trim();
    if (!name) continue;
    const key = normalizeName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(key);
  }
  return names;
}

/**
 * Group rows by consultation and by consultation × payment mode.
 * `groups` is the list of buckets to guarantee in the output; anything outside
 * it lands in OTHER, so the totals always add up to the row set.
 */
function computeAggregates(rows, groups) {
  const consultationTotals = {};
  const consultationPaymentModeTotals = {};

  for (const row of rows) {
    const raw = String(row.consultation ?? "")
      .trim()
      .toUpperCase();
    const key = groups.includes(raw) ? raw : "OTHER";
    const amount = Number(row.total) || 0;
    const mode = normalizeMode(row.payment_mode);

    consultationTotals[key] = (consultationTotals[key] || 0) + amount;
    if (!consultationPaymentModeTotals[key]) {
      consultationPaymentModeTotals[key] = {};
    }
    consultationPaymentModeTotals[key][mode] =
      (consultationPaymentModeTotals[key][mode] || 0) + amount;
  }

  for (const g of [...groups, "OTHER"]) {
    if (!consultationTotals[g]) consultationTotals[g] = 0;
    if (!consultationPaymentModeTotals[g]) {
      consultationPaymentModeTotals[g] = {};
    }
    for (const pm of PAYMENT_MODES) {
      if (!consultationPaymentModeTotals[g][pm]) {
        consultationPaymentModeTotals[g][pm] = 0;
      }
    }
  }

  return { consultationTotals, consultationPaymentModeTotals };
}

/* ── main ─────────────────────────────────────────────────────────────────── */

/**
 * getCollectionV4(req)
 *   req.query.location  branch key
 *   req.query.from      YYYY-MM-DD
 *   req.query.to        YYYY-MM-DD
 *   req.query.section   'OPD' (default) | 'LAB'
 */
async function getCollectionV4(req) {
  const { connection, location } = getConnectionByLocation(req.query.location);
  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const { connection: masterConnection } =
    getConnectionByLocation(MASTER_DB_KEY);
  if (!masterConnection) {
    const err = new Error("Master database connection (lead) not available");
    err.status = 500;
    throw err;
  }

  const from = req.query.from;
  const to = req.query.to;
  const section = String(req.query.section || "OPD").toUpperCase();
  if (section !== "OPD" && section !== "LAB") {
    const err = new Error("`section` must be OPD or LAB");
    err.status = 400;
    throw err;
  }

  const labNames = await getLabConsultationNames(masterConnection);
  const hasLab = labNames.length > 0;
  const placeholders = labNames.map(() => "?").join(", ");
  const NORM_COL = "REPLACE(LOWER(COALESCE(ip.consultation, '')), ' ', '')";

  // No LAB configured: LAB is empty, OPD is everything.
  const matchSql =
    section === "LAB"
      ? hasLab
        ? `${NORM_COL} IN (${placeholders})`
        : "1 = 0"
      : hasLab
        ? `${NORM_COL} NOT IN (${placeholders})`
        : "1 = 1";

  const itemSql = `
    SELECT ip.receipt_id, ip.patient_id, p.name, ip.item_date,
           ip.consultation, ip.payment_mode, ip.total
      FROM patient_itemreceipt ip
      JOIN patient p ON ip.patient_id = p.patient_id
     WHERE ip.is_deleted != 1
       AND ip.item_date >= ?
       AND ip.item_date <= ?
       AND ${matchSql}
     ORDER BY ip.item_date DESC
  `;
  const itemParams = hasLab ? [from, to, ...labNames] : [from, to];

  let rows = (await run(connection, itemSql, itemParams)).map((r) => ({
    ...r,
    payment_mode: normalizeMode(r.payment_mode),
  }));

  // ── DP Road: lab lives in patient_receipt, not patient_itemreceipt ──
  if (location === "DP Road") {
    const receiptSql = `
      SELECT pr.receipt_id, pr.patient_id, p.name,
             pr.receipt_date AS item_date,
             'LAB' AS consultation,
             pr.paymentmode AS payment_mode,
             pr.totalamt AS total
        FROM patient_receipt pr
        JOIN patient p ON pr.patient_id = p.patient_id
       WHERE pr.chargeCondition = 'LabTest'
         AND pr.is_deleted != 1
         AND pr.receipt_date >= ?
         AND pr.receipt_date <= ?
       ORDER BY pr.receipt_date DESC
    `;
    const receiptRows = (await run(connection, receiptSql, [from, to])).map(
      (r) => ({ ...r, payment_mode: normalizeMode(r.payment_mode) }),
    );

    if (section === "LAB") {
      rows = [...rows, ...receiptRows];
    } else {
      const labIds = new Set(receiptRows.map((r) => String(r.receipt_id)));
      rows = rows.filter((r) => !labIds.has(String(r.receipt_id)));
    }
  }

  // ── grouping ──
  // LAB: one bucket per lab test actually billed in the range.
  // OPD: the four fixed buckets the screen already knows, rest to OTHER.
  const groups =
    section === "LAB"
      ? Array.from(
          new Set(
            rows.map((r) =>
              String(r.consultation ?? "")
                .trim()
                .toUpperCase(),
            ),
          ),
        )
          .filter(Boolean)
          .sort()
      : ["CONSULTATION", "PROCTOSCOPY", "FOLLOW-UP", "BUGSPEAKS"];

  const { consultationTotals, consultationPaymentModeTotals } =
    computeAggregates(rows, groups);

  return {
    section,
    location,
    range: { from, to },
    data: rows,
    // The groups the screen should render as filter chips, in order.
    consultationList: [...groups, "OTHER"],
    consultationTotals,
    consultationPaymentModeTotals,
  };
}

module.exports = {
  getCollectionV4,
  getLabConsultationNames,
};
