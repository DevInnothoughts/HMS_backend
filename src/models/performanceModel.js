const { getConnectionByLocation } = require("../../databaseUtils");

function prepareChartData(currentData, previousData) {
  // Extract labels in sorted order (from currentData mainly)
  const labels = currentData.map((row) => row.label);

  // Create maps for quick lookup
  const currentMap = new Map(currentData.map((row) => [row.label, row.value]));
  const previousMap = new Map(
    previousData.map((row) => [row.label, row.value])
  );

  return {
    labels,
    thisYear: labels.map((label) => currentMap.get(label) || 0),
    lastYear: labels.map((label) => previousMap.get(label) || 0),
  };
}

// Utility: format DB results into { Monthly: {}, Quarterly: {}, Yearly: {} }
function buildResponse(monthlyData, quarterlyData, yearlyData) {
  return {
    Monthly: {
      "OPD Invoice": monthlyData.opd,
      "IPD Invoice": monthlyData.ipd,
      "New Appointments": monthlyData.new,
      "Follow-up Appointments": monthlyData.follow,
      //"Postoperative Appointments": monthlyData.postop,
      "IVR Calls": monthlyData.ivr,
      "Web Leads": monthlyData.web,
      "Bot Leads": monthlyData.bot,
    },
    Quarterly: {
      "OPD Invoice": quarterlyData.opd,
      "IPD Invoice": quarterlyData.ipd,
      "New Appointments": quarterlyData.new,
      "Follow-up Appointments": quarterlyData.follow,
      //"Postoperative Appointments": quarterlyData.postop,
      "IVR Calls": quarterlyData.ivr,
      "Web Leads": quarterlyData.web,
      "Bot Leads": quarterlyData.bot,
    },
    Yearly: {
      "OPD Invoice": yearlyData.opd,
      "IPD Invoice": yearlyData.ipd,
      "New Appointments": yearlyData.new,
      "Follow-up Appointments": yearlyData.follow,
      "IPD Patients": yearlyData.ipdPatient,
      //"Postoperative Appointments": yearlyData.postop,
      "IVR Calls": yearlyData.ivr,
      "Web Leads": yearlyData.web,
      "Bot Leads": yearlyData.bot,
    },
  };
}

function mergeLeads(ivrData, webData, botData) {
  const map = new Map();

  // Add IVR
  ivrData.forEach((row) => {
    map.set(row.label, {
      label: row.label,
      ivr: row.value,
      web: 0,
      bot: 0,
    });
  });

  // Merge Web
  webData.forEach((row) => {
    if (!map.has(row.label)) {
      map.set(row.label, {
        label: row.label,
        ivr: 0,
        web: row.value,
        bot: 0,
      });
    } else {
      map.get(row.label)["web"] = row.value;
    }
  });

  // Merge Bot
  botData.forEach((row) => {
    if (!map.has(row.label)) {
      map.set(row.label, {
        label: row.label,
        ivr: 0,
        web: 0,
        bot: row.value,
      });
    } else {
      map.get(row.label)["bot"] = row.value;
    }
  });

  // Convert Map → Array sorted by label order in ivrData
  return Array.from(map.values());
}

function mergePatients(newData, followData) {
  const map = new Map();

  // Add IVR
  newData.forEach((row) => {
    map.set(row.label, {
      label: row.label,
      new: row.value,
      follow: 0,
      //postop: 0,
    });
  });

  // Merge Web
  followData.forEach((row) => {
    if (!map.has(row.label)) {
      map.set(row.label, {
        label: row.label,
        new: 0,
        follow: row.value,
        //postop: 0,
      });
    } else {
      map.get(row.label)["follow"] = row.value;
    }
  });

  // Merge Bot
  // postopData.forEach((row) => {
  //   if (!map.has(row.label)) {
  //     map.set(row.label, {
  //       label: row.label,
  //       new: 0,
  //       follow: 0,
  //       postop: row.value,
  //     });
  //   } else {
  //     map.get(row.label)["postop"] = row.value;
  //   }
  // });
  // Convert Map → Array sorted by label order in ivrData
  return Array.from(map.values());
}

// aliases you showed, turned into plain terms (without %)
const LOCATION_ALIASES = {
  "DP Road": ["Tilak Road", "Dhole Patil Road"],
  "Salunke Vihar": ["Salunkhe Vihar", "Wanowrie"],
  Hinjewadi: ["Hinjawadi"],
  HSR: ["HSR Layout"],
  "Rajaji Nagar": ["Rajajinagar"],
  Belgavi: ["Belagavi"],
  Hyderabad: ["Jubilee Hills"],
  "Gurgaon Sector 14": ["Gurugram - Sector 14", "Gurgaon Sector - 14"],
  "Gurgaon Sector 49": ["Gurugram - Sector 49", "Gurgaon Sector - 49"],
  Chinchwad: ["Pimpri-Chinchwad"],
};

function buildChatbotWhere(location) {
  // terms to match (location + aliases)
  const terms = [location, ...(LOCATION_ALIASES[location] || [])];

  // (branch LIKE ? OR chat_whatsapp_branch LIKE ?) OR ...
  const pieces = terms.map(
    () => "(branch LIKE ? OR chat_whatsapp_branch LIKE ?)"
  );
  let clause = "(" + pieces.join(" OR ") + ")";

  // Vashi special: allow empties
  if (location === "Vashi") {
    clause = "(" + clause + " OR (branch = '' AND chat_whatsapp_branch = ''))";
  }

  // params: for each term we pass %term% twice (for branch & chat_whatsapp_branch)
  const params = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);

  return { clause, params };
}

