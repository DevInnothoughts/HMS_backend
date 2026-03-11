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
        diagnosis.patient_id = appointment.patient_id AND appointment.appointment_timestamp <= diagnosis.date_diagnosis AND appointment.confirm_time != '0'
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
        diagnosis.patient_id = appointment.patient_id AND appointment.appointment_timestamp <= diagnosis.date_diagnosis AND appointment.confirm_time != '0'
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

    //console.log(mainDoctorPerformanceData.length);

    let mainDoctorPerformance = mainDoctorPerformanceResponse(
      mainDoctorPerformanceData,
      invoicePatientIds,
    );
    let asstDoctorPerformance = asstDoctorPerformanceResponse(
      asstDoctorPerformanceData,
      invoicePatientIds,
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

  const docs = uniqueConsultantDoctors.map(() => Array(10).fill(0)); // Added one more field for surgeryDone

  const invoicePatientIds = new Set(
    invoiceData.map((invoice) => invoice.patient_id),
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
      default:
        // item.patient_type === null
        //   ? docs[doctorIndex][0]++
        //   :
        docs[doctorIndex][8]++;
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
      default:
        docs[doctorIndex][9]++;
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
    otherPatients: docs[index][8],
    otherDiagnosis: docs[index][9],
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
    docs.push([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // New, Follow, Postoperative, Medication, Surgery, Test, SurgeryDone, otherPatient, otherDiagnosis
  });

  // Convert invoiceData to a Set for efficient lookup
  const invoicePatientIds = new Set(
    invoiceData.map((invoice) => invoice.patient_id),
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
      default:
        // item.patient_type === null
        //   ? docs[doctorIndex][0]++
        //   :
        docs[doctorIndex][8]++;
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
      default:
        docs[doctorIndex][9]++;
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
      otherPatients: docs[index][8],
      otherDiagnosis: docs[index][9],
    };
  });
};

