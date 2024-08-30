const { getConnectionByLocation } = require("../../databaseUtils");

const getDeposit = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    // Function to execute a query
    const executeQuery = (query, values = []) => {
      return new Promise((resolve, reject) => {
        connection.query(query, values, (error, results) => {
          if (error) {
            return reject(error);
          }
          resolve(results);
        });
      });
    };

    // Fetch the current date
    const currentDate = new Date().toISOString().split("T")[0];

    // Fetch the latest cash deposit record
    const LatestCashDepositQuery = `
      SELECT date
      FROM cash_collection
      ORDER BY collection_id DESC
      LIMIT 1;
    `;

    // Execute query to get the latest deposit date
    const LastRecord = await executeQuery(LatestCashDepositQuery);
    const latestCashDepositDate =
      new Date(LastRecord[0]?.date).toISOString().split("T")[0] || "1970-01-01"; // Default to an early date if no record
    console.log(latestCashDepositDate, currentDate);

    // Queries for OPD and IPD cash totals
    const OPDCashTotalQuery = `
      SELECT SUM(total) AS Total, item_date
      FROM patient_itemreceipt
      WHERE item_date > ?
        AND item_date <= ?
        AND payment_mode = 'Cash'
        AND is_deleted != 1
        GROUP BY item_date
  ORDER BY item_date ASC
    `;
    const IPDCashTotalQuery = `
      SELECT receipt_date AS item_date, SUM(cashamt) AS Total
      FROM ipd_payment
      WHERE receipt_date > ?
        AND receipt_date <= ?
        GROUP BY receipt_date
  ORDER BY receipt_date ASC
    `;

    // Execute queries for cash totals
    const [OPDCashTotal, IPDCashTotal] = await Promise.all([
      executeQuery(OPDCashTotalQuery, [latestCashDepositDate, currentDate]),
      executeQuery(IPDCashTotalQuery, [latestCashDepositDate, currentDate]),
    ]);
    console.log(OPDCashTotal);
    console.log(IPDCashTotal);

    // Merge OPD and IPD data by date
    const mergedData = {};

    OPDCashTotal.forEach((record) => {
      mergedData[record.item_date] = {
        date: record.item_date,
        OPDCash: record.Total || 0,
        IPDCash: 0,
      };
    });

    IPDCashTotal.forEach((record) => {
      let item_date = new Date(record.item_date).toLocaleDateString("en-CA");
      if (mergedData[item_date]) {
        mergedData[item_date].IPDCash = record.Total || 0;
      } else {
        mergedData[item_date] = {
          date: item_date,
          OPDCash: 0,
          IPDCash: record.Total || 0,
        };
      }
    });

    // Convert merged data object to an array
    const result = Object.values(mergedData);

    // Return results
    return result;
  } catch (error) {
    console.error("Error executing queries:", error);
    throw error;
  } finally {
    if (connection && connection.release) {
      connection.release();
    }
  }
};

const cashDeposit = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) {
          return reject(err);
        }

        const sql = `
          SELECT 
            di.date_diagnosis,
            di.diagnosis,
            di.diagnosisAdvice,
            di.advice,
            consultantDoctor.name AS consultantDoctor,
            assistantDoctor.name AS assistantDoctor
          FROM diagnosis di
          JOIN doctor consultantDoctor ON di.consultantDoctor = consultantDoctor.doctor_id
          JOIN doctor assistantDoctor ON di.assistanceDoctor = assistantDoctor.doctor_id
          WHERE di.patient_id = ?
          ORDER BY di.diag_id ASC
        `;

        const queryParams = [req.query.patientId]; // Parameters for the SQL query

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
    console.error("Error fetching diagnosis data:", error);
    throw error;
  }
};

module.exports = { getDeposit, cashDeposit };
