const { getConnectionByLocation } = require("../../databaseUtils");

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
        DATE_FORMAT(CONVERT_TZ(i.creation_date, '+00:00', '+05:30'), '%Y-%m-%d') AS creation_date,
        i.discount,
        i.status,
        ic.companyname AS insurance_company,
        i.payable_amt,
        i.totalamt,
        i.totaldue
      FROM invoice i
      LEFT JOIN patient p ON p.patient_id = i.patient_id
      LEFT JOIN insurance_company ic ON ic.comapny_id = i.insurancecompany
      WHERE i.creation_date BETWEEN ? AND ?
    `;
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

    return new Promise((resolve, reject) => {
      connection.query(sql, queryParams, (error, rows) => {
        if (error) return reject(error);
        resolve(rows);
      });
    });
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
};
