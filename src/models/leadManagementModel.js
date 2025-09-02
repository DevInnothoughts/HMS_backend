const { getConnectionByLocation } = require("../../databaseUtils");
const util = require("util");

async function getLeads(location) {
  const { connection } = getConnectionByLocation("lead");
  if (!connection) {
    const err = new Error("Invalid location", location);
    err.status = 404;
    throw err;
  }

  return new Promise((resolve, reject) => {
    connection.getConnection(function (err, tempCon) {
      if (err) {
        return reject(err);
      }

      let query = `
        SELECT *
        FROM appointments 
        WHERE selected_area LIKE CONCAT('%', ?, '%') 
        ORDER BY appointment_id DESC
        LIMIT 100
      `;

      let queryParams = [location];

      if (location === "DP Road") {
        query = `
          SELECT *
          FROM appointments 
          WHERE (
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Tilak Road', '%')
            OR selected_area LIKE CONCAT('%', 'Dhole Patil Road', '%')
          )
          ORDER BY appointment_id DESC
          LIMIT 100
        `;
      }
      if (location === "Salunke Vihar") {
        query = `
          SELECT *
          FROM appointments 
          WHERE (
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Wanowrie', '%')
          )
          ORDER BY appointment_id DESC
          LIMIT 100
        `;
      }
      if (location === "Hinjewadi") {
        query = `
          SELECT *
          FROM appointments 
          WHERE (
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Hinjawadi', '%')
          )
          ORDER BY appointment_id DESC
          LIMIT 100
        `;
      }
      if (location === "JP Nagar") {
        query = `
          SELECT *
          FROM appointments 
          WHERE (
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area = 'Bengaluru'
          )
          ORDER BY appointment_id DESC
          LIMIT 100
        `;
      }
      if (location === "Sarjapura") {
        query = `
          SELECT *
          FROM appointments 
          WHERE (
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Sarjapur', '%')
          )
          ORDER BY appointment_id DESC
          LIMIT 100
        `;
      }
      if (location === "Rajaji Nagar") {
        query = `
          SELECT *
          FROM appointments 
          WHERE (
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Rajajinagar', '%')
          )
          ORDER BY appointment_id DESC
          LIMIT 100
        `;
      }
      if (location === "Belgavi") {
        query = `
          SELECT *
          FROM appointments 
          WHERE (
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Belagavi', '%')
          )
          ORDER BY appointment_id DESC
          LIMIT 100
        `;
      }
      if (location === "Sahakar Nagar") {
        query = `
          SELECT *
          FROM appointments 
          WHERE (
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Sahakarnagar', '%')
          )
          ORDER BY appointment_id DESC
          LIMIT 100
        `;
      }
      if (location === "Gurgaon Sector 14") {
        query = `
          SELECT *
          FROM appointments 
          WHERE (
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Gurugram - Sector 14', '%')
          )
          ORDER BY appointment_id DESC
          LIMIT 100
        `;
      }
      if (location === "Gurgaon Sector 49") {
        query = `
          SELECT *
          FROM appointments 
          WHERE (
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Gurugram - Sector 49', '%')
          )
          ORDER BY appointment_id DESC
          LIMIT 100
        `;
      }
      if (location === "Thane") {
        query = `
          SELECT *
          FROM appointments 
          WHERE (
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Kapurbawdi', '%')
          )
          ORDER BY appointment_id DESC
          LIMIT 100
        `;
      }

      tempCon.query(query, queryParams, function (error, rows) {
        tempCon.release();
        if (error) {
          return reject(error);
        }
        rows.forEach((row) => {
          row.selected_area = location;
        });
        //console.log(rows);
        resolve(rows);
      });
    });
  });
}

