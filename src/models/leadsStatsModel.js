const util = require("util");
const { getConnectionByLocation } = require("../../databaseUtils");

// ─── Location alias map ───────────────────────────────────────────────────────
const LOCATION_ALIASES = {
  "DP Road": ["DP Road", "Tilak Road", "Dhole Patil Road"],
  "Salunke Vihar": ["Salunke Vihar", "Salunkhe Vihar", "Wanowrie"],
  Hinjewadi: ["Hinjewadi", "Hinjawadi"],
  "JP Nagar": ["JP Nagar"], // + exact 'Bengaluru' handled below
  Sarjapura: ["Sarjapura", "Sarjapur"],
  "Rajaji Nagar": ["Rajaji Nagar", "Rajajinagar"],
  Belgavi: ["Belgavi", "Belagavi"],
  "Sahakar Nagar": ["Sahakar Nagar", "Sahakarnagar"],
  "Gurgaon Sector 14": [
    "Gurgaon Sector 14",
    "Gurugram - Sector 14",
    "Gurgaon Sector - 14",
  ],
  "Gurgaon Sector 49": [
    "Gurgaon Sector 49",
    "Gurugram - Sector 49",
    "Gurgaon Sector - 49",
  ],
  Thane: ["Thane", "Kapurbawdi"],
  HSR: ["HSR", "HSR Layout"],
  Hyderabad: ["Hyderabad", "Jubilee Hills"],
  Chinchwad: ["Chinchwad", "Pimpri-Chinchwad"],
  Andheri: ["Andheri", "Andheri West", "Andheri East"],
  Baner: ["Baner", "Baner Road"],
  Chakan: ["Chakan"],
  Dighi: ["Dighi"],
  Indiranagar: ["Indiranagar", "Indira Nagar"],
  Kalaburagi: ["Kalaburagi", "Gulbarga"],
  Latur: ["Latur"],
  Ludhiana: ["Ludhiana"],
  Lucknow: ["Lucknow"],
  Mysore: ["Mysore", "Mysuru"],
  Nashik: ["Nashik", "Nasik"],
  "Navi Mumbai": ["Navi Mumbai", "Navi-Mumbai"],
  Secunderabad: ["Secunderabad"],
  Surat: ["Surat"],
  Undri: ["Undri"],
  Vashi: ["Vashi"],
  Katraj: ["Katraj"],
  Ahmedabad: ["Ahmedabad"],
  Mohali: ["Mohali"],
  Aurangabad: ["Aurangabad"],
  Whitefield: ["Whitefield"],
  Hadapsar: ["Hadapsar"],
  Kalyan: ["Kalyan"],
};

const ALL_LOCATIONS = Object.keys(LOCATION_ALIASES);

// ─── WHERE clause builders ────────────────────────────────────────────────────

function buildAreaWhere(location) {
  const aliases = LOCATION_ALIASES[location] || [location];
  const conditions = aliases.map(
    () => `selected_area LIKE CONCAT('%', ?, '%')`,
  );
  const params = [...aliases];

  if (location === "JP Nagar") {
    conditions.push(`selected_area = ?`);
    params.push("Bengaluru");
  }

  return { whereClause: `(${conditions.join(" OR ")})`, params };
}

function buildBranchWhere(location) {
  if (location === "Vashi") {
    return {
      whereClause: `(branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%') OR (branch = '' AND chat_whatsapp_branch = ''))`,
      params: [location, location],
    };
  }

  const aliases = LOCATION_ALIASES[location] || [location];
  const conditions = [];
  const params = [];

  aliases.forEach((alias) => {
    conditions.push(
      `(branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%'))`,
    );
    params.push(alias, alias);
  });

  return { whereClause: `(${conditions.join(" OR ")})`, params };
}

// ─── IPD count helper (shared by web + bot) ──────────────────────────────────
// Takes appointment phone numbers, queries clinic DB for confirmed new visits,
// then checks invoices. Returns { actualVisitCount, ipdCount }.

async function getIpdCount(clinicDB, appointmentPhones, fromDate, toDate) {
  if (!appointmentPhones || appointmentPhones.length === 0) {
    return { actualVisitCount: 0, ipdCount: 0 };
  }

  const clinicQuery = util.promisify(clinicDB.query).bind(clinicDB);

  // Phase 1: confirmed new visits within date range
  const phonePlaceholders = appointmentPhones
    .map(() => `patient_phone = ?`)
    .join(" OR ");

  const visitResults = await clinicQuery(
    `SELECT patient_id, patient_phone
     FROM appointment
     WHERE (${phonePlaceholders})
       AND appointment_timestamp BETWEEN ? AND ?
       AND confirm_time != 0
       AND patient_type = 'New'`,
    [...appointmentPhones, fromDate, toDate],
  );

  if (visitResults.length === 0) {
    return { actualVisitCount: 0, ipdCount: 0 };
  }

  // Phase 2: check invoices for those patient_ids
  const patientIds = visitResults.map((r) => r.patient_id);
  const invoicePlaceholders = patientIds.map(() => "?").join(",");

  const invoiceResults = await clinicQuery(
    `SELECT DISTINCT i.patient_id, p.phone AS patient_phone
     FROM invoice AS i
     LEFT JOIN patient AS p ON p.patient_id = i.patient_id
     WHERE i.patient_id IN (${invoicePlaceholders})`,
    patientIds,
  );

  return {
    actualVisitCount: visitResults.length,
    ipdCount: invoiceResults.length,
  };
}

