const { getConnectionByLocation } = require("../../databaseUtils");
const { getApprovalDetails } = require("./approvalModel");

const excludedNumbers = [
  "+917411951943",
  "+918123922650",
  "+917411804875",
  "+918147647685",
  "+917411951965",
  "+917411805024",
  "+917411951962",
  "+918971928968",
  "+918123919853",
  "+918123919853",
  "+918147647677",
  "+917411951963",
  "+918792498991",
  "+919164045999",
  "+918855865060",
  "+918888188885",
]; //

async function getDashboardValues(req) {
  const { connection, location } = getConnectionByLocation(req.query.location);
  console.log(req.query.from, req.query.to);

  const fromDate = req.query.from;
  const toDate = req.query.to;
  const startOfDay = new Date(`${fromDate}T00:00:00+05:30`).getTime();
  const endOfDay = new Date(`${toDate}T23:59:59+05:30`).getTime();

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
      const totalPatientCountQuery = `
        SELECT COUNT(patient_id) AS totalPatients
        FROM patient p
        WHERE p.ConfirmPatient = 1  
        AND p.is_deleted !=1
      `;

      const npsAverageQuery = `SELECT
          ROUND(
              AVG(
                  CAST(
                      JSON_UNQUOTE(JSON_EXTRACT(ratingInfo, '$.averageRating'))
                      AS DECIMAL(5,2)
                  )
              ),
              2
          ) AS branch_average_rating,
          COUNT(*) AS rated_patient_count
      FROM invoice
      WHERE ratingInfo IS NOT NULL
        AND JSON_EXTRACT(ratingInfo, '$.averageRating') IS NOT NULL
        AND creation_date BETWEEN
            CASE
                WHEN MONTH(CURDATE()) >= 4
                THEN CONCAT(YEAR(CURDATE()), '-04-01')
                ELSE CONCAT(YEAR(CURDATE()) - 1, '-04-01')
            END
            AND
            CASE
                WHEN MONTH(CURDATE()) >= 4
                THEN CONCAT(YEAR(CURDATE()) + 1, '-03-31')
                ELSE CONCAT(YEAR(CURDATE()), '-03-31')
            END;
      `;
      const genderWiseCountQuery = `SELECT 
    COUNT(CASE WHEN p.sex = 'Male' THEN 1 END) AS malePatients,
    COUNT(CASE WHEN p.sex = 'Female' THEN 1 END) AS femalePatients
FROM patient p
WHERE p.ConfirmPatient = 1  
AND p.is_deleted != 1;
`;
      // Counts for patient types
      const newPatientCountQuery = `
        SELECT COUNT(patient_type) AS newpatient
        FROM appointment ap
        WHERE ap.appointment_timestamp >= ?  
  AND ap.appointment_timestamp <= ?
          AND patient_type = 'New'
          AND is_deleted != 1
          AND confirm_time != '0'
      `;
      const followPatientCountQuery = `
        SELECT COUNT(patient_type) AS followpatient
        FROM appointment ap
        WHERE ap.appointment_timestamp >= ?  
  AND ap.appointment_timestamp <= ?
          AND patient_type = 'Follow'
          AND is_deleted != 1
          AND confirm_time != '0'
      `;
      const poPatientCountQuery = `
        SELECT COUNT(patient_type) AS popatient
        FROM appointment ap
        WHERE ap.appointment_timestamp >= ?  
  AND ap.appointment_timestamp <= ?
          AND patient_type = 'Postoperative'
          AND is_deleted != 1
         AND confirm_time != '0'
      `;

      // Proctoscopy count
      const proctoscopyCountQuery = `
        SELECT COUNT(consultation) AS proctoscopy
        FROM patient_itemreceipt
        WHERE item_date >= ?
        AND item_date <= ?
          AND consultation = 'PROCTOSCOPY'
          AND is_deleted != 1
      `;

      const appointmentCountQuery = `
  SELECT 
    COUNT(*) AS appointment_count
  FROM appointment ap
  WHERE ap.appointment_timestamp >= ?  
  AND ap.appointment_timestamp <= ?
  AND ap.is_deleted != 1
`;
      const ipdCountQuery = `
  SELECT 
    COUNT(*) AS ipd_count
  FROM invoice i
  WHERE i.creation_date >= ?  
  AND i.creation_date <= ?
  AND i.is_deleted != 1
`;

      const dischargeCardCountQuery = `
  SELECT 
    COUNT(*) AS dc_count
  FROM discharge_card d
  WHERE d.DOD >= ?  
  AND d.DOD <= ?
`;

      const MissedCallCountQuery = `
    SELECT 
      COUNT(*) AS missed_count
    FROM IVRdata i
   WHERE STR_TO_DATE(i.call_date, "%Y-%d-%m") >= ?
  AND STR_TO_DATE(i.call_date, "%Y-%d-%m") <= ?
  AND call_status = 'Missed'
   AND destination_no != ''
  `;

      const AttendedMissedCallCountQuery = `
    SELECT 
      COUNT(*) AS attended_missed_count
    FROM IVRdata i
   WHERE STR_TO_DATE(i.call_date, "%Y-%d-%m") >= ?
    AND STR_TO_DATE(i.call_date, "%Y-%d-%m") <= ?
    AND call_status = 'Missed'
    AND destination_no != ''
    AND (status !='' OR note != '')
  `;
      const AnsweredCallCountQuery = `
    SELECT 
      COUNT(*) AS answered_count
    FROM IVRdata i
   WHERE STR_TO_DATE(i.call_date, "%Y-%d-%m") >= ?
  AND STR_TO_DATE(i.call_date, "%Y-%d-%m") <= ?
  AND call_status = 'Answered'
  AND destination_no != ''
  `;

      const HelplineMissedCallCountQuery = `
    SELECT 
      COUNT(*) AS helpline_missed_count
    FROM phonecalllogs p
   WHERE timestamp BETWEEN ? AND ?
  AND p.phoneNumber NOT IN (${excludedNumbers.map(() => "?").join(",")})
  AND (p.type = 'MISSED' OR p.type = 'UNKNOWN')
  `;

      const HelplineAttendedMissedCallCountQuery = `
          SELECT
            COUNT(*) AS helpline_attended_missed_count
          FROM phonecalllogs p
         WHERE timestamp BETWEEN ? AND ?
           AND note IS NOT NULL
          AND note <> ''
          AND p.type IN ('MISSED', 'UNKNOWN')
           AND p.phoneNumber NOT IN (${excludedNumbers
             .map(() => "?")
             .join(",")})
        `;
      //         `SELECT COUNT(DISTINCT p1.phoneNumber) AS helpline_attended_missed_count
      // FROM phonecalllogs p1
      // WHERE p1.timestamp BETWEEN ? AND ?
      //   AND p1.phoneNumber NOT IN (${excludedNumbers.map(() => "?").join(",")})
      //   AND (p1.type = 'MISSED' OR p1.type = 'UNKNOWN')
      //   AND EXISTS (
      //     SELECT 1
      //     FROM phonecalllogs p2
      //     WHERE p2.timestamp BETWEEN ? AND ?
      //       AND p2.phoneNumber = p1.phoneNumber
      //       AND p2.type = 'OUTGOING'
      //   )`;

      const HelplineAnsweredCallCountQuery = `
    SELECT 
      COUNT(*) AS helpline_answered_count
    FROM phonecalllogs p
   WHERE timestamp BETWEEN ? AND ?
   AND p.phoneNumber NOT IN (${excludedNumbers.map(() => "?").join(",")})
  AND p.type = 'INCOMING'
  `;
      const HelplineOutgoingCallCountQuery = `
    SELECT 
      COUNT(*) AS helpline_outgoing_count
    FROM phonecalllogs p
   WHERE timestamp BETWEEN ? AND ?
   AND p.phoneNumber NOT IN (${excludedNumbers.map(() => "?").join(",")})
  AND p.type = 'OUTGOING'
  `;

      const [
        newPatientCount,
        followPatientCount,
        poPatientCount,
        proctoscopyCount,
        appointment_count,
        ipd_count,
        dc_count,
        missed_count,
        attended_missed_count,
        answered_count,
        helpline_missed_count,
        helpline_attended_missed_count,
        helpline_answered_count,
        helpline_outgoing_count,
        totalPatientCount,
        npsAverageCount,
      ] = await Promise.all([
        executeQuery(newPatientCountQuery, [req.query.from, req.query.to]),
        executeQuery(followPatientCountQuery, [req.query.from, req.query.to]),
        executeQuery(poPatientCountQuery, [req.query.from, req.query.to]),
        executeQuery(proctoscopyCountQuery, [req.query.from, req.query.to]),
        executeQuery(appointmentCountQuery, [req.query.from, req.query.to]),
        executeQuery(ipdCountQuery, [req.query.from, req.query.to]),
        executeQuery(dischargeCardCountQuery, [req.query.from, req.query.to]),
        executeQuery(MissedCallCountQuery, [req.query.from, req.query.to]),
        executeQuery(AttendedMissedCallCountQuery, [
          req.query.from,
          req.query.to,
        ]),
        executeQuery(AnsweredCallCountQuery, [req.query.from, req.query.to]),
        executeQuery(HelplineMissedCallCountQuery, [
          startOfDay,
          endOfDay,
          ...excludedNumbers,
        ]),
        executeQuery(HelplineAttendedMissedCallCountQuery, [
          startOfDay,
          endOfDay,
          ...excludedNumbers,
          startOfDay,
          endOfDay,
        ]),
        executeQuery(HelplineAnsweredCallCountQuery, [
          startOfDay,
          endOfDay,
          ...excludedNumbers,
        ]),
        executeQuery(HelplineOutgoingCallCountQuery, [
          startOfDay,
          endOfDay,
          ...excludedNumbers,
        ]),
        executeQuery(totalPatientCountQuery),
        executeQuery(npsAverageQuery),
      ]);

      const approvalStatus = await getApprovalDetails(req.query.location);
      console.log("NPS Average:", npsAverageCount[0].branch_average_rating);

      return {
        dailyOPDReport: {
          new: newPatientCount[0].newpatient,
          FU: followPatientCount[0].followpatient,
          PO: poPatientCount[0].popatient,
          procto: proctoscopyCount[0].proctoscopy,
        },
        totalPatients: totalPatientCount[0].totalPatients,
        appointment_count: appointment_count[0].appointment_count,
        ipd_count: ipd_count[0].ipd_count,
        dc_count: dc_count[0].dc_count,
        missed_count: missed_count[0].missed_count,
        attended_missed_count: attended_missed_count[0].attended_missed_count,
        answered_count: answered_count[0].answered_count,
        helpline_missed_count: helpline_missed_count[0].helpline_missed_count,
        helpline_attended_missed_count:
          helpline_attended_missed_count[0].helpline_attended_missed_count,
        helpline_answered_count:
          helpline_answered_count[0].helpline_answered_count,
        helpline_outgoing_count:
          helpline_outgoing_count[0].helpline_outgoing_count,
        approvalStatus,
        nps_avg: npsAverageCount[0].branch_average_rating || 0,
      };
    } catch (error) {
      console.error("Error executing queries:", error);
      throw error;
    }
  };

  return getCounts();
}

