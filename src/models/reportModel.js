const { getConnectionByLocation } = require("../../databaseUtils");

// ── Insurance company master cutover ────────────────────────────────────────
// Until 30 Jun 2026 every branch DB kept its own `insurance_company` table, so
// invoice.insurancecompany held a BRANCH-LOCAL id.
// From 01 Jul 2026 the master `insuranceMasterData` table in hhc_appointments
// (the "lead" pool) is the single source of truth, and new invoices point at
// ids in THAT table.
//
// The two id spaces are unrelated, so the lookup is routed per invoice by its
// creation date — a report spanning the cutover needs both maps at once.
const INSURANCE_MASTER_CUTOVER = "2026-07-01"; // inclusive, IST

// Same structure in both tables — including the legacy `comapny_id` spelling.
// >>> VERIFY: if insuranceMasterData fixed the typo to `company_id`, split
// these into two constants and pass the right one per table.
const INSURANCE_ID_COL = "comapny_id";
const INSURANCE_NAME_COL = "companyname";

// An id missing from the expected table falls back to the other one. Around the
// cutover a branch may still write a legacy id for a day or two, and the right
// name beats a blank cell. Set false for strict date-only routing.
const INSURANCE_LOOKUP_FALLBACK = true;

const queryPool = (pool, sql, params = []) =>
  new Promise((resolve, reject) =>
    pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))),
  );