// ─── Web leads stats for one location ────────────────────────────────────────

async function getWebLeadsCount(location, fromDate, toDate) {
  const { connection: leadDB } = getConnectionByLocation("lead");
  const { connection: clinicDB } = getConnectionByLocation(location);

  if (!leadDB || !clinicDB) {
    const err = new Error(`Invalid location: ${location}`);
    err.status = 404;
    throw err;
  }

  const { whereClause, params } = buildAreaWhere(location);

  const dateFrom = `${fromDate}T00:00:00+05:30`;
  const dateTo = `${toDate}T23:59:59+05:30`;

  return new Promise((resolve, reject) => {
    leadDB.getConnection(async (err, tempCon) => {
      if (err) return reject(err);

      try {
        const query = util.promisify(tempCon.query).bind(tempCon);

        // Fetch all leads in date range (deduplicated by phone)
        const rows = await query(
          `SELECT appointment_id, phoneno, status
           FROM appointments
           WHERE ${whereClause}
             AND date BETWEEN ? AND ?
           ORDER BY appointment_id DESC`,
          [...params, dateFrom, dateTo],
        );

        tempCon.release();

        // Deduplicate by normalised phone
        const seen = new Set();
        const allLeads = [];
        for (const row of rows) {
          const phone = row.phoneno?.replace(/^(\+91|91|0)/, "") || "";
          if (!seen.has(phone)) {
            seen.add(phone);
            allLeads.push({ ...row, _normPhone: phone });
          }
        }

        const total = allLeads.length;
        const appointments = allLeads.filter((l) => l.status === "Appointment");
        const appointmentPhones = appointments.map((a) => a._normPhone);

        const { actualVisitCount, ipdCount } = await getIpdCount(
          clinicDB,
          appointmentPhones,
          fromDate,
          toDate,
        );

        resolve({
          total,
          appointment: appointments.length,
          actualVisitCount,
          ipd: ipdCount,
        });
      } catch (e) {
        tempCon.release();
        reject(e);
      }
    });
  });
}

// ─── Chatbot leads stats for one location ────────────────────────────────────

async function getChatbotLeadsCount(location, fromDate, toDate) {
  const { connection: leadDB } = getConnectionByLocation("lead");
  const { connection: clinicDB } = getConnectionByLocation(location);

  if (!leadDB || !clinicDB) {
    const err = new Error(`Invalid location: ${location}`);
    err.status = 404;
    throw err;
  }

  const { whereClause, params } = buildBranchWhere(location);

  const dateFrom = `${fromDate}T00:00:00+05:30`;
  const dateTo = `${toDate}T23:59:59+05:30`;

  return new Promise((resolve, reject) => {
    leadDB.getConnection(async (err, tempCon) => {
      if (err) return reject(err);

      try {
        const query = util.promisify(tempCon.query).bind(tempCon);

        const rows = await query(
          `SELECT id AS appointment_id, contact AS phoneno, status
           FROM chatbot_leads
           WHERE ${whereClause}
             AND DATE(datetime) BETWEEN ? AND ?
           ORDER BY id DESC`,
          [...params, dateFrom, dateTo],
        );

        tempCon.release();

        // Deduplicate by normalised phone
        const seen = new Set();
        const allLeads = [];
        for (const row of rows) {
          const phone = row.phoneno?.replace(/^(\+91|91|0)/, "") || "";
          if (!seen.has(phone)) {
            seen.add(phone);
            allLeads.push({ ...row, _normPhone: phone });
          }
        }

        const total = allLeads.length;
        const appointments = allLeads.filter((l) => l.status === "Appointment");
        const appointmentPhones = appointments.map((a) => a._normPhone);

        const { actualVisitCount, ipdCount } = await getIpdCount(
          clinicDB,
          appointmentPhones,
          fromDate,
          toDate,
        );

        resolve({
          total,
          appointment: appointments.length,
          actualVisitCount,
          ipd: ipdCount,
        });
      } catch (e) {
        tempCon.release();
        reject(e);
      }
    });
  });
}

// ─── Combined stats for one location ─────────────────────────────────────────

