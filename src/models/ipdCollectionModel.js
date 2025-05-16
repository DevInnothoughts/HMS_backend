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
          AND i.creation_date >= '2024-04-01'
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

module.exports = {
  getIPDCollection,
  getTotalIPDCollection,
  getIPDBills,
  getIPDDueList,
};