const getDCData = async (req) => {
  console.log(req.query.location);
  console.log(req.query.from);
  console.log(req.query.to);
  const { connection, location } = getConnectionByLocation(req.query.location); // Ensure `req.params.location` is correct

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    // Using a promise-based approach to handle the connection
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) {
          return reject(err);
        }

        const sql = `
          SELECT dc.discharge_id, dc.patient_id, dc.DOA, dc.DOD, dc.surgeryadvice, p.name,p.phone, d.name AS doctor_name, madeByD.name AS made_by, checkByD.name AS checked_by
          FROM discharge_card dc
          LEFT JOIN patient p ON dc.patient_id = p.patient_id
          LEFT JOIN doctor d ON dc.consultantName = d.doctor_id
          LEFT JOIN doctor madeByD ON dc.madeby = madeByD.doctor_id
          LEFT JOIN doctor checkByD ON dc.checkedby = checkByD.doctor_id
          WHERE dc.DOD >= ?  
          AND dc.DOD <= ?
        `;

        const queryParams = [req.query.from, req.query.to]; // Parameters for the SQL query

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
    throw error;
  }
};

async function getOPDReportData(req) {
  const { connection } = getConnectionByLocation(req.query.location);

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

  const getDetails = async () => {
    try {
      const patientType = req.query.patientType
        ? req.query.patientType.trim().toLowerCase()
        : "";

      let query;

      switch (patientType) {
        case "new":
          query = `SELECT 
              ap.patient_phone,
              ap.patient_type,
              ap.appointment_timestamp,
              ap.appointment_time,
              ap.confirm_time,
              ap.FDE_Name,
              ap.executivechk,
               ap.is_deleted,
              p.patient_id,
              p.name AS patient_name,
              p.sex AS gender,
              d.name AS doctor_name
            FROM appointment ap
            LEFT JOIN patient p ON ap.patient_id = p.patient_id
            LEFT JOIN doctor d ON ap.doctor_id = d.doctor_id
            WHERE ap.appointment_timestamp >= ?  
            AND ap.appointment_timestamp <= ?
            AND ap.patient_type = 'New'`;
          break;

        case "postoperative":
          query = `SELECT 
              ap.patient_phone,
              ap.patient_type,
              ap.appointment_timestamp,
              ap.appointment_time,
              ap.confirm_time,
              ap.FDE_Name,
              ap.executivechk,
               ap.is_deleted,
              p.name AS patient_name,
              p.sex AS gender,
              d.name AS doctor_name
            FROM appointment ap
            LEFT JOIN patient p ON ap.patient_id = p.patient_id
            LEFT JOIN doctor d ON ap.doctor_id = d.doctor_id
            WHERE ap.appointment_timestamp >= ?  
            AND ap.appointment_timestamp <= ?
            AND ap.patient_type = 'Postoperative'
            `;
          break;

        case "follow":
          query = `SELECT 
              ap.patient_phone,
              ap.patient_type,
              ap.appointment_timestamp,
              ap.appointment_time,
              ap.confirm_time,
              ap.FDE_Name,
              ap.executivechk,
               ap.is_deleted,
              p.name AS patient_name,
              p.sex AS gender,
              d.name AS doctor_name
            FROM appointment ap
            LEFT JOIN patient p ON ap.patient_id = p.patient_id
            LEFT JOIN doctor d ON ap.doctor_id = d.doctor_id
            WHERE ap.appointment_timestamp >= ?  
            AND ap.appointment_timestamp <= ?
            AND ap.patient_type = 'Follow'
            `;
          break;

        case "proctoscopy":
          query = `SELECT 
        ap.patient_phone,
        ap.patient_type,
        ap.appointment_timestamp,
        ap.appointment_time,
        ap.confirm_time,
        ap.FDE_Name,
        ap.executivechk,
        ap.is_deleted,
        p.name AS patient_name,
        p.sex AS gender,
        d.name AS doctor_name
        FROM patient_itemreceipt pir
        JOIN patient p ON pir.patient_id = p.patient_id
        JOIN appointment ap ON ap.patient_id = pir.patient_id AND DATE(ap.appointment_timestamp) = pir.item_date
        JOIN doctor d ON ap.doctor_id = d.doctor_id
        WHERE pir.item_date >= ?
          AND pir.item_date <= ?
          AND pir.consultation = 'PROCTOSCOPY'
          AND ap.patient_type = 'New'
         `;
          break;

        default:
          throw new Error("Invalid patient type provided");
      }

      const queryResult = await executeQuery(query, [
        req.query.from,
        req.query.to,
      ]);

      return {
        data: queryResult,
      };
    } catch (error) {
      console.error("Error executing queries:", error);
      throw error;
    }
  };

  return getDetails();
}

