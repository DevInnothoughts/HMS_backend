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

/* ══════════════════════════════════════════════════════════════════════════
 * V2 — converted enquiries removed, operated patients flagged
 *
 * ADDITIVE. Nothing above this line is touched. getCallingListV1 and
 * GET /callingList/v1 keep working exactly as before, so the app can be
 * switched back by changing one string if anything looks wrong.
 *
 * V2 does two things:
 *
 *   1. FILTERS Enquiry — drops anyone who has since booked or visited. Only
 *      Enquiry: the other five lists are patients who HAVE already been to the
 *      clinic, so that test would empty them.
 *
 *   2. FLAGS SurgeryOPD / MedicationOPD / TestOPD — marks patients who have
 *      since been operated. NOT dropped: the caller still wants to see them,
 *      and a patient advised surgery who then had it is a conversion worth
 *      knowing about mid-call, not a row to hide.
 *
 * ── WHY IT CALLS V1 RATHER THAN REPEATING ITS SQL ─────────────────────────
 * V1 runs twelve queries across five tables. Copying them would mean two
 * definitions of every category, and the copy would drift the first time one
 * is tuned. V2 calls V1 and post-processes, so a change to any category flows
 * through automatically and this block only ever owns the exclusion and the
 * flag.
 * ══════════════════════════════════════════════════════════════════════════ */

// Uid_no is issued at registration, so its presence means the patient turned up.
// Worth confirming once per branch:  SHOW COLUMNS FROM patient LIKE '%phone%';
const PATIENT_UID_COLUMN = "Uid_no";
const PATIENT_PHONE_COLUMN = "phone";

/**
 * true  — only appointments dated on or after the enquiry suppress it.
 * false — ANY appointment ever made against that number suppresses it.
 *
 * Default true: someone who came two years ago and enquires again today has a
 * NEW need and should still be called. With false, one old appointment
 * silently suppresses every future enquiry from that number, forever.
 */
const ONLY_APPOINTMENTS_AFTER_ENQUIRY = true;

/**
 * The three advice lists. A patient advised surgery, medication or a test and
 * then operated is worth flagging — the call still happens, but it is a
 * different conversation. PostOp and MCDPA are post-surgery flows already, and
 * Enquiry has no patient record yet.
 */
const OPERATED_CATEGORIES = ["SurgeryOPD", "MedicationOPD", "TestOPD"];

/**
 * Phone numbers are not stored consistently across tables — the same person is
 * '9876543210' in one and '+919876543210' or '09876543210' in another. A plain
 * `=` misses those, and a missed match means a booked patient stays on the
 * calling list, which is the whole problem being solved.
 *
 * REPLACE chain rather than REGEXP_REPLACE so this runs on MySQL 5.7 as well
 * as 8.0.
 */
const normPhoneSql = (col) => `
  RIGHT(
    REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col}, ''), ' ', ''), '-', ''), '+', ''), '(', ''),
    10
  )`;

/** The same rule in JS, for matching the SQL results back to the rows. */
const normPhoneV2 = (v) =>
  String(v ?? "")
    .replace(/\D/g, "")
    .slice(-10);

/** YYYY-MM-DD from whatever the driver hands back — Date object or string. */
const ymd = (v) => {
  if (!v) return "";
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
};

const queryPoolV2 = (pool, sql, params = []) =>
  new Promise((resolve, reject) => {
    pool.getConnection((err, tempCon) => {
      // Guard the release — .release() on an undefined connection throws inside
      // the callback and the promise never settles, so the request hangs until
      // the client times out instead of erroring.
      if (err) {
        if (tempCon) tempCon.release();
        return reject(err);
      }
      tempCon.query(sql, params, (error, rows) => {
        tempCon.release();
        if (error) return reject(error);
        resolve(rows);
      });
    });
  });

/**
 * For the phones actually on the list, returns the latest appointment date per
 * number and the set of numbers with a Uid_no.
 *
 * Scoped to those phones rather than an unbounded NOT EXISTS per row: on a
 * branch with a large appointment table that is the difference between a fast
 * response and a slow one.
 */
async function getConvertedPhones(connection, phones) {
  if (!phones.length) return { booked: new Map(), visited: new Set() };

  const placeholders = phones.map(() => "?").join(", ");

  const [appointments, patients] = await Promise.all([
    queryPoolV2(
      connection,
      `SELECT ${normPhoneSql("a.patient_phone")} AS phone,
              MAX(DATE(a.appointment_timestamp))  AS latest
         FROM appointment a
        WHERE ${normPhoneSql("a.patient_phone")} IN (${placeholders})
        GROUP BY phone`,
      phones,
    ),
    queryPoolV2(
      connection,
      `SELECT DISTINCT ${normPhoneSql(`p.${PATIENT_PHONE_COLUMN}`)} AS phone
         FROM patient p
        WHERE ${normPhoneSql(`p.${PATIENT_PHONE_COLUMN}`)} IN (${placeholders})
          AND p.${PATIENT_UID_COLUMN} IS NOT NULL
          AND TRIM(p.${PATIENT_UID_COLUMN}) <> ''`,
      phones,
    ),
  ]);

  const booked = new Map();
  for (const r of appointments) {
    if (r.phone) booked.set(String(r.phone), r.latest);
  }

  return {
    booked,
    visited: new Set(patients.map((r) => String(r.phone)).filter(Boolean)),
  };
}

