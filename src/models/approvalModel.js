const { getConnectionByLocation } = require("../../databaseUtils");

const getCallAndWebData = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const getYesterdayDateString = () => {
    const now = new Date();

    // Add IST offset (5.5 hours = 330 minutes)
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);

    // Subtract one day in IST-adjusted context
    istNow.setUTCDate(istNow.getUTCDate() - 1);
    console.log(istNow);
    // Extract and format date in UTC after IST shift
    const yyyy = istNow.getUTCFullYear();
    const mm = String(istNow.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(istNow.getUTCDate()).padStart(2, "0");

    const formatted = `${yyyy}-${mm}-${dd}`;
    //console.log("IST Yesterday:", formatted);
    return formatted;
  };

  const inputDate = req.query.from || getYesterdayDateString();
  const startOfDay = new Date(`${inputDate}T00:00:00+05:30`).getTime();
  const endOfDay = new Date(`${inputDate}T23:59:59+05:30`).getTime();

  // SQL Parameters
  const ivrDateParam = [inputDate];
  const ivrDateRangeParam = [inputDate, inputDate];
  const helplineTimestampParam = [startOfDay, endOfDay];

  // Reusable query executor
  const executeQuery = (sql, values = []) => {
    return new Promise((resolve, reject) => {
      connection.query(sql, values, (err, results) => {
        if (err) return reject(err);
        resolve(results);
      });
    });
  };

  try {
    const [
      ivrData,
      helplineData,
      missedIVRCount,
      answeredIVRCount,
      helplineMissedCount,
      helplineAnsweredCount,
      helplineOutgoingCount,
    ] = await Promise.all([
      executeQuery(
        `
        SELECT ivr_id, call_date, call_duration, call_status, call_time,
               caller_no, circle_name, destination_name, destination_no, note
        FROM IVRdata
        WHERE STR_TO_DATE(call_date, '%Y-%d-%m') = ?
          AND destination_no != ''
        ORDER BY ivr_id DESC
      `,
        ivrDateParam
      ),
      executeQuery(
        `
        SELECT *
        FROM phonecalllogs
        WHERE timestamp BETWEEN ? AND ?
        ORDER BY timestamp DESC
      `,
        helplineTimestampParam
      ),
      executeQuery(
        `
        SELECT COUNT(*) AS missed_count
        FROM IVRdata
        WHERE STR_TO_DATE(call_date, '%Y-%d-%m') >= ?
          AND STR_TO_DATE(call_date, '%Y-%d-%m') <= ?
          AND call_status = 'Missed'
          AND destination_no != ''
      `,
        ivrDateRangeParam
      ),
      executeQuery(
        `
        SELECT COUNT(*) AS answered_count
        FROM IVRdata
        WHERE STR_TO_DATE(call_date, '%Y-%d-%m') >= ?
          AND STR_TO_DATE(call_date, '%Y-%d-%m') <= ?
          AND call_status = 'Answered'
          AND destination_no != ''
      `,
        ivrDateRangeParam
      ),
      executeQuery(
        `
        SELECT COUNT(*) AS helpline_missed_count
        FROM phonecalllogs
        WHERE timestamp BETWEEN ? AND ?
          AND (type = 'MISSED' OR type = 'UNKNOWN')
      `,
        helplineTimestampParam
      ),
      executeQuery(
        `
        SELECT COUNT(*) AS helpline_answered_count
        FROM phonecalllogs
        WHERE timestamp BETWEEN ? AND ?
          AND type = 'INCOMING'
      `,
        helplineTimestampParam
      ),
      executeQuery(
        `
        SELECT COUNT(*) AS helpline_outgoing_count
        FROM phonecalllogs
        WHERE timestamp BETWEEN ? AND ?
          AND type = 'OUTGOING'
      `,
        helplineTimestampParam
      ),
    ]);

    const webLeads = await getLeads(req.query.location);
    const botLeads = await getBotLeads(req.query.location);

    // Return structured result
    return {
      ivrData,
      helplineData,
      missed_count: missedIVRCount[0]?.missed_count || 0,
      answered_count: answeredIVRCount[0]?.answered_count || 0,
      helpline_missed_count: helplineMissedCount[0]?.helpline_missed_count || 0,
      helpline_answered_count:
        helplineAnsweredCount[0]?.helpline_answered_count || 0,
      helpline_outgoing_count:
        helplineOutgoingCount[0]?.helpline_outgoing_count || 0,
      webLeads,
      botLeads,
    };
  } catch (error) {
    console.error("Error in getCallAndWebData:", error);
    throw error;
  }
};