async function getChatBotLeads(location) {
  const { connection } = getConnectionByLocation("lead");
  if (!connection) {
    const err = new Error("Invalid location", location);
    err.status = 404;
    throw err;
  }

  return new Promise((resolve, reject) => {
    connection.getConnection(function (err, tempCon) {
      if (err) return reject(err);

      let query = `
        SELECT id AS appointment_id, datetime AS date, name, branch, contact AS phoneno,  disease, chat_whatsapp_branch, query AS message, status, note
        FROM chatbot_leads 
        WHERE (branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%'))
        ORDER BY id DESC
        LIMIT 100
      `;
      let queryParams = [location, location];

      if (location === "DP Road") {
        query = `
          SELECT id AS appointment_id, datetime AS date, name, branch, contact AS phoneno,  disease, chat_whatsapp_branch, query AS message, status, note
          FROM chatbot_leads 
          WHERE (
            (branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%')) 
            OR (branch LIKE '%Tilak Road%' OR chat_whatsapp_branch LIKE '%Tilak Road%')
            OR (branch LIKE '%Dhole Patil Road%' OR chat_whatsapp_branch LIKE '%Dhole Patil Road%')
          )
          ORDER BY id DESC
          LIMIT 100
        `;
        queryParams = [location, location];
      }

      if (location === "Salunke Vihar") {
        query = `
          SELECT id AS appointment_id, datetime AS date, name, branch, contact AS phoneno,  disease, chat_whatsapp_branch, query AS message, status, note
          FROM chatbot_leads 
          WHERE (
            (branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%')) 
            OR (branch LIKE '%Salunkhe Vihar%' OR chat_whatsapp_branch LIKE '%Salunke Vihar%') 
            OR (branch LIKE '%Wanowrie%' OR chat_whatsapp_branch LIKE '%Wanowrie%')
          )
          ORDER BY id DESC
          LIMIT 100
        `;
        queryParams = [location, location];
      }

      if (location === "Hinjewadi") {
        query = `
          SELECT id AS appointment_id, datetime AS date, name, branch, contact AS phoneno,  disease, chat_whatsapp_branch, query AS message, status, note
          FROM chatbot_leads 
          WHERE (
            (branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%')) 
            OR (branch LIKE '%Hinjawadi%' OR chat_whatsapp_branch LIKE '%Hinjawadi%')
          )
          ORDER BY id DESC
          LIMIT 100
        `;
        queryParams = [location, location];
      }

      if (location === "HSR") {
        query = `
          SELECT id AS appointment_id, datetime AS date, name, branch, contact AS phoneno,  disease, chat_whatsapp_branch, query AS message, status, note
          FROM chatbot_leads 
          WHERE (
            (branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%')) 
            OR (branch LIKE '%HSR Layout%' OR chat_whatsapp_branch LIKE '%HSR Layout%')
          )
          ORDER BY id DESC
          LIMIT 100
        `;
        queryParams = [location, location];
      }

      if (location === "Rajaji Nagar") {
        query = `
          SELECT id AS appointment_id, datetime AS date, name, branch, contact AS phoneno,  disease, chat_whatsapp_branch, query AS message, status, note
          FROM chatbot_leads 
          WHERE (
            (branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%')) 
            OR (branch LIKE '%Rajajinagar%' OR chat_whatsapp_branch LIKE '%Rajajinagar%')
          )
          ORDER BY id DESC
          LIMIT 100
        `;
        queryParams = [location, location];
      }

      if (location === "Belgavi") {
        query = `
          SELECT id AS appointment_id, datetime AS date, name, branch, contact AS phoneno,  disease, chat_whatsapp_branch, query AS message, status, note
          FROM chatbot_leads 
          WHERE (
            (branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%')) 
            OR (branch LIKE '%Belagavi%' OR chat_whatsapp_branch LIKE '%Belagavi%')
          )
          ORDER BY id DESC
          LIMIT 100
        `;
        queryParams = [location, location];
      }

      if (location === "Hyderabad") {
        query = `
          SELECT id AS appointment_id, datetime AS date, name, branch, contact AS phoneno,  disease, chat_whatsapp_branch, query AS message, status, note
          FROM chatbot_leads 
          WHERE (
            (branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%')) 
            OR (branch LIKE '%Jubilee Hills%' OR chat_whatsapp_branch LIKE '%Jubilee Hills%')
          )
          ORDER BY id DESC
          LIMIT 100
        `;
        queryParams = [location, location];
      }

      if (location === "Gurgaon Sector 14") {
        query = `
          SELECT id AS appointment_id, datetime AS date, name, branch, contact AS phoneno,  disease, chat_whatsapp_branch, query AS message, status, note
          FROM chatbot_leads 
          WHERE (
            (branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%')) 
            OR (branch LIKE '%Gurugram - Sector 14%' OR chat_whatsapp_branch LIKE '%Gurugram - Sector 14%')
             OR (branch LIKE '%Gurgaon Sector - 14%' OR chat_whatsapp_branch LIKE '%Gurgaon Sector - 14%')
          )
          ORDER BY id DESC
          LIMIT 100
        `;
        queryParams = [location, location];
      }

      if (location === "Gurgaon Sector 49") {
        query = `
          SELECT id AS appointment_id, datetime AS date, name, branch, contact AS phoneno,  disease, chat_whatsapp_branch, query AS message, status, note
          FROM chatbot_leads 
          WHERE (
            (branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%')) 
            OR (branch LIKE '%Gurugram - Sector 49%' OR chat_whatsapp_branch LIKE '%Gurugram - Sector 49%')
            OR (branch LIKE '%Gurgaon Sector - 49%' OR chat_whatsapp_branch LIKE '%Gurgaon Sector - 49%')
          )
          ORDER BY id DESC
          LIMIT 100
        `;
        queryParams = [location, location];
      }

      if (location === "Chinchwad") {
        query = `
          SELECT id AS appointment_id, datetime AS date, name, branch, contact AS phoneno,  disease, chat_whatsapp_branch, query AS message, status, note
          FROM chatbot_leads 
          WHERE (
            (branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%')) 
            OR (branch LIKE '%Pimpri-Chinchwad%' OR chat_whatsapp_branch LIKE '%Pimpri-Chinchwad%')
          )
          ORDER BY id DESC
          LIMIT 100
        `;
        queryParams = [location, location];
      }
      if (location === "Vashi") {
        query = `
          SELECT id AS appointment_id, datetime AS date, name, branch, contact AS phoneno, disease, chat_whatsapp_branch, query AS message, status, note
          FROM chatbot_leads 
          WHERE (
            (branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%')) 
            OR (branch = '' AND chat_whatsapp_branch = '')
          )
          ORDER BY id DESC
          LIMIT 100
        `;
        queryParams = [location, location];
      }

      tempCon.query(query, queryParams, function (error, rows) {
        tempCon.release();
        if (error) return reject(error);
        rows.forEach((row) => {
          if (
            location === "Vashi" &&
            row.branch === "" &&
            row.chat_whatsapp_branch === ""
          ) {
            row.message = `OTHER BRANCH -${row.message}`;
          }
          row.selected_area = location;
        });
        //console.log(rows);
        resolve(rows);
      });
    });
  });
}

