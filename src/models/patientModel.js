const { getConnectionByLocation } = require("../../databaseUtils");

const getPatient = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    // Ensure a promise-based approach to handle the connection
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) {
          return reject(err);
        }

        let sql;
        const queryParams = [];

        if (req.query.name) {
          sql = `
            SELECT *
            FROM patient
            WHERE name LIKE ?
            ORDER BY patient_id DESC
          `;
          queryParams.push(`%${req.query.name}%`);
        } else if (req.query.mobile) {
          sql = `
            SELECT *
            FROM patient
            WHERE phone LIKE ?
            OR mobile_2 LIKE ?
            ORDER BY patient_id DESC
          `;
          queryParams.push(req.query.mobile, req.query.mobile);
        } else {
          // No valid query parameter
          tempCon.release();
          return reject(new Error("No valid query parameters provided"));
        }

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
    console.error("Error fetching patient data:", error);
    throw error;
  }
};

const getDiagnosis = async (req) => {
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

module.exports = { getPatient, getDiagnosis };
