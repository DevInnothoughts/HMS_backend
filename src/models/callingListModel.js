const { getConnectionByLocation } = require("../../databaseUtils");

// ─────────────────────────────────────────────────────────────────────────────
// Robust calling_notes handling for getCallingList / getCallingListV1.
//
// parseCallingNotes() takes whatever the DB column holds and returns a clean
// array of { date, note }, dropping empty entries (e.g. {"note": {}}). It is
// safe for every shape: null | '' | '{}' | '[]' | a JSON array string |
// a JSON object string | an already-parsed value (JSON column) | malformed text
// | a non-empty string that only contains empty entries.
//
// Pick ONE cleanCallingNotes below depending on what your frontend expects, and
// replace your current cleanCallingNotes with it.
// ─────────────────────────────────────────────────────────────────────────────

function normalizeNoteEntry(entry) {
  if (entry == null) return null;

  // A bare string note inside the array
  if (typeof entry === "string") {
    const t = entry.trim();
    return t ? { date: null, note: t } : null;
  }
  if (typeof entry !== "object") return null;

  // Unwrap the note, following nested { note } objects. Some rows stored the
  // note as another { date, note } object instead of a plain string; without
  // this the object leaks to the client and crashes rendering.
  let note = entry.note;
  let date = entry.date ?? null;
  let guard = 0;
  while (
    note &&
    typeof note === "object" &&
    !Array.isArray(note) &&
    guard < 5
  ) {
    if (date == null && note.date != null) date = note.date; // keep innermost date if outer missing
    note = note.note;
    guard += 1;
  }

  if (typeof note === "string") note = note.trim();
  else if (note == null) note = "";
  else note = String(note); // any leftover primitive -> string

  if (note === "") return null; // drop empty entries (incl. {} that unwrapped to nothing)
  return { date, note };
}

function parseCallingNotes(raw) {
  if (raw == null) return [];

  let value = raw;
  if (typeof value === "string") {
    const t = value.trim();
    if (t === "" || t === "{}" || t === "[]" || t.toLowerCase() === "null") {
      return [];
    }
    try {
      value = JSON.parse(t);
    } catch {
      return [{ date: null, note: t }]; // not JSON -> single free-text note
    }
  }

  let arr;
  if (Array.isArray(value)) {
    arr = value;
  } else if (value && typeof value === "object") {
    arr = Object.keys(value).length === 0 ? [] : [value]; // {} => none; obj => wrap
  } else {
    return [];
  }

  return arr.map(normalizeNoteEntry).filter(Boolean);
}

// ── Option A (RECOMMENDED if you don't want to touch the frontend) ────────────
// Same null-or-string shape your current code returns: empty -> null, populated
// -> a CLEANED JSON string. Your existing JSON.parse on the client keeps working
// and simply never receives blank entries anymore.
const cleanCallingNotes = (rows) =>
  rows.map((row) => {
    const notes = parseCallingNotes(row.calling_notes);
    return {
      ...row,
      calling_notes: notes.length ? JSON.stringify(notes) : null,
    };
  });

// ── Option B (cleaner; requires a one-line frontend change) ───────────────────
// Returns a ready-to-use array (empty -> []). On the client, drop the JSON.parse
// and map calling_notes directly; use calling_notes.length to detect "no notes".
//
// const cleanCallingNotes = (rows) =>
//   rows.map((row) => ({
//     ...row,
//     calling_notes: parseCallingNotes(row.calling_notes),
//   }));

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

    // Sanitize calling_notes on every list so the frontend never receives an
    // empty {"note": {}} object (which React Native can't render). Mirrors
    // getCallingListV1. cleanCallingNotes drops blank entries and returns a
    // clean JSON string (or null when there are no real notes).
    return {
      SurgeryOPD: cleanCallingNotes(opdSurgeryCallsData),
      MedicationOPD: cleanCallingNotes(opdMedicationCallsData),
      TestOPD: cleanCallingNotes(opdTestCallsData),
      Enquiry: cleanCallingNotes(enquiryCallsData),
      PostOp: cleanCallingNotes(postOpCallsData),
    };
  } catch (error) {
    console.error("Error executing queries:", error.message, error.stack);
    throw error;
  }
}

