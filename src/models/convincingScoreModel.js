const { getConnectionByLocation } = require("../../databaseUtils");
// Parse the provisionalDiagnosis TEXT column into an object, safely. It stores
// JSON like {"piles":["Grade 2"],"fistula":["Fistula in Ano"]} — keys are
// specialities, values are sub-type arrays. Handles null / '' / '{}' / malformed.
function parseProvisional(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw; // already parsed (JSON column type)
  const s = raw.toString().trim();
  if (s === "" || s === "{}" || s.toLowerCase() === "null") return null;
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

// Sub-types recorded for a given speciality (case-insensitive key match),
// de-duplicated. e.g. subTypesFor({"piles":["Grade 2"]}, "Piles") -> ["Grade 2"].
function subTypesFor(provisional, speciality) {
  if (!provisional) return [];
  const target = speciality.toLowerCase();
  for (const key of Object.keys(provisional)) {
    if (key.toLowerCase() === target) {
      const val = provisional[key];
      if (!Array.isArray(val)) return [];
      const cleaned = val
        .map((v) => (v == null ? "" : v.toString().trim()))
        .filter((v) => v !== "");
      return [...new Set(cleaned)];
    }
  }
  return [];
}

// Capitalize the first character only (leaves the rest of the label untouched).
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// For the same case-insensitive key, prefer the label that already starts with a
// capital letter (e.g. keep "Piles" over "piles"); otherwise keep what we have.
function preferLabel(existing, candidate) {
  if (!existing) return candidate;
  const eCap = /^[A-Z]/.test(existing);
  const cCap = /^[A-Z]/.test(candidate);
  return !eCap && cCap ? candidate : existing;
}

// Build the per-speciality breakdown for one doctor. Each patient is assigned to
// exactly ONE speciality (their latest diagnosis in range), so the per-speciality
// patient counts always sum to the doctor's distinct patientCount. Also counts,
// within each speciality, how many patients were advised surgery, how many
// converted to IPD, and the sub-type distribution (from provisionalDiagnosis).
// Speciality and sub-type names are grouped case-insensitively, so "Piles" and
// "piles" (or "Grade 2" / "grade 2") merge into one entry.
// patientSpeciality maps patient_id -> { speciality, surgeryAdvised, subTypes }.
function buildSpecialityBreakdown(patientSpeciality, invoicePatientIdSet) {
  const label = {}; // specKey -> best display label
  const count = {};
  const surgery = {};
  const ipd = {};
  const subTypes = {}; // specKey -> { subKey -> { label, count } }
  for (const [patientId, info] of patientSpeciality) {
    const rawSpec = (info.speciality || "Unspecified").toString().trim();
    const specKey = rawSpec.toLowerCase();
    label[specKey] = preferLabel(label[specKey], rawSpec);
    count[specKey] = (count[specKey] || 0) + 1;
    if (info.surgeryAdvised) surgery[specKey] = (surgery[specKey] || 0) + 1;
    if (invoicePatientIdSet.has(patientId))
      ipd[specKey] = (ipd[specKey] || 0) + 1;
    if (info.subTypes && info.subTypes.length) {
      if (!subTypes[specKey]) subTypes[specKey] = {};
      for (const st of info.subTypes) {
        // Keep only Grade 1–4; merge variants ("Grade II", "grade-2") → "Grade 2".
        const gradeMatch = st.toString().match(/grade\s*-?\s*([1-4])(?!\d)/i);
        if (!gradeMatch) continue; // ignore anything that isn't a grade
        const raw = `Grade ${gradeMatch[1]}`;
        const subKey = raw.toLowerCase();
        if (!subTypes[specKey][subKey]) {
          subTypes[specKey][subKey] = {
            label: raw,
            seen: 0,
            advised: 0,
            surgery: 0,
          };
        }
        const t = subTypes[specKey][subKey];
        t.seen += 1;
        if (info.surgeryAdvised) t.advised += 1;
        if (invoicePatientIdSet.has(patientId)) t.surgery += 1;
      }
    }
  }
  return Object.keys(count)
    .map((specKey) => {
      const patientCount = count[specKey];
      const surgeryAdvised = surgery[specKey] || 0;
      const ipdCount = ipd[specKey] || 0;
      return {
        speciality: capFirst(label[specKey]),
        patientCount,
        surgeryAdvised,
        ipdCount,
        conversionRate:
          patientCount > 0
            ? Math.round((ipdCount / patientCount) * 1000) / 10
            : 0,
        subTypes: Object.values(subTypes[specKey] || {})
          .map((s) => ({
            name: capFirst(s.label),
            seen: s.seen,
            advised: s.advised,
            surgery: s.surgery,
            patientCount: s.seen, // kept so any old reader still works
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    })
    .sort((a, b) => b.patientCount - a.patientCount || b.ipdCount - a.ipdCount);
}

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
          totalSurgeriesPerformed: 0,
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

    const totalSurgeriesPerformed = consultantDoctors.reduce(
      (sum, doc) => sum + (doc.invoiceCount || 0),
      0,
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
        totalSurgeriesPerformed: totalSurgeriesPerformed,
      },
    };
  } catch (error) {
    console.error("Error executing queries:", error);
    throw error;
  }
}

async function getConvincingScoreV3(req) {
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
          totalSurgeriesPerformed: 0,
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
    d.diagnosisAdvice,
    d.speciality,
    d.provisionalDiagnosis
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
    d.diagnosisAdvice,
    d.speciality,
    d.provisionalDiagnosis
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

    const procedureCountQuery = `SELECT patient_id, COUNT(*) AS procedureCount
                                 FROM invoice
                                 WHERE creation_date >= ? AND creation_date <= ? AND is_deleted != 1
                                 GROUP BY patient_id`;

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
      procedureCountRows,
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
      executeQuery(procedureCountQuery, [req.query.from, req.query.to]),
    ]);

    const { consultantDoctors, assistantDoctors, totalCounts } =
      processDiagnosisData1(
        mainDoctorRows,
        assistantDoctorRows,
        invoiceQueryRows,
        sameMonthInvoiceRows,
        procedureCountRows,
      );

    const totalSurgeriesPerformed = consultantDoctors.reduce(
      (sum, doc) => sum + (doc.invoiceCount || 0),
      0,
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
        totalSurgeriesPerformed: totalSurgeriesPerformed,
      },
    };
  } catch (error) {
    console.error("Error executing queries:", error);
    throw error;
  }
}