// id → name for one table. Never throws: a missing table or an unreachable
// master DB degrades to blank insurer names rather than killing the report.
const loadInsuranceMap = async (pool, table) => {
  const map = new Map();
  if (!pool) return map;
  try {
    const rows = await queryPool(
      pool,
      `SELECT ${INSURANCE_ID_COL} AS id, ${INSURANCE_NAME_COL} AS name FROM ${table}`,
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
 * Replaces the raw id sitting in each row's `insurance_company` key with the
 * company NAME, resolved against the branch table or the master table
 * depending on the invoice date.
 *
 * The value is overwritten IN PLACE so the key keeps its position — the app
 * builds its preview columns and Excel headers from Object.keys(rows[0]).
 *
 * @param rows       result rows carrying `insurance_company` (raw id)
 * @param branchPool the branch connection the rows came from
 * @param dateKey    row key holding the invoice date as 'YYYY-MM-DD'
 */
const resolveInsuranceNames = async (
  rows,
  branchPool,
  dateKey = "creation_date",
) => {
  if (!rows || !rows.length) return rows;

  const hasId = (r) =>
    r.insurance_company !== null &&
    r.insurance_company !== undefined &&
    r.insurance_company !== "" &&
    Number(r.insurance_company) !== 0;

  if (!rows.some(hasId)) return rows; // nothing to resolve — skip both queries

  const isLegacy = (r) =>
    String(r[dateKey] || "").slice(0, 10) < INSURANCE_MASTER_CUTOVER;

  const needLegacy =
    INSURANCE_LOOKUP_FALLBACK || rows.some((r) => hasId(r) && isLegacy(r));
  const needMaster =
    INSURANCE_LOOKUP_FALLBACK || rows.some((r) => hasId(r) && !isLegacy(r));

  const masterPool = needMaster
    ? getConnectionByLocation("lead")?.connection
    : null;

  const [legacyMap, masterMap] = await Promise.all([
    needLegacy ? loadInsuranceMap(branchPool, "insurance_company") : new Map(),
    needMaster
      ? loadInsuranceMap(masterPool, "insuranceMasterData")
      : new Map(),
  ]);

  rows.forEach((row) => {
    if (!hasId(row)) {
      row.insurance_company = null;
      return;
    }
    const key = String(row.insurance_company);
    const legacy = isLegacy(row);
    const primary = legacy ? legacyMap : masterMap;
    const secondary = legacy ? masterMap : legacyMap;

    row.insurance_company =
      primary.get(key) ??
      (INSURANCE_LOOKUP_FALLBACK ? (secondary.get(key) ?? null) : null);
  });

  return rows;
};

function getFinancialYearRange() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // Jan = 1

  let fromDate, toDate;

  if (month >= 4) {
    // Apr–Dec → current year to next year
    fromDate = `${year}-04-01`;
    toDate = `${year + 1}-03-31`;
  } else {
    // Jan–Mar → previous year to current year
    fromDate = `${year - 1}-04-01`;
    toDate = `${year}-03-31`;
  }

  return { fromDate, toDate };
}

const getReport = async (req) => {
  const { reportType, sheetType } = req.body;
  const { location, from, to } = req.query;
  console.log({ location, from, to, reportType, sheetType });

  const { connection } = getConnectionByLocation(req.query.location); // Ensure `req.params.location` is correct

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  // Promise wrapper around the pooled connection.query
  const runQuery = (sql, params = [from, to]) =>
    new Promise((resolve, reject) => {
      connection.query(sql, params, (error, rows) =>
        error ? reject(error) : resolve(rows),
      );
    });

  // ── IPD Sheet2 ──────────────────────────────────────────────
  // Patient collections (ipd_payment) and insurance settlements
  // (insurance_invoice) are distinct events recorded in different tables,
  // each with its OWN date column. They must be fetched as two independent
  // queries — joining them on invoice_id and filtering by a single date is
  // incorrect (it mis-dates settlements, drops out-of-range ones, and can
  // duplicate rows). So we return two separate result sets.
  if (reportType === "IPD" && sheetType === "Sheet2") {
    // 1) Patient payments — filtered by ipd_payment.receipt_date
    const patientPaymentsSql = `
      SELECT
          ip.invoice_id,
          DATE_FORMAT(CONVERT_TZ(ip.receipt_date,  '+00:00', '+05:30'), '%Y-%m-%d') AS receipt_date,
          DATE_FORMAT(CONVERT_TZ(i.creation_date,  '+00:00', '+05:30'), '%Y-%m-%d') AS invoice_date,
          p.name AS patient_name,
          NULLIF(TRIM(i.patient_location), '') AS patient_location,
          i.status,
          ip.cashamt,
          ip.cardamt,
          ip.chequeamt,
          ip.onlineamt,
          ip.discountamt,
          ip.tdsamt AS internal_discount
      FROM ipd_payment ip
      INNER JOIN invoice i  ON i.invoice_id = ip.invoice_id
      LEFT  JOIN patient p  ON p.patient_id = ip.patient_id
      WHERE ip.receipt_date BETWEEN ? AND ?
      ORDER BY ip.receipt_date ASC, ip.invoice_id ASC;
    `;

    // 2) Insurance settlements — filtered by insurance_invoice.paymentdate
    const insuranceSettlementsSql = `
      SELECT
          iv.invoice_id,
          DATE_FORMAT(iv.paymentdate, '%Y-%m-%d') AS payment_date,
          DATE_FORMAT(CONVERT_TZ(iv.creationdate, '+00:00', '+05:30'), '%Y-%m-%d') AS invoice_date,
          p.name AS patient_name,
          NULLIF(TRIM(i.patient_location), '') AS patient_location,
          iv.receivedamt AS settled_amt,
          COALESCE(iv.tdsamt, 0) AS TDS,
          iv.utrno
      FROM insurance_invoice iv
      LEFT JOIN invoice i  ON i.invoice_id = iv.invoice_id
      LEFT JOIN patient p  ON p.patient_id = iv.patientid
      WHERE iv.paymentdate BETWEEN ? AND ?
      ORDER BY iv.paymentdate ASC, iv.invoice_id ASC;
    `;

    const [patientPayments, insuranceSettlements] = await Promise.all([
      runQuery(patientPaymentsSql),
      runQuery(insuranceSettlementsSql),
    ]);

    await resolveInsuranceNames(
      insuranceSettlements,
      connection,
      "invoice_date",
    );

    return { patientPayments, insuranceSettlements };
  }

  try {
    let sql = "";
    const queryParams = [from, to];

    if (reportType === "IPD" && sheetType === "Sheet1") {
      sql = `
      SELECT 
        i.invoice_id,
        i.patient_id,
        p.name,
        NULLIF(TRIM(i.patient_location), '') AS patient_location,
        DATE_FORMAT(CONVERT_TZ(i.creation_date, '+00:00', '+05:30'), '%Y-%m-%d') AS creation_date,
        i.discount,
        i.status,
        i.insurancecompany AS insurance_company,
        i.payable_amt,
        i.totalamt,
        i.totaldue,
        COALESCE(pay.cash_collected,      0) AS cash_collected,
        COALESCE(pay.card_collected,      0) AS card_collected,
        COALESCE(pay.cheque_collected,    0) AS cheque_collected,
        COALESCE(pay.online_collected,    0) AS online_collected,
        COALESCE(pay.pdc_cheque_collected,0) AS pdc_cheque_collected,
        COALESCE(pay.total_collected,     0) AS total_collected
      FROM invoice i
      LEFT JOIN patient p ON p.patient_id = i.patient_id
      LEFT JOIN (
        -- One row per invoice: an invoice can have many ipd_payment entries,
        -- so collections are summed per mode BEFORE the join. Joining
        -- ipd_payment directly would duplicate the invoice row per payment.
        -- The inner join to invoice keeps this aggregate scoped to the same
        -- date window as the outer query instead of the whole payments table.
        SELECT
          ip.invoice_id,
          COALESCE(SUM(ip.cashamt),    0) AS cash_collected,
          COALESCE(SUM(ip.cardamt),    0) AS card_collected,
          COALESCE(SUM(ip.chequeamt),  0) AS cheque_collected,
          COALESCE(SUM(ip.onlineamt),  0) AS online_collected,
          COALESCE(SUM(ip.pdcCheque),  0) AS pdc_cheque_collected,
          COALESCE(SUM(
            COALESCE(ip.cashamt,0)   + COALESCE(ip.cardamt,0) +
            COALESCE(ip.chequeamt,0) + COALESCE(ip.onlineamt,0) +
            COALESCE(ip.pdcCheque,0)
          ), 0) AS total_collected
        FROM ipd_payment ip
        INNER JOIN invoice i2 ON i2.invoice_id = ip.invoice_id
        WHERE i2.creation_date BETWEEN ? AND ?
        GROUP BY ip.invoice_id
      ) pay ON pay.invoice_id = i.invoice_id
      WHERE i.creation_date BETWEEN ? AND ?
    `;
      queryParams.push(from, to);
    } else if (reportType === "OPD" && sheetType === "Sheet1") {
      sql = `
      SELECT 
        pr.receipt_id,
        pr.patient_id,
        p.name,
        pr.receipt_date,
        pr.consultation,
        pr.chargeCondition,
        pr.comment,
        pr.totalamt,
        pr.discountamt,
        pr.paymentmode
      FROM patient_receipt pr
      LEFT JOIN patient p ON p.patient_id = pr.patient_id
      WHERE pr.is_deleted = '0'
        AND pr.receipt_date BETWEEN ? AND ?
    `;
    } else if (reportType === "OPD" && sheetType === "Sheet2") {
      sql = `
      SELECT 
        ip.receipt_id,
        ip.item_date,
        p.name AS patient_name,
        ip.consultation,
        ip.total,
        ip.payment_mode
      FROM patient_itemreceipt ip
      INNER JOIN patient_receipt i ON i.receipt_id = ip.receipt_id
      LEFT JOIN patient p ON p.patient_id = ip.patient_id
      WHERE i.is_deleted = '0'
        AND i.receipt_date BETWEEN ? AND ?
    `;
    } else {
      const err = new Error("Invalid reportType or sheetType");
      err.status = 400;
      throw err;
    }

    // SUM() comes back as DECIMAL → string from the driver. Excel needs real
    // numbers or the collection columns land as text and won't total.
    const NUMERIC_KEYS = [
      "cash_collected",
      "card_collected",
      "cheque_collected",
      "online_collected",
      "pdc_cheque_collected",
      "total_collected",
    ];

    const rows = await new Promise((resolve, reject) => {
      connection.query(sql, queryParams, (error, result) =>
        error ? reject(error) : resolve(result),
      );
    });

    if (reportType === "IPD" && sheetType === "Sheet1") {
      rows.forEach((row) => {
        NUMERIC_KEYS.forEach((k) => {
          if (row[k] !== null && row[k] !== undefined) row[k] = Number(row[k]);
        });
      });
      return await resolveInsuranceNames(rows, connection, "creation_date");
    }

    return rows;
  } catch (error) {
    throw error;
  }
};

const getIPDBillsV2 = async (req) => {
  const { connection } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const { status = "" } = req.query;
  const hasStatusFilter = status && status.trim() !== "";

  // ✅ Financial year dates
  const { fromDate, toDate } = getFinancialYearRange();

  try {
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        let sql = `
  SELECT 
      i.invoice_id,
      i.patient_id,
      i.creation_date AS admission_date,
      i.due_date AS discharge_date,
      p.name,
      p.phone,
      p.sex,
      i.discount,
      i.status,
      i.payable_amt,
      i.totalamt,
      i.totaldue,
      i.ratingInfo,
      COALESCE(SUM(
          COALESCE(ip.cashamt, 0) + 
          COALESCE(ip.cardamt, 0) + 
          COALESCE(ip.chequeamt, 0) + 
          COALESCE(ip.onlineamt, 0)
      ), 0) AS collection
  FROM invoice i
  JOIN patient p ON i.patient_id = p.patient_id
  LEFT JOIN ipd_payment ip ON i.invoice_id = ip.invoice_id
  WHERE i.creation_date BETWEEN ? AND ?
    AND i.is_deleted != 1
    AND i.ratingInfo IS NOT NULL
    AND JSON_LENGTH(i.ratingInfo) > 0
`;

        const queryParams = [fromDate, toDate];

        if (hasStatusFilter) {
          sql += ` AND i.status = ?`;
          queryParams.push(status);
        }

        sql += `
          GROUP BY 
            i.invoice_id, i.patient_id, p.name, p.phone, p.sex,
            i.discount, i.status, i.payable_amt, i.totalamt, i.totaldue
        `;

        tempCon.query(sql, queryParams, (error, result) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(result);
        });
      });
    });

    return {
      financialYear: `${fromDate} to ${toDate}`,
      ipdBills: rows,
    };
  } catch (error) {
    console.error("Error in getIPDBillsV2:", error);
    throw error;
  }
};

