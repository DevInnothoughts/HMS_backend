const { getConnectionByLocation } = require("../../databaseUtils");

const getIPDCollection = async (req) => {
  console.log(req.params.location);
  console.log(req.params.from);
  console.log(req.params.to);
  const { connection, location } = getConnectionByLocation(req.query.location); // Ensure `req.params.location` is correct

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    // Using a promise-based approach to handle the connection
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) {
          return reject(err);
        }

        const sql = `
         SELECT 
            ip.patient_id, 
            p.name, 
            ip.receipt_date, 
            ip.cashamt, 
            ip.cardamt, 
            ip.chequeamt, 
            ip.onlineamt, 
            ip.discountamt,
            i.totalamt,
            i.totaldue,
            i.status
          FROM ipd_payment ip
          JOIN patient p ON ip.patient_id = p.patient_id
          JOIN invoice i ON ip.invoice_id = i.invoice_id
          WHERE ip.receipt_date >= ?  
            AND ip.receipt_date <= ?
            AND i.creation_date >= ?  
          AND i.creation_date <= ?
          ORDER BY ip.receipt_date DESC;
        `;

        const queryParams = [
          req.query.from,
          req.query.to,
          req.query.from,
          req.query.to,
        ]; // Parameters for the SQL query

        tempCon.query(sql, queryParams, (error, rows) => {
          tempCon.release();
          if (error) {
            return reject(error);
          }
          resolve(rows);
        });
      });
    });
    console.log(rows);
    return rows;
  } catch (error) {
    throw error;
  }
};

const getIPDCollectionV2 = async (req) => {
  const { connection } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const [from, to] = [req.query.from, req.query.to];

  try {
    const ipdPaymentData = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        const ipdQuery = `
          SELECT 
            ip.patient_id,
            ip.invoice_id,
            ip.receipt_date,
            ip.cashamt,
            ip.cardamt,
            ip.chequeamt,
            ip.onlineamt,
            ip.discountamt,
            p.name
          FROM ipd_payment ip
          JOIN patient p ON ip.patient_id = p.patient_id
          WHERE ip.receipt_date BETWEEN ? AND ?
          ORDER BY ip.receipt_date DESC;
        `;

        tempCon.query(ipdQuery, [from, to], (error, results) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(results);
        });
      });
    });

    const invoiceData = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        const invoiceQuery = `
          SELECT 
            invoice_id,
            totalamt,
            totaldue,
            status
          FROM invoice
          WHERE creation_date BETWEEN ? AND ?;
        `;

        tempCon.query(invoiceQuery, [from, to], (error, results) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(results);
        });
      });
    });

    return {
      ipdPayments: ipdPaymentData,
      invoices: invoiceData,
    };
  } catch (error) {
    throw error;
  }
};

const getIPDBills = async (req) => {
  console.log(req.query.location);
  console.log(req.query.from);
  console.log(req.query.to);
  const { connection, location } = getConnectionByLocation(req.query.location); // Ensure `req.params.location` is correct

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    // Using a promise-based approach to handle the connection
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) {
          return reject(err);
        }

        const sql = `
          SELECT i.invoice_id, i.patient_id, p.name,p.phone,p.sex, i.discount, i.status, i.payable_amt, i.totalamt
          FROM invoice i
          JOIN patient p ON i.patient_id = p.patient_id
          WHERE i.creation_date >= ?  
          AND i.creation_date <= ?
          AND i.is_deleted != 1
        `;

        const queryParams = [req.query.from, req.query.to]; // Parameters for the SQL query

        tempCon.query(sql, queryParams, (error, rows) => {
          tempCon.release();
          if (error) {
            return reject(error);
          }
          resolve(rows);
        });
      });
    });
    console.log(rows);
    return rows;
  } catch (error) {
    throw error;
  }
};

