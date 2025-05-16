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

async function getReference(req) {
  const { connection, location } = getConnectionByLocation(req.query.location);
  console.log(
    new Date(req.query.from).getTime(),
    new Date(req.query.to).getTime()
  );

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

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

  const getCounts = async () => {
    try {
      const referenceTypeCountQuery = `
      SELECT reference_type, COUNT(*) AS count
      FROM patient
      WHERE date >= ?  
      AND date <= ?
      AND ConfirmPatient = 1
      AND is_deleted = 0
      GROUP BY reference_type;
    `;

      const referenceTypeCount = await executeQuery(referenceTypeCountQuery, [
        req.query.from,
        req.query.to,
      ]);

      // Mapping of reference types to readable names
      const referenceTypeMap = {
        dr_ref: "Referred By Doctor",
        family_friends: "Family Friends",
        hhc_board: "HHC Board",
        HHF: "HHF",
        internet: "Internet",
        MediaRef: "Media Referral",
        newspaper: "Newspaper",
        old_ref: "Old Patient Referral",
        other: "Other",
        WOM: "Word of Mouth",
        self_old_pt: "Old Patient",
        hhc_branch: "HHC Branch",
        null: "Unknown",
      };

      // Calculate total count
      let totalCount = referenceTypeCount.reduce(
        (sum, item) => sum + item.count,
        0
      );

      // Transform data with readable names and percentage calculation
      const transformedData = referenceTypeCount.map((item) => {
        const percentage = Math.round((item.count / totalCount) * 100); // Round to nearest whole number
        return {
          reference_type:
            referenceTypeMap[item.reference_type] || item.reference_type,
          count: item.count,
          percentage: percentage,
        };
      });

      console.log(transformedData);

      return { referenceTypeCount: transformedData, totalCount };
    } catch (error) {
      console.error("Error executing queries:", error);
      throw error;
    }
  };

  return getCounts();
}

module.exports = { getPatient, getDiagnosis, getReference };
