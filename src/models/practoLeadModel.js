// practoLeadsModel.js
// ─────────────────────────────────────────────────────────────────────────────
// Master-database writer for leads pushed by Practo's webhook.
//
// practoLeadsController.js calls savePractoLead(payload) once per delivery. The
// row lands in the master DB's `practo_leads` table (see practo_leads.sql) —
// the same DB that holds `appointments` (web leads), `chatbot_leads` (bot
// leads) and `hexa_leads`, reached through the project's existing connection
// factory:
//   getConnectionByLocation("lead")
//
// Practo sends these fields:
//   mobile, name, email, lead_Sourcesource, practice_city, practice_locality,
//   external_appointmentId, doctor_name, practice_name, appointment_time,
//   appointment_date, event_type
//
// Three things about that list drive this file:
//
//   • external_appointmentId is a real natural key — unlike Hexa, which gives
//     us nothing stable and forces a content hash. So dedup_key is
//     "p:" + external_appointmentId, and the sha256 fallback ("ph:") only
//     fires for a delivery that arrives without one. Every write is
//     INSERT … ON DUPLICATE KEY UPDATE on that key, so a Practo retry refreshes
//     the existing row instead of creating a second lead.
//
//   • event_type implies Practo reuses this webhook for more than new leads
//     (cancellation, reschedule). Because the key is the appointment id ALONE,
//     a later event updates the same row rather than adding another lead —
//     one row per appointment, event_type holding the most recent state. If you
//     ever want one row per event instead, add fields.event_type into
//     buildDedupKey's explicit branch.
//
//   • No country code field. mobile is normalised to a bare local number so it
//     lines up with appointment.patient_phone (what the lead→appointment sync
//     matches on); country_code stays NULL unless a payload carries one.
//
// NOTE: normalizeCountryCode / normalizePhone below are identical to the ones
// in hexaLeadsModel.js. Two copies means two places to fix a phone bug — if you
// want, lift both into a shared leadNormalizeUtils.js (same pattern as
// adviceUtils.js) and require it from both models. Kept self-contained here so
// this file drops in without touching the working Hexa path.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");
const { getConnectionByLocation } = require("../../databaseUtils");

// Connection key for the master DB in the shared connection factory.
const MASTER_DB_KEY = "lead";

const makeRunner =
  (connection) =>
  (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) =>
        err ? reject(err) : resolve(rows),
      ),
    );

// IST is a fixed +05:30 offset with no DST, so shifting by hand is exact and
// avoids depending on the host's timezone data. This stamps the row with our
// receipt time in IST — matching how the rest of this DB stores time.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function nowMySQLDateTimeIST() {
  return new Date(Date.now() + IST_OFFSET_MS)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

// Returns the first key that is present and non-empty. One extra alias per field
// absorbs minor casing/spelling drift without a code change; the name Practo
// actually documents is always listed first.
const pick = (obj, ...keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
};

const trim = (v, max) => (v == null ? null : String(v).trim().slice(0, max));

// countryCode as digits only: "+91" -> "91", "91 " -> "91".
function normalizeCountryCode(cc) {
  if (!cc) return null;
  const d = String(cc).replace(/\D/g, "");
  return d || null;
}

// mobile -> bare local number, comparable to appointment.patient_phone.
//
// Strip non-digits, then leading zeros, THEN a duplicated country code. A clean
// 10-digit number that happens to start with the country code digits
// (e.g. "9123456789" with cc "91") is left untouched.
function normalizePhone(mobileNo, countryCode) {
  if (!mobileNo) return null;
  let d = String(mobileNo).replace(/\D/g, "").replace(/^0+/, "");
  const cc = normalizeCountryCode(countryCode);
  if (cc && d.length > 10 && d.startsWith(cc)) {
    d = d.slice(cc.length);
  }
  return d || null;
}

// Practo's appointment_time arrives as "2026-04-23 11:45:00" — already MySQL
// shaped and already clinic-local, so it is taken literally. NO timezone shift:
// treating a local wall-clock time as UTC and adding 5:30 would push every
// appointment forward by five and a half hours.
//
// The ISO branch is a guard for the day Practo changes format on you — a value
// with a trailing Z or an explicit offset IS a real instant, so that one gets
// converted to IST.
function toMySQLDateTime(value) {
  if (!value) return null;
  const s = String(value).trim();

  // "YYYY-MM-DD HH:MM[:SS]" or "YYYY-MM-DDTHH:MM[:SS]" with no zone marker.
  const local = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/);
  if (local) return `${local[1]} ${local[2]}${local[3] || ":00"}`;

  // Date only.
  const dateOnly = s.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnly) return `${dateOnly[1]} 00:00:00`;

  // Anything else: parse as a real instant and render it in IST.
  const parsed = Date.parse(s);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed + IST_OFFSET_MS)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