async function getLocationStats(location, fromDate, toDate) {
  // ✅ Fix
  const [web, chatbot, ivr] = await Promise.all([
    getWebLeadsCount(location, fromDate, toDate),
    getChatbotLeadsCount(location, fromDate, toDate),
    getIVRLeadsCount(location, fromDate, toDate),
  ]);

  return {
    location,
    web,
    chatbot,
    ivr,
    combined: {
      total: web.total + chatbot.total + ivr.total,
      appointment: web.appointment + chatbot.appointment + ivr.appointment,
      actualVisitCount:
        web.actualVisitCount + chatbot.actualVisitCount + ivr.actualVisitCount,
      ipd: web.ipd + chatbot.ipd + ivr.ipd,
    },
  };
}

// ─── IPD count helper (same logic as web/bot leads) ──────────────────────────

async function getIpdCount(clinicDB, callerPhones, fromDate, toDate) {
  if (!callerPhones || callerPhones.length === 0) {
    return { actualVisitCount: 0, ipdCount: 0 };
  }

  const clinicQuery = util.promisify(clinicDB.query).bind(clinicDB);

  // Phase 1: confirmed new visits within date range
  const phonePlaceholders = callerPhones
    .map(() => `patient_phone = ?`)
    .join(" OR ");

  const visitResults = await clinicQuery(
    `SELECT patient_id, patient_phone
     FROM appointment
     WHERE (${phonePlaceholders})
       AND appointment_timestamp BETWEEN ? AND ?
       AND confirm_time != 0
       AND patient_type = 'New'`,
    [...callerPhones, fromDate, toDate],
  );

  if (visitResults.length === 0) {
    return { actualVisitCount: 0, ipdCount: 0 };
  }

  // Phase 2: check invoices for those patient_ids
  const patientIds = visitResults.map((r) => r.patient_id);
  const invoicePlaceholders = patientIds.map(() => "?").join(",");

  const invoiceResults = await clinicQuery(
    `SELECT DISTINCT i.patient_id, p.phone AS patient_phone
     FROM invoice AS i
     LEFT JOIN patient AS p ON p.patient_id = i.patient_id
     WHERE i.patient_id IN (${invoicePlaceholders})`,
    patientIds,
  );

  return {
    actualVisitCount: visitResults.length,
    ipdCount: invoiceResults.length,
  };
}

// ─── IVR leads stats for one location ────────────────────────────────────────

/**
 * Returns { total, appointment, actualVisitCount, ipd }
 * for IVR calls at a given location within a date range.
 *
 * call_date is stored as 'YYYY-DD-MM' so we use STR_TO_DATE('%Y-%d-%m') to filter.
 */
async function getIVRLeadsCount(location, fromDate, toDate) {
  const { connection: ivrDB } = getConnectionByLocation(location);
  const { connection: clinicDB } = getConnectionByLocation(location);

  if (!ivrDB || !clinicDB) {
    const err = new Error(`Invalid location: ${location}`);
    err.status = 404;
    throw err;
  }

  return new Promise((resolve, reject) => {
    ivrDB.getConnection(async (err, tempCon) => {
      if (err) return reject(err);

      try {
        const query = util.promisify(tempCon.query).bind(tempCon);

        // Fetch all IVR calls in date range
        const rows = await query(
          `SELECT ivr_id, caller_no
           FROM IVRdata
           WHERE STR_TO_DATE(call_date, '%Y-%d-%m') BETWEEN ? AND ?
             AND destination_no != ''
           ORDER BY ivr_id DESC`,
          [fromDate, toDate],
        );

        tempCon.release();

        // Deduplicate by normalised caller_no
        const seen = new Set();
        const allCalls = [];

        for (const row of rows) {
          const phone = row.caller_no?.replace(/^(\+91|91|0)/, "") || "";
          if (!seen.has(phone)) {
            seen.add(phone);
            allCalls.push({ ...row, _normPhone: phone });
          }
        }

        const total = allCalls.length;
        const callerPhones = allCalls.map((r) => r._normPhone);

        const { actualVisitCount, ipdCount } = await getIpdCount(
          clinicDB,
          callerPhones,
          fromDate,
          toDate,
        );

        resolve({
          total,
          appointment: actualVisitCount,
          actualVisitCount,
          ipd: ipdCount,
        });
      } catch (e) {
        tempCon.release();
        reject(e);
      }
    });
  });
}

// ─── All locations ────────────────────────────────────────────────────────────

async function getAllLocationsStats(fromDate, toDate) {
  const results = await Promise.all(
    ALL_LOCATIONS.map((loc) => getLocationStats(loc, fromDate, toDate)),
  );
  return results.sort((a, b) => a.location.localeCompare(b.location));
}

module.exports = {
  getWebLeadsCount,
  getChatbotLeadsCount,
  getLocationStats,
  getAllLocationsStats,
  getIVRLeadsCount,
};
