const { getConnectionByLocation } = require("../../databaseUtils");
const util = require("util");

function mapLocationToCity(inputLocation) {
  if (!inputLocation) return null;

  const location = inputLocation.trim().toLowerCase();

  const cityMap = {
    pune: ["dp road"],
    bangalore: ["indiranagar"],
    mumbai: ["andheri"],
    hyderabad: ["hyderabad"],
    nashik: ["nashik"],
    ludhiana: ["ludhiana"],
    mysore: ["mysore"],
    kalaburagi: ["kalaburagi"],
    surat: ["surat"],
    ahmedabad: ["ahmedabad"],
    mohali: ["mohali"],
    gurgaon: ["gurgaon sector 49"],
    lucknow: ["lucknow"],
    latur: ["latur"],
    belagavi: ["belagavi"],
    ahmedabad: ["ahmedabad"],
    mohali: ["mohali"],
  };

  for (const [city, locations] of Object.entries(cityMap)) {
    if (locations.includes(location)) {
      return city.charAt(0).toUpperCase() + city.slice(1);
    }
  }

  return inputLocation; // no match found
}

async function getDatewiseReferredPatients(location, fromDate, toDate, role) {
  const { connection: leadDB } = getConnectionByLocation("lead");
  const { connection: clinicDB } = getConnectionByLocation(location);

  if (!leadDB || !clinicDB) {
    const err = new Error("Invalid location: " + location);
    err.status = 404;
    throw err;
  }

  return new Promise((resolve, reject) => {
    leadDB.getConnection(function (err, tempCon) {
      if (err) return reject(err);

      const city = mapLocationToCity(location);
      console.log(`Fetching referred patients for city: ${city}`);

      let query = `
        SELECT *
        FROM referredPatients
        WHERE DATE(referredPatients.dateTime) BETWEEN ? AND ?
        AND (
          -- Case 1: Exact branch match
          referredPatients.branch = ?

          -- Case 2: Branch empty/NULL but location matches city
          OR (
            (referredPatients.branch IS NULL OR referredPatients.branch = '')
            AND referredPatients.location = ?
          )

          -- Case 3: BOTH empty/NULL → only allow for DP Road
          OR (
            (referredPatients.branch IS NULL OR referredPatients.branch = '')
            AND (referredPatients.location IS NULL OR referredPatients.location = '')
            AND ? = 'DP Road'
          )
        )
        ORDER BY referredPatients.id DESC
      `;

      let queryParams = [fromDate, toDate, location, city, location];

      tempCon.query(query, queryParams, async function (error, rows) {
        tempCon.release();
        if (error) return reject(error);

        const seen = new Set();
        const allLeads = [];

        for (const row of rows) {
          const normalizedPhone =
            row.patientsContact?.replace(/^(\+91|0)/, "") || "";
          if (!seen.has(normalizedPhone)) {
            seen.add(normalizedPhone);
            allLeads.push({
              ...row,
              selected_area: location,
            });
          }
        }

        // 🔥 GROUPING BY DOCTOR CONTACT
        const groupedReferred = allLeads.reduce((acc, row) => {
          const key = row.doctorsContact;
          if (!acc[key]) {
            acc[key] = {
              doctorsName: row.doctorsName,
              doctorsContact: row.doctorsContact,
              patients: [],
              totalPatients: 0,
            };
          }
          acc[key].patients.push(row);
          acc[key].totalPatients++;
          return acc;
        }, {});

        // ---------- Existing Logic ----------
        const appointments = allLeads.filter(
          (lead) => lead.status === "Appointment"
        );

        const appointmentPhones = appointments.map((a) =>
          a.patientsContact.replace(/^(\+91|0)/, "")
        );

        let actualVisits = 0;
        let ipdCount = 0;
        let visitedLeads = [];
        let ipdLeads = [];

        if (appointmentPhones.length > 0) {
          const placeholders = appointmentPhones
            .map(() => `patient_phone = ?`)
            .join(" OR ");

          const visitQuery = `
            SELECT patient_id, patient_phone
            FROM appointment
            WHERE (${placeholders})
            AND appointment_timestamp BETWEEN ? AND ?
            AND confirm_time != 0
            AND patient_type = 'New'
          `;

          const clinicQuery = util.promisify(clinicDB.query).bind(clinicDB);
          const visitResults = await clinicQuery(visitQuery, [
            ...appointmentPhones,
            fromDate,
            toDate,
          ]);

          actualVisits = visitResults.length;
          visitedLeads = visitResults;

          const patientIds = visitResults.map((row) => row.patient_id);

          if (patientIds.length > 0) {
            const invoicePlaceholders = patientIds.map(() => `?`).join(",");
            const invoiceQuery = `
              SELECT DISTINCT i.patient_id, p.phone AS patient_phone
              FROM invoice AS i
              LEFT JOIN patient AS p ON p.patient_id = i.patient_id
              WHERE i.patient_id IN (${invoicePlaceholders})
            `;
            const invoiceResults = await clinicQuery(invoiceQuery, patientIds);
            ipdCount = invoiceResults.length;
            ipdLeads = invoiceResults;
          }
        }

        const stats = {
          totalLeads: allLeads.length,
          appointmentCount: appointments.length,
          appointmentLeads: appointments,
          visitedLeads: visitedLeads,
          actualVisitCount: actualVisits,
          ipdLeads: ipdLeads,
          ipdCount: ipdCount,
          leads: allLeads,

          // 🔥 NEW DATA YOU REQUESTED
          groupedReferred: groupedReferred,
        };
        console.log(
          `📊 Datewise Referred Patients Stats for ${location}:`,
          stats
        );
        resolve(stats);
      });
    });
  });
}