// DATE half of a datetime, for the appointment_date column and its index.
function toMySQLDate(value) {
  const dt = toMySQLDateTime(value);
  return dt ? dt.slice(0, 10) : null;
}

// Map + normalise the documented Practo fields into the shape we store. Built
// once and used for BOTH the column values and the dedup hash, so the two can
// never drift apart.
//
// practice_city / practice_locality are stored as city_name / area_name to match
// hexa_leads — it keeps a cross-source UNION or a shared reporting screen from
// needing per-table column aliases. Rename here if you'd rather the columns read
// exactly as Practo names them.
function mapFields(payload) {
  const country_code = normalizeCountryCode(
    pick(payload, "country_code", "countryCode", "dialCode"),
  );
  const phoneno = normalizePhone(
    pick(payload, "mobile", "mobileNo", "phone", "phoneno", "mobile_number"),
    country_code,
  );

  const appointment_datetime =
    toMySQLDateTime(pick(payload, "appointment_time", "appointmentTime")) ||
    toMySQLDateTime(pick(payload, "appointment_date", "appointmentDate"));

  return {
    name: trim(pick(payload, "name", "fullName", "full_name"), 255),
    country_code,
    phoneno,
    email: trim(pick(payload, "email", "emailId", "email_id"), 255),
    city_name: trim(
      pick(payload, "practice_city", "practiceCity", "city"),
      120,
    ),
    area_name: trim(
      pick(payload, "practice_locality", "practiceLocality", "locality"),
      120,
    ),
    doctor_name: trim(pick(payload, "doctor_name", "doctorName"), 255),
    practice_name: trim(pick(payload, "practice_name", "practiceName"), 255),
    // Practo's own key is "lead_Sourcesource" — the run-together spelling is
    // theirs, not a typo here. Aliases cover the day they fix it.
    source:
      trim(
        pick(
          payload,
          "lead_Sourcesource",
          "lead_source",
          "leadSource",
          "source",
        ),
        60,
      ) || "Practo",
    event_type: trim(pick(payload, "event_type", "eventType"), 60),
    external_appointment_id: trim(
      pick(
        payload,
        "external_appointmentId",
        "external_appointment_id",
        "externalAppointmentId",
        "appointmentId",
      ),
      180,
    ),
    appointment_datetime,
    appointment_date:
      toMySQLDate(pick(payload, "appointment_date", "appointmentDate")) ||
      (appointment_datetime ? appointment_datetime.slice(0, 10) : null),
  };
}