function getYesterdayDateTimeRange() {
  const now = new Date();

  // Add IST offset (5.5 hours = 330 minutes)
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);

  // Subtract one day in IST-adjusted context
  istNow.setUTCDate(istNow.getUTCDate() - 1);
  console.log(istNow);
  // Extract and format date in UTC after IST shift
  const yyyy = istNow.getUTCFullYear();
  const mm = String(istNow.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(istNow.getUTCDate()).padStart(2, "0");

  const formatted = `${yyyy}-${mm}-${dd}`;

  const start = `${formatted}T00:00:00+05:30`;
  const end = `${formatted}T23:59:59+05:30`;

  return { start, end };
}
const getYesterdayInIST = () => {
  const now = new Date();

  // Add IST offset (5.5 hours = 330 minutes)
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);

  // Subtract one day in IST-adjusted context
  istNow.setUTCDate(istNow.getUTCDate() - 1);
  console.log(istNow);
  // Extract and format date in UTC after IST shift
  const yyyy = istNow.getUTCFullYear();
  const mm = String(istNow.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(istNow.getUTCDate()).padStart(2, "0");

  const formatted = `${yyyy}-${mm}-${dd}`;
  //console.log("IST Yesterday:", formatted);
  return formatted;
};

const getTodayISTDate = () => {
  const now = new Date();

  // Convert to milliseconds since UTC and add IST offset
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffsetMs);
  //console.log(istTime);
  // Format IST date manually in YYYY-MM-DD format
  const year = istTime.getUTCFullYear();
  const month = String(istTime.getUTCMonth() + 1).padStart(2, "0");
  const day = String(istTime.getUTCDate()).padStart(2, "0");
  //console.log(`${year}-${month}-${day}`);
  return `${year}-${month}-${day}`;
};

async function getLeads(location) {
  const { connection } = getConnectionByLocation("lead");
  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const { start, end } = getYesterdayDateTimeRange();

  const baseConditions = {
    "DP Road": ["DP Road", "Tilak Road", "Dhole Patil Road"],
    "Salunke Vihar": ["Salunke Vihar", "Wanowrie"],
    Hinjewadi: ["Hinjewadi", "Hinjawadi"],
    "JP Nagar": ["JP Nagar", "Bengaluru"],
    Sarjapura: ["Sarjapura", "Sarjapur"],
    "Rajaji Nagar": ["Rajaji Nagar", "Rajajinagar"],
    Belgavi: ["Belgavi", "Belagavi"],
    "Sahakar Nagar": ["Sahakar Nagar", "Sahakarnagar"],
    "Gurgaon Sector 14": ["Gurgaon Sector 14", "Gurugram - Sector 14"],
    "Gurgaon Sector 49": ["Gurgaon Sector 49", "Gurugram - Sector 49"],
    Thane: ["Thane", "Kapurbawdi"],
  };

  const areas = baseConditions[location] || [location];
  const whereArea = areas.map(() => `selected_area LIKE ?`).join(" OR ");
  const areaParams = areas.map((a) => `%${a}%`);

  const datetimeCondition = `date BETWEEN ? AND ?`;

  const executeCountQuery = (sql, params) =>
    new Promise((resolve, reject) => {
      connection.query(sql, params, (err, results) => {
        if (err) return reject(err);
        resolve(results[0]?.count || 0);
      });
    });

  const fetchLeadRecords = (sql, params) =>
    new Promise((resolve, reject) => {
      connection.query(sql, params, (err, results) => {
        if (err) return reject(err);
        resolve(results);
      });
    });

  const baseQuery = `
    SELECT COUNT(*) AS count
    FROM appointments
    WHERE (${whereArea}) AND ${datetimeCondition}
  `;

  const statusQuery = (status) => `
    SELECT COUNT(*) AS count
    FROM appointments
    WHERE (${whereArea}) AND ${datetimeCondition} AND status = ?
  `;

  const leadsDetailQuery = `
    SELECT *
    FROM appointments
    WHERE (${whereArea}) AND ${datetimeCondition}
    ORDER BY date DESC
  `;

  try {
    const [totalLeads, enquiryCount, appointmentCount, webLeads] =
      await Promise.all([
        executeCountQuery(baseQuery, [...areaParams, start, end]),
        executeCountQuery(statusQuery("Enquiry"), [
          ...areaParams,
          start,
          end,
          "Enquiry",
        ]),
        executeCountQuery(statusQuery("Appointment"), [
          ...areaParams,
          start,
          end,
          "Appointment",
        ]),
        fetchLeadRecords(leadsDetailQuery, [...areaParams, start, end]),
      ]);

    return {
      location,
      totalLeads,
      enquiryCount,
      appointmentCount,
      webLeads, // Actual records
    };
  } catch (err) {
    console.error("Error fetching lead data:", err);
    throw err;
  }
}

