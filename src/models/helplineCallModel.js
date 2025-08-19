const { getConnectionByLocation } = require("../../databaseUtils");

const excludedNumbers = [
  "+917411951943",
  "+918123922650",
  "+917411804875",
  "+918147647685",
  "+917411951965",
  "+917411805024",
  "+917411951962",
  "+918971928968",
  "+918123919853",
  "+918123919853",
  "+918147647677",
  "+917411951963",
  "+918792498991",
  "+919164045999",
  "+918855865060",
  "+918888188885",
]; //IVR Numbers

const getHelplineCall = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location); // Ensure `req.params.location` is correct

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    // Using a promise-based approach to handle the connection
    const fromDate = req.query.from;
    const toDate = req.query.to || req.query.from;
    const status = req.query.status || null; // MISSED, INCOMING, OUTGOING or NULL
    const startOfDay = new Date(`${fromDate}T00:00:00+05:30`).getTime();
    const endOfDay = new Date(`${toDate}T23:59:59+05:30`).getTime();
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) {
          return reject(err);
        }

        let sql = `
          SELECT *
          FROM phonecalllogs
          WHERE timestamp BETWEEN ? AND ?
            AND phoneNumber NOT IN (${
              excludedNumbers.map(() => "?").join(",") || "''"
            })
        `;

        const params = [startOfDay, endOfDay, ...excludedNumbers];

        if (status && status !== null) {
          status === "MISSED"
            ? (sql += ` AND (type = ? OR type = 'UNKNOWN')`)
            : (sql += ` AND type = ?`);
          params.push(status);
        }

        sql += ` ORDER BY timestamp DESC`;

        tempCon.query(sql, params, (error, rows) => {
          tempCon.release();
          if (error) {
            return reject(error);
          }
          resolve(rows);
        });
      });
    });
    // console.log(rows);
    return rows;
  } catch (error) {
    throw error;
  }
};

const getHelplineCallV2 = async (req) => {
  const { connection } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    const fromDate = req.query.from;
    const toDate = req.query.to;
    const startOfDay = new Date(`${fromDate}T00:00:00+05:30`).getTime();
    const endOfDay = new Date(`${toDate}T23:59:59+05:30`).getTime();

    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        const sql = `
          SELECT *
          FROM phonecalllogs
          WHERE timestamp BETWEEN ? AND ?
           AND phoneNumber NOT IN (${excludedNumbers.map(() => "?").join(",")})
          ORDER BY timestamp DESC
        `;

        tempCon.query(
          sql,
          [startOfDay, endOfDay, ...excludedNumbers],
          (error, results) => {
            tempCon.release();
            if (error) return reject(error);
            resolve(results);
          }
        );
      });
    });

    // ✅ Group and merge data by phone_number
    const grouped = {};
    for (const row of rows) {
      const number = row.phoneNumber;
      if (!grouped[number]) {
        grouped[number] = {
          phoneNumber: number,
          call_count: 0,
          total_duration: 0,
          records: [], // store individual calls if needed
        };
      }

      grouped[number].call_count += 1;
      grouped[number].total_duration += row.duration || 0; // assuming `duration` field
      grouped[number].records.push(row); // optional: to keep original call logs
    }

    // Convert object to array
    const result = Object.values(grouped);
    console.log(result);
    return result;
  } catch (error) {
    throw error;
  }
};

module.exports = { getHelplineCall, getHelplineCallV2 };
