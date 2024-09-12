const { getConnectionByLocation } = require("../../databaseUtils");

const getIVRCall = async (req) => {
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
          SELECT ivr_id, call_date, call_duration, call_status, call_time, caller_no, circle_name, destination_name, destination_no, note
          FROM IVRdata
          WHERE STR_TO_DATE(call_date, '%Y-%d-%m') >= ?
          ORDER BY ivr_id DESC
        `;

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
    console.log(rows);
    return rows;
  } catch (error) {
    throw error;
  }
};

module.exports = { getIVRCall };
