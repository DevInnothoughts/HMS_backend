const { default: axios } = require("axios");
const { getConnectionByLocation } = require("../../databaseUtils");

const getPatient = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    // Ensure a promise-based approach to handle the connection
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) {
          return reject(err);
        }

        let sql;
        const queryParams = [];

        if (req.query.name) {
          sql = `
            SELECT *
            FROM patient
            WHERE name LIKE ?
            ORDER BY patient_id DESC
          `;
          queryParams.push(`%${req.query.name}%`);
        } else if (req.query.mobile) {
          sql = `
            SELECT *
            FROM patient
            WHERE phone LIKE ?
            OR mobile_2 LIKE ?
            ORDER BY patient_id DESC
          `;
          queryParams.push(req.query.mobile, req.query.mobile);
        } else {
          // No valid query parameter
          tempCon.release();
          return reject(new Error("No valid query parameters provided"));
        }

        tempCon.query(sql, queryParams, (error, rows) => {
          tempCon.release();
          if (error) {
            return reject(error);
          }
          resolve(rows);
        });
      });
    });

    console.log(rows);
    return rows;
  } catch (error) {
    console.error("Error fetching patient data:", error);
    throw error;
  }
};

const getDiagnosis = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) {
          return reject(err);
        }

        const sql = `
          SELECT 
            di.date_diagnosis,
            di.diagnosis,
            di.diagnosisAdvice,
            di.advice,
            consultantDoctor.name AS consultantDoctor,
            assistantDoctor.name AS assistantDoctor
          FROM diagnosis di
          JOIN doctor consultantDoctor ON di.consultantDoctor = consultantDoctor.doctor_id
          JOIN doctor assistantDoctor ON di.assistanceDoctor = assistantDoctor.doctor_id
          WHERE di.patient_id = ?
          ORDER BY di.diag_id ASC
        `;

        const queryParams = [req.query.patientId]; // Parameters for the SQL query

        tempCon.query(sql, queryParams, (error, rows) => {
          tempCon.release();
          if (error) {
            return reject(error);
          }
          resolve(rows);
        });
      });
    });

    console.log(rows);
    return rows;
  } catch (error) {
    console.error("Error fetching diagnosis data:", error);
    throw error;
  }
};

async function getReference(req) {
  const { connection, location } = getConnectionByLocation(req.query.location);
  console.log(
    new Date(req.query.from).getTime(),
    new Date(req.query.to).getTime()
  );

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  // Function to execute a query
  const executeQuery = (query, values = []) => {
    return new Promise((resolve, reject) => {
      connection.query(query, values, (error, results) => {
        if (error) {
          return reject(error);
        }
        resolve(results);
      });
    });
  };

  const getCounts = async () => {
    try {
      const referenceTypeCountQuery = `
      SELECT reference_type, COUNT(*) AS count
      FROM patient
      WHERE date >= ?  
      AND date <= ?
      AND ConfirmPatient = 1
      AND is_deleted = 0
      GROUP BY reference_type;
    `;

      const referenceTypeCount = await executeQuery(referenceTypeCountQuery, [
        req.query.from,
        req.query.to,
      ]);

      // Mapping of reference types to readable names
      const referenceTypeMap = {
        dr_ref: "Referred By Doctor",
        family_friends: "Family Friends",
        hhc_board: "HHC Board",
        HHF: "HHF",
        internet: "Internet",
        MediaRef: "Media Referral",
        newspaper: "Newspaper",
        old_ref: "Old Patient Referral",
        other: "Other",
        WOM: "Word of Mouth",
        self_old_pt: "Old Patient",
        hhc_branch: "HHC Branch",
        null: "Unknown",
      };

      // Calculate total count
      let totalCount = referenceTypeCount.reduce(
        (sum, item) => sum + item.count,
        0
      );

      // Transform data with readable names and percentage calculation
      const transformedData = referenceTypeCount.map((item) => {
        const percentage = Math.round((item.count / totalCount) * 100); // Round to nearest whole number
        return {
          reference_type:
            referenceTypeMap[item.reference_type] || item.reference_type,
          count: item.count,
          percentage: percentage,
        };
      });

      console.log(transformedData);

      return { referenceTypeCount: transformedData, totalCount };
    } catch (error) {
      console.error("Error executing queries:", error);
      throw error;
    }
  };

  return getCounts();
}

