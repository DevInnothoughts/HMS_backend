const { getConnectionByLocation } = require("../../databaseUtils");

async function getDashboardValues(req) {
  const { connection, location } = getConnectionByLocation(req.query.location);

  // Get the current date in YYYY-MM-DD format
  const currentDate = new Date().toISOString().split("T")[0];

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
      // Counts for patient types
      const newPatientCountQuery = `
        SELECT COUNT(patient_type) AS newpatient
        FROM appointment ap
        WHERE ap.appointment_timestamp >= ?  
  AND ap.appointment_timestamp <= ?
          AND patient_type = 'New'
          AND is_deleted != 1
          AND executivechk = 2
      `;
      const followPatientCountQuery = `
        SELECT COUNT(patient_type) AS followpatient
        FROM appointment ap
        WHERE ap.appointment_timestamp >= ?  
  AND ap.appointment_timestamp <= ?
          AND patient_type = 'Follow'
          AND is_deleted != 1
          AND executivechk = 2
      `;
      const poPatientCountQuery = `
        SELECT COUNT(patient_type) AS popatient
        FROM appointment ap
        WHERE ap.appointment_timestamp >= ?  
  AND ap.appointment_timestamp <= ?
          AND patient_type = 'Postoperative'
          AND is_deleted != 1
          AND executivechk = 2
      `;

      // Proctoscopy count
      const proctoscopyCountQuery = `
        SELECT COUNT(consultation) AS proctoscopy
        FROM patient_itemreceipt
        WHERE item_date >= ?
        AND item_date <= ?
          AND consultation = 'PROCTOSCOPY'
          AND is_deleted != 1
      `;

      const appointmentCountQuery = `
  SELECT 
    COUNT(*) AS appointment_count
  FROM appointment ap
  WHERE ap.appointment_timestamp >= ?  
  AND ap.appointment_timestamp <= ?
  AND ap.is_deleted != 1
`;
      const ipdCountQuery = `
  SELECT 
    COUNT(*) AS ipd_count
  FROM invoice i
  WHERE i.creation_date >= ?  
  AND i.creation_date <= ?
  AND i.is_deleted != 1
`;

      const MissedCallCountQuery = `
    SELECT 
      COUNT(*) AS missed_count
    FROM IVRdata i
   WHERE STR_TO_DATE(i.call_date, "%Y-%d-%m") >= ?
  AND STR_TO_DATE(i.call_date, "%Y-%d-%m") <= ?
  AND call_status = 'Missed'
  `;
      const AnsweredCallCountQuery = `
    SELECT 
      COUNT(*) AS answered_count
    FROM IVRdata i
   WHERE STR_TO_DATE(i.call_date, "%Y-%d-%m") >= ?
  AND STR_TO_DATE(i.call_date, "%Y-%d-%m") <= ?
  AND call_status = 'Answered'
  `;

      const [
        newPatientCount,
        followPatientCount,
        poPatientCount,
        proctoscopyCount,
        appointment_count,
        ipd_count,
        missed_count,
        answered_count,
      ] = await Promise.all([
        executeQuery(newPatientCountQuery, [req.query.from, req.query.to]),
        executeQuery(followPatientCountQuery, [req.query.from, req.query.to]),
        executeQuery(poPatientCountQuery, [req.query.from, req.query.to]),
        executeQuery(proctoscopyCountQuery, [req.query.from, req.query.to]),
        executeQuery(appointmentCountQuery, [req.query.from, req.query.to]),
        executeQuery(ipdCountQuery, [req.query.from, req.query.to]),
        executeQuery(MissedCallCountQuery, [req.query.from, req.query.to]),
        executeQuery(AnsweredCallCountQuery, [req.query.from, req.query.to]),
      ]);

      return {
        dailyOPDReport: {
          new: newPatientCount[0].newpatient,
          FU: followPatientCount[0].followpatient,
          PO: poPatientCount[0].popatient,
          procto: proctoscopyCount[0].proctoscopy,
        },
        appointment_count: appointment_count[0].appointment_count,
        ipd_count: ipd_count[0].ipd_count,
        missed_count: missed_count[0].missed_count,
        answered_count: answered_count[0].answered_count,
      };
    } catch (error) {
      console.error("Error executing queries:", error);
      throw error;
    }
  };

  return getCounts();
}

module.exports = { getDashboardValues };