async function getBotLeads(location) {
  const { connection } = getConnectionByLocation("lead");
  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const { start, end } = getYesterdayDateTimeRange();

  const baseConditions = {
    "DP Road": ["DP Road", "Tilak Road", "Dhole Patil Road"],
    "Salunke Vihar": ["Salunke Vihar", "Salunkhe Vihar", "Wanowrie"],
    Hinjewadi: ["Hinjewadi", "Hinjawadi"],
    HSR: ["HSR", "HSR Layout"],
    Sarjapura: ["Sarjapura", "Sarjapur"],
    "Rajaji Nagar": ["Rajaji Nagar", "Rajajinagar"],
    Belgavi: ["Belgavi", "Belagavi"],
    "Gurgaon Sector 14": ["Gurgaon Sector 14", "Gurugram - Sector 14"],
    "Gurgaon Sector 49": ["Gurgaon Sector 49", "Gurugram - Sector 49"],
    Hyderabad: ["Hyderabad", "Jubilee Hills"],
    Chinchwad: ["Chinchwad", "Pimpri-Chinchwad"],
  };

  const areas = baseConditions[location] || [location];
  let areaConditions;
  let areaParams;

  if (location === "Vashi") {
    areaConditions = areas
      .map(() => `(branch LIKE ? OR chat_whatsapp_branch LIKE ?)`)
      .join(" OR ");

    // Add extra condition for blank branches
    areaConditions += " OR (branch = '' AND chat_whatsapp_branch = '')";

    areaParams = areas.flatMap((area) => [`%${area}%`, `%${area}%`]);
  } else {
    areaConditions = areas
      .map(() => `(branch LIKE ? OR chat_whatsapp_branch LIKE ?)`)
      .join(" OR ");
    areaParams = areas.flatMap((area) => [`%${area}%`, `%${area}%`]);
  }

  const dateCondition = `datetime BETWEEN ? AND ?`;

  const executeCountQuery = (sql, params) =>
    new Promise((resolve, reject) => {
      connection.query(sql, params, (err, results) => {
        if (err) return reject(err);
        resolve(results[0]?.count || 0);
      });
    });

  const fetchLeadRecords = (sql, params) =>
    new Promise((resolve, reject) => {
      connection.query(sql, params, (err, results) => {
        if (err) return reject(err);
        resolve(results);
      });
    });

  const baseQuery = `
    SELECT COUNT(*) AS count
    FROM chatbot_leads
    WHERE (${areaConditions}) AND ${dateCondition}
  `;

  const statusQuery = (status) => `
    SELECT COUNT(*) AS count
    FROM chatbot_leads
    WHERE (${areaConditions}) AND ${dateCondition} AND status = ?
  `;

  const leadsDetailQuery = `
    SELECT id AS appointment_id, datetime AS date, name, branch, contact AS phoneno, disease, chat_whatsapp_branch, query AS message, status, note
    FROM chatbot_leads
    WHERE (${areaConditions}) AND ${dateCondition}
    ORDER BY datetime DESC
  `;

  try {
    const [totalLeads, enquiryCount, appointmentCount, botLeads] =
      await Promise.all([
        executeCountQuery(baseQuery, [...areaParams, start, end]),
        executeCountQuery(statusQuery("Enquiry"), [
          ...areaParams,
          start,
          end,
          "Enquiry",
        ]),
        executeCountQuery(statusQuery("Appointment"), [
          ...areaParams,
          start,
          end,
          "Appointment",
        ]),
        fetchLeadRecords(leadsDetailQuery, [...areaParams, start, end]),
      ]);

    // Append message prefix for empty-branch records if location is Vashi
    if (location === "Vashi") {
      botLeads.forEach((row) => {
        if (!row.branch && !row.chat_whatsapp_branch) {
          row.message = `OTHER BRANCH - ${row.message}`;
        }
        row.selected_area = location;
      });
    }

    return {
      location,
      totalLeads,
      enquiryCount,
      appointmentCount,
      botLeads,
    };
  } catch (err) {
    console.error("Error fetching chatbot lead summary:", err);
    throw err;
  }
}

