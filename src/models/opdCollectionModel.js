const { getConnectionByLocation } = require("../../databaseUtils");

const getOPDCollection = async (req) => {
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
          SELECT ip.patient_id, p.name, ip.item_date, ip.consultation, ip.payment_mode, ip.total
          FROM patient_itemreceipt ip
          JOIN patient p ON ip.patient_id = p.patient_id
          WHERE ip.is_deleted != 1
          AND ip.item_date >= ?  
          AND ip.item_date <= ?
          ORDER BY ip.item_date DESC
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

const getTotalOPDCollection = async (req) => {
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
            ip.item_date,
            SUM(CASE WHEN ip.payment_mode = 'Cash' THEN ip.total ELSE 0 END) AS total_cash,
            SUM(CASE WHEN ip.payment_mode = 'Card' THEN ip.total ELSE 0 END) AS total_card,
            SUM(CASE WHEN ip.payment_mode = 'Online' THEN ip.total ELSE 0 END) AS total_online,
            SUM(CASE WHEN ip.payment_mode = 'Cheque' THEN ip.total ELSE 0 END) AS total_cheque
          FROM patient_itemreceipt ip
          JOIN patient p ON ip.patient_id = p.patient_id
          WHERE ip.is_deleted != 1
          AND ip.item_date >= ?  
          AND ip.item_date <= ?
          GROUP BY ip.item_date
          ORDER BY ip.item_date ASC
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

module.exports = { getOPDCollection, getTotalOPDCollection };