async function getReferenceV2(req) {
  const { connection, location } = getConnectionByLocation(req.query.location);
  const fromDate = req.query.from;
  const toDate = req.query.to;

  if (!connection) {
    const err = new Error("Invalid location");
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

  const getCounts = async () => {
    try {
      // Step 1: Get total invoice count (in same date range, only for patients that are confirmed & not deleted)
      const totalInvoiceCountQuery = `
      SELECT COUNT(*) AS totalInvoiceCount
      FROM invoice i
      JOIN patient p ON i.patient_id = p.patient_id
      WHERE p.date >= ? AND p.date <= ? 
      AND p.ConfirmPatient = 1 AND p.is_deleted = 0
    `;
      const [{ totalInvoiceCount }] = await executeQuery(
        totalInvoiceCountQuery,
        [req.query.from, req.query.to]
      );

      // Step 2: Get reference type count
      const referenceTypeCountQuery = `
      SELECT reference_type, COUNT(*) AS count
      FROM patient
      WHERE date >= ?  
      AND date <= ?
      AND ConfirmPatient = 1
      AND is_deleted = 0
      GROUP BY reference_type;
    `;
      const referenceTypeCount = await executeQuery(referenceTypeCountQuery, [
        req.query.from,
        req.query.to,
      ]);

      // Mapping of reference types to readable names
      const referenceTypeMap = {
        dr_ref: "Referred By Doctor",
        family_friends: "Family Friends",
        hhc_board: "HHC Board",
        HHF: "HHF",
        internet: "Internet",
        MediaRef: "Media Referral",
        newspaper: "Newspaper",
        old_ref: "Old Patient Referral",
        other: "Other",
        WOM: "Word of Mouth",
        self_old_pt: "Old Patient",
        hhc_branch: "HHC Branch",
        null: "Unknown",
      };

      const totalCount = referenceTypeCount.reduce(
        (sum, item) => sum + item.count,
        0
      );

      const transformedData = [];

      for (const item of referenceTypeCount) {
        const count = item.count;
        const refType = item.reference_type;

        // Step 3: Get invoice count for this reference type
        const invoiceCountQuery = `
        SELECT COUNT(*) AS invoiceCount
        FROM invoice i
        JOIN patient p ON i.patient_id = p.patient_id
        WHERE p.date >= ? AND p.date <= ?
        AND p.ConfirmPatient = 1
        AND p.is_deleted = 0
        AND p.reference_type = ?
      `;
        const [{ invoiceCount }] = await executeQuery(invoiceCountQuery, [
          req.query.from,
          req.query.to,
          refType,
        ]);

        const percentage = Math.round((count / totalCount) * 100);
        const invoicePercentage =
          totalInvoiceCount > 0
            ? Math.round((invoiceCount / totalInvoiceCount) * 100)
            : 0;

        transformedData.push({
          reference_type: referenceTypeMap[refType] || refType,
          count,
          percentage,
          invoiceCount,
          invoicePercentage,
        });
      }

      return {
        referenceTypeCount: transformedData,
        totalCount,
        totalInvoiceCount,
      };
    } catch (error) {
      console.error("Error executing queries:", error);
      throw error;
    }
  };

  return getCounts();
}

async function getTomorrowsAppointment(loc) {
  const { connection, location } = getConnectionByLocation(loc);
  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  return new Promise((resolve, reject) => {
    connection.getConnection(function (err, tempCon) {
      if (err) {
        return reject(err);
      }

      // Get tomorrow's date in YYYY-MM-DD format
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const formattedTomorrow = tomorrow.toLocaleDateString("en-CA", {
        timeZone: "Asia/Kolkata",
      });

      const tomorrowsAppointmentQuery = `
        SELECT
          ap.appointment_id,
          ap.patient_phone,
          ap.patient_type,
          ap.appointment_timestamp,
          ap.appointment_time,
          ap.FDE_Name,
          ap.note,
          d.name AS doctor_name,
          p.name AS patient_name
        FROM 
          appointment ap
        LEFT JOIN 
          patient p ON ap.patient_id = p.patient_id
        LEFT JOIN
          doctor d ON ap.doctor_id = d.doctor_id
        WHERE 
          DATE(ap.appointment_timestamp) = ?
        ORDER BY 
          ap.appointment_id ASC;
      `;

      tempCon.query(
        tomorrowsAppointmentQuery,
        [formattedTomorrow],
        function (error, rows) {
          tempCon.release();
          if (error) {
            return reject(error);
          }

          //console.log(rows); // Log the fetched appointments
          resolve(rows);
        }
      );
    });
  });
}

const sendScheduledWhatsAppMsg = async (
  patientPhone,
  doctorName,
  appoDate,
  appoTime,
  branchLocation,
  fdName
) => {
  // Define the start and end time
  const startTime = new Date(`1970-01-01T${appoTime}:00`).toLocaleTimeString(
    [],
    { hour: "2-digit", minute: "2-digit" }
  );
  const endTime = new Date(
    new Date(`1970-01-01T${appoTime}:00`).getTime() + 60 * 60 * 1000
  ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const timeRange = `${startTime} to ${endTime}`;

  // Branch location details (same as the PHP function)
  let branchaddress = "";
  let helpline = "";
  let googlemap = "";

  switch (branchLocation) {
    case "DP Road":
      branchaddress =
        "Ground Floor, Millenium Star Extension, Dhole Patil Road, Pune";
      helpline = "8888288884";
      googlemap = "https://goo.gl/maps/5hV85GqaVfSCRejC7";
      break;
    case "Tilak Road":
      branchaddress = "Mangalmurti Complex, 105, Tilak Road, Pune";
      helpline = "8888288884";
      googlemap = "https://maps.app.goo.gl/ZLiwZr5aLUwU8XdPA";
      break;
    case "Salunkhe-Vihar":
    case "Salunke Vihar":
      branchaddress = "101/102 Girme Towers, Wanowrie, Pune";
      helpline = "8888522226";
      googlemap = "https://maps.app.goo.gl/cnDzyEFSiDBqVxXs8";
      break;
    case "Baner":
      branchaddress = "1st floor, Crystal Empire Building, Baner, Pune";
      helpline = "8888622221";
      googlemap = "https://goo.gl/maps/7yBP3kPn2C9jtNwz6";
      break;
    case "Pimpri-Chinchwad":
    case "Chinchwad":
      branchaddress = "Second floor, Premier Plaza, Chinchwad, Pune";
      helpline = "8888200004";
      googlemap = "https://maps.app.goo.gl/wXetuZV9sFqxhebn7";
      break;
    case "Chakan":
      branchaddress = "1st Floor, Gokul Complex, Chakan, Pune";
      helpline = "8888596666";
      googlemap = "https://goo.gl/maps/cNdvDPK2sqTM9Rwp9";
      break;
    case "Dighi":
      branchaddress = "Amrutdhara Commercial Hub, Charholi Budruk, Pune";
      helpline = "8483999588";
      googlemap = "https://maps.app.goo.gl/9wNEDTMtG3qwtsYLA";
      break;
    case "Katraj":
      branchaddress =
        "Ground Floor, Atmosphere Building, Ambegaon Budruk, Pune";
      helpline = "9175235343";
      googlemap = "";
      break;
    case "Undri":
      branchaddress = "220, Marvel sangria, Mohammed Wadi, Pune";
      helpline = "8888522226";
      googlemap = "https://maps.app.goo.gl/YPi5Fd455tjsTRLP6";
      break;
    case "Hinjewadi":
      branchaddress = "AH Infotech, 3rd Floor, Hinjawadi, Pune";
      helpline = "9175232340";
      googlemap = "https://maps.app.goo.gl/E75SswJ4EJTY9JK27";
      break;
    case "Vashi":
      branchaddress = "Unit no 18, Palm Beach Galleria, Vashi, New Mumbai";
      helpline = "9175232308";
      googlemap = "";
      break;
    case "Navi-Mumbai":
    case "Navi Mumbai":
      branchaddress = "Gahlot Majesty, Navi Mumbai";
      helpline = "8888166667";
      googlemap = "https://goo.gl/maps/QV383Zezxs1jWRCu6";
      break;
    case "Kemps-Corner":
      branchaddress =
        "3rd Floor, Advani Chambers, August Kranti Marg, Kemps Corner, Malabar Hill, Mumbai, Maharashtra 400036";
      helpline = "8888266664";
      googlemap = "https://goo.gl/maps/ZHNqt9YcWZg5EXmG6";
      break;
    case "Thane":
      branchaddress = "Cosmos Jewels, 3rd floor, Thane West";
      helpline = "8575999994";
      googlemap = "https://maps.app.goo.gl/tcGBRcV72VmSv4Zq6";
      break;
    case "Andheri":
      branchaddress =
        "B-3 ,C-4, 1st floor, Mayfair Meridien HSG Society, Andheri West, Mumbai";
      helpline = "9156634201";
      googlemap = "https://goo.gl/maps/PaupXzJFyVpEauG88";
      break;
    case "Nashik":
      branchaddress = "3rd floor, Above MacDonald, Nashik";
      helpline = "8888366662";
      googlemap = "https://goo.gl/maps/FfocHX1R3vK3dqNM7";
      break;
    case "Kolhapur":
      branchaddress =
        "Kukreja Nursing home, 232 3b 2a, near Telephone Bhavan, Tarabai Park, Kolhapur, Maharashtra 416003.";
      helpline = "8956223460";
      googlemap = "https://goo.gl/maps/MJuBSSbUKzwcphut8";
      break;
    case "Latur":
      branchaddress = "MG Rd, Latur";
      helpline = "8956223459";
      googlemap = "https://goo.gl/maps/m5W9qXUGEAkE1p6BA";
      break;
    case "Lucknow":
      branchaddress = "L-2/761, Vinay Khand 2, Lucknow";
      helpline = "";
      googlemap = "";
      break;
    case "Bangalore":
    case "JP Nagar":
      branchaddress = "Krishna towers, Ground floor, JP Nagar, Bengaluru";
      helpline = "8888133338";
      googlemap = "https://goo.gl/maps/mZye2mYQt9inHV3F8";
      break;
    case "Indiranagar":
      branchaddress = "3rd Floor Krishvi Aspire, Indiranagar, Bengaluru";
      helpline = "8197978641";
      googlemap = "https://goo.gl/maps/9xHENbGGTb4C9guC8";
      break;
    case "Sahakarnagar":
    case "Sahakar Nagar":
      branchaddress =
        "1st Floor, above McDonalds, F Block, Sahakar Nagar, Bengaluru";
      helpline = "9731118056";
      googlemap = "https://goo.gl/maps/fKx2Z5iRAuEQFugTA";
      break;
    case "Belagavi":
    case "Belgavi":
      branchaddress = "C/O Sbg hospital, Belagavi";
      helpline = "8600002156";
      googlemap = "https://maps.app.goo.gl/qnLx7Yc8VZJHeVsa7";
      break;
    case "Hyderabad":
      branchaddress = "1st Floor, DK's Kavya House, Jubilee Hills, Hyderabad";
      helpline = "7680862049";
      googlemap = "https://goo.gl/maps/ouqsC1e5AA11EBhR7";
      break;
    case "Ludhiana":
      branchaddress = "Gobind Nagar, Ludhiana, Punjab";
      helpline = "7986935908";
      googlemap = "https://goo.gl/maps/B6GboeLp3bWrLnGU9";
      break;
    case "Surat":
      branchaddress = "Third Floor, VIP Plaza, Surat";
      helpline = "7436008844";
      googlemap = "https://goo.gl/maps/jZ9cCPBqwP43x6Q58";
      break;
    case "Gurgaon-49":
    case "Gurgaon Sector 49":
      branchaddress =
        "Spaze ITech Park, Tower C, Ground Floor, Sector 49, Gurugram";
      helpline = "9990479800";
      googlemap = "https://maps.app.goo.gl/iS8WboxRXfR8TF8BA";
      break;
    case "Gurgaon-14":
    case "Gurgaon Sector 14":
      branchaddress = "1st Floor, Sheetla Chamber, Sector 14, Gurugram";
      helpline = "9990473800";
      googlemap = "https://maps.app.goo.gl/yCXnMS373kSmS54HA";
      break;
    case "Kalaburagi":
      branchaddress = "Shanta hospital, 4 th floor, Kalaburagi";
      helpline = "9164045999";
      googlemap = "";
      break;
    case "HSR":
      branchaddress = "1st Floor, Krishna Complex, HSR Layout, Bengaluru";
      helpline = "8792950455";
      googlemap = "";
      break;
    case "Rajajinagar":
    case "Rajaji Nagar":
      branchaddress = "2nd floor, above HDFC Bank, Rajajinagar, Bengaluru";
      helpline = "7996126669";
      googlemap = "";
      break;
    case "Sarjapura":
      branchaddress = "Trinity Complex, Sarjapura, Bengaluru";
      helpline = "9036053501";
      googlemap = "";
      break;
    case "Mysore":
      branchaddress = "1st and 2nd Floor, Scarlet Towers, Mysore";
      helpline = "8971928968";
      googlemap = "https://g.co/kgs/qNo5GKP";
      break;
    case "Secunderabad":
      branchaddress =
        "1st floor, Chandragiri Colony, Tirumalgiri, Secunderabad";
      helpline = "8977520083";
      googlemap = "https://g.co/kgs/ZCihPnZ";
      break;
    default:
      branchaddress = "Location not found.";
      helpline = "";
      googlemap = "";
      break;
  }

  // Prepare data to send in the API request
  const data = {
    broadcast_name: "appointment_msg",
    template_name: "appointment_msg_1",
    parameters: [
      { name: "address", value: branchaddress },
      { name: "doctor_name", value: doctorName },
      { name: "appointment_date", value: appoDate },
      { name: "appointment_time", value: timeRange },
      { name: "helpline", value: helpline },
      { name: "map_link", value: googlemap },
      { name: "fde_name", value: fdName },
      { name: "branch_name", value: branchLocation },
    ],
  };

  // Make the API call to send the WhatsApp message
  const whatsappUrl = `https://live-server-115992.wati.io/api/v1/sendTemplateMessage?whatsappNumber=${patientPhone}`;

  try {
    const response = await axios.post(whatsappUrl, data, {
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI3MTU3MzdjNC04NzhjLTQ0ZGQtOTBjZC04ZmY2NGRlMDUyYzkiLCJ1bmlxdWVfbmFtZSI6InByYXNhZGhoYzIwMjNAZ21haWwuY29tIiwibmFtZWlkIjoicHJhc2FkaGhjMjAyM0BnbWFpbC5jb20iLCJlbWFpbCI6InByYXNhZGhoYzIwMjNAZ21haWwuY29tIiwiYXV0aF90aW1lIjoiMTAvMjYvMjAyMyAxMjozMzo1MiIsImRiX25hbWUiOiIxMTU5OTIiLCJodHRwOi8vc2NoZW1hcy5taWNyb3NvZnQuY29tL3dzLzIwMDgvMDYvaWRlbnRpdHkvY2xhaW1zL3JvbGUiOiJBRE1JTklTVFJBVE9SIiwiZXhwIjoyNTM0MDIzMDA4MDAsImlzcyI6IkNsYXJlX0FJIiwiYXVkIjoiQ2xhcmVfQUkifQ.bC3SVh28fDgASthq1A8oRXrCvrNxQrna-BWh4p_R3eg", // Replace with your actual API key
      },
    });

    console.log("Message sent successfully:", response.data);
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
  }
};

module.exports = {
  getPatient,
  getDiagnosis,
  getReference,
  getReferenceV2,
  getTomorrowsAppointment,
  sendScheduledWhatsAppMsg,
};