async function getConvincingScoreV1(req) {
  const { connection, location } = getConnectionByLocation(req.query.location);
  console.log("from:", req.query.from, "to:", req.query.to);

  if (!connection) {
    const err = new Error(`Invalid location: ${req.query.location}`);
    err.status = 404;
    throw err;
  }

  const executeQuery = (query, values = []) =>
    new Promise((resolve, reject) => {
      connection.query(query, values, (error, results) => {
        if (error) return reject(error);
        resolve(results);
      });
    });

  try {
    // 1) Get distinct diagnosis data per patient_id within date range.
    //    We take the latest diagnosis row per patient in the date range.
    const distinctDiagnosisQuery = `
     SELECT 
    d.consultantDoctor,
    (SELECT name FROM doctor WHERE doctor_id = d.consultantDoctor) AS DoctorName,
    d.patient_id,
    d.date_diagnosis,
    d.diagnosisAdvice
FROM diagnosis d
WHERE d.date_diagnosis >= ? AND d.date_diagnosis <= ?
ORDER BY d.consultantDoctor, d.patient_id, d.date_diagnosis;
    `;

    // 2) Count distinct patients (one per patient) who have diagnosisAdvice containing
    //    medication / surgery / test (case-insensitive). This subquery makes flags per patient.
    const countsQuery = `
     SELECT 
    d.assistanceDoctor,
    (SELECT name FROM doctor WHERE doctor_id = d.assistanceDoctor) AS DoctorName,
    d.patient_id,
    d.date_diagnosis,
    d.diagnosisAdvice
FROM diagnosis d
WHERE d.date_diagnosis >= ? AND d.date_diagnosis <= ?
ORDER BY d.assistanceDoctor, d.patient_id, d.date_diagnosis;
    `;

    const invoiceQuery = `SELECT 
    d.patient_id,
    d.consultantDoctor,
    c.name AS consultantName,
    d.assistanceDoctor,
    a.name AS assistantName
FROM diagnosis d
LEFT JOIN doctor c ON c.doctor_id = d.consultantDoctor
LEFT JOIN doctor a ON a.doctor_id = d.assistanceDoctor
WHERE d.patient_id IN (
    SELECT patient_id
    FROM invoice
    WHERE creation_date >= ? 
      AND creation_date <= ? 
      AND is_deleted != 1
)
GROUP BY d.patient_id;
`;

    const sameMonthInvoiceQuery = `SELECT 
    d.patient_id,
    d.consultantDoctor,
    c.name AS consultantName,
    d.assistanceDoctor,
    a.name AS assistantName
FROM diagnosis d
LEFT JOIN doctor c ON c.doctor_id = d.consultantDoctor
LEFT JOIN doctor a ON a.doctor_id = d.assistanceDoctor
WHERE d.patient_id IN (
    SELECT patient_id
    FROM invoice
    WHERE creation_date >= ? 
      AND creation_date <= ? 
      AND is_deleted != 1
)
AND d.date_diagnosis >= ? 
AND d.date_diagnosis <= ?
GROUP BY d.patient_id;
`;

    const newAppointmentCount = `
          SELECT 
            COUNT (*) AS newAppointmentCount
          FROM appointment ap
          WHERE ap.appointment_timestamp >= ?  
          AND ap.appointment_timestamp <= ?
          AND ap.is_deleted != 1
          AND ap.patient_type = 'New'
          AND ap.confirm_time != '0'
          AND executivechk = 2
        `;
    // Run both queries in parallel
    const [
      mainDoctorRows,
      assistantDoctorRows,
      invoiceQueryRows,
      sameMonthInvoiceRows,
      newAppointmentCountRows,
    ] = await Promise.all([
      executeQuery(distinctDiagnosisQuery, [req.query.from, req.query.to]),
      executeQuery(countsQuery, [req.query.from, req.query.to]),
      executeQuery(invoiceQuery, [req.query.from, req.query.to]),
      executeQuery(sameMonthInvoiceQuery, [
        req.query.from,
        req.query.to,
        req.query.from,
        req.query.to,
      ]),
      executeQuery(newAppointmentCount, [req.query.from, req.query.to]),
    ]);

    const { consultantDoctors, assistantDoctors, totalCounts } =
      processDiagnosisData(
        mainDoctorRows,
        assistantDoctorRows,
        invoiceQueryRows,
        sameMonthInvoiceRows,
      );

    console.log("Consultant Doctors:", totalCounts);
    console.log("Assistant Doctors:", newAppointmentCountRows);
    return {
      consultantDoctors, // array of distinct diagnosis rows (one per patient, latest in range)
      assistantDoctors,
      branchTotal: {
        newAppointmentCount:
          newAppointmentCountRows[0]?.newAppointmentCount || 0,
        totalDiagnosisCount: mainDoctorRows.length,
        totalMedication: totalCounts.Medication,
        totalSurgery: totalCounts.Surgery,
      },
    };
  } catch (error) {
    console.error("Error executing queries:", error);
    throw error;
  }
}