/**
 * Which of these patients have been OPERATED, and when.
 *
 * An invoice IS the surgery record — there is no separate "operated" flag, and
 * this is the same test the surgery-pending report uses.
 *
 * Keyed on patient_id: these three lists come from the clinic's own tables and
 * already carry one, so the phone normalisation the Enquiry exclusion needs
 * does not apply here. A registered patient is a stronger match than a number
 * anyway — two family members share a phone often enough to matter.
 *
 * Both the first and last invoice dates are returned. The flag uses the LAST:
 * a patient may carry an older unrelated invoice from a previous episode, and
 * the question is whether ANY surgery followed this advice.
 */
async function getSurgeryDates(connection, patientIds) {
  if (!patientIds.length) return new Map();

  const placeholders = patientIds.map(() => "?").join(", ");

  const rows = await queryPoolV2(
    connection,
    `SELECT patient_id,
            MIN(DATE(creation_date)) AS firstOp,
            MAX(DATE(creation_date)) AS lastOp
       FROM invoice
      WHERE patient_id IN (${placeholders})
        AND is_deleted != 1
      GROUP BY patient_id`,
    patientIds,
  );

  const map = new Map();
  for (const r of rows) {
    if (r.patient_id != null) {
      map.set(String(r.patient_id), {
        first: ymd(r.firstOp) || null,
        last: ymd(r.lastOp) || null,
      });
    }
  }
  return map;
}

/**
 * getCallingListV2(req)
 *
 * Same signature and same response shape as getCallingListV1, plus:
 *   • Enquiry filtered
 *   • `operated` / `operatedOn` on every SurgeryOPD / MedicationOPD / TestOPD row
 *   • `_excludedEnquiries` — the dropped rows with a reason, so the fall in the
 *     Enquiry count can be explained without a second endpoint
 */
async function getCallingListV2(req) {
  const base = await getCallingListV1(req);

  const { connection } = getConnectionByLocation(req.query.location);
  if (!connection) {
    const err = new Error(`Invalid location: ${req.query.location}`);
    err.status = 404;
    throw err;
  }

  /* ── 1. Flag patients who have since been operated ──────────────────────
   * Runs FIRST and unconditionally. An early return on an empty Enquiry list
   * would otherwise skip the flagging entirely — the two features are
   * independent and a branch can easily have advice rows and no enquiries.
   */
  try {
    const ids = [
      ...new Set(
        OPERATED_CATEGORIES.flatMap((k) => base?.[k] || [])
          .map((r) => r.patient_id)
          .filter((v) => v != null)
          .map(String),
      ),
    ];

    const ops = await getSurgeryDates(connection, ids);

    for (const key of OPERATED_CATEGORIES) {
      base[key] = (base[key] || []).map((row) => {
        const op = ops.get(String(row.patient_id));
        const rowDate = ymd(row.date);

        // Strictly AFTER the visit that produced the advice. An OPD visit and
        // an IPD invoice can share a date — same-day admission — and `>=`
        // would flag rows where the invoice actually predates the advice.
        const operated = !!op?.last && !!rowDate && op.last > rowDate;

        return { ...row, operated, operatedOn: operated ? op.last : null };
      });
    }
  } catch (err) {
    // A failed lookup costs a highlight, not the list. Every row simply
    // renders unflagged.
    console.error("callingList V2: surgery lookup failed:", err.message);
  }

  /* ── 2. Drop enquiries that already converted ───────────────────────────── */

  const enquiries = base?.Enquiry || [];
  if (!enquiries.length) return { ...base, _excludedEnquiries: [] };

  // Deduplicated: one number may have enquired several times, and each extra
  // copy is a wasted placeholder in the IN list.
  const phones = [
    ...new Set(
      enquiries
        .map((e) => normPhoneV2(e.phone ?? e.patient_phone))
        .filter(Boolean),
    ),
  ];

  let booked;
  let visited;
  try {
    ({ booked, visited } = await getConvertedPhones(connection, phones));
  } catch (err) {
    // A failed exclusion lookup must not cost the whole calling list. Falling
    // back to the unfiltered array means a few already-booked patients get
    // called — annoying. Returning nothing means nobody gets called at all.
    console.error("callingList V2: exclusion lookup failed:", err.message);
    return { ...base, _excludedEnquiries: [], _exclusionFailed: true };
  }

  const kept = [];
  const dropped = [];

  for (const row of enquiries) {
    const phone = normPhoneV2(row.phone ?? row.patient_phone);
    if (!phone) {
      // No number means nothing to match on — keep it. A phone-less enquiry is
      // a data problem, not a conversion.
      kept.push(row);
      continue;
    }

    const hasVisited = visited.has(phone);

    const latest = booked.get(phone);
    const hasAppointment = latest
      ? !ONLY_APPOINTMENTS_AFTER_ENQUIRY || ymd(latest) >= ymd(row.date)
      : false;

    if (hasVisited || hasAppointment) {
      dropped.push({
        ...row,
        reason: hasAppointment
          ? "Already booked an appointment"
          : "Already visited (has Uid_no)",
      });
    } else {
      kept.push(row);
    }
  }

  return { ...base, Enquiry: kept, _excludedEnquiries: dropped };
}

module.exports = { getCallingList, getCallingListV1, getCallingListV2 };