const getTotalIPDCollection = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location); // Ensure `req.params.location` is correct

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    // Using a promise-based approach to handle the connection
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) {
          return reject(err);
        }

        const sql = `
          SELECT 
            ip.receipt_date,
            SUM(ip.cashamt) AS total_cashamt,
            SUM(ip.cardamt) AS total_cardamt,
            SUM(ip.onlineamt) AS total_onlineamt,
            SUM(ip.discountamt) AS total_discountamt
          FROM ipd_payment ip
          WHERE ip.receipt_date >= ?  
          AND ip.receipt_date <= ?
          GROUP BY ip.receipt_date
          ORDER BY ip.receipt_date ASC
        `;

        const queryParams = [req.query.from, req.query.to]; // Parameters for the SQL query

        tempCon.query(sql, queryParams, (error, rows) => {
          tempCon.release();
          if (error) {
            return reject(error);
          }
          resolve(rows);
        });
      });
    });
    console.log(rows);
    return rows;
  } catch (error) {
    throw error;
  }
};

const getIPDDueList = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        const sql = `
          SELECT 
              p.patient_id,
              p.name,
              i.invoice_id,
              i.status,
              i.creation_date,
              i.totalamt,
              i.totaldue,
              CASE 
                WHEN DATEDIFF(CURDATE(), i.creation_date) > 90 THEN '>90 days'
                WHEN DATEDIFF(CURDATE(), i.creation_date) > 60 THEN '>60 days'
                WHEN DATEDIFF(CURDATE(), i.creation_date) > 30 THEN '>30 days'
                ELSE '<30 days'
              END AS due_category
          FROM patient p
          JOIN invoice i ON p.patient_id = i.patient_id
          WHERE i.totaldue > 0
          AND i.creation_date >= '2025-04-01'
          ORDER BY due_category, i.creation_date
        `;

        tempCon.query(sql, (error, rows) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(rows);
        });
      });
    });

    // Initialize category buckets with totals
    const groupedPatients = {
      ">90 days": { patients: [], totalDue: 0 },
      ">60 days": { patients: [], totalDue: 0 },
      ">30 days": { patients: [], totalDue: 0 },
      "<30 days": { patients: [], totalDue: 0 },
    };

    // Populate buckets and sum totaldue
    rows.forEach((patient) => {
      const category = patient.due_category;
      if (groupedPatients[category]) {
        groupedPatients[category].patients.push(patient);

        // Ensure totaldue is treated as a number
        const totalDueValue = Number(patient.totaldue) || 0;
        groupedPatients[category].totalDue += totalDueValue;
      }
    });

    console.log(groupedPatients);
    return groupedPatients;
  } catch (error) {
    throw error;
  }
};

const getIPDBillsV2 = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const { from, to, status = "" } = req.query;

  const hasStatusFilter = status && status.trim() !== "";

  try {
    // Main query
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        let sql = `
          SELECT i.invoice_id, i.patient_id, p.name, p.phone, p.sex,
                 i.discount, i.status, i.payable_amt, i.totalamt
          FROM invoice i
          JOIN patient p ON i.patient_id = p.patient_id
          WHERE i.creation_date >= ?  
            AND i.creation_date <= ?
            AND i.is_deleted != 1
        `;

        const queryParams = [from, to];

        if (hasStatusFilter) {
          sql += ` AND i.status = ?`;
          queryParams.push(status);
        }

        tempCon.query(sql, queryParams, (error, result) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(result);
        });
      });
    });

    // Totals query
    const typeTotals = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        let summarySql = `
          SELECT i.status, SUM(i.totalamt) AS total_amount
          FROM invoice i
          WHERE i.creation_date >= ?
            AND i.creation_date <= ?
            AND i.is_deleted != 1
            GROUP BY i.status
        `;

        const summaryParams = [from, to];

        tempCon.query(summarySql, summaryParams, (error, result) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(result);
        });
      });
    });

    return {
      ipdBills: rows,
      statusWiseTotals: typeTotals,
    };
  } catch (error) {
    console.error("Error in getIPDBillsV2:", error);
    throw error;
  }
};