async function getCallingListV1(req) {
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
        appointment a ON e.patient_phone = a.patient_phone
      WHERE 
        e.enquirytype != 'Visited'
        AND (a.patient_phone IS NULL OR a.confirm_time = 0)
        AND DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), e.date) IN (3, 7, 15, 30)
      ORDER BY e.date DESC;
    `;

    const enquiryCallbackQuery = `
      SELECT DISTINCT
        e.enquiry_id AS id,
        e.enquirytype,
        e.patient_name AS name,
        e.patient_phone AS phone,
        e.date,
        e.note AS diagnosis,
        e.calling_notes,
        NULL AS days_since
      FROM 
        appointment_enquiry e
      LEFT JOIN 
        appointment a ON e.patient_phone = a.patient_phone
      WHERE 
        e.enquirytype != 'Visited'
        AND (a.patient_phone IS NULL OR a.confirm_time = 0)
        AND e.callbackDate = ?
      ORDER BY e.date DESC;
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
        DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), d.date_diagnosis) AS days_since,
        dr.name AS doctor_name
      FROM 
        diagnosis d
      LEFT JOIN patient p ON d.patient_id = p.patient_id
      LEFT JOIN doctor dr
          ON d.assistanceDoctor = dr.doctor_id
      WHERE 
        DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), d.date_diagnosis) IN (3, 7, 15, 30)
        AND d.diagnosisAdvice LIKE '%Surgery%'
      ORDER BY d.date_diagnosis DESC;
    `;

    const opdSurgeryCallbackQuery = `
      SELECT DISTINCT
        d.diag_id AS id,
        d.patient_id,
        p.name,
        p.phone,
        d.date_diagnosis AS date,
        d.diagnosis,
        d.diagnosisAdvice,
        d.calling_notes,
        dr.name AS doctor_name,
        NULL AS days_since
      FROM 
        diagnosis d
      LEFT JOIN patient p ON d.patient_id = p.patient_id
      LEFT JOIN doctor dr
          ON d.assistanceDoctor = dr.doctor_id
      WHERE 
        d.callbackDate = ?
        AND d.diagnosisAdvice LIKE '%Surgery%'
      ORDER BY d.date_diagnosis DESC;
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
        DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), d.date_diagnosis) AS days_since,
        dr.name AS doctor_name
      FROM 
        diagnosis d
      LEFT JOIN patient p ON d.patient_id = p.patient_id
      LEFT JOIN doctor dr
          ON d.assistanceDoctor = dr.doctor_id
      WHERE 
        DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), d.date_diagnosis) IN (3, 7, 15, 30)
        AND d.diagnosisAdvice LIKE '%Medication%'
      ORDER BY d.date_diagnosis DESC;
    `;

    const opdMedicationCallbackQuery = `
      SELECT DISTINCT
        d.diag_id AS id,
        d.patient_id,
        p.name,
        p.phone,
        d.date_diagnosis AS date,
        d.diagnosis,
        d.diagnosisAdvice,
        d.calling_notes,
        NULL AS days_since,
        dr.name AS doctor_name
      FROM 
        diagnosis d
      LEFT JOIN patient p ON d.patient_id = p.patient_id
      LEFT JOIN doctor dr
          ON d.assistanceDoctor = dr.doctor_id
      WHERE 
        d.callbackDate = ?
        AND d.diagnosisAdvice LIKE '%Medication%'
      ORDER BY d.date_diagnosis DESC;
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
        DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), d.date_diagnosis) AS days_since,
        dr.name AS doctor_name
      FROM 
        diagnosis d
      LEFT JOIN patient p ON d.patient_id = p.patient_id
      LEFT JOIN doctor dr
          ON d.assistanceDoctor = dr.doctor_id
      WHERE 
        DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), d.date_diagnosis) IN (3, 7, 15, 30)
        AND d.diagnosisAdvice LIKE '%Test%'
      ORDER BY d.date_diagnosis DESC;
    `;

    const opdTestCallbackQuery = `
      SELECT DISTINCT
        d.diag_id AS id,
        d.patient_id,
        p.name,
        p.phone,
        d.date_diagnosis AS date,
        d.diagnosis,
        d.diagnosisAdvice,
        d.calling_notes,
        NULL AS days_since,
        dr.name AS doctor_name
      FROM 
        diagnosis d
      LEFT JOIN patient p ON d.patient_id = p.patient_id
      LEFT JOIN doctor dr
          ON d.assistanceDoctor = dr.doctor_id

      WHERE 
        d.callbackDate = ?
        AND d.diagnosisAdvice LIKE '%Test%'
      ORDER BY d.date_diagnosis DESC;
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
        DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), d.DOD) AS days_since,
         dr.name AS doctor_name
      FROM 
        discharge_card d
      LEFT JOIN patient p ON d.patient_id = p.patient_id
      LEFT JOIN doctor dr
          ON d.consultantName = dr.doctor_id
      WHERE 
        DATEDIFF(STR_TO_DATE(?, '%Y-%m-%d'), d.DOD) IN (3, 7, 15, 30)
      ORDER BY d.DOD DESC;
    `;

    const postOpCallbackQuery = `
      SELECT DISTINCT
        d.discharge_id AS id,
        d.patient_id,
        p.name,
        p.phone,
        d.DOD AS date,
        d.diagnosis,
        d.surgical_procedure,
        d.calling_notes,
        NULL AS days_since,
        dr.name AS doctor_name
      FROM 
        discharge_card d
      LEFT JOIN patient p ON d.patient_id = p.patient_id
      LEFT JOIN doctor dr
          ON d.consultantName = dr.doctor_id
      WHERE 
        d.callbackDate = ?
      ORDER BY d.DOD DESC;
    `;

    const MCDPACallsQuery = ` SELECT DISTINCT
        d.diag_id AS id,
        d.patient_id,
        p.name,
        p.phone,
        d.date_diagnosis AS date,
        d.diagnosis,
        d.diagnosisAdvice,
        d.calling_notes,
        NULL AS days_since,
        dr.name AS doctor_name
      FROM 
        diagnosis d
      LEFT JOIN patient p ON d.patient_id = p.patient_id
      LEFT JOIN doctor dr
          ON d.assistanceDoctor = dr.doctor_id
      WHERE 
        d.callbackDate = ?
        AND d.diagnosisAdvice LIKE '%MCDPA%'
      ORDER BY d.date_diagnosis DESC;`;
    const MCDPACallbackQuery = `SELECT DISTINCT
        d.diag_id AS id,
        d.patient_id,
        p.name,
        p.phone,
        d.date_diagnosis AS date,
        d.diagnosis,
        d.diagnosisAdvice,
        d.calling_notes,
        NULL AS days_since,
        dr.name AS doctor_name
      FROM 
        diagnosis d
      LEFT JOIN patient p ON d.patient_id = p.patient_id
      LEFT JOIN doctor dr
          ON d.assistanceDoctor = dr.doctor_id

      WHERE 
        d.callbackDate = ?
        AND d.diagnosisAdvice LIKE '%MCDPA%'
      ORDER BY d.date_diagnosis DESC;`;

    let [
      enquiryCallsData,
      enquiryCallbackData,
      opdSurgeryCallsData,
      opdSurgeryCallbackData,
      opdMedicationCallsData,
      opdMedicationCallbackData,
      opdTestCallsData,
      opdTestCallbackData,
      postOpCallsData,
      postOpCallbackData,
      MCDPACallsData,
      MCDPACallbackData,
    ] = await Promise.all([
      executeQuery(enquiryCallsQuery, [referenceDate, referenceDate]),
      executeQuery(enquiryCallbackQuery, [referenceDate]),
      executeQuery(opdSurgeryCallsQuery, [referenceDate, referenceDate]),
      executeQuery(opdSurgeryCallbackQuery, [referenceDate]),
      executeQuery(opdMedicationCallsQuery, [referenceDate, referenceDate]),
      executeQuery(opdMedicationCallbackQuery, [referenceDate]),
      executeQuery(opdTestCallsQuery, [referenceDate, referenceDate]),
      executeQuery(opdTestCallbackQuery, [referenceDate]),
      executeQuery(postOpCallsQuery, [referenceDate, referenceDate]),
      executeQuery(postOpCallbackQuery, [referenceDate]),
      executeQuery(MCDPACallsQuery, [referenceDate, referenceDate]),
      executeQuery(MCDPACallbackQuery, [referenceDate]),
    ]);

    enquiryCallsData = cleanCallingNotes(enquiryCallsData);
    enquiryCallbackData = cleanCallingNotes(enquiryCallbackData);

    opdSurgeryCallsData = cleanCallingNotes(opdSurgeryCallsData);
    opdSurgeryCallbackData = cleanCallingNotes(opdSurgeryCallbackData);

    opdMedicationCallsData = cleanCallingNotes(opdMedicationCallsData);
    opdMedicationCallbackData = cleanCallingNotes(opdMedicationCallbackData);

    opdTestCallsData = cleanCallingNotes(opdTestCallsData);
    opdTestCallbackData = cleanCallingNotes(opdTestCallbackData);

    postOpCallsData = cleanCallingNotes(postOpCallsData);
    postOpCallbackData = cleanCallingNotes(postOpCallbackData);

    MCDPACallsData = cleanCallingNotes(MCDPACallsData);
    MCDPACallbackData = cleanCallingNotes(MCDPACallbackData);

    // ✅ Merge callback rows into each list, tagged with isCallback flag
    const mergeWithCallback = (mainList, callbackList) => [
      ...mainList,
      ...callbackList.map((row) => ({
        ...row,
        days_since: "CB",
        isCallback: true,
      })),
    ];

    return {
      SurgeryOPD: mergeWithCallback(
        opdSurgeryCallsData,
        opdSurgeryCallbackData,
      ),
      MedicationOPD: mergeWithCallback(
        opdMedicationCallsData,
        opdMedicationCallbackData,
      ),
      TestOPD: mergeWithCallback(opdTestCallsData, opdTestCallbackData),
      Enquiry: mergeWithCallback(enquiryCallsData, enquiryCallbackData),
      PostOp: mergeWithCallback(postOpCallsData, postOpCallbackData),
      MCDPA: mergeWithCallback(MCDPACallsData, MCDPACallbackData),
    };
  } catch (error) {
    console.error("Error executing queries:", error.message, error.stack);
    throw error;
  }
}

module.exports = { getCallingList, getCallingListV1 };
