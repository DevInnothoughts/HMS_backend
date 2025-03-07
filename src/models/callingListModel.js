const { getConnectionByLocation } = require("../../databaseUtils");

async function getCallingList(req) {
  const { connection, location } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error(`Invalid location: ${req.query.location}`);
    err.status = 404;
    throw err;
  }

  const executeQuery = (query, values = []) => {
    return new Promise((resolve, reject) => {
      connection.query(query, values, (error, results) => {
        if (error) return reject(error);
        resolve(results);
      });
    });
  };

  try {
    // Get and validate the date from req.query
    const referenceDate = req.query.date;
    if (!referenceDate || isNaN(new Date(referenceDate).getTime())) {
      throw new Error(`Invalid date provided: ${referenceDate}`);
    }

    const enquiryCallsQuery = `
      SELECT DISTINCT
        e.enquiry_id AS id,
        e.enquirytype,
        e.patient_name AS name,
        e.patient_phone AS phone,
        e.date,
        e.note AS diagnosis,
        e.calling_notes,
        DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), e.date) AS days_since
      FROM 
        appointment_enquiry e
      LEFT JOIN 
        appointment a
      ON 
        e.patient_phone = a.patient_phone
      WHERE 
        e.enquirytype != 'Visited'
        AND (a.patient_phone IS NULL OR a.confirm_time = 0)
        AND DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), e.date) IN (3, 7, 15, 30)
      ORDER BY 
        e.date DESC;
    `;

    const opdSurgeryCallsQuery = `
      SELECT DISTINCT
        d.diag_id AS id,
        d.patient_id,
        p.name,
        p.phone,
        d.date_diagnosis AS date,
        d.diagnosis,
        d.diagnosisAdvice,
        d.calling_notes,
        DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), d.date_diagnosis) AS days_since
      FROM 
        diagnosis d
      LEFT JOIN 
        patient p
      ON 
        d.patient_id = p.patient_id
      WHERE 
        DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), d.date_diagnosis) IN (3, 7, 15, 30)
        AND d.diagnosisAdvice LIKE '%Surgery%'
      ORDER BY 
        d.date_diagnosis DESC;
    `;

    const opdMedicationCallsQuery = `
      SELECT DISTINCT
        d.diag_id AS id,
        d.patient_id,
        p.name,
        p.phone,
        d.date_diagnosis AS date,
        d.diagnosis,
        d.diagnosisAdvice,
        d.calling_notes,
        DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), d.date_diagnosis) AS days_since
      FROM 
        diagnosis d
      LEFT JOIN 
        patient p
      ON 
        d.patient_id = p.patient_id
      WHERE 
        DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), d.date_diagnosis) IN (3, 7, 15, 30)
        AND d.diagnosisAdvice LIKE '%Medication%'
      ORDER BY 
        d.date_diagnosis DESC;
    `;

    const opdTestCallsQuery = `
      SELECT DISTINCT
        d.diag_id AS id,
        d.patient_id,
        p.name,
        p.phone,
        d.date_diagnosis AS date,
        d.diagnosis,
        d.diagnosisAdvice,
        d.calling_notes,
        DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), d.date_diagnosis) AS days_since
      FROM 
        diagnosis d
      LEFT JOIN 
        patient p
      ON 
        d.patient_id = p.patient_id
      WHERE 
        DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), d.date_diagnosis) IN (3, 7, 15, 30)
        AND d.diagnosisAdvice LIKE '%Test%'
      ORDER BY 
        d.date_diagnosis DESC;
    `;

    const postOpCallsQuery = `
      SELECT DISTINCT
        d.discharge_id AS id,
        d.patient_id,
        p.name,
        p.phone,
        d.DOD AS date,
        d.diagnosis,
        d.surgical_procedure,
        d.calling_notes,
        DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), d.DOD) AS days_since
      FROM 
        discharge_card d
      LEFT JOIN 
        patient p
      ON 
        d.patient_id = p.patient_id
      WHERE 
        DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), d.DOD) IN (3, 7, 15, 30)
      ORDER BY 
        d.DOD DESC;
    `;

    const [
      enquiryCallsData,
      opdSurgeryCallsData,
      opdMedicationCallsData,
      opdTestCallsData,
      postOpCallsData,
    ] = await Promise.all([
      executeQuery(enquiryCallsQuery, [referenceDate, referenceDate]),
      executeQuery(opdSurgeryCallsQuery, [referenceDate, referenceDate]),
      executeQuery(opdMedicationCallsQuery, [referenceDate, referenceDate]),
      executeQuery(opdTestCallsQuery, [referenceDate, referenceDate]),
      executeQuery(postOpCallsQuery, [referenceDate, referenceDate]),
    ]);

    console.log("Calling List:", {
      SurgeryOPD: opdSurgeryCallsData,
      MedicationOPD: opdMedicationCallsData,
      TestOPD: opdTestCallsData,
      Enquiry: enquiryCallsData,
      PostOp: postOpCallsData,
    });

    return {
      SurgeryOPD: opdSurgeryCallsData,
      MedicationOPD: opdMedicationCallsData,
      TestOPD: opdTestCallsData,
      Enquiry: enquiryCallsData,
      PostOp: postOpCallsData,
    };
  } catch (error) {
    console.error("Error executing queries:", error.message, error.stack);
    throw error;
  }
}

module.exports = { getCallingList };
