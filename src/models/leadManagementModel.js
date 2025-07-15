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
            REPLACE(REPLACE(patient_phone, '+91', ''), '0', '') = ?
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
            REPLACE(REPLACE(patient_phone, '+91', ''), '0', '') = ?
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

module.exports = {
  getLeads,
  getChatBotLeads,
  syncAppointments,
  syncBotAppointments,
};
