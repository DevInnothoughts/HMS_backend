const { getConnectionByLocation } = require("../../databaseUtils");

async function getConvincingScore(req) {
  const { connection, location } = getConnectionByLocation(req.query.location);
  console.log(req.query.from, req.query.to);

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
    const mainDoctorPerformanceQuery = `
        SELECT 
        diagnosis.consultantDoctor,
        diagnosis.diagnosisAdvice,
        (SELECT name FROM doctor WHERE doctor.doctor_id = diagnosis.consultantDoctor) AS DoctorName,
        diagnosis.patient_id,
        appointment.patient_type
      FROM 
        diagnosis
      LEFT JOIN 
        appointment 
      ON 
        diagnosis.patient_id = appointment.patient_id
      WHERE 
        diagnosis.date_diagnosis >= ? 
        AND diagnosis.date_diagnosis <= ? 
        `;

    const asstDoctorPerformanceQuery = `
        SELECT 
        diagnosis.assistanceDoctor,
        diagnosis.diagnosisAdvice,
        (SELECT name FROM doctor WHERE doctor.doctor_id = diagnosis.assistanceDoctor) AS DoctorName,
        diagnosis.patient_id,
        appointment.patient_type
      FROM 
        diagnosis
      LEFT JOIN 
        appointment 
      ON 
        diagnosis.patient_id = appointment.patient_id
      WHERE 
        diagnosis.date_diagnosis >= ? 
        AND diagnosis.date_diagnosis <= ? 
        `;

    const invoiceQuery = `SELECT patient_id 
                          FROM invoice 
                          WHERE creation_date >= ?`;

    const queries = [
      executeQuery(mainDoctorPerformanceQuery, [req.query.from, req.query.to]),
      executeQuery(asstDoctorPerformanceQuery, [req.query.from, req.query.to]),
      executeQuery(invoiceQuery, [req.query.from]),
    ];

    const [
      mainDoctorPerformanceData,
      asstDoctorPerformanceData,
      invoicePatientIds,
    ] = await Promise.all(queries);

    let mainDoctorPerformance = mainDoctorPerformanceResponse(
      mainDoctorPerformanceData,
      invoicePatientIds
    );
    let asstDoctorPerformance = asstDoctorPerformanceResponse(
      asstDoctorPerformanceData,
      invoicePatientIds
    );
    console.log(mainDoctorPerformance);
    return {
      mainDoctorPerformance,
      asstDoctorPerformance,
    };
  } catch (error) {
    console.error("Error executing queries:", error);
    throw error;
  }
}

const mainDoctorPerformanceResponse = (results, invoiceData) => {
  // Create a mapping of consultantDoctor to DoctorName
  const doctorMapping = {};
  results.forEach((item) => {
    doctorMapping[item.consultantDoctor] = item.DoctorName;
  });

  // Use unique consultantDoctor values for grouping
  const uniqueConsultantDoctors = [
    ...new Set(results.map((item) => item.consultantDoctor)),
  ];

  const docs = uniqueConsultantDoctors.map(() => Array(8).fill(0)); // Added one more field for surgeryDone

  const invoicePatientIds = new Set(
    invoiceData.map((invoice) => invoice.patient_id)
  );

  results.forEach((item) => {
    const doctorIndex = uniqueConsultantDoctors.indexOf(item.consultantDoctor);

    switch (item.patient_type) {
      case "New":
        docs[doctorIndex][0]++;
        break;
      case "Follow":
        docs[doctorIndex][1]++;
        break;
      case "Postoperative":
        docs[doctorIndex][2]++;
        break;
    }

    switch (item.diagnosisAdvice) {
      case "Medication":
      case "Medication,":
        docs[doctorIndex][3]++;
        docs[doctorIndex][7]++;
        break;
      case "Surgery":
      case "Surgery,":
        docs[doctorIndex][4]++;
        docs[doctorIndex][7]++;
        break;
      case "Test":
      case "Test,":
        docs[doctorIndex][5]++;
        docs[doctorIndex][7]++;
        break;
    }

    // Check if patient_id is in invoiceData
    if (invoicePatientIds.has(item.patient_id)) {
      docs[doctorIndex][6]++; // Increment surgeryDone
    }
  });

  // Return result with DoctorName mapped from consultantDoctor
  return uniqueConsultantDoctors.map((consultantDoctor, index) => ({
    Sr: index + 1,
    DoctorName: doctorMapping[consultantDoctor],
    NewPatients: docs[index][0],
    FollowUpPatients: docs[index][1],
    PostOpPatients: docs[index][2],
    MedicationPatients: docs[index][3],
    SurgeryPatients: docs[index][4],
    TestPatients: docs[index][5],
    SurgeryDone: docs[index][6], // New field
    totalCount: docs[index][7],
  }));
};

const asstDoctorPerformanceResponse = (results, invoiceData) => {
  // Process the results
  let uniqueNames = [];
  let doctorname = [];
  let docs = [];

  // Extract unique doctors and names
  results.forEach((item) => {
    if (!uniqueNames.includes(item.assistanceDoctor)) {
      uniqueNames.push(item.assistanceDoctor);
    }
    if (!doctorname.includes(item.DoctorName)) {
      doctorname.push(item.DoctorName);
    }
  });

  // Initialize docs array with the necessary structure
  uniqueNames.forEach(() => {
    docs.push([0, 0, 0, 0, 0, 0, 0, 0]); // New, Follow, Postoperative, Medication, Surgery, Test, SurgeryDone
  });

  // Convert invoiceData to a Set for efficient lookup
  const invoicePatientIds = new Set(
    invoiceData.map((invoice) => invoice.patient_id)
  );

  // Populate docs array with patient types, diagnosis, and SurgeryDone
  results.forEach((item) => {
    const doctorIndex = uniqueNames.indexOf(item.assistanceDoctor);

    switch (item.patient_type) {
      case "New":
        docs[doctorIndex][0]++;
        break;
      case "Follow":
        docs[doctorIndex][1]++;
        break;
      case "Postoperative":
        docs[doctorIndex][2]++;
        break;
    }

    switch (item.diagnosisAdvice) {
      case "Medication":
      case "Medication,":
        docs[doctorIndex][3]++;
        docs[doctorIndex][7]++;
        break;
      case "Surgery":
      case "Surgery,":
        docs[doctorIndex][4]++;
        docs[doctorIndex][7]++;
        break;
      case "Test":
      case "Test,":
        docs[doctorIndex][5]++;
        docs[doctorIndex][7]++;
        break;
    }

    // Check if patient_id is in invoiceData
    if (invoicePatientIds.has(item.patient_id)) {
      docs[doctorIndex][6]++; // Increment SurgeryDone
    }
  });

  // Prepare data for the response
  return uniqueNames.map((doctor, index) => {
    return {
      Sr: index + 1,
      DoctorName: doctorname[index],
      NewPatients: docs[index][0],
      FollowUpPatients: docs[index][1],
      PostOpPatients: docs[index][2],
      MedicationPatients: docs[index][3],
      SurgeryPatients: docs[index][4],
      TestPatients: docs[index][5],
      SurgeryDone: docs[index][6], // Include SurgeryDone
      totalCount: docs[index][7],
    };
  });
};

module.exports = { getConvincingScore };
