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

  try {
    let sql = "";
    const queryParams = [from, to];

    if (reportType === "IPD" && sheetType === "Sheet1") {
      sql = `
      SELECT 
        i.invoice_id,
        i.patient_id,
        p.name,
        i.creation_date,
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
    } else if (reportType === "IPD" && sheetType === "Sheet2") {
      sql = `
      SELECT 
        ip.invoice_id,
        ip.receipt_date,
        p.name AS patient_name,
        ip.cashamt,
        ip.cardamt,
        ip.chequeamt,
        ip.onlineamt,
        ip.discountamt,
        ip.tdsamt AS internal_discount
      FROM ipd_payment ip
      INNER JOIN invoice i ON i.invoice_id = ip.invoice_id
      LEFT JOIN patient p ON p.patient_id = ip.patient_id
      WHERE i.creation_date BETWEEN ? AND ?
      ORDER BY ip.invoice_id ASC
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

module.exports = {
  getReport,
  getIPDBillsV2,
};
