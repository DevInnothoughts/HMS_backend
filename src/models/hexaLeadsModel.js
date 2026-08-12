// hexaLeadModel.js
// ─────────────────────────────────────────────────────────────────────────────
// Master-database writer for leads pushed by Hexa's webhook.
//
// hexaLeadController.js calls saveHexaLead(payload) once per delivery. The row
// lands in the master DB's `hexa_leads` table (see hexa_leads.sql) — the same
// DB that holds `appointments` (web leads) and `chatbot_leads` (bot leads),
// reached through the project's existing connection factory:
//   getConnectionByLocation("lead")
//
// Hexa sends these fields, and nothing else documented:
//   name, mobileNo, countryCode, email, gender, procedure, condition,
//   department, cityName, query
//
// Two consequences of that list drive this file:
//
//   • No id, no timestamp. There's no natural key to recognise a retried
//     delivery. So we build one: dedup_key = Hexa's own id IF the live payload
//     happens to carry one, else "h:" + sha256(business fields). Every write is
//     INSERT … ON DUPLICATE KEY UPDATE on that key, so a retry refreshes the
//     existing row instead of creating a second lead. Without it, one Hexa
//     timeout = one patient called twice.
//
//   • mobileNo and countryCode arrive separately. phoneno is normalised to a
//     bare local number so it lines up with appointment.patient_phone (what the
//     lead→appointment sync matches on); the country code is kept in its own
//     column.
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
// avoids depending on the host's timezone data. Hexa gives us no lead time, so
// this stamps the row with our receipt time in IST — matching how the rest of
// this DB stores time.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function nowMySQLDateTimeIST() {
  return new Date(Date.now() + IST_OFFSET_MS)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

// Returns the first key that is present and non-empty. One extra alias per field
// absorbs minor casing/spelling drift without a code change; the documented name
// is always listed first.
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

// mobileNo -> bare local number, comparable to appointment.patient_phone.
//
// Order matters: strip non-digits, then leading zeros, THEN a duplicated country
// code. Because countryCode arrives in its own field, mobileNo is usually
// already the 10-digit local number — so we only strip the country code when it
// is actually duplicated inside mobileNo AND doing so still leaves a plausible
// local number. A clean 10-digit number that happens to start with the country
// code digits (e.g. "9123456789" with cc "91") is left untouched.
function normalizePhone(mobileNo, countryCode) {
  if (!mobileNo) return null;
  let d = String(mobileNo).replace(/\D/g, "").replace(/^0+/, "");
  const cc = normalizeCountryCode(countryCode);
  if (cc && d.length > 10 && d.startsWith(cc)) {
    d = d.slice(cc.length);
  }
  return d || null;
}

// Map + normalise the documented Hexa fields into the shape we store. Built once
// and used for BOTH the column values and the dedup hash, so the two can never
// drift apart.
function mapFields(payload) {
  const country_code = normalizeCountryCode(
    pick(payload, "countryCode", "country_code", "dialCode"),
  );
  const phoneno = normalizePhone(
    pick(payload, "mobileNo", "mobile", "phone", "phoneno", "mobile_number"),
    country_code,
  );
  return {
    name: trim(pick(payload, "name", "fullName", "full_name"), 255),
    country_code,
    phoneno,
    email: trim(pick(payload, "email", "emailId", "email_id"), 255),
    gender: trim(pick(payload, "gender", "sex"), 20),
    procedure_name: trim(pick(payload, "procedure", "procedureName"), 255),
    medical_condition: trim(pick(payload, "condition", "ailment"), 255),
    department: trim(pick(payload, "department", "dept"), 255),
    city_name: trim(pick(payload, "cityName", "city", "city_name"), 120),
    message: trim(
      pick(payload, "query", "message", "comments", "remarks"),
      4000,
    ),
  };
}

// dedup_key: prefer an explicit id if the live payload has one (strictly better
// than a content hash); otherwise hash the business fields. Lowercased+joined in
// a fixed order so key order / casing in the JSON can't change the result — a
// byte-identical retry always lands on the same key.
function buildDedupKey(payload, fields) {
  const explicit = pick(payload, "leadId", "lead_id", "id", "hexaLeadId");
  if (explicit) return "id:" + String(explicit).trim().slice(0, 180);

  const canonical = [
    fields.name,
    fields.country_code,
    fields.phoneno,
    fields.email,
    fields.gender,
    fields.procedure_name,
    fields.medical_condition,
    fields.department,
    fields.city_name,
    fields.message,
  ]
    .map((v) => (v == null ? "" : String(v).trim().toLowerCase()))
    .join("\u0001");

  return "h:" + crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * saveHexaLead(payload)
 * Writes one Hexa lead into the master DB. Safe to call repeatedly with the same
 * payload — a repeat updates the existing row rather than duplicating it.
 *
 * Returns { dedupKey, id, inserted, receivedCount }.
 * Throws with .status = 400 for an unusable payload (Hexa should NOT retry),
 *        with .status = 500 for an infra failure (Hexa SHOULD retry).
 */
async function saveHexaLead(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const err = new Error("Hexa webhook: payload must be a JSON object");
    err.status = 400;
    throw err;
  }

  const fields = mapFields(payload);

  // A lead with no way to reach the person is not actionable — reject it rather
  // than quietly pile up junk rows.
  if (!fields.phoneno && !fields.email) {
    const err = new Error(
      "Hexa webhook: payload has neither a phone number nor an email",
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
  // Once your team works a lead (status -> 'Appointment', a note added), a Hexa
  // retry must not undo that. received_count ticks up so you can see the retry;
  // everything Hexa actually sends is refreshed from the newer copy.
  const result = await run(
    `INSERT INTO hexa_leads
       (name, country_code, phoneno, email, gender, procedure_name,
        medical_condition, department, city_name, message,
        dedup_key, lead_datetime, raw_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name              = VALUES(name),
       country_code      = VALUES(country_code),
       phoneno           = VALUES(phoneno),
       email             = VALUES(email),
       gender            = VALUES(gender),
       procedure_name    = VALUES(procedure_name),
       medical_condition = VALUES(medical_condition),
       department        = VALUES(department),
       city_name         = VALUES(city_name),
       message           = VALUES(message),
       raw_payload       = VALUES(raw_payload),
       received_count    = received_count + 1`,
    [
      fields.name,
      fields.country_code,
      fields.phoneno,
      fields.email,
      fields.gender,
      fields.procedure_name,
      fields.medical_condition,
      fields.department,
      fields.city_name,
      fields.message,
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
      `SELECT id, received_count FROM hexa_leads WHERE dedup_key = ? LIMIT 1`,
      [dedupKey],
    );
    if (rows && rows[0]) {
      id = rows[0].id;
      receivedCount = rows[0].received_count;
    }
  }

  console.log(
    `✅ Hexa lead ${inserted ? "inserted" : `already seen (x${receivedCount}) → updated`}: ` +
      `${fields.city_name || "no city"} / ${fields.phoneno || fields.email || "no contact"}`,
  );

  return { dedupKey, id, inserted, receivedCount };
}

module.exports = {
  saveHexaLead,
  // exported for reuse/tests
  normalizePhone,
  normalizeCountryCode,
  mapFields,
};
