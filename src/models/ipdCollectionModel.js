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
          SELECT ip.patient_id, p.name, ip.receipt_date, ip.cashamt, ip.cardamt, ip.chequeamt, ip.onlineamt, ip.discountamt
          FROM ipd_payment ip
          JOIN patient p ON ip.patient_id = p.patient_id
          WHERE ip.receipt_date >= ?  
          AND ip.receipt_date <= ?
          ORDER BY ip.receipt_date DESC
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

module.exports = { getIPDCollection, getTotalIPDCollection };