async function syncAppointments(location) {
  const { connection: leadsDB } = getConnectionByLocation("lead");
  const { connection: clinicDB } = getConnectionByLocation(location);
  if (!leadsDB || !clinicDB) {
    const err = new Error("Invalid location", location);
    err.status = 404;
    throw err;
  }

  try {
    console.log("🔄Web Lead Sync started at", new Date().toLocaleString());

    const leads = await getLeads(location);
    //console.log(leads);

    if (leads.length === 0) {
      console.log("✅ No unsynced leads found.");
      return;
    }

    // Promisify query methods
    const clinicQuery = util.promisify(clinicDB.query).bind(clinicDB);
    const leadsQuery = util.promisify(leadsDB.query).bind(leadsDB);

    // Step 2: Loop through each lead
    for (const lead of leads) {
      const { appointment_id, phoneno, date, status } = lead;

      if (status === "Appointment") continue; // Skip already processed

      const normalizedPhone = phoneno.replace(/^(\+91|0)/, "");
      //console.log(normalizedPhone, date);

      const rows = await clinicQuery(
        `
          SELECT patient_phone, appointment_timestamp
          FROM appointment
          WHERE 
            patient_phone = ?
            AND appointment_timestamp >= ?
          LIMIT 1
        `,
        [normalizedPhone, date]
      );

      // console.log("Matched:", rows);

      if (rows && rows.length > 0) {
        const match = rows[0]; // This is your RowDataPacket
        const appointmentDate = new Date(
          match.appointment_timestamp
        ).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
        const note = `Appointment booked on ${appointmentDate} and synchronised successfully.`;
        // console.log(note);
        await leadsQuery(
          `
    UPDATE appointments
    SET status = 'Appointment', note = ?
    WHERE appointment_id = ?
  `,
          [note, appointment_id]
        );
        //console.log("Matched:", match);
        console.log(`✅ Synced ${location}: ${phoneno} → status updated.`);
      }
    }

    console.log("🔁Web Lead Sync completed at", new Date().toLocaleString());
  } catch (err) {
    console.error("❌ Error during Web Lead sync:", err.message);
  }
}