const getConditionwiseReport = async (req) => {
  const { connection } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  // ✅ Financial year dates
  const { from, to } = req.query;

  console.log("Generating condition-wise report for:", {
    location: req.query.location,
    from,
    to,
  });

  try {
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        let sql = `
              SELECT 
                speciality,
                COUNT(DISTINCT patient_id) AS patient_count
            FROM 
                diagnosis
            WHERE 
                date_diagnosis BETWEEN ? AND ?
                AND symptoms != ''
            GROUP BY 
                speciality
            ORDER BY 
                patient_count DESC
          `;

        const queryParams = [from, to];

        tempCon.query(sql, queryParams, (error, result) => {
          tempCon.release();
          if (error) return reject(error);
          console.log("Condition-wise report generated:", result);
          resolve(result);
        });
      });
    });

    const missingDiagReport = await getMissingDiagReport(req);

    return {
      conditionwiseReport: rows,
      missingDiagReport,
    };
  } catch (error) {
    console.error("Error in getConditionwiseReport:", error);
    throw error;
  }
};

const getMissingDiagReport = async (req) => {
  const { connection } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  // ✅ Financial year dates
  const { from, to } = req.query;

  // console.log("Generating Missing Diagnosis report for:", {
  //   location: req.query.location,
  //   from,
  //   to,
  // });

  try {
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        let sql = `
            SELECT 
               DISTINCT pa.patient_id,
                pa.Uid_no,
                pa.name,
                pa.sex,
                pa.age,
                pa.phone,
                pa.mobile_2,
                pa.ref,
                pa.occupation,
                pa.address,
                ap.appointment_timestamp AS visit_date
            FROM appointment ap

            INNER JOIN patient pa 
                ON pa.patient_id = ap.patient_id

           WHERE ap.appointment_timestamp >= ?
        AND ap.appointment_timestamp <= ?
        AND ap.is_deleted != 1
        AND ap.patient_type = 'New'
        AND ap.confirm_time != '0'
        AND ap.executivechk = 2
                AND pa.ConfirmPatient = 1

                AND NOT EXISTS (
                    SELECT 1 
                    FROM diagnosis da 
                    WHERE da.patient_id = ap.patient_id
                )

            ORDER BY 
                ap.appointment_timestamp DESC;
          `;

        const queryParams = [from, to];

        tempCon.query(sql, queryParams, (error, result) => {
          tempCon.release();
          if (error) return reject(error);
          console.log("Missing Diagnosis report generated:", result);
          resolve(result);
        });
      });
    });

    //console.log("Missing Diagnosis report rows:", rows);

    return rows;
  } catch (error) {
    console.error("Error in getConditionwiseReport:", error);
    throw error;
  }
};

module.exports = {
  getReport,
  getConditionwiseReport,
  getIPDBillsV2,
  resolveInsuranceNames,
};
