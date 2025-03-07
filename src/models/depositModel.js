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

    // Fetch the current date and the date for 7 days ago
    const currentDate = new Date().toISOString().split("T")[0];
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const pastDate = sevenDaysAgo.toISOString().split("T")[0];

    // Query to fetch last 7 days deposit data from cash_collection table
    const depositQuery = `
      SELECT collection_id, date, opd_totalcash, ipd_totalcash, totalcash, deposited_cash, receipt_no, cash_differnce
      FROM cash_collection
      WHERE date >= ? AND date <= ?
      ORDER BY date ASC
    `;
    const depositData = await executeQuery(depositQuery, [
      pastDate,
      currentDate,
    ]);
    console.log("Deposit data:", depositData);
    // Get all dates from the deposit data to exclude them from the OPD/IPD cash queries
    const depositDates = depositData.map((record) => record.date);

    // Create a placeholder for the NOT IN clause if there are dates to exclude
    const depositDatesPlaceholder =
      depositDates.length > 0 ? depositDates : ["9999-12-31"]; // A dummy date to prevent SQL error when the array is empty

    // Queries for OPD and IPD cash totals excluding dates already present in the deposit data
    const OPDCashTotalQuery = `
      SELECT SUM(total) AS Total, item_date
      FROM patient_itemreceipt
      WHERE item_date >= ? AND item_date <= ? AND payment_mode = 'Cash' AND is_deleted != 1
      ${depositDates.length > 0 ? `AND item_date NOT IN (?)` : ""}
      GROUP BY item_date
      ORDER BY item_date ASC
    `;
    const IPDCashTotalQuery = `
      SELECT receipt_date AS item_date, SUM(cashamt) AS Total
      FROM ipd_payment
      WHERE receipt_date >= ? AND receipt_date <= ?
      ${depositDates.length > 0 ? `AND receipt_date NOT IN (?)` : ""}
      GROUP BY receipt_date
      ORDER BY receipt_date ASC
    `;

    // Execute queries for cash totals excluding dates in the deposit data
    const [OPDCashTotal, IPDCashTotal] = await Promise.all([
      executeQuery(OPDCashTotalQuery, [
        pastDate,
        currentDate,
        depositDatesPlaceholder,
      ]),
      executeQuery(IPDCashTotalQuery, [
        pastDate,
        currentDate,
        depositDatesPlaceholder,
      ]),
    ]);
    console.log("OPD IPD data:", OPDCashTotal, IPDCashTotal);
    // Merge deposit data with OPD and IPD cash data
    const mergedData = {};

    // Add deposit data to mergedData
    depositData.forEach((record) => {
      mergedData[
        new Date(record.date).toLocaleDateString("en-CA", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
      ] = {
        date: new Date(record.date).toLocaleDateString("en-CA", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }),
        OPDCash: record.opd_totalcash || 0,
        IPDCash: record.ipd_totalcash || 0,
        cashDeposited: record.deposited_cash || 0,
        receiptNo: record.receipt_no || "",
        cashDifference: record.cash_differnce || 0,
        isDeposited: true,
      };
    });

    // Add OPD data to mergedData (skipping already processed dates)
    OPDCashTotal.forEach((record) => {
      if (!mergedData[record.item_date]) {
        mergedData[record.item_date] = {
          date: record.item_date,
          OPDCash: record.Total || 0,
          IPDCash: 0,
          cashDeposited: 0,
          receiptNo: "",
          cashDifference: 0,
          isDeposited: false,
        };
      }
    });

    // Add IPD data to mergedData (skipping already processed dates)
    IPDCashTotal.forEach((record) => {
      let item_date = new Date(record.item_date).toLocaleDateString("en-CA");
      if (mergedData[item_date]) {
        mergedData[item_date].IPDCash = record.Total || 0;
      } else {
        mergedData[item_date] = {
          date: item_date,
          OPDCash: 0,
          IPDCash: record.Total || 0,
          cashDeposited: 0,
          receiptNo: "",
          cashDifference: 0,
          isDeposited: false,
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

        const sql = `INSERT INTO cash_collection (date, opd_totalcash, ipd_totalcash, totalcash, deposited_cash, receipt_no, cash_differnce) VALUES (?, ?, ?, ?, ?, ?, ?)`;
        console.log(req.body);
        // Destructure parameters directly from req.query
        const {
          date,
          IPDCash,
          OPDCash,
          total,
          cashDeposited,
          receiptId,
          amountDiff,
        } = req.body; // Access query parameters

        const queryParams = [
          date,
          OPDCash,
          IPDCash,
          total,
          cashDeposited,
          receiptId,
          amountDiff,
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
    console.error("Error fetching deposit data:", error);
    throw error;
  }
};

module.exports = { getDeposit, cashDeposit };