async function addApprovalDetails(data) {
  const { connection, location } = getConnectionByLocation(data.location);
  if (!connection) {
    const err = new Error(`Invalid location for add approval: ${location}`);
    err.status = 404;
    throw err;
  }

  const nowUTC = new Date();

  const formattedDate = getYesterdayInIST();

  return new Promise((resolve, reject) => {
    connection.getConnection((err, tempCon) => {
      if (err) return reject(err);

      const checkQuery = `SELECT * FROM approval WHERE date = ?`;
      tempCon.query(checkQuery, [formattedDate], (error, rows) => {
        if (error) {
          tempCon.release();
          return reject(error);
        }

        if (data.subRole === "Owner") {
          // Only insert if record doesn't exist
          if (rows.length === 0) {
            const insertQuery = `INSERT INTO approval (date, user1, user2) VALUES (?, ?, NULL)`;
            tempCon.query(
              insertQuery,
              [formattedDate, data.user],
              (err2, result) => {
                tempCon.release();
                if (err2) return reject(err2);
                resolve({ message: "Owner approval successful." });
              }
            );
          } else {
            tempCon.release();
            resolve({ message: "Owner approval skipped (already exists)." });
          }
        } else if (data.subRole === "Cluster Head") {
          // Only update if record exists
          if (rows.length > 0) {
            const updateQuery = `UPDATE approval SET user2 = ? WHERE date = ?`;
            tempCon.query(
              updateQuery,
              [data.user, formattedDate],
              (err3, result) => {
                tempCon.release();
                if (err3) return reject(err3);
                resolve({ message: "Cluster head approval successful." });
              }
            );
          } else {
            // tempCon.release();
            // resolve({
            //   message: "No existing record found to update for Cluster Head.",
            // });
            const insertQuery = `INSERT INTO approval (date, user1, user2) VALUES (?, NULL, ?)`;
            tempCon.query(
              insertQuery,
              [formattedDate, data.user],
              (err2, result) => {
                tempCon.release();
                if (err2) return reject(err2);
                resolve({ message: "Cluster head approval successful." });
              }
            );
          }
        } else {
          tempCon.release();
          reject(
            new Error(
              "Invalid subRole provided. Expected 'OWNER' or 'Cluster Head'."
            )
          );
        }
      });
    });
  });
}

async function getApprovalDetails(location) {
  console.log(location);
  const { connection } = getConnectionByLocation(location);
  if (!connection) {
    const err = new Error(
      `Invalid location for approval retrieval: ${location}`
    );
    err.status = 404;
    throw err;
  }

  const formattedDate = getYesterdayInIST();

  try {
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        const sql = `SELECT * FROM approval WHERE date = ?`;
        tempCon.query(sql, [formattedDate], (error, rows) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(rows);
        });
      });
    });

    console.log("Approval records:", rows);
    return rows;
  } catch (error) {
    throw new Error("Error while fetching approval details: " + error.message);
  }
}

const getIPDReportData = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const { from, to } = req.query;

  try {
    const results = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        const collectionQuery = `
          SELECT ip.patient_id, p.name, ip.receipt_date, ip.cashamt, ip.cardamt, ip.chequeamt, ip.onlineamt, ip.discountamt
          FROM ipd_payment ip
          JOIN patient p ON ip.patient_id = p.patient_id
          WHERE ip.receipt_date >= ? AND ip.receipt_date <= ?
          ORDER BY ip.receipt_date DESC
        `;

        const billsQuery = `
          SELECT i.invoice_id, i.patient_id, p.name, p.phone, p.sex, i.discount, i.status, i.payable_amt, i.totalamt
          FROM invoice i
          JOIN patient p ON i.patient_id = p.patient_id
          WHERE i.creation_date >= ? AND i.creation_date <= ? AND i.is_deleted != 1
        `;

        const queryParams = [from, to];

        // Execute both queries in parallel
        Promise.all([
          new Promise((res, rej) =>
            tempCon.query(collectionQuery, queryParams, (e, r) =>
              e ? rej(e) : res(r)
            )
          ),
          new Promise((res, rej) =>
            tempCon.query(billsQuery, queryParams, (e, r) =>
              e ? rej(e) : res(r)
            )
          ),
        ])
          .then(([ipdCollection, ipdBills]) => {
            tempCon.release();
            resolve({ ipdCollection, ipdBills });
          })
          .catch((error) => {
            tempCon.release();
            reject(error);
          });
      });
    });

    return results;
  } catch (error) {
    console.error("Error in getIPDReportData:", error);
    throw error;
  }
};

module.exports = {
  getCallAndWebData,
  addApprovalDetails,
  getApprovalDetails,
  getIPDReportData,
};