function processDiagnosisData1(
  mainDoctorRows,
  assistantDoctorRows,
  invoiceQueryRows,
  sameMonthInvoiceRows,
  procedureCountRows = [],
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

  // Invoices (surgeries) per patient in range → total procedure counts per doctor.
  // Same per-patient doctor attribution as the invoice maps above; a patient with
  // 2 surgeries contributes 2. This is always >= the distinct-patient invoiceCount.
  const procByPatient = {};
  procedureCountRows.forEach((row) => {
    procByPatient[row.patient_id] = row.procedureCount;
  });

  const consultantProcedureMap = {};
  const assistantProcedureMap = {};
  invoiceQueryRows.forEach((row) => {
    const n = procByPatient[row.patient_id] || 1;
    if (row.consultantDoctor) {
      consultantProcedureMap[row.consultantDoctor] =
        (consultantProcedureMap[row.consultantDoctor] || 0) + n;
    }
    if (row.assistanceDoctor) {
      assistantProcedureMap[row.assistanceDoctor] =
        (assistantProcedureMap[row.assistanceDoctor] || 0) + n;
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

  // Set of patient_ids that have an invoice in range (for per-speciality IPD).
  const invoicePatientIdSet = new Set(
    invoiceQueryRows.map((r) => r.patient_id),
  );

  // Helper to process diagnosis rows
  const processRows = (
    rows,
    doctorKey,
    invoiceMap,
    surgeryMap,
    procedureMap,
  ) => {
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
          invoiceCount: invoiceMap[doctorId] || 0, // total invoices
          surgeryPerformed: surgeryMap[doctorId] || 0, // surgeries in same month
          patientSpeciality: new Map(), // patient_id -> { speciality, surgeryAdvised } (latest wins)
        };
      }

      doctorMap[doctorId].patientIds.add(row.patient_id);

      // Classify this diagnosis's advice (anything not "medication" = Surgery).
      const adviceRaw = row.diagnosisAdvice || "Unknown";
      let advice = adviceRaw.toString().replace(/,$/, "").trim();
      if (advice.toLowerCase() !== "medication") {
        advice = "Surgery";
      }

      // Assign each patient to ONE speciality (latest diagnosis wins — rows are
      // ordered by date_diagnosis ascending). This keeps the per-speciality
      // patient counts summing to patientCount, and covers every diagnosed
      // patient regardless of whether symptoms were recorded. We also carry the
      // latest diagnosis's advice so we can count surgery-advised patients.
      const speciality =
        (row.speciality || "").toString().trim() || "Unspecified";
      const provisional = parseProvisional(row.provisionalDiagnosis);
      doctorMap[doctorId].patientSpeciality.set(row.patient_id, {
        speciality,
        surgeryAdvised: advice === "Surgery",
        subTypes: subTypesFor(provisional, speciality),
      });
    });

    return Object.values(doctorMap).map((doc) => {
      // Doctor-level Surgery / Medication as DISTINCT patients (by latest
      // diagnosis). This makes them equal the sum of the per-speciality funnel
      // and partition patientCount (Surgery + Medication === patientCount).
      let surgeryPatients = 0;
      let medicationPatients = 0;
      for (const [, info] of doc.patientSpeciality) {
        if (info.surgeryAdvised) surgeryPatients++;
        else medicationPatients++;
      }

      return {
        doctorId: doc.doctorId,
        doctorName: doc.doctorName,
        patientCount: doc.patientIds.size,
        patientIds: Array.from(doc.patientIds),
        diagnosisCounts: {
          Surgery: surgeryPatients,
          Medication: medicationPatients,
        },
        invoiceCount: doc.invoiceCount,
        totalSurgeriesDone: procedureMap[doc.doctorId] || 0,
        thisMonthDiagnosedAndSurgeryPerformed: doc.surgeryPerformed,
        specialities: buildSpecialityBreakdown(
          doc.patientSpeciality,
          invoicePatientIdSet,
        ),
      };
    });
  };

  const consultantDoctors = processRows(
    mainDoctorRows,
    "consultantDoctor",
    consultantInvoiceMap,
    consultantSurgeryMap,
    consultantProcedureMap,
  );
  const assistantDoctors = processRows(
    assistantDoctorRows,
    "assistanceDoctor",
    assistantInvoiceMap,
    assistantSurgeryMap,
    assistantProcedureMap,
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
  getConvincingScoreV3,
};