// dedup_key: Practo's appointment id is a genuine identifier, so it is used
// directly — strictly better than a content hash, and stable across a
// reschedule (which is what we want: the same appointment, updated).
//
// The phone number is folded in as a safety net. If Practo ever reuses an
// appointment id across two different patients (or a test payload ships with a
// placeholder id), we want two rows rather than one patient's lead silently
// overwriting another's — a duplicate lead costs one extra call, an overwritten
// lead is invisible and lost. A genuine retry or reschedule carries the same
// phone, so it still resolves to the same key and still updates in place.
//
// The trade-off: a Practo correction that FIXES a mistyped phone number lands as
// a second row instead of updating the first. Watch for that if their payloads
// turn out to be correctable.
//
// The hash branch only runs for a delivery with no appointment id. It leaves out
// appointment_datetime and event_type deliberately, so a reschedule of an
// id-less lead still resolves to the same person rather than a new row.
function buildDedupKey(payload, fields) {
  if (fields.external_appointment_id) {
    return "p:" + fields.external_appointment_id + "|" + (fields.phoneno || "");
  }

  const canonical = [
    fields.name,
    fields.country_code,
    fields.phoneno,
    fields.email,
    fields.city_name,
    fields.area_name,
    fields.doctor_name,
    fields.practice_name,
  ]
    .map((v) => (v == null ? "" : String(v).trim().toLowerCase()))
    .join("\u0001");

  return "ph:" + crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * savePractoLead(payload)
 * Writes one Practo lead into the master DB. Safe to call repeatedly with the
 * same payload — a repeat updates the existing row rather than duplicating it.
 *
 * Returns { dedupKey, id, inserted, receivedCount }.
 * Throws with .status = 400 for an unusable payload (Practo should NOT retry),
 *        with .status = 500 for an infra failure (Practo SHOULD retry).
 */
async function savePractoLead(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const err = new Error("Practo webhook: payload must be a JSON object");
    err.status = 400;
    throw err;
  }

  const fields = mapFields(payload);

  // A lead with no way to reach the person is not actionable — reject it rather
  // than quietly pile up junk rows.
  if (!fields.phoneno && !fields.email) {
    const err = new Error(
      "Practo webhook: payload has neither a phone number nor an email",
    );
    err.status = 400;
    throw err;
  }

  const { connection } = getConnectionByLocation(MASTER_DB_KEY);
  if (!connection) {
    const err = new Error(`No connection for "${MASTER_DB_KEY}" (master) DB`);
    err.status = 500;
    throw err;
  }

  const dedupKey = buildDedupKey(payload, fields);
  const leadDatetime = nowMySQLDateTimeIST();
  const rawPayload = JSON.stringify(payload);

  const run = makeRunner(connection);

  // ON DUPLICATE KEY UPDATE is the whole idempotency story.
  //
  // Note what is NOT updated: status, note, lead_datetime, received_count-reset.
  // Once your team works a lead (status -> 'Appointment', a note added), a
  // Practo retry must not undo that. received_count ticks up so you can see the
  // retry; everything Practo actually sends is refreshed from the newer copy —
  // which is also how a reschedule moves appointment_datetime forward.
  const result = await run(
    `INSERT INTO practo_leads
       (name, country_code, phoneno, email, city_name, area_name,
        doctor_name, practice_name, source, event_type,
        external_appointment_id, appointment_datetime, appointment_date,
        dedup_key, lead_datetime, raw_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name                    = VALUES(name),
       country_code            = VALUES(country_code),
       phoneno                 = VALUES(phoneno),
       email                   = VALUES(email),
       city_name               = VALUES(city_name),
       area_name               = VALUES(area_name),
       doctor_name             = VALUES(doctor_name),
       practice_name           = VALUES(practice_name),
       source                  = VALUES(source),
       event_type              = VALUES(event_type),
       external_appointment_id = VALUES(external_appointment_id),
       appointment_datetime    = VALUES(appointment_datetime),
       appointment_date        = VALUES(appointment_date),
       raw_payload             = VALUES(raw_payload),
       received_count          = received_count + 1`,
    [
      fields.name,
      fields.country_code,
      fields.phoneno,
      fields.email,
      fields.city_name,
      fields.area_name,
      fields.doctor_name,
      fields.practice_name,
      fields.source,
      fields.event_type,
      fields.external_appointment_id,
      fields.appointment_datetime,
      fields.appointment_date,
      dedupKey,
      leadDatetime,
      rawPayload,
    ],
  );

  // mysql reports affectedRows = 1 for a fresh insert and 2 for an ON DUPLICATE
  // update. Only 1 is a genuinely new lead.
  const inserted = result.affectedRows === 1;

  // insertId is only meaningful on a fresh insert; on an update we read the id
  // back via the dedup_key.
  let id = inserted ? result.insertId : null;
  let receivedCount = 1;
  if (!inserted) {
    const rows = await run(
      `SELECT id, received_count FROM practo_leads WHERE dedup_key = ? LIMIT 1`,
      [dedupKey],
    );
    if (rows && rows[0]) {
      id = rows[0].id;
      receivedCount = rows[0].received_count;
    }
  }

  console.log(
    `✅ Practo lead ${inserted ? "inserted" : `already seen (x${receivedCount}) → updated`}: ` +
      `${fields.city_name || "no city"} / ${fields.phoneno || fields.email || "no contact"} ` +
      `/ ${fields.event_type || "no event type"}`,
  );

  return { dedupKey, id, inserted, receivedCount };
}

module.exports = {
  savePractoLead,
  // exported for reuse/tests
  normalizePhone,
  normalizeCountryCode,
  toMySQLDateTime,
  mapFields,
};