async function getTopDoctors(fromDate, toDate, location, role) {
  // console.log(
  //   `Fetching top doctors for location: ${location}, from: ${fromDate}, to: ${toDate}`
  // );
  const { connection: leadDB } = getConnectionByLocation("lead");
  if (!leadDB) throw new Error("DB connection not found");

  const city = mapLocationToCity(location);

  const query = `
  SELECT 
    gp.doctorsName,
    gp.phoneNumber AS doctorPhone,
    gp.degree,
    gp.speciality,
    COUNT(DISTINCT rp.patientsContact) AS patientCount
  FROM referredPatients rp
  INNER JOIN GPData gp
    ON rp.doctorsContact = gp.phoneNumber
  WHERE DATE(rp.dateTime) BETWEEN ? AND ?
    AND (
      -- Case 1: Exact branch match
      rp.branch = ?

      -- Case 2: Branch empty/NULL, location matches city
      OR (
        (rp.branch IS NULL OR rp.branch = '')
        AND rp.location = ?
      )

      -- Case 3: BOTH empty/NULL → allow only for DP Road
      OR (
        (rp.branch IS NULL OR rp.branch = '')
        AND (rp.location IS NULL OR rp.location = '')
        AND ? = 'DP Road'
      )
    )
  GROUP BY gp.phoneNumber
  ORDER BY patientCount DESC
  LIMIT 5
`;

  const params = [
    fromDate,
    toDate,
    location, // for branch match
    city, // for city fallback
    location,
  ];

  const dbQuery = util.promisify(leadDB.query).bind(leadDB);
  const topDoctors = await dbQuery(query, params);
  const allDoctors = await getAllDoctorsStatistics(fromDate, toDate, location); // Preload data for performance
  return { topDoctors, allDoctors };
}

async function getAllDoctorsStatistics(fromDate, toDate, location, role) {
  const { connection: leadDB } = getConnectionByLocation("lead");
  if (!leadDB) throw new Error("DB connection not found");

  const city = mapLocationToCity(location);

  const query = `
  SELECT
    gp.doctorsName,
    gp.phoneNumber AS doctorPhone,
    gp.degree,
    gp.speciality,
    rp.patientsName,
    rp.patientsContact,
    rp.disease,
    DATE(rp.dateTime) AS visitDate
  FROM referredPatients rp
  INNER JOIN GPData gp
    ON rp.doctorsContact = gp.phoneNumber
  WHERE DATE(rp.dateTime) BETWEEN ? AND ?
    AND (
      -- Case 1: Exact branch match
      rp.branch = ?

      -- Case 2: Branch empty/NULL, location matches city
      OR (
        (rp.branch IS NULL OR rp.branch = '')
        AND rp.location = ?
      )

      -- Case 3: BOTH empty/NULL → allow only for DP Road
      OR (
        (rp.branch IS NULL OR rp.branch = '')
        AND (rp.location IS NULL OR rp.location = '')
        AND ? = 'DP Road'
      )
    )
  ORDER BY gp.doctorsName, rp.dateTime DESC
`;

  const dbQuery = util.promisify(leadDB.query).bind(leadDB);
  const rows = await dbQuery(query, [
    fromDate,
    toDate,
    location, // for rp.branch
    city, // for rp.location
    location, // for DP Road case
  ]);

  console.log(
    `Fetched ${rows.length} doctor-patient records for location: ${location}`
  );

  // 🔥 Grouping for frontend
  const doctorMap = {};

  for (const row of rows) {
    const key = row.doctorPhone;

    if (!doctorMap[key]) {
      doctorMap[key] = {
        doctorName: row.doctorsName,
        doctorPhone: row.doctorPhone,
        degree: row.degree,
        speciality: row.speciality,
        patients: [],
        _seenPatients: new Set(),
      };
    }

    // ✅ unique patients per doctor
    if (!doctorMap[key]._seenPatients.has(row.patientsContact)) {
      doctorMap[key]._seenPatients.add(row.patientsContact);
      doctorMap[key].patients.push({
        name: row.patientsName,
        disease: row.disease,
        date: row.visitDate,
      });
    }
  }

  // cleanup helper Set
  return Object.values(doctorMap).map((d) => {
    delete d._seenPatients;
    return {
      ...d,
      count: d.patients.length,
    };
  });
}

module.exports = {
  getDatewiseReferredPatients,
  getTopDoctors,
  getAllDoctorsStatistics,
};