async function getDoctorOPDReportData(req) {
  const { connection } = getConnectionByLocation(req.query.location);

  if (!connection) {
    throw new Error("Invalid location: Database connection not found.");
  }

  // Function to execute a query
  const executeQuery = (query, values = []) => {
    return new Promise((resolve, reject) => {
      connection.query(query, values, (error, results) => {
        if (error) {
          console.error("Database query error:", error);
          return reject(error);
        }
        resolve(results);
      });
    });
  };

  // Get Doctor ID
  const getDocId = async () => {
    try {
      if (!req.query.mobile) {
        throw new Error("Doctor mobile number is required.");
      }

      const doctorIdQuery = `
        SELECT doctor_id 
        FROM doctor 
        WHERE phone = ?  
        AND is_deleted != 1
      `;

      const doctorRows = await executeQuery(doctorIdQuery, [req.query.mobile]);

      if (doctorRows.length === 0) {
        return null; // No doctor found
      }

      return doctorRows[0].doctor_id;
    } catch (error) {
      console.error("Error fetching doctor ID:", error);
      throw error;
    }
  };

  const getDetails = async (doctorId) => {
    try {
      if (!req.query.from || !req.query.to) {
        throw new Error("Date range (from and to) is required.");
      }

      const patientType = req.query.patientType
        ? req.query.patientType.trim().toLowerCase()
        : "";

      let query;
      let queryParams = [req.query.from, req.query.to, doctorId];

      switch (patientType) {
        case "new":
          query = `
            SELECT 
              ap.patient_phone,
              ap.patient_type,
              ap.appointment_timestamp,
              ap.appointment_time,
              ap.confirm_time,
              ap.FDE_Name,
              p.name AS patient_name,
              d.name AS doctor_name
            FROM appointment ap
            JOIN patient p ON ap.patient_id = p.patient_id
            JOIN doctor d ON ap.doctor_id = d.doctor_id
            WHERE ap.appointment_timestamp BETWEEN ? AND ?
            AND ap.is_deleted != 1
            AND ap.patient_type = 'New'
            AND ap.doctor_id = ?
            AND ap.executivechk = 2`;
          break;

        case "postoperative":
          query = `
            SELECT 
              ap.patient_phone,
              ap.patient_type,
              ap.appointment_timestamp,
              ap.appointment_time,
              ap.confirm_time,
              ap.FDE_Name,
              p.name AS patient_name,
              d.name AS doctor_name
            FROM appointment ap
            JOIN patient p ON ap.patient_id = p.patient_id
            JOIN doctor d ON ap.doctor_id = d.doctor_id
            WHERE ap.appointment_timestamp BETWEEN ? AND ?
            AND ap.is_deleted != 1
            AND ap.patient_type = 'Postoperative'
            AND ap.doctor_id = ?
            AND ap.executivechk = 2`;
          break;

        case "follow":
          query = `
            SELECT 
              ap.patient_phone,
              ap.patient_type,
              ap.appointment_timestamp,
              ap.appointment_time,
              ap.confirm_time,
              ap.FDE_Name,
              p.name AS patient_name,
              d.name AS doctor_name
            FROM appointment ap
            JOIN patient p ON ap.patient_id = p.patient_id
            JOIN doctor d ON ap.doctor_id = d.doctor_id
            WHERE ap.appointment_timestamp BETWEEN ? AND ?
            AND ap.is_deleted != 1
            AND ap.patient_type = 'Follow'
            AND ap.doctor_id = ?
            AND ap.executivechk = 2`;
          break;

        case "proctoscopy":
          query = `
            SELECT 
              ap.patient_phone,
              ap.patient_type,
              ap.appointment_timestamp,
              ap.appointment_time,
              ap.confirm_time,
              ap.FDE_Name,
              p.name AS patient_name,
              d.name AS doctor_name
            FROM appointment ap
            JOIN patient p ON ap.patient_id = p.patient_id
            JOIN doctor d ON ap.doctor_id = d.doctor_id
            JOIN patient_itemreceipt pir ON ap.patient_id = pir.patient_id
            WHERE pir.item_date BETWEEN ? AND ?
            AND pir.consultation = 'PROCTOSCOPY'
            AND ap.is_deleted != 1
            AND ap.doctor_id = ?
            AND ap.executivechk = 2`;
          break;

        default:
          throw new Error("Invalid patient type provided: " + patientType);
      }

      const queryResult = await executeQuery(query, queryParams);

      return {
        doctor_id: doctorId,
        data: queryResult,
      };
    } catch (error) {
      console.error("Error executing queries:", error);
      throw error;
    }
  };

  // Fetch doctor ID
  const doctorId = await getDocId();

  if (!doctorId) {
    return {
      message: "Doctor not found for the given mobile number.",
      data: [],
    };
  }

  return getDetails(doctorId);
}