async function syncBotAppointments(location) {
  const { connection: leadsDB } = getConnectionByLocation("lead");
  const { connection: clinicDB } = getConnectionByLocation(location);
  if (!leadsDB || !clinicDB) {
    const err = new Error("Invalid location", location);
    err.status = 404;
    throw err;
  }

  try {
    console.log("🔄Bot Lead Sync started at", new Date().toLocaleString());

    const leads = await getChatBotLeads(location);
    //console.log(leads);

    if (leads.length === 0) {
      console.log("✅ No unsynced Bot leads found.");
      return;
    }

    // Promisify query methods
    const clinicQuery = util.promisify(clinicDB.query).bind(clinicDB);
    const leadsQuery = util.promisify(leadsDB.query).bind(leadsDB);

    // Step 2: Loop through each lead
    for (const lead of leads) {
      const { appointment_id, phoneno, date, status } = lead;

      if (!phoneno || status === "Appointment") continue;

      const normalizedPhone = phoneno.replace(/^(\+91|91|0)/, "");
      //console.log(normalizedPhone, date);

      const rows = await clinicQuery(
        `
          SELECT patient_phone, appointment_timestamp
          FROM appointment
          WHERE 
            patient_phone = ?
            AND appointment_timestamp >= ?
          LIMIT 1
        `,
        [normalizedPhone, date]
      );

      //console.log("Matched:", rows);

      if (rows && rows.length > 0) {
        const match = rows[0]; // This is your RowDataPacket
        const appointmentDate = new Date(
          match.appointment_timestamp
        ).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
        const note = `Appointment booked on ${appointmentDate} and synchronised successfully.`;
        //console.log(note);
        await leadsQuery(
          `
          UPDATE chatbot_leads
          SET status = 'Appointment', note = ?
          WHERE id = ?
        `,
          [note, appointment_id]
        );
        //console.log("Matched:", match);
        console.log(
          `✅Bot Lead Synced ${location}: ${phoneno} → status updated.`
        );
      }
    }

    console.log("🔁Bot Lead Sync completed at", new Date().toLocaleString());
  } catch (err) {
    console.error("❌ Error during Bot Lead sync:", err.message);
  }
}

