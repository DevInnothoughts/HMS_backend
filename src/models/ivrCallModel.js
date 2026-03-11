const { getConnectionByLocation } = require("../../databaseUtils");

const getIVRCall = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location); // Ensure `req.params.location` is correct
  console.log(req.query.status);
  const status = req.query.status || null; // MISSED, INCOMING, OUTGOING or NULL
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

        let sql = `
          SELECT ivr_id, call_date, call_duration, call_status, call_time, caller_no, circle_name, destination_name, destination_no, note
          FROM IVRdata
          WHERE STR_TO_DATE(call_date, '%Y-%d-%m') >= ?
          AND destination_no != ''
        `;

        if (status && status !== null) {
          status === "MISSED"
            ? (sql += ` AND call_status = 'Missed'`)
            : (sql += ` AND call_status = 'Answered'`);
        }

        sql += ` ORDER BY ivr_id DESC`;

        const queryParams = [req.query.from]; // Parameters for the SQL query

        tempCon.query(sql, queryParams, (error, rows) => {
          tempCon.release();
          if (error) {
            return reject(error);
          }
          resolve(rows);
        });
      });
    });
    //console.log(rows);
    return rows;
  } catch (error) {
    throw error;
  }
};

module.exports = { getIVRCall };