const getStatuswiseIPDDueList = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const statusFilter = req.query.status; // e.g., 'Charity', 'Cashless', etc.

  try {
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        // Base SQL
        let sql = `
          SELECT 
              p.patient_id,
              p.name,
              i.invoice_id,
              i.status,
              i.creation_date,
              i.totalamt,
              i.totaldue,
              CASE 
                WHEN DATEDIFF(CURDATE(), i.creation_date) > 90 THEN '>90 days'
                WHEN DATEDIFF(CURDATE(), i.creation_date) > 60 THEN '>60 days'
                WHEN DATEDIFF(CURDATE(), i.creation_date) > 30 THEN '>30 days'
                ELSE '<30 days'
              END AS due_category
          FROM patient p
          JOIN invoice i ON p.patient_id = i.patient_id
          WHERE i.totaldue > 0
            AND i.creation_date >= '2025-04-01'
        `;

        const queryParams = [];

        if (statusFilter) {
          sql += ` AND i.status = ?`;
          queryParams.push(statusFilter);
        }

        sql += ` ORDER BY due_category, i.creation_date`;

        tempCon.query(sql, queryParams, (error, rows) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(rows);
        });
      });
    });

    // Grouping logic
    const groupedPatients = {
      ">90 days": { patients: [], totalDue: 0 },
      ">60 days": { patients: [], totalDue: 0 },
      ">30 days": { patients: [], totalDue: 0 },
      "<30 days": { patients: [], totalDue: 0 },
    };

    rows.forEach((patient) => {
      const category = patient.due_category;
      if (groupedPatients[category]) {
        groupedPatients[category].patients.push(patient);
        groupedPatients[category].totalDue += Number(patient.totaldue) || 0;
      }
    });

    console.log(groupedPatients);
    return groupedPatients;
  } catch (error) {
    throw error;
  }
};

const getIPDTotalSummary = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);
  const status = req.query.status; // Can be undefined

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    const result = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        // Construct SQL with dynamic conditions
        let sql;
        let values = [];

        if (status) {
          sql = `
            SELECT 
              (SELECT SUM(totalamt) 
               FROM invoice 
               WHERE creation_date >= '2025-04-01' 
                 AND is_deleted != 1 
                 AND status = ?) AS total_invoice_amount,

              (SELECT SUM(p.cashamt + p.cardamt + p.chequeamt + p.onlineamt + p.discountamt)
               FROM ipd_payment p
               JOIN invoice i ON p.invoice_id = i.invoice_id
               WHERE p.receipt_date >= '2025-04-01'
                 AND i.status = ?) AS total_collection_amount,

              (SELECT SUM(totaldue) 
               FROM invoice 
               WHERE totaldue > 0 
                 AND creation_date >= '2025-04-01'
                 AND status = ?) AS total_due_amount;
          `;
          values = [status, status, status];
        } else {
          sql = `
            SELECT 
              (SELECT SUM(totalamt) 
               FROM invoice 
               WHERE creation_date >= '2025-04-01' 
                 AND is_deleted != 1) AS total_invoice_amount,

              (SELECT SUM(p.cashamt + p.cardamt + p.chequeamt + p.onlineamt + p.discountamt)
               FROM ipd_payment p
               JOIN invoice i ON p.invoice_id = i.invoice_id
               WHERE p.receipt_date >= '2025-04-01') AS total_collection_amount,

              (SELECT SUM(totaldue) 
               FROM invoice 
               WHERE totaldue > 0 
                 AND creation_date >= '2025-04-01') AS total_due_amount;
          `;
        }

        tempCon.query(sql, values, (error, rows) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(rows[0]);
        });
      });
    });

    console.log(result);
    return result;
  } catch (error) {
    throw error;
  }
};

module.exports = {
  getIPDCollection,
  getIPDCollectionV2,
  getTotalIPDCollection,
  getIPDBills,
  getIPDDueList,
  getIPDBillsV2,
  getStatuswiseIPDDueList,
  getIPDTotalSummary,
};
