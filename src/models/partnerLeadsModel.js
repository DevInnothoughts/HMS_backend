/**
 * partnerLeadsModel.js
 * ---------------------------------------------------------------------------
 * Sulekha + Hexa leads, normalised into ONE list shaped like the response
 * getDatewiseLeads returns, so the leads screen can be reused unchanged.
 *
 * Both tables live in hhc_appointments (the "lead" connection), same as
 * `appointments` and `chatbot_leads`.
 *
 *   sulekha_leads : lead_id, user_name, user_mobile, user_email, user_city,
 *                   status, note, created_at
 *   hexa_leads    : id, name, country_code, phoneno, email, gender,
 *                   procedure_name, medical_condition, department, city_name,
 *                   note, lead_datetime
 *
 * ── Two structural differences from web/bot leads, worth knowing ────────────
 *
 * 1. NO BRANCH COLUMN. `appointments` has selected_area and `chatbot_leads`
 *    has branch, which is how those reports scope to a location. Neither
 *    partner table has one — only a free-text city. So this model does NOT
 *    filter by branch. Every branch sees every partner lead. Visit/IPD
 *    matching still runs against the clinic DB of the requested `location`,
 *    which means a lead that walked into a different branch will show as
 *    un-converted here. If you need true per-branch scoping, the tables need
 *    a branch column — city text won't do it reliably.
 *
 * 2. HEXA HAS NO STATUS COLUMN. Sulekha does. Hexa rows are therefore
 *    reported with status = null, i.e. they all land in "Un-Attended" and
 *    none can ever be "Appointment" or "Enquiry". The Appointment / Visited /
 *    IPD counts below are derived from the clinic DB instead of the status
 *    column, so they DO work for Hexa — but the status chips will look
 *    lopsided until a status column is added to hexa_leads.
 *
 * ── Response ────────────────────────────────────────────────────────────────
 *   {
 *     totalLeads, appointmentCount, actualVisitCount, ipdCount,
 *     sourceCounts: { sulekha, hexa },
 *     leads: [ ...unified rows... ],
 *     appointmentLeads, visitedLeads, ipdLeads
 *   }
 *
 * Each unified row carries `source` ('Sulekha' | 'Hexa') — that's the field
 * the screen uses for its badge and its source filter.
 *
 * Usage:
 *   GET /leadManagement/partnerLeads?location=Baner&from=2026-08-01&to=2026-08-14
 *   GET /leadManagement/partnerLeads?...&source=sulekha      (optional)
 * ---------------------------------------------------------------------------
 */

const util = require("util");
const { getConnectionByLocation } = require("../../databaseUtils");

/* ── helpers ──────────────────────────────────────────────────────────────── */

// Same normalisation the web/bot lead models use, so phones match across DBs.
const normPhone = (v) =>
  String(v ?? "")
    .replace(/\D/g, "")
    .replace(/^(91|0)/, "");

const clean = (v) => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};

/* ── fetch + normalise ────────────────────────────────────────────────────── */

async function fetchSulekha(query, from, to) {
  const rows = await query(
    `SELECT lead_id, user_name, user_mobile, user_email, user_city,
            status, note, created_at
       FROM sulekha_leads
      WHERE DATE(created_at) BETWEEN ? AND ?
      ORDER BY created_at DESC`,
    [from, to],
  );

  return rows.map((r) => ({
    // Prefixed so Sulekha 101 and Hexa 101 can't collide as React keys or
    // in any downstream Set/Map keyed on the id.
    lead_key: `SLK-${r.lead_id}`,
    appointment_id: r.lead_id,
    source: "Sulekha",
    name: clean(r.user_name),
    phoneno: clean(r.user_mobile),
    email: clean(r.user_email),
    city: clean(r.user_city),
    status: clean(r.status),
    note: clean(r.note),
    date: r.created_at,
    // Hexa-only fields, present as null so the row shape is uniform.
    gender: null,
    procedure_name: null,
    medical_condition: null,
    department: null,
    _phone: normPhone(r.user_mobile),
  }));
}

async function fetchHexa(query, from, to) {
  const rows = await query(
    `SELECT id, name, country_code, phoneno, email, gender,
            procedure_name, medical_condition, department, city_name,
            note, lead_datetime
       FROM hexa_leads
      WHERE DATE(lead_datetime) BETWEEN ? AND ?
      ORDER BY lead_datetime DESC`,
    [from, to],
  );

  return rows.map((r) => ({
    lead_key: `HEX-${r.id}`,
    appointment_id: r.id,
    source: "Hexa",
    name: clean(r.name),
    // Keep the dialable number whole; _phone below is the match key.
    phoneno: clean(
      r.country_code ? `${r.country_code}${r.phoneno}` : r.phoneno,
    ),
    email: clean(r.email),
    city: clean(r.city_name),
    // hexa_leads has no status column — see header note.
    status: null,
    note: clean(r.note),
    date: r.lead_datetime,
    gender: clean(r.gender),
    procedure_name: clean(r.procedure_name),
    medical_condition: clean(r.medical_condition),
    department: clean(r.department),
    _phone: normPhone(r.phoneno),
  }));
}