async function getConvincingScoreV2(req) {
  const { connection, location } = getConnectionByLocation(req.query.location);
  console.log("from:", req.query.from, "to:", req.query.to);

  if (!connection) {
    const err = new Error(`Invalid location: ${req.query.location}`);
    err.status = 404;
    throw err;
  }

  const executeQuery = (query, values = []) =>
    new Promise((resolve, reject) => {
      connection.query(query, values, (error, results) => {
        if (error) return reject(error);
        resolve(results);
      });
    });

  try {
    const newAppointmentPatientsQuery = `
      SELECT DISTINCT ap.patient_id
      FROM appointment ap
      WHERE ap.appointment_timestamp >= ?
        AND ap.appointment_timestamp <= ?
        AND ap.is_deleted != 1
        AND ap.patient_type = 'New'
        AND ap.confirm_time != '0'
        AND ap.executivechk = 2
    `;

    const newAppointmentPatientRows = await executeQuery(
      newAppointmentPatientsQuery,
      [req.query.from, req.query.to],
    );

    const newPatientIds = newAppointmentPatientRows.map((r) => r.patient_id);

    // 🚨 Important safeguard
    if (newPatientIds.length === 0) {
      return {
        consultantDoctors: [],
        assistantDoctors: [],
        branchTotal: {
          newAppointmentCount: 0,
          totalDiagnosisCount: 0,
          totalMedication: 0,
          totalSurgery: 0,
        },
      };
    }

    // 1) Get distinct diagnosis data per patient_id within date range.
    //    We take the latest diagnosis row per patient in the date range.
    const distinctDiagnosisQuery = `
     SELECT 
    d.consultantDoctor,
    (SELECT name FROM doctor WHERE doctor_id = d.consultantDoctor) AS DoctorName,
    d.patient_id,
    d.date_diagnosis,
    d.diagnosisAdvice
FROM diagnosis d
WHERE d.patient_id IN (?)
ORDER BY d.consultantDoctor, d.patient_id, d.date_diagnosis;
    `;

    // 2) Count distinct patients (one per patient) who have diagnosisAdvice containing
    //    medication / surgery / test (case-insensitive). This subquery makes flags per patient.
    const countsQuery = `
     SELECT 
    d.assistanceDoctor,
    (SELECT name FROM doctor WHERE doctor_id = d.assistanceDoctor) AS DoctorName,
    d.patient_id,
    d.date_diagnosis,
    d.diagnosisAdvice
FROM diagnosis d
WHERE d.patient_id IN (?)
ORDER BY d.assistanceDoctor, d.patient_id, d.date_diagnosis;
    `;

    const invoiceQuery = `SELECT 
    d.patient_id,
    d.consultantDoctor,
    c.name AS consultantName,
    d.assistanceDoctor,
    a.name AS assistantName
FROM diagnosis d
LEFT JOIN doctor c ON c.doctor_id = d.consultantDoctor
LEFT JOIN doctor a ON a.doctor_id = d.assistanceDoctor
WHERE d.patient_id IN (
    SELECT patient_id
    FROM invoice
    WHERE creation_date >= ? 
      AND creation_date <= ? 
      AND is_deleted != 1
)
GROUP BY d.patient_id;
`;

    const sameMonthInvoiceQuery = `SELECT 
    d.patient_id,
    d.consultantDoctor,
    c.name AS consultantName,
    d.assistanceDoctor,
    a.name AS assistantName
FROM diagnosis d
LEFT JOIN doctor c ON c.doctor_id = d.consultantDoctor
LEFT JOIN doctor a ON a.doctor_id = d.assistanceDoctor
WHERE d.patient_id IN (
    SELECT patient_id
    FROM invoice
    WHERE creation_date >= ? 
      AND creation_date <= ? 
      AND is_deleted != 1
)
AND d.date_diagnosis >= ? 
AND d.date_diagnosis <= ?
GROUP BY d.patient_id;
`;

    // Run both queries in parallel
    const [
      mainDoctorRows,
      assistantDoctorRows,
      invoiceQueryRows,
      sameMonthInvoiceRows,
    ] = await Promise.all([
      executeQuery(distinctDiagnosisQuery, [newPatientIds]),
      executeQuery(countsQuery, [newPatientIds]),
      executeQuery(invoiceQuery, [req.query.from, req.query.to]),
      executeQuery(sameMonthInvoiceQuery, [
        req.query.from,
        req.query.to,
        req.query.from,
        req.query.to,
      ]),
    ]);

    const { consultantDoctors, assistantDoctors, totalCounts } =
      processDiagnosisData(
        mainDoctorRows,
        assistantDoctorRows,
        invoiceQueryRows,
        sameMonthInvoiceRows,
      );

    console.log("Consultant Doctors:", totalCounts);
    //console.log("Assistant Doctors:", newAppointmentCountRows);
    return {
      consultantDoctors, // array of distinct diagnosis rows (one per patient, latest in range)
      assistantDoctors,
      branchTotal: {
        newAppointmentCount: newPatientIds.length,
        totalDiagnosisCount: mainDoctorRows.length,
        totalMedication: totalCounts.Medication,
        totalSurgery: totalCounts.Surgery,
      },
    };
  } catch (error) {
    console.error("Error executing queries:", error);
    throw error;
  }
}