async function getDoctorDashboardValues(req) {
  const { connection, location } = getConnectionByLocation(req.query.location);

  console.log(
    // new Date(req.query.from).getTime(),
    // new Date(req.query.to).getTime(),
    req.query.mobile,
  );

  if (!connection) {
    throw new Error("Invalid location");
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

  // Get Doctor ID
  const getDocId = async () => {
    try {
      const doctorIdQuery = `
        SELECT doctor_id
        FROM doctor 
        WHERE phone = ?  
        AND is_deleted != 1
      `;

      const doctorRows = await executeQuery(doctorIdQuery, [req.query.mobile]);

      if (doctorRows.length === 0) {
        return null; // No doctor found
      }

      console.log(doctorRows);

      return doctorRows[0].doctor_id;
    } catch (error) {
      console.error("Error fetching doctor ID:", error);
      throw error;
    }
  };

  // Get Appointment & Discharge Counts
  const getCount = async (doctorId) => {
    try {
      if (!doctorId) {
        return {
          doctorId: null,
          appointment_count: 0,
          dc_count: 0,
        };
      }

      const appointmentCountQuery = `
        SELECT COUNT(*) AS appointment_count
        FROM appointment 
        WHERE DATE(appointment_timestamp) BETWEEN ? AND ?
        AND doctor_id = ?
        AND is_deleted != 1
      `;

      const dischargeCountQuery = `
          SELECT 
            COUNT(*) AS dc_count
          FROM discharge_card d
          WHERE d.DOD >= ?  
          AND d.DOD <= ?
          AND d.consultantName = ?
      `;

      // Counts for patient types
      const newPatientCountQuery = `
        SELECT COUNT(patient_type) AS newpatient
        FROM appointment ap
        WHERE ap.appointment_timestamp >= ?  
          AND ap.appointment_timestamp <= ?
          AND patient_type = 'New'
          AND doctor_id = ?
          AND is_deleted != 1
          AND executivechk = 2
      `;
      const followPatientCountQuery = `
        SELECT COUNT(patient_type) AS followpatient
        FROM appointment ap
        WHERE ap.appointment_timestamp >= ?  
  AND ap.appointment_timestamp <= ?
          AND patient_type = 'Follow'
          AND doctor_id = ?
          AND is_deleted != 1
          AND executivechk = 2
      `;
      const poPatientCountQuery = `
        SELECT COUNT(patient_type) AS popatient
        FROM appointment ap
        WHERE ap.appointment_timestamp >= ?  
  AND ap.appointment_timestamp <= ?
          AND patient_type = 'Postoperative'
          AND doctor_id = ?
          AND is_deleted != 1
          AND executivechk = 2
      `;

      const [
        appointmentCount,
        dischargeCount,
        newPatientCount,
        followPatientCount,
        poPatientCount,
      ] = await Promise.all([
        executeQuery(appointmentCountQuery, [
          req.query.from,
          req.query.to,
          doctorId,
        ]),
        executeQuery(dischargeCountQuery, [
          req.query.from,
          req.query.to,
          doctorId,
        ]),
        executeQuery(newPatientCountQuery, [
          req.query.from,
          req.query.to,
          doctorId,
        ]),
        executeQuery(followPatientCountQuery, [
          req.query.from,
          req.query.to,
          doctorId,
        ]),
        executeQuery(poPatientCountQuery, [
          req.query.from,
          req.query.to,
          doctorId,
        ]),
      ]);

      console.log(dischargeCount);

      return {
        doctorId,
        dailyOPDReport: {
          new: newPatientCount[0].newpatient,
          FU: followPatientCount[0].followpatient,
          PO: poPatientCount[0].popatient,
        },
        appointment_count: appointmentCount[0].appointment_count,
        dc_count: dischargeCount[0].dc_count,
      };
    } catch (error) {
      console.error("Error executing count queries:", error);
      throw error;
    }
  };

  const doctorId = await getDocId();
  return getCount(doctorId);
}

async function getDoctorsDCData(req) {
  const { connection, location } = getConnectionByLocation(req.query.location);
  if (!connection) {
    throw new Error("Invalid location");
  }

  // Function to execute a query
  const executeQuery = (tempCon, query, values = []) => {
    return new Promise((resolve, reject) => {
      tempCon.query(query, values, (error, results) => {
        if (error) {
          return reject(error);
        }
        resolve(results);
      });
    });
  };

  return new Promise((resolve, reject) => {
    connection.getConnection(async (err, tempCon) => {
      if (err) {
        return reject(err);
      }

      try {
        // Get Doctor ID
        const doctorIdQuery = `
          SELECT doctor_id 
          FROM doctor 
          WHERE phone = ? 
          AND is_deleted != 1
        `;

        const doctorRows = await executeQuery(tempCon, doctorIdQuery, [
          req.query.mobile,
        ]);

        if (doctorRows.length === 0) {
          return resolve({ doctorId: null, dischargeCards: [] });
        }

        const doctorId = doctorRows[0].doctor_id;

        // Get Discharge Cards for the Doctor
        const sql = `
          SELECT 
            dc.discharge_id, 
            dc.patient_id, 
            dc.DOA, 
            dc.DOD, 
            dc.surgeryadvice, 
            p.name AS patient_name, 
            p.phone AS patient_phone, 
            d.name AS doctor_name, 
            madeByD.name AS made_by, 
            checkByD.name AS checked_by
          FROM discharge_card dc
          LEFT JOIN patient p ON dc.patient_id = p.patient_id
          LEFT JOIN doctor d ON dc.consultantName = d.doctor_id
          LEFT JOIN doctor madeByD ON dc.madeby = madeByD.doctor_id
          LEFT JOIN doctor checkByD ON dc.checkedby = checkByD.doctor_id
          WHERE dc.DOD BETWEEN ? AND ?  
          AND dc.consultantName = ?  -- Corrected doctor_id reference
        `;

        const dischargeCards = await executeQuery(tempCon, sql, [
          req.query.from,
          req.query.to,
          doctorId,
        ]);

        console.log({ doctorId, dischargeCards });

        resolve({
          doctorId,
          dischargeCards,
        });
      } catch (error) {
        console.error("Error fetching doctor's discharge data:", error);
        reject(error);
      } finally {
        tempCon.release(); // Ensures the connection is released in all cases
      }
    });
  });
}

module.exports = {
  getDashboardValues,
  getOPDReportData,
  getDoctorOPDReportData,
  getDCData,
  getDoctorDashboardValues,
  getDoctorsDCData,
};