async function getDatewiseLeads(location, fromDate, toDate) {
  const { connection: leadDB } = getConnectionByLocation("lead");
  const { connection: clinicDB } = getConnectionByLocation(location);

  console.log("From:", fromDate, "To:", toDate);

  if (!leadDB || !clinicDB) {
    const err = new Error("Invalid location: " + location);
    err.status = 404;
    throw err;
  }

  return new Promise((resolve, reject) => {
    leadDB.getConnection(async function (err, tempCon) {
      if (err) return reject(err);

      try {
        let dateParams = [
          `${fromDate}T00:00:00+05:30`,
          `${toDate}T23:59:59+05:30`,
        ];
        let areaConditions = "selected_area LIKE CONCAT('%', ?, '%')";
        let areaParams = [location];

        if (location === "DP Road") {
          areaConditions = `
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Tilak Road', '%')
            OR selected_area LIKE CONCAT('%', 'Dhole Patil Road', '%')
          `;
        } else if (location === "Salunke Vihar") {
          areaConditions = `
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Wanowrie', '%')
          `;
        } else if (location === "Hinjewadi") {
          areaConditions = `
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Hinjawadi', '%')
          `;
        } else if (location === "JP Nagar") {
          areaConditions = `
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area = 'Bengaluru'
          `;
        } else if (location === "Sarjapura") {
          areaConditions = `
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Sarjapur', '%')
          `;
        } else if (location === "Rajaji Nagar") {
          areaConditions = `
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Rajajinagar', '%')
          `;
        } else if (location === "Belgavi") {
          areaConditions = `
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Belagavi', '%')
          `;
        } else if (location === "Sahakar Nagar") {
          areaConditions = `
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Sahakarnagar', '%')
          `;
        } else if (location === "Gurgaon Sector 14") {
          areaConditions = `
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Gurugram - Sector 14', '%')
          `;
        } else if (location === "Gurgaon Sector 49") {
          areaConditions = `
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Gurugram - Sector 49', '%')
          `;
        } else if (location === "Thane") {
          areaConditions = `
            selected_area LIKE CONCAT('%', ?) 
            OR selected_area LIKE CONCAT('%', 'Kapurbawdi', '%')
          `;
        }

        const query = `
          SELECT *
          FROM appointments
          WHERE (${areaConditions})
            AND date BETWEEN ? AND ?
          ORDER BY appointment_id DESC
        `;

        let queryParams = [...areaParams, ...dateParams];

        tempCon.query(query, queryParams, async function (error, rows) {
          tempCon.release();
          if (error) return reject(error);

          const seen = new Set();
          const allLeads = [];

          for (const row of rows) {
            const normalizedPhone =
              row.phoneno?.replace(/^(\+91|91|0)/, "") || "";
            if (!seen.has(normalizedPhone)) {
              seen.add(normalizedPhone);
              allLeads.push({
                ...row,
                selected_area: location,
              });
            }
          }

          // Count appointments from leads
          const appointments = allLeads.filter(
            (lead) => lead.status === "Appointment"
          );

          const appointmentPhones = appointments.map((a) =>
            a.phoneno.replace(/^(\+91|91|0)/, "")
          );

          let actualVisits = 0;
          let ipdCount = 0;
          let visitedLeads = [];
          let ipdLeads = [];

          if (appointmentPhones.length > 0) {
            const placeholders = appointmentPhones
              .map(() => `patient_phone = ?`)
              .join(" OR ");

            // Phase 1: Get patient_id and patient_phone for confirmed new visits
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

            // Phase 2: Check if invoice exists for these patient_ids
            const patientIds = visitResults.map((row) => row.patient_id);

            if (patientIds.length > 0) {
              const invoicePlaceholders = patientIds.map(() => `?`).join(",");

              const invoiceQuery = `
                SELECT DISTINCT i.patient_id, p.phone AS patient_phone
          FROM invoice AS i
          LEFT JOIN patient AS p
            ON p.patient_id = i.patient_id
          WHERE i.patient_id IN (${invoicePlaceholders})
    `;

              const invoiceResults = await clinicQuery(
                invoiceQuery,
                patientIds
              );

              ipdCount = invoiceResults.length;
              ipdLeads = invoiceResults;
            }
          }

          // Final stats
          const stats = {
            totalLeads: allLeads.length,
            appointmentCount: appointments.length,
            appointmentLeads: appointments,
            visitedLeads: visitedLeads,
            actualVisitCount: actualVisits,
            ipdLeads: ipdLeads,
            ipdCount: ipdCount,
            leads: allLeads,
          };
          //console.log(`📊 Datewise Leads Stats for ${location}:`, stats);
          resolve(stats);
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function getDatewiseBotLeads(location, fromDate, toDate) {
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

      let query = `
        SELECT id AS appointment_id, datetime AS date, name, branch, contact AS phoneno, email, disease, chat_whatsapp_branch, query AS message, status, note
        FROM chatbot_leads 
        WHERE (branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%'))
          AND DATE(datetime) BETWEEN ? AND ?
        ORDER BY id DESC
      `;

      let queryParams = [
        location,
        location,
        `${fromDate}T00:00:00+05:30`,
        `${toDate}T23:59:59+05:30`,
      ];

      // Custom location mappings (optional)
      const locationMap = {
        "DP Road": ["%Tilak Road%", "%Dhole Patil Road%"],
        "Salunke Vihar": ["%Salunkhe Vihar%", "%Wanowrie%"],
        Hinjewadi: ["%Hinjawadi%"],
        HSR: ["%HSR Layout%"],
        "Rajaji Nagar": ["%Rajajinagar%"],
        Belgavi: ["%Belagavi%"],
        Hyderabad: ["%Jubilee Hills%"],
        "Gurgaon Sector 14": [
          "%Gurugram - Sector 14%",
          "%Gurgaon Sector - 14%",
        ],
        "Gurgaon Sector 49": [
          "%Gurugram - Sector 49%",
          "%Gurgaon Sector - 49%",
        ],
        Chinchwad: ["%Pimpri-Chinchwad%"],
      };
      if (location === "Vashi") {
        query = `
          SELECT id AS appointment_id, datetime AS date, name, branch, contact AS phoneno,  email, disease, chat_whatsapp_branch, query AS message, status, note
          FROM chatbot_leads 
          WHERE (
            (branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%')) 
            OR (branch = '' AND chat_whatsapp_branch = '')
          )
          AND DATE(datetime) BETWEEN ? AND ?
          ORDER BY id DESC
          LIMIT 100
        `;
        queryParams = [
          location,
          location,
          `${fromDate}T00:00:00+05:30`,
          `${toDate}T23:59:59+05:30`,
        ];
      } else if (locationMap[location]) {
        const extraConditions = locationMap[location]
          .map(
            (alias) =>
              `(branch LIKE '${alias}' OR chat_whatsapp_branch LIKE '${alias}')`
          )
          .join(" OR ");

        const baseCondition = `(branch LIKE CONCAT('%', ?, '%') OR chat_whatsapp_branch LIKE CONCAT('%', ?, '%'))`;

        query = `
          SELECT id AS appointment_id, datetime AS date, name, branch, contact AS phoneno, email, disease, chat_whatsapp_branch, query AS message, status, note
          FROM chatbot_leads 
          WHERE (${baseCondition}${
          extraConditions ? ` OR ${extraConditions}` : ""
        })
            AND DATE(datetime) BETWEEN ? AND ?
          ORDER BY id DESC
        `;
        queryParams = [
          location,
          location,
          `${fromDate}T00:00:00+05:30`,
          `${toDate}T23:59:59+05:30`,
        ];
      }

      tempCon.query(query, queryParams, async function (error, rows) {
        tempCon.release();
        if (error) return reject(error);

        const seen = new Set();
        const allLeads = [];

        for (const row of rows) {
          const normalizedPhone =
            row.phoneno?.replace(/^(\+91|91|0)/, "") || "";
          if (!seen.has(normalizedPhone)) {
            seen.add(normalizedPhone);
            allLeads.push({
              ...row,
              selected_area: location,
            });
          }
        }

        const appointments = allLeads.filter(
          (lead) => lead.status === "Appointment"
        );

        const appointmentPhones = appointments.map((a) =>
          a.phoneno.replace(/^(\+91|91|0)/, "")
        );

        let actualVisits = 0;
        let ipdCount = 0;
        let visitedLeads = [];
        let ipdLeads = [];

        if (appointmentPhones.length > 0) {
          const placeholders = appointmentPhones
            .map(() => `patient_phone = ?`)
            .join(" OR ");

          // Phase 1: Get patient_id and patient_phone for confirmed new visits
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

          // Phase 2: Check if invoice exists for these patient_ids
          const patientIds = visitResults.map((row) => row.patient_id);

          if (patientIds.length > 0) {
            const invoicePlaceholders = patientIds.map(() => `?`).join(",");

            const invoiceQuery = `
                  SELECT DISTINCT i.patient_id, p.phone AS patient_phone
          FROM invoice AS i
          LEFT JOIN patient AS p
            ON p.patient_id = i.patient_id
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
        };
        //console.log(`📊 Datewise Bot Leads Stats for ${location}:`, stats);
        resolve(stats);
      });
    });
  });
}

module.exports = {
  getLeads,
  getChatBotLeads,
  syncAppointments,
  syncBotAppointments,
  getDatewiseLeads,
  getDatewiseBotLeads,
};