// Helper to promisify connection.query
function runQuery(connection, sql) {
  return new Promise((resolve, reject) => {
    connection.query(sql, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function runLeadQuery(connection, sql, params) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

const getPerformance = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);
  const { connection: leadConnection } = getConnectionByLocation("lead");

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  if (!leadConnection) {
    const err = new Error("Invalid Lead location");
    err.status = 404;
    throw err;
  }

  try {
    const { clause: whereClause, params } = buildChatbotWhere(location);
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

    // ---------- Monthly (last 6 months) ----------
    const ivrMonthlyCurrent = await runQuery(
      connection,
      `
  SELECT DATE_FORMAT(STR_TO_DATE(call_date, '%Y-%d-%m'), '%b') AS label,
       COUNT(*) AS value
FROM IVRdata
WHERE STR_TO_DATE(call_date, '%Y-%d-%m') >= DATE_SUB(DATE_ADD(LAST_DAY(CURDATE()), INTERVAL 1 DAY), INTERVAL 6 MONTH)
AND destination_name != ""
GROUP BY YEAR(STR_TO_DATE(call_date, '%Y-%d-%m')), MONTH(STR_TO_DATE(call_date, '%Y-%d-%m'))
ORDER BY YEAR(STR_TO_DATE(call_date, '%Y-%d-%m')), MONTH(STR_TO_DATE(call_date, '%Y-%d-%m'));
  `
    );
    const ivrMonthlyPrevious = await runQuery(
      connection,
      `
  SELECT DATE_FORMAT(STR_TO_DATE(call_date, '%Y-%d-%m'), '%b') AS label,
         COUNT(*) AS value
  FROM IVRdata
  WHERE STR_TO_DATE(call_date, '%Y-%d-%m') >= DATE_SUB(DATE_ADD(LAST_DAY(DATE_SUB(CURDATE(), INTERVAL 1 YEAR)), INTERVAL 1 DAY), INTERVAL 6 MONTH)
    AND STR_TO_DATE(call_date, '%Y-%d-%m') < DATE_SUB(DATE_ADD(LAST_DAY(CURDATE()), INTERVAL 1 DAY), INTERVAL 12 MONTH)
    AND destination_name != ""
  GROUP BY YEAR(STR_TO_DATE(call_date, '%Y-%d-%m')), MONTH(STR_TO_DATE(call_date, '%Y-%d-%m'))
  ORDER BY YEAR(STR_TO_DATE(call_date, '%Y-%d-%m')), MONTH(STR_TO_DATE(call_date, '%Y-%d-%m'));
  `
    );

    const newMonthlyCurrent = await runQuery(
      connection,
      `
  SELECT 
  DATE_FORMAT(ap.appointment_timestamp, '%b') AS label,
  COUNT(*) AS value
FROM appointment ap
WHERE ap.patient_type = 'New'
  AND ap.is_deleted != 1
  AND ap.confirm_time != '0'
  AND ap.appointment_timestamp >= DATE_SUB(DATE_ADD(LAST_DAY(CURDATE()), INTERVAL 1 DAY), INTERVAL 6 MONTH)
GROUP BY YEAR(ap.appointment_timestamp), MONTH(ap.appointment_timestamp)
ORDER BY YEAR(ap.appointment_timestamp), MONTH(ap.appointment_timestamp);
  `
    );

    const newMonthlyPrevious = await runQuery(
      connection,
      `
  SELECT 
  DATE_FORMAT(ap.appointment_timestamp, '%b') AS label,
  COUNT(*) AS value
FROM appointment ap
WHERE ap.patient_type = 'New'
  AND ap.is_deleted != 1
  AND ap.confirm_time != '0'
  AND ap.appointment_timestamp >= DATE_SUB(DATE_ADD(LAST_DAY(DATE_SUB(CURDATE(), INTERVAL 1 YEAR)), INTERVAL 1 DAY), INTERVAL 6 MONTH)
  AND ap.appointment_timestamp <  DATE_SUB(DATE_ADD(LAST_DAY(CURDATE()), INTERVAL 1 DAY), INTERVAL 12 MONTH)
GROUP BY YEAR(ap.appointment_timestamp), MONTH(ap.appointment_timestamp)
ORDER BY YEAR(ap.appointment_timestamp), MONTH(ap.appointment_timestamp);
  `
    );
    const followupMonthlyCurrent = await runQuery(
      connection,
      `
SELECT 
  DATE_FORMAT(ap.appointment_timestamp, '%b') AS label,
  COUNT(*) AS value
FROM appointment ap
WHERE ap.patient_type = 'Follow'
  AND ap.is_deleted != 1
  AND ap.confirm_time != '0'
  AND ap.appointment_timestamp >= DATE_SUB(DATE_ADD(LAST_DAY(CURDATE()), INTERVAL 1 DAY), INTERVAL 6 MONTH)
GROUP BY YEAR(ap.appointment_timestamp), MONTH(ap.appointment_timestamp)
ORDER BY YEAR(ap.appointment_timestamp), MONTH(ap.appointment_timestamp);
  `
    );

    const followupMonthlyPrevious = await runQuery(
      connection,
      `
SELECT 
  DATE_FORMAT(ap.appointment_timestamp, '%b') AS label,
  COUNT(*) AS value
FROM appointment ap
WHERE ap.patient_type = 'Follow'
  AND ap.is_deleted != 1
  AND ap.confirm_time != '0'
  AND ap.appointment_timestamp >= DATE_SUB(DATE_ADD(LAST_DAY(DATE_SUB(CURDATE(), INTERVAL 1 YEAR)), INTERVAL 1 DAY), INTERVAL 6 MONTH)
  AND ap.appointment_timestamp <  DATE_SUB(DATE_ADD(LAST_DAY(CURDATE()), INTERVAL 1 DAY), INTERVAL 12 MONTH)
GROUP BY YEAR(ap.appointment_timestamp), MONTH(ap.appointment_timestamp)
ORDER BY YEAR(ap.appointment_timestamp), MONTH(ap.appointment_timestamp);
  `
    );

    const ipdPatientMonthlyCurrent = await runQuery(
      connection,
      `
  SELECT 
    DATE_FORMAT(inv.creation_date, '%b') AS label,
    COUNT(DISTINCT inv.patient_id) AS value
  FROM invoice inv
  WHERE inv.creation_date >= DATE_SUB(DATE_ADD(LAST_DAY(CURDATE()), INTERVAL 1 DAY), INTERVAL 6 MONTH)
  GROUP BY YEAR(inv.creation_date), MONTH(inv.creation_date)
  ORDER BY YEAR(inv.creation_date), MONTH(inv.creation_date);
  `
    );

    const ipdPatientMonthlyPrevious = await runQuery(
      connection,
      `
  SELECT 
    DATE_FORMAT(inv.creation_date, '%b') AS label,
    COUNT(DISTINCT inv.patient_id) AS value
  FROM invoice inv
  WHERE inv.creation_date >= DATE_SUB(DATE_ADD(LAST_DAY(DATE_SUB(CURDATE(), INTERVAL 1 YEAR)), INTERVAL 1 DAY), INTERVAL 6 MONTH)
    AND inv.creation_date <  DATE_SUB(DATE_ADD(LAST_DAY(CURDATE()), INTERVAL 1 DAY), INTERVAL 12 MONTH)
  GROUP BY YEAR(inv.creation_date), MONTH(inv.creation_date)
  ORDER BY YEAR(inv.creation_date), MONTH(inv.creation_date);
  `
    );

    const opdMonthlyCurrent = await runQuery(
      connection,
      `
  SELECT 
    DATE_FORMAT(receipt_date, '%b') AS label,
    SUM(totalamt) AS value
  FROM patient_receipt
  WHERE receipt_date >= DATE_SUB(DATE_ADD(LAST_DAY(CURDATE()), INTERVAL 1 DAY), INTERVAL 6 MONTH)
  GROUP BY YEAR(receipt_date), MONTH(receipt_date)
  ORDER BY YEAR(receipt_date), MONTH(receipt_date);
  `
    );
    const opdMonthlyPrevious = await runQuery(
      connection,
      `
  SELECT 
    DATE_FORMAT(receipt_date, '%b') AS label,
    SUM(totalamt) AS value
  FROM patient_receipt
  WHERE receipt_date >= DATE_SUB(DATE_ADD(LAST_DAY(DATE_SUB(CURDATE(), INTERVAL 1 YEAR)), INTERVAL 1 DAY), INTERVAL 6 MONTH)
    AND receipt_date < DATE_SUB(DATE_ADD(LAST_DAY(CURDATE()), INTERVAL 1 DAY), INTERVAL 12 MONTH)
  GROUP BY YEAR(receipt_date), MONTH(receipt_date)
  ORDER BY YEAR(receipt_date), MONTH(receipt_date);
  `
    );

    const ipdMonthlyCurrent = await runQuery(
      connection,
      `
  SELECT 
    DATE_FORMAT(creation_date, '%b') AS label,
    SUM(totalamt) AS value
  FROM invoice
  WHERE creation_date >= DATE_SUB(DATE_ADD(LAST_DAY(CURDATE()), INTERVAL 1 DAY), INTERVAL 6 MONTH)
  GROUP BY YEAR(creation_date), MONTH(creation_date)
  ORDER BY YEAR(creation_date), MONTH(creation_date);
  `
    );

    const ipdMonthlyPrevious = await runQuery(
      connection,
      `
  SELECT 
    DATE_FORMAT(creation_date, '%b') AS label,
    SUM(totalamt) AS value
  FROM invoice
  WHERE creation_date >= DATE_SUB(DATE_ADD(LAST_DAY(DATE_SUB(CURDATE(), INTERVAL 1 YEAR)), INTERVAL 1 DAY), INTERVAL 6 MONTH)
    AND creation_date < DATE_SUB(DATE_ADD(LAST_DAY(CURDATE()), INTERVAL 1 DAY), INTERVAL 12 MONTH)
  GROUP BY YEAR(creation_date), MONTH(creation_date)
  ORDER BY YEAR(creation_date), MONTH(creation_date);
  `
    );

    // ✅ Monthly (last 6 months, month start → month end)
    const leadsMonthlyCurrent = await runLeadQuery(
      leadConnection,
      `
  SELECT 
  DATE_FORMAT(date, '%b') AS label,     -- Jan, Feb, Mar...
  COUNT(*) AS value
FROM appointments
WHERE (${areaConditions})
  AND date >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01 00:00:00'), INTERVAL 5 MONTH)
  AND date <  DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01 00:00:00'), INTERVAL 1 MONTH)
GROUP BY YEAR(date), MONTH(date)
ORDER BY YEAR(date), MONTH(date);
  `,
      [...areaParams]
    );

    const leadsMonthlyPrevious = await runLeadQuery(
      leadConnection,
      `
  SELECT 
    DATE_FORMAT(date, '%b') AS label,
    COUNT(*) AS value
  FROM appointments
  WHERE (${areaConditions})
    AND date >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01 00:00:00'), INTERVAL 17 MONTH) -- 12 + 5
    AND date <  DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01 00:00:00'), INTERVAL 11 MONTH)
  GROUP BY YEAR(date), MONTH(date)
  ORDER BY YEAR(date), MONTH(date);
  `,
      [...areaParams]
    );

    const chatbotLeadsMonthlyCurrent = await runLeadQuery(
      leadConnection,
      `
      SELECT 
        DATE_FORMAT(datetime, '%b') AS label, 
        COUNT(*) AS value
      FROM chatbot_leads
      WHERE ${whereClause}
        AND datetime >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01 00:00:00'), INTERVAL 5 MONTH)
        AND datetime <  DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01 00:00:00'), INTERVAL 1 MONTH)
      GROUP BY YEAR(datetime), MONTH(datetime)
      ORDER BY YEAR(datetime), MONTH(datetime);
    `,
      params
    );

    const chatbotLeadsMonthlyPrevious = await runLeadQuery(
      leadConnection,
      `
  SELECT 
    DATE_FORMAT(datetime, '%b') AS label, 
    COUNT(*) AS value
  FROM chatbot_leads
  WHERE ${whereClause}
    AND datetime >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01 00:00:00'), INTERVAL 17 MONTH) -- 12 + 5
    AND datetime <  DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01 00:00:00'), INTERVAL 11 MONTH)
  GROUP BY YEAR(datetime), MONTH(datetime)
  ORDER BY YEAR(datetime), MONTH(datetime);
  `,
      params
    );

    // ---------- Quarterly (last 4 quarters) ----------
    const ivrQuarterlyCurrent = await runQuery(
      connection,
      `
    SELECT 
    CONCAT('Q', qtrs.qtr) AS label, 
    CASE 
      WHEN qtrs.qtr <= qtrs.current_qtr THEN COALESCE(SUM(m.mcount), 0)
      ELSE 0
    END AS value
FROM (
  SELECT 
    CASE 
      WHEN MONTH(d) BETWEEN 4 AND 6 THEN 1
      WHEN MONTH(d) BETWEEN 7 AND 9 THEN 2
      WHEN MONTH(d) BETWEEN 10 AND 12 THEN 3
      ELSE 4
    END AS qtr,
    COUNT(*) AS mcount
  FROM (
    SELECT STR_TO_DATE(call_date, '%Y-%d-%m') AS d
    FROM IVRdata
    WHERE destination_name <> ''
      AND STR_TO_DATE(call_date, '%Y-%d-%m') >= DATE_FORMAT(CURDATE(), '%Y-04-01') -- current FY start
      AND STR_TO_DATE(call_date, '%Y-%d-%m') < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH) -- till current month
  ) x
  GROUP BY qtr
) m
RIGHT JOIN (
  SELECT 1 AS qtr, 
         CASE 
           WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
           WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
           WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
           ELSE 4
         END AS current_qtr
  UNION SELECT 2, 
         CASE 
           WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
           WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
           WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
           ELSE 4
         END
  UNION SELECT 3, 
         CASE 
           WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
           WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
           WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
           ELSE 4
         END
  UNION SELECT 4, 
         CASE 
           WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
           WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
           WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
           ELSE 4
         END
) qtrs
  ON m.qtr = qtrs.qtr
GROUP BY qtrs.qtr, qtrs.current_qtr
ORDER BY qtrs.qtr;

  `
    );

    const ivrQuarterlyPrevious = await runQuery(
      connection,
      `
   SELECT CONCAT('Q', qtrs.qtr) AS label, 
       COALESCE(SUM(m.mcount), 0) AS value
FROM (
  SELECT 
    CASE 
      WHEN MONTH(d) BETWEEN 4 AND 6 THEN 1
      WHEN MONTH(d) BETWEEN 7 AND 9 THEN 2
      WHEN MONTH(d) BETWEEN 10 AND 12 THEN 3
      ELSE 4
    END AS qtr,
    COUNT(*) AS mcount
  FROM (
    SELECT STR_TO_DATE(call_date, '%Y-%d-%m') AS d
    FROM IVRdata
    WHERE destination_name <> ''
      AND STR_TO_DATE(call_date, '%Y-%d-%m') >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 YEAR), '%Y-04-01')
      AND STR_TO_DATE(call_date, '%Y-%d-%m') < DATE_FORMAT(CURDATE(), '%Y-04-01')
  ) x
  GROUP BY qtr
) m
RIGHT JOIN (
  SELECT 1 AS qtr
  UNION SELECT 2
  UNION SELECT 3
  UNION SELECT 4
) qtrs
  ON m.qtr = qtrs.qtr
GROUP BY qtrs.qtr
ORDER BY qtrs.qtr;

  `
    );

    const newQuarterlyCurrent = await runQuery(
      connection,
      `
SELECT 
  CONCAT('Q', qtrs.qtr) AS label, 
  CASE 
    WHEN qtrs.qtr <= qtrs.current_qtr THEN COALESCE(SUM(m.mcount), 0)
    ELSE 0
  END AS value
FROM (
  SELECT 
    CASE 
      WHEN MONTH(ap.appointment_timestamp) BETWEEN 4 AND 6 THEN 1
      WHEN MONTH(ap.appointment_timestamp) BETWEEN 7 AND 9 THEN 2
      WHEN MONTH(ap.appointment_timestamp) BETWEEN 10 AND 12 THEN 3
      ELSE 4
    END AS qtr,
    COUNT(*) AS mcount
  FROM appointment ap
  WHERE ap.patient_type = 'New'
    AND ap.is_deleted != 1
    AND ap.confirm_time != '0'
    AND ap.appointment_timestamp >= DATE_FORMAT(CURDATE(), '%Y-04-01')  -- start of current FY
    AND ap.appointment_timestamp < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH) -- till current month
  GROUP BY qtr
) m
RIGHT JOIN (
  SELECT 1 AS qtr, 
         CASE 
           WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
           WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
           WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
           ELSE 4
         END AS current_qtr
  UNION SELECT 2, 
         CASE 
           WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
           WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
           WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
           ELSE 4
         END
  UNION SELECT 3, 
         CASE 
           WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
           WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
           WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
           ELSE 4
         END
  UNION SELECT 4, 
         CASE 
           WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
           WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
           WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
           ELSE 4
         END
) qtrs
  ON m.qtr = qtrs.qtr
GROUP BY qtrs.qtr, qtrs.current_qtr
ORDER BY qtrs.qtr;
  `
    );

    const newQuarterlyPrevious = await runQuery(
      connection,
      `
SELECT CONCAT('Q', qtrs.qtr) AS label, 
       COALESCE(SUM(m.mcount), 0) AS value
FROM (
  SELECT 
    CASE 
      WHEN MONTH(ap.appointment_timestamp) BETWEEN 4 AND 6 THEN 1
      WHEN MONTH(ap.appointment_timestamp) BETWEEN 7 AND 9 THEN 2
      WHEN MONTH(ap.appointment_timestamp) BETWEEN 10 AND 12 THEN 3
      ELSE 4
    END AS qtr,
    COUNT(*) AS mcount
  FROM appointment ap
  WHERE ap.patient_type = 'New'
    AND ap.is_deleted != 1
    AND ap.confirm_time != '0'
    AND ap.appointment_timestamp >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 YEAR), '%Y-04-01') -- prev FY start
    AND ap.appointment_timestamp < DATE_FORMAT(CURDATE(), '%Y-04-01') -- before current FY
  GROUP BY qtr
) m
RIGHT JOIN (
  SELECT 1 AS qtr
  UNION SELECT 2
  UNION SELECT 3
  UNION SELECT 4
) qtrs
  ON m.qtr = qtrs.qtr
GROUP BY qtrs.qtr
ORDER BY qtrs.qtr;

  `
    );

    const followupQuarterlyCurrent = await runQuery(
      connection,
      `
  SELECT 
    CONCAT('Q', qtrs.qtr) AS label,
    CASE 
      WHEN qtrs.qtr <= qtrs.current_qtr THEN COALESCE(SUM(m.mcount), 0)
      ELSE 0
    END AS value
  FROM (
    SELECT 
      CASE 
        WHEN MONTH(ap.appointment_timestamp) BETWEEN 4 AND 6 THEN 1
        WHEN MONTH(ap.appointment_timestamp) BETWEEN 7 AND 9 THEN 2
        WHEN MONTH(ap.appointment_timestamp) BETWEEN 10 AND 12 THEN 3
        ELSE 4
      END AS qtr,
      COUNT(*) AS mcount
    FROM appointment ap
    WHERE ap.patient_type = 'Follow'
      AND ap.is_deleted != 1
      AND ap.confirm_time != '0'
      AND ap.appointment_timestamp >= DATE_FORMAT(CURDATE(), '%Y-04-01') -- start of current FY
      AND ap.appointment_timestamp < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH) -- till current month
    GROUP BY qtr
  ) m
  RIGHT JOIN (
    SELECT 1 AS qtr,
           CASE 
             WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
             WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
             WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
             ELSE 4
           END AS current_qtr
    UNION SELECT 2, 
           CASE 
             WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
             WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
             WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
             ELSE 4
           END
    UNION SELECT 3, 
           CASE 
             WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
             WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
             WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
             ELSE 4
           END
    UNION SELECT 4, 
           CASE 
             WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
             WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
             WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
             ELSE 4
           END
  ) qtrs
    ON m.qtr = qtrs.qtr
  GROUP BY qtrs.qtr, qtrs.current_qtr
  ORDER BY qtrs.qtr;
  `
    );
    const followupQuarterlyPrevious = await runQuery(
      connection,
      `
  SELECT CONCAT('Q', qtrs.qtr) AS label,
         COALESCE(SUM(m.mcount), 0) AS value
  FROM (
    SELECT 
      CASE 
        WHEN MONTH(ap.appointment_timestamp) BETWEEN 4 AND 6 THEN 1
        WHEN MONTH(ap.appointment_timestamp) BETWEEN 7 AND 9 THEN 2
        WHEN MONTH(ap.appointment_timestamp) BETWEEN 10 AND 12 THEN 3
        ELSE 4
      END AS qtr,
      COUNT(*) AS mcount
    FROM appointment ap
    WHERE ap.patient_type = 'Follow'
      AND ap.is_deleted != 1
      AND ap.confirm_time != '0'
      AND ap.appointment_timestamp >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 YEAR), '%Y-04-01') -- start of prev FY
      AND ap.appointment_timestamp < DATE_FORMAT(CURDATE(), '%Y-04-01') -- before current FY
    GROUP BY qtr
  ) m
  RIGHT JOIN (
    SELECT 1 AS qtr
    UNION SELECT 2
    UNION SELECT 3
    UNION SELECT 4
  ) qtrs
    ON m.qtr = qtrs.qtr
  GROUP BY qtrs.qtr
  ORDER BY qtrs.qtr;
  `
    );

    const ipdPatientQuarterlyCurrent = await runQuery(
      connection,
      `
  SELECT 
    CONCAT('Q', qtrs.qtr) AS label, 
    CASE 
      WHEN qtrs.qtr <= qtrs.current_qtr THEN COALESCE(SUM(m.mcount), 0)
      ELSE 0
    END AS value
  FROM (
    SELECT 
      CASE 
        WHEN MONTH(inv.creation_date) BETWEEN 4 AND 6 THEN 1
        WHEN MONTH(inv.creation_date) BETWEEN 7 AND 9 THEN 2
        WHEN MONTH(inv.creation_date) BETWEEN 10 AND 12 THEN 3
        ELSE 4
      END AS qtr,
      COUNT(DISTINCT inv.patient_id) AS mcount
    FROM invoice inv
    WHERE inv.creation_date >= DATE_FORMAT(CURDATE(), '%Y-04-01') -- start of current FY
      AND inv.creation_date < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH) -- till current month
    GROUP BY qtr
  ) m
  RIGHT JOIN (
    SELECT 1 AS qtr, 
           CASE 
             WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
             WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
             WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
             ELSE 4
           END AS current_qtr
    UNION SELECT 2,
           CASE 
             WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
             WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
             WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
             ELSE 4
           END
    UNION SELECT 3,
           CASE 
             WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
             WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
             WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
             ELSE 4
           END
    UNION SELECT 4,
           CASE 
             WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
             WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
             WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
             ELSE 4
           END
  ) qtrs
    ON m.qtr = qtrs.qtr
  GROUP BY qtrs.qtr, qtrs.current_qtr
  ORDER BY qtrs.qtr;
  `
    );

    const ipdPatientQuarterlyPrevious = await runQuery(
      connection,
      `
  SELECT CONCAT('Q', qtrs.qtr) AS label, 
         COALESCE(SUM(m.mcount), 0) AS value
  FROM (
    SELECT 
      CASE 
        WHEN MONTH(inv.creation_date) BETWEEN 4 AND 6 THEN 1
        WHEN MONTH(inv.creation_date) BETWEEN 7 AND 9 THEN 2
        WHEN MONTH(inv.creation_date) BETWEEN 10 AND 12 THEN 3
        ELSE 4
      END AS qtr,
      COUNT(DISTINCT inv.patient_id) AS mcount
    FROM invoice inv
    WHERE inv.creation_date >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 YEAR), '%Y-04-01') -- prev FY start
      AND inv.creation_date < DATE_FORMAT(CURDATE(), '%Y-04-01') -- before current FY
    GROUP BY qtr
  ) m
  RIGHT JOIN (
    SELECT 1 AS qtr
    UNION SELECT 2
    UNION SELECT 3
    UNION SELECT 4
  ) qtrs
    ON m.qtr = qtrs.qtr
  GROUP BY qtrs.qtr
  ORDER BY qtrs.qtr;
  `
    );

    //     const postopQuarterly = await runQuery(
    //       connection,
    //       `
    // SELECT
    //   CONCAT('Q',
    //     CASE
    //       WHEN MONTH(ap.appointment_timestamp) BETWEEN 4 AND 6 THEN 1
    //       WHEN MONTH(ap.appointment_timestamp) BETWEEN 7 AND 9 THEN 2
    //       WHEN MONTH(ap.appointment_timestamp) BETWEEN 10 AND 12 THEN 3
    //       ELSE 4
    //     END, ' ',
    //     CASE
    //       WHEN MONTH(ap.appointment_timestamp) BETWEEN 1 AND 3
    //         THEN YEAR(ap.appointment_timestamp) - 1
    //       ELSE YEAR(ap.appointment_timestamp)
    //     END
    //   ) AS label,
    //   COUNT(*) AS value
    // FROM appointment ap
    // WHERE ap.patient_type = 'Postoperative'
    //   AND ap.is_deleted != 1
    //   AND ap.confirm_time != '0'
    //   AND ap.appointment_timestamp >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
    // GROUP BY
    //   CASE
    //     WHEN MONTH(ap.appointment_timestamp) BETWEEN 1 AND 3
    //       THEN YEAR(ap.appointment_timestamp) - 1
    //     ELSE YEAR(ap.appointment_timestamp)
    //   END,
    //   CASE
    //     WHEN MONTH(ap.appointment_timestamp) BETWEEN 4 AND 6 THEN 1
    //     WHEN MONTH(ap.appointment_timestamp) BETWEEN 7 AND 9 THEN 2
    //     WHEN MONTH(ap.appointment_timestamp) BETWEEN 10 AND 12 THEN 3
    //     ELSE 4
    //   END
    // ORDER BY MIN(ap.appointment_timestamp);

    //   `
    //     );

    const opdQuarterlyCurrent = await runQuery(
      connection,
      `
  SELECT 
    CONCAT('Q', qtrs.qtr) AS label,
    CASE 
      WHEN qtrs.qtr <= qtrs.current_qtr THEN COALESCE(SUM(m.amount), 0)
      ELSE 0
    END AS value
  FROM (
    SELECT 
      CASE 
        WHEN MONTH(receipt_date) BETWEEN 4 AND 6 THEN 1
        WHEN MONTH(receipt_date) BETWEEN 7 AND 9 THEN 2
        WHEN MONTH(receipt_date) BETWEEN 10 AND 12 THEN 3
        ELSE 4
      END AS qtr,
      SUM(totalamt) AS amount
    FROM patient_receipt
    WHERE receipt_date >= DATE_FORMAT(CURDATE(), '%Y-04-01') -- start of current FY
      AND receipt_date < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH) -- till current month
    GROUP BY qtr
  ) m
  RIGHT JOIN (
    SELECT 1 AS qtr,
           CASE 
             WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
             WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
             WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
             ELSE 4
           END AS current_qtr
    UNION SELECT 2, 
           CASE 
             WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
             WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
             WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
             ELSE 4
           END
    UNION SELECT 3, 
           CASE 
             WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
             WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
             WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
             ELSE 4
           END
    UNION SELECT 4, 
           CASE 
             WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
             WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
             WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
             ELSE 4
           END
  ) qtrs
    ON m.qtr = qtrs.qtr
  GROUP BY qtrs.qtr, qtrs.current_qtr
  ORDER BY qtrs.qtr;
  `
    );

    const opdQuarterlyPrevious = await runQuery(
      connection,
      `
  SELECT CONCAT('Q', qtrs.qtr) AS label,
         COALESCE(SUM(m.amount), 0) AS value
  FROM (
    SELECT 
      CASE 
        WHEN MONTH(receipt_date) BETWEEN 4 AND 6 THEN 1
        WHEN MONTH(receipt_date) BETWEEN 7 AND 9 THEN 2
        WHEN MONTH(receipt_date) BETWEEN 10 AND 12 THEN 3
        ELSE 4
      END AS qtr,
      SUM(totalamt) AS amount
    FROM patient_receipt
    WHERE receipt_date >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 YEAR), '%Y-04-01') -- start of prev FY
      AND receipt_date < DATE_FORMAT(CURDATE(), '%Y-04-01') -- before current FY
    GROUP BY qtr
  ) m
  RIGHT JOIN (
    SELECT 1 AS qtr
    UNION SELECT 2
    UNION SELECT 3
    UNION SELECT 4
  ) qtrs
    ON m.qtr = qtrs.qtr
  GROUP BY qtrs.qtr
  ORDER BY qtrs.qtr;
  `
    );

    const ipdQuarterlyCurrent = await runQuery(
      connection,
      `
  SELECT 
    CONCAT('Q', qtrs.qtr) AS label,
    CASE 
      WHEN qtrs.qtr <= qtrs.current_qtr THEN COALESCE(SUM(m.amount), 0)
      ELSE 0
    END AS value
  FROM (
    SELECT 
      CASE 
        WHEN MONTH(creation_date) BETWEEN 4 AND 6 THEN 1
        WHEN MONTH(creation_date) BETWEEN 7 AND 9 THEN 2
        WHEN MONTH(creation_date) BETWEEN 10 AND 12 THEN 3
        ELSE 4
      END AS qtr,
      SUM(totalamt) AS amount
    FROM invoice
    WHERE creation_date >= DATE_FORMAT(CURDATE(), '%Y-04-01') -- start of current FY
      AND creation_date < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH) -- till current month
    GROUP BY qtr
  ) m
  RIGHT JOIN (
    SELECT 1 AS qtr,
           CASE 
             WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
             WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
             WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
             ELSE 4
           END AS current_qtr
    UNION SELECT 2, 
           CASE 
             WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
             WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
             WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
             ELSE 4
           END
    UNION SELECT 3, 
           CASE 
             WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
             WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
             WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
             ELSE 4
           END
    UNION SELECT 4, 
           CASE 
             WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
             WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
             WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
             ELSE 4
           END
  ) qtrs
    ON m.qtr = qtrs.qtr
  GROUP BY qtrs.qtr, qtrs.current_qtr
  ORDER BY qtrs.qtr;
  `
    );

    const ipdQuarterlyPrevious = await runQuery(
      connection,
      `
  SELECT CONCAT('Q', qtrs.qtr) AS label,
         COALESCE(SUM(m.amount), 0) AS value
  FROM (
    SELECT 
      CASE 
        WHEN MONTH(creation_date) BETWEEN 4 AND 6 THEN 1
        WHEN MONTH(creation_date) BETWEEN 7 AND 9 THEN 2
        WHEN MONTH(creation_date) BETWEEN 10 AND 12 THEN 3
        ELSE 4
      END AS qtr,
      SUM(totalamt) AS amount
    FROM invoice
    WHERE creation_date >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 YEAR), '%Y-04-01') -- start of prev FY
      AND creation_date < DATE_FORMAT(CURDATE(), '%Y-04-01') -- before current FY
    GROUP BY qtr
  ) m
  RIGHT JOIN (
    SELECT 1 AS qtr
    UNION SELECT 2
    UNION SELECT 3
    UNION SELECT 4
  ) qtrs
    ON m.qtr = qtrs.qtr
  GROUP BY qtrs.qtr
  ORDER BY qtrs.qtr;
  `
    );

    // ✅ Quarterly (last 4 quarters, FY style: Apr–Jun=Q1, Jul–Sep=Q2, Oct–Dec=Q3, Jan–Mar=Q4)
    const leadsQuarterlyCurrent = await runLeadQuery(
      leadConnection,
      `
  SELECT
  CONCAT('Q', q.qtr) AS label,
  CASE
    /* show 0 for future quarters of the current FY */
    WHEN q.qtr <= (
      CASE
        WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
        WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
        WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
        ELSE 4
      END
    ) THEN COALESCE(m.mcount, 0)
    ELSE 0
  END AS value
FROM (
  SELECT 1 AS qtr UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
) q
LEFT JOIN (
  SELECT
    CASE
      WHEN MONTH(date) BETWEEN 4 AND 6  THEN 1
      WHEN MONTH(date) BETWEEN 7 AND 9  THEN 2
      WHEN MONTH(date) BETWEEN 10 AND 12 THEN 3
      ELSE 4
    END AS qtr,
    COUNT(*) AS mcount
  FROM appointments
  WHERE (${areaConditions})
    /* current FY start (Apr 1 of the correct year even in Jan–Mar) */
    AND date >= (
      CASE
        WHEN MONTH(CURDATE()) BETWEEN 1 AND 3
          THEN MAKEDATE(YEAR(CURDATE()) - 1, 1) + INTERVAL 3 MONTH   -- (YEAR-1)-04-01
        ELSE MAKEDATE(YEAR(CURDATE()), 1) + INTERVAL 3 MONTH          -- YEAR-04-01
      END
    )
    /* up to the current month only, but never beyond FY end */
    AND date < LEAST(
      DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH),           -- next month start
      CASE
        WHEN MONTH(CURDATE()) BETWEEN 1 AND 3
          THEN MAKEDATE(YEAR(CURDATE()), 1) + INTERVAL 3 MONTH                  -- YEAR-04-01
        ELSE MAKEDATE(YEAR(CURDATE()) + 1, 1) + INTERVAL 3 MONTH                -- (YEAR+1)-04-01
      END
    )
  GROUP BY qtr
) m
  ON m.qtr = q.qtr
ORDER BY q.qtr;
  `,
      [...areaParams]
    );

    const leadsQuarterlyPrevious = await runLeadQuery(
      leadConnection,
      `
  SELECT
  CONCAT('Q', q.qtr) AS label,
  COALESCE(m.mcount, 0) AS value
FROM (
  SELECT 1 AS qtr UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
) q
LEFT JOIN (
  SELECT
    CASE
      WHEN MONTH(date) BETWEEN 4 AND 6  THEN 1
      WHEN MONTH(date) BETWEEN 7 AND 9  THEN 2
      WHEN MONTH(date) BETWEEN 10 AND 12 THEN 3
      ELSE 4
    END AS qtr,
    COUNT(*) AS mcount
  FROM appointments
  WHERE (${areaConditions})
    /* previous FY start */
    AND date >= (
      CASE
        WHEN MONTH(CURDATE()) BETWEEN 1 AND 3
          THEN MAKEDATE(YEAR(CURDATE()) - 2, 1) + INTERVAL 3 MONTH   -- (YEAR-2)-04-01
        ELSE MAKEDATE(YEAR(CURDATE()) - 1, 1) + INTERVAL 3 MONTH      -- (YEAR-1)-04-01
      END
    )
    /* previous FY end (start of current FY) */
    AND date < (
      CASE
        WHEN MONTH(CURDATE()) BETWEEN 1 AND 3
          THEN MAKEDATE(YEAR(CURDATE()) - 1, 1) + INTERVAL 3 MONTH   -- (YEAR-1)-04-01
        ELSE MAKEDATE(YEAR(CURDATE()), 1) + INTERVAL 3 MONTH          -- YEAR-04-01
      END
    )
  GROUP BY qtr
) m
  ON m.qtr = q.qtr
ORDER BY q.qtr;

  `,
      [...areaParams]
    );

    const chatbotLeadsQuarterlyCurrent = await runLeadQuery(
      leadConnection,
      `
  SELECT
  CONCAT('Q', qtrs.qtr) AS label,
  CASE
    WHEN qtrs.qtr <= qtrs.current_qtr THEN COALESCE(m.mcount, 0)
    ELSE 0
  END AS value
FROM (
  SELECT 1 AS qtr, 
         CASE WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
              WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
              WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
              ELSE 4
         END AS current_qtr
  UNION ALL SELECT 2, CASE WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
                          WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
                          WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
                          ELSE 4 END
  UNION ALL SELECT 3, CASE WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
                          WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
                          WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
                          ELSE 4 END
  UNION ALL SELECT 4, CASE WHEN MONTH(CURDATE()) BETWEEN 4 AND 6 THEN 1
                          WHEN MONTH(CURDATE()) BETWEEN 7 AND 9 THEN 2
                          WHEN MONTH(CURDATE()) BETWEEN 10 AND 12 THEN 3
                          ELSE 4 END
) qtrs
LEFT JOIN (
  SELECT
    CASE
      WHEN MONTH(datetime) BETWEEN 4 AND 6 THEN 1
      WHEN MONTH(datetime) BETWEEN 7 AND 9 THEN 2
      WHEN MONTH(datetime) BETWEEN 10 AND 12 THEN 3
      ELSE 4
    END AS qtr,
    COUNT(*) AS mcount
  FROM chatbot_leads
  WHERE ${whereClause}
    -- start of current FY (Apr 1 of the correct year even if current month is Jan–Mar)
    AND datetime >= (
      CASE
        WHEN MONTH(CURDATE()) BETWEEN 1 AND 3
          THEN MAKEDATE(YEAR(CURDATE()) - 1, 1) + INTERVAL 3 MONTH  -- (YEAR-1)-04-01
        ELSE MAKEDATE(YEAR(CURDATE()), 1) + INTERVAL 3 MONTH         -- YEAR-04-01
      END
    )
    -- up to current month (next month start), but capped at FY end (start_next_fy)
    AND datetime < LEAST(
      DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH),
      (CASE
         WHEN MONTH(CURDATE()) BETWEEN 1 AND 3
           THEN MAKEDATE(YEAR(CURDATE()), 1) + INTERVAL 3 MONTH         -- YEAR-04-01
         ELSE MAKEDATE(YEAR(CURDATE()) + 1, 1) + INTERVAL 3 MONTH       -- (YEAR+1)-04-01
       END)
    )
  GROUP BY qtr
) m
  ON m.qtr = qtrs.qtr
ORDER BY qtrs.qtr;

  `,
      params
    );

    const chatbotLeadsQuarterlyPrevious = await runLeadQuery(
      leadConnection,
      `
  SELECT
  CONCAT('Q', q.qtr) AS label,
  COALESCE(m.mcount, 0) AS value
FROM (
  SELECT 1 AS qtr UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
) q
LEFT JOIN (
  SELECT
    CASE
      WHEN MONTH(datetime) BETWEEN 4 AND 6 THEN 1
      WHEN MONTH(datetime) BETWEEN 7 AND 9 THEN 2
      WHEN MONTH(datetime) BETWEEN 10 AND 12 THEN 3
      ELSE 4
    END AS qtr,
    COUNT(*) AS mcount
  FROM chatbot_leads
  WHERE ${whereClause}
    -- previous FY start (Apr 1 of previous FY)
    AND datetime >= (
      CASE
        WHEN MONTH(CURDATE()) BETWEEN 1 AND 3
          THEN MAKEDATE(YEAR(CURDATE()) - 2, 1) + INTERVAL 3 MONTH   -- (YEAR-2)-04-01
        ELSE MAKEDATE(YEAR(CURDATE()) - 1, 1) + INTERVAL 3 MONTH     -- (YEAR-1)-04-01
      END
    )
    -- previous FY end (start of current FY)
    AND datetime < (
      CASE
        WHEN MONTH(CURDATE()) BETWEEN 1 AND 3
          THEN MAKEDATE(YEAR(CURDATE()) - 1, 1) + INTERVAL 3 MONTH   -- (YEAR-1)-04-01
        ELSE MAKEDATE(YEAR(CURDATE()), 1) + INTERVAL 3 MONTH         -- YEAR-04-01
      END
    )
  GROUP BY qtr
) m
  ON m.qtr = q.qtr
ORDER BY q.qtr;

  `,
      params
    );

    // ---------- Yearly (last 4 years) ----------
    const ivrYearly = await runQuery(
      connection,
      `
  SELECT YEAR(STR_TO_DATE(call_date, '%Y-%d-%m')) AS label,
       COUNT(*) AS value
FROM IVRdata
WHERE YEAR(STR_TO_DATE(call_date, '%Y-%d-%m')) BETWEEN YEAR(CURDATE()) - 3 AND YEAR(CURDATE())
AND destination_name != ""
GROUP BY YEAR(STR_TO_DATE(call_date, '%Y-%d-%m'))
ORDER BY YEAR(STR_TO_DATE(call_date, '%Y-%d-%m'));
  `
    );

    const newYearly = await runQuery(
      connection,
      `
  SELECT 
  YEAR(ap.appointment_timestamp) AS label,
  COUNT(*) AS value
FROM appointment ap
WHERE ap.patient_type = 'New'   -- change to 'Follow' or 'Postoperative'
  AND ap.is_deleted != 1
  AND ap.confirm_time != '0'
  AND YEAR(ap.appointment_timestamp) BETWEEN YEAR(CURDATE()) - 3 AND YEAR(CURDATE())
GROUP BY YEAR(ap.appointment_timestamp)
ORDER BY YEAR(ap.appointment_timestamp);
  `
    );

    const followupYearly = await runQuery(
      connection,
      `
  SELECT 
  YEAR(ap.appointment_timestamp) AS label,
  COUNT(*) AS value
FROM appointment ap
WHERE ap.patient_type = 'Follow'   -- change to 'Follow' or 'Postoperative'
  AND ap.is_deleted != 1
  AND ap.confirm_time != '0'
  AND YEAR(ap.appointment_timestamp) BETWEEN YEAR(CURDATE()) - 3 AND YEAR(CURDATE())
GROUP BY YEAR(ap.appointment_timestamp)
ORDER BY YEAR(ap.appointment_timestamp);

  `
    );

    const ipdPatientYearly = await runQuery(
      connection,
      `
  SELECT 
    YEAR(inv.creation_date) AS label,
    COUNT(DISTINCT inv.patient_id) AS value
  FROM invoice inv
  WHERE YEAR(inv.creation_date) BETWEEN YEAR(CURDATE()) - 3 AND YEAR(CURDATE())
  GROUP BY YEAR(inv.creation_date)
  ORDER BY YEAR(inv.creation_date);
  `
    );

    //     const postopYearly = await runQuery(
    //       connection,
    //       `
    //     SELECT
    //   YEAR(ap.appointment_timestamp) AS label,
    //   COUNT(*) AS value
    // FROM appointment ap
    // WHERE ap.patient_type = 'Postoperative'   -- change to 'Follow' or 'Postoperative'
    //   AND ap.is_deleted != 1
    //   AND ap.confirm_time != '0'
    //   AND YEAR(ap.appointment_timestamp) BETWEEN YEAR(CURDATE()) - 3 AND YEAR(CURDATE())
    // GROUP BY YEAR(ap.appointment_timestamp)
    // ORDER BY YEAR(ap.appointment_timestamp);
    //   `
    //     );

    const opdYearly = await runQuery(
      connection,
      `
  SELECT YEAR(receipt_date) AS label,
       SUM(totalamt) AS value
FROM patient_receipt
WHERE YEAR(receipt_date) BETWEEN YEAR(CURDATE()) - 3 AND YEAR(CURDATE())
GROUP BY YEAR(receipt_date)
ORDER BY YEAR(receipt_date);
  `
    );

    const ipdYearly = await runQuery(
      connection,
      `
  SELECT YEAR(creation_date) AS label,
       SUM(totalamt) AS value
FROM invoice
WHERE YEAR(creation_date) BETWEEN YEAR(CURDATE()) - 3 AND YEAR(CURDATE())
GROUP BY YEAR(creation_date)
ORDER BY YEAR(creation_date);
  `
    );

    // ✅ Yearly (last 4 calendar years, Jan–Dec)
    const leadsYearly = await runLeadQuery(
      leadConnection,
      `
  SELECT 
    YEAR(date) AS label,
    COUNT(*) AS value
  FROM appointments
  WHERE (${areaConditions})
    AND YEAR(date) BETWEEN YEAR(CURDATE()) - 3 AND YEAR(CURDATE())
  GROUP BY YEAR(date)
  ORDER BY YEAR(date);
  `,
      [...areaParams]
    );

    const chatbotLeadsYearly = await runLeadQuery(
      leadConnection,
      `
  SELECT YEAR(datetime) AS label, COUNT(*) AS value
  FROM chatbot_leads
  WHERE ${whereClause}
    AND YEAR(datetime) BETWEEN YEAR(CURDATE()) - 3 AND YEAR(CURDATE())
  GROUP BY YEAR(datetime)
  ORDER BY YEAR(datetime)
  `,
      params
    );

    // ✅ Build final response with plain arrays (no Query objects)
    let response = buildResponse(
      {
        //opd: opdMonthly,
        //ipd: ipdMonthly,
        //new: newMonthly,
        //follow: followupMonthly,
        //postop: postopMonthly,
        // ivrCurrent: ivrMonthlyCurrent,
        // ivrPrevious: ivrMonthlyPrevious,
        // webCurrent: leadsMonthlyCurrent,
        // webPrevious: leadsMonthlyPrevious,
        // botCurrent: chatbotLeadsMonthlyCurrent,
        // botPrevious: chatbotLeadsMonthlyPrevious,
      },
      {
        //opd: opdQuarterly,
        //ipd: ipdQuarterly,
        // new: newQuarterly,
        // follow: followupQuarterly,
        // //postop: postopQuarterly,
        // ivrCurrent: ivrQuarterlyCurrent,
        // ivrPrevious: ivrQuarterlyPrevious,
        // webCurrent: leadsQuarterlyCurrent,
        // webPrevious: leadsQuarterlyPrevious,
        // botCurrent: chatbotLeadsQuarterlyCurrent,
        // botPrevious: chatbotLeadsQuarterlyPrevious,
      },
      {
        opd: opdYearly,
        ipd: ipdYearly,
        new: newYearly,
        follow: followupYearly,
        ipdPatient: ipdPatientYearly,
        // postop: postopYearly,
        ivr: ivrYearly,
        web: leadsYearly,
        bot: chatbotLeadsYearly,
      }
    );
    const monthlyLeads = mergeLeads(
      ivrMonthlyCurrent,
      ivrMonthlyPrevious,
      leadsMonthlyCurrent,
      leadsMonthlyPrevious,
      chatbotLeadsMonthlyCurrent,
      chatbotLeadsMonthlyPrevious
    );
    const quarterlyLeads = mergeLeads(
      ivrQuarterlyCurrent,
      ivrQuarterlyPrevious,
      leadsQuarterlyCurrent,
      leadsQuarterlyPrevious,
      chatbotLeadsQuarterlyCurrent,
      chatbotLeadsQuarterlyPrevious
    );
    const yearlyLeads = mergeLeads(ivrYearly, leadsYearly, chatbotLeadsYearly);
    // const monthlyPatients = mergePatients(
    //   newMonthly,
    //   followupMonthly
    //   //postopMonthly
    // );
    // const quarterlyPatients = mergePatients(
    //   newQuarterly,
    //   followupQuarterly
    //   //postopQuarterly
    // );
    const yearlyPatients = mergePatients(
      newYearly,
      followupYearly
      //postopYearly
    );

    // IVR Chart Data
    const ivrChartDataMonthly = prepareChartData(
      ivrMonthlyCurrent,
      ivrMonthlyPrevious
    );

    // Web Leads Chart Data
    const webChartDataMonthly = prepareChartData(
      leadsMonthlyCurrent,
      leadsMonthlyPrevious
    );

    // Bot Leads Chart Data
    const botChartDataMonthly = prepareChartData(
      chatbotLeadsMonthlyCurrent,
      chatbotLeadsMonthlyPrevious
    );
    // IVR Chart Data
    const ivrChartDataQuarterly = prepareChartData(
      ivrQuarterlyCurrent,
      ivrQuarterlyPrevious
    );

    // Web Leads Chart Data
    const webChartDataQuarterly = prepareChartData(
      leadsQuarterlyCurrent,
      leadsQuarterlyPrevious
    );

    // Bot Leads Chart Data
    const botChartDataQuarterly = prepareChartData(
      chatbotLeadsQuarterlyCurrent,
      chatbotLeadsQuarterlyPrevious
    );

    // Patients Chart Data
    const newPatientChartDataMonthly = prepareChartData(
      newMonthlyCurrent,
      newMonthlyPrevious
    );
    const followUpPatientChartDataMonthly = prepareChartData(
      followupMonthlyCurrent,
      followupMonthlyPrevious
    );

    const newPatientChartDataQuarterly = prepareChartData(
      newQuarterlyCurrent,
      newQuarterlyPrevious
    );
    const followUpPatientChartDataQuarterly = prepareChartData(
      followupQuarterlyCurrent,
      followupQuarterlyPrevious
    );

    const ipdPatientChartDataMonthly = prepareChartData(
      ipdPatientMonthlyCurrent,
      ipdPatientMonthlyPrevious
    );
    const ipdPatientChartDataQuarterly = prepareChartData(
      ipdPatientQuarterlyCurrent,
      ipdPatientQuarterlyPrevious
    );

    //OPD Data

    const opdInvoiceChartDataMonthly = prepareChartData(
      opdMonthlyCurrent,
      opdMonthlyPrevious
    );
    const opdInvoiceChartDataQuarterly = prepareChartData(
      opdQuarterlyCurrent,
      opdQuarterlyPrevious
    );

    //IPD Data

    const ipdInvoiceChartDataMonthly = prepareChartData(
      ipdMonthlyCurrent,
      ipdMonthlyPrevious
    );
    const ipdInvoiceChartDataQuarterly = prepareChartData(
      ipdQuarterlyCurrent,
      ipdQuarterlyPrevious
    );

    response.Leads = {
      Monthly: {
        ivrChartData: ivrChartDataMonthly,
        webChartData: webChartDataMonthly,
        botChartData: botChartDataMonthly,
      },
      Quarterly: {
        ivrChartData: ivrChartDataQuarterly,
        webChartData: webChartDataQuarterly,
        botChartData: botChartDataQuarterly,
      },
    };

    response.Patients = {
      Monthly: {
        newPatientChartData: newPatientChartDataMonthly,
        followUpPatientChartData: followUpPatientChartDataMonthly,
        ipdPatientChartData: ipdPatientChartDataMonthly,
      },
      Quarterly: {
        newPatientChartData: newPatientChartDataQuarterly,
        followUpPatientChartData: followUpPatientChartDataQuarterly,
        ipdPatientChartData: ipdPatientChartDataQuarterly,
      },
    };

    response.Opd = {
      Monthly: {
        opdPatientChartData: opdInvoiceChartDataMonthly,
      },
      Quarterly: {
        opdPatientChartData: opdInvoiceChartDataQuarterly,
      },
    };

    response.Ipd = {
      Monthly: {
        ipdPatientChartData: ipdInvoiceChartDataMonthly,
      },
      Quarterly: {
        ipdPatientChartData: ipdInvoiceChartDataQuarterly,
      },
    };

    // response.Leads = {
    //   Monthly: monthlyLeads,
    //   Quarterly: quarterlyLeads,
    //   Yearly: yearlyLeads,
    // };

    //console.log(ivrMonthly, ivrQuarterly);
    console.log("Performance data fetched for", response.Opd);
    return response;
  } catch (error) {
    console.error("Error fetching performance data:", error);
    throw error;
  }
};

module.exports = { getPerformance };