function processDiagnosisData(
  mainDoctorRows,
  assistantDoctorRows,
  invoiceQueryRows,
  sameMonthInvoiceRows,
) {
  console.log("Processing diagnosis data...", invoiceQueryRows.length);
  // Build invoice count maps (overall invoices)
  const consultantInvoiceMap = {};
  const assistantInvoiceMap = {};

  invoiceQueryRows.forEach((row) => {
    if (row.consultantDoctor) {
      consultantInvoiceMap[row.consultantDoctor] =
        (consultantInvoiceMap[row.consultantDoctor] || 0) + 1;
    }
    if (row.assistanceDoctor) {
      assistantInvoiceMap[row.assistanceDoctor] =
        (assistantInvoiceMap[row.assistanceDoctor] || 0) + 1;
    }
  });

  // Build surgery count maps (same month surgeries)
  const consultantSurgeryMap = {};
  const assistantSurgeryMap = {};

  sameMonthInvoiceRows.forEach((row) => {
    if (row.consultantDoctor) {
      consultantSurgeryMap[row.consultantDoctor] =
        (consultantSurgeryMap[row.consultantDoctor] || 0) + 1;
    }
    if (row.assistanceDoctor) {
      assistantSurgeryMap[row.assistanceDoctor] =
        (assistantSurgeryMap[row.assistanceDoctor] || 0) + 1;
    }
  });

  // Helper to process diagnosis rows
  const processRows = (rows, doctorKey, invoiceMap, surgeryMap) => {
    const doctorMap = {};

    rows.forEach((row) => {
      const doctorId = row[doctorKey];
      const doctorName = row.DoctorName;
      if (!doctorId) return;

      if (!doctorMap[doctorId]) {
        doctorMap[doctorId] = {
          doctorId,
          doctorName,
          patientIds: new Set(),
          diagnosisCounts: { Surgery: 0, Medication: 0 },
          invoiceCount: invoiceMap[doctorId] || 0, // total invoices
          surgeryPerformed: surgeryMap[doctorId] || 0, // surgeries in same month
        };
      }

      doctorMap[doctorId].patientIds.add(row.patient_id);

      // Count diagnosis advice
      const adviceRaw = row.diagnosisAdvice || "Unknown";
      let advice = adviceRaw.toString().replace(/,$/, "").trim();
      if (advice.toLowerCase() !== "medication") {
        advice = "Surgery";
      }
      doctorMap[doctorId].diagnosisCounts[advice]++;
    });

    return Object.values(doctorMap).map((doc) => ({
      doctorId: doc.doctorId,
      doctorName: doc.doctorName,
      patientCount: doc.patientIds.size,
      patientIds: Array.from(doc.patientIds),
      diagnosisCounts: doc.diagnosisCounts,
      invoiceCount: doc.invoiceCount,
      thisMonthDiagnosedAndSurgeryPerformed: doc.surgeryPerformed,
    }));
  };

  const consultantDoctors = processRows(
    mainDoctorRows,
    "consultantDoctor",
    consultantInvoiceMap,
    consultantSurgeryMap,
  );
  const assistantDoctors = processRows(
    assistantDoctorRows,
    "assistanceDoctor",
    assistantInvoiceMap,
    assistantSurgeryMap,
  );

  // ✅ Calculate total Medication & Surgery counts across all doctors
  const allDoctors = [...consultantDoctors];
  const totalCounts = allDoctors.reduce(
    (totals, doc) => {
      totals.Medication += doc.diagnosisCounts.Medication;
      totals.Surgery += doc.diagnosisCounts.Surgery;
      return totals;
    },
    { Medication: 0, Surgery: 0 },
  );

  return { consultantDoctors, assistantDoctors, totalCounts };
}

module.exports = {
  getConvincingScoreV1,
  getConvincingScore,
  getConvincingScoreV2,
};