/* ── clinic-side conversion lookup ────────────────────────────────────────── */

/**
 * Same two-phase test as leadManagementModel: a confirmed NEW appointment is a
 * visit; a visit with an invoice is an IPD conversion. Kept identical so the
 * numbers reconcile with the web/bot lead screens.
 */
async function getConversions(clinicDB, phones, from, to) {
  const empty = {
    visitedLeads: [],
    ipdLeads: [],
    visitedPhones: new Set(),
    ipdPhones: new Set(),
  };
  if (!phones.length) return empty;

  const clinicQuery = util.promisify(clinicDB.query).bind(clinicDB);
  const placeholders = phones.map(() => "patient_phone = ?").join(" OR ");

  const visitResults = await clinicQuery(
    `SELECT patient_id, patient_phone
       FROM appointment
      WHERE (${placeholders})
        AND appointment_timestamp BETWEEN ? AND ?
        AND confirm_time != 0
        AND patient_type = 'New'`,
    [...phones, from, to],
  );

  if (!visitResults.length) return empty;

  const patientIds = visitResults.map((r) => r.patient_id);
  const invoiceResults = await clinicQuery(
    `SELECT DISTINCT i.patient_id, p.phone AS patient_phone
       FROM invoice AS i
       LEFT JOIN patient AS p ON p.patient_id = i.patient_id
      WHERE i.patient_id IN (${patientIds.map(() => "?").join(",")})`,
    patientIds,
  );

  return {
    visitedLeads: visitResults,
    ipdLeads: invoiceResults,
    visitedPhones: new Set(visitResults.map((r) => normPhone(r.patient_phone))),
    ipdPhones: new Set(invoiceResults.map((r) => normPhone(r.patient_phone))),
  };
}

/* ── main ─────────────────────────────────────────────────────────────────── */

/**
 * @param {string} location  branch key — used only for the clinic-DB lookup
 * @param {string} fromDate  YYYY-MM-DD
 * @param {string} toDate    YYYY-MM-DD
 * @param {string} [source]  'sulekha' | 'hexa' | undefined (both)
 */
async function getPartnerLeads(location, fromDate, toDate, source) {
  const { connection: leadDB } = getConnectionByLocation("lead");
  const { connection: clinicDB } = getConnectionByLocation(location);

  if (!leadDB || !clinicDB) {
    const err = new Error("Invalid location: " + location);
    err.status = 404;
    throw err;
  }

  const wanted = String(source || "").toLowerCase();

  return new Promise((resolve, reject) => {
    leadDB.getConnection(async (err, tempCon) => {
      if (err) return reject(err);

      try {
        const query = util.promisify(tempCon.query).bind(tempCon);

        const [sulekha, hexa] = await Promise.all([
          wanted === "hexa" ? [] : fetchSulekha(query, fromDate, toDate),
          wanted === "sulekha" ? [] : fetchHexa(query, fromDate, toDate),
        ]);

        tempCon.release();

        // Deduplicate WITHIN each source only. The same person enquiring on
        // both Sulekha and Hexa is two partner leads and both should be
        // visible — collapsing them would hide one partner's volume.
        const dedupe = (rows) => {
          const seen = new Set();
          return rows.filter((r) => {
            if (!r._phone) return true; // keep phone-less rows rather than drop
            if (seen.has(r._phone)) return false;
            seen.add(r._phone);
            return true;
          });
        };

        const allLeads = [...dedupe(sulekha), ...dedupe(hexa)].sort(
          (a, b) => new Date(b.date) - new Date(a.date),
        );

        const phones = [
          ...new Set(allLeads.map((l) => l._phone).filter(Boolean)),
        ];

        const { visitedLeads, ipdLeads, visitedPhones, ipdPhones } =
          await getConversions(clinicDB, phones, fromDate, toDate);

        // Flag each lead so the screen can filter without re-deriving.
        for (const lead of allLeads) {
          lead.visited = visitedPhones.has(lead._phone);
          lead.ipd = ipdPhones.has(lead._phone);
        }

        // Sulekha's own status column is authoritative where it exists;
        // Hexa has none, so a confirmed clinic visit is the only signal.
        const appointmentLeads = allLeads.filter(
          (l) => l.status === "Appointment" || l.visited,
        );

        resolve({
          totalLeads: allLeads.length,
          appointmentCount: appointmentLeads.length,
          actualVisitCount: visitedLeads.length,
          ipdCount: ipdLeads.length,
          sourceCounts: {
            sulekha: allLeads.filter((l) => l.source === "Sulekha").length,
            hexa: allLeads.filter((l) => l.source === "Hexa").length,
          },
          appointmentLeads,
          visitedLeads,
          ipdLeads,
          leads: allLeads,
        });
      } catch (e) {
        try {
          tempCon.release();
        } catch (_) {
          /* already released */
        }
        reject(e);
      }
    });
  });
}

module.exports = { getPartnerLeads };
