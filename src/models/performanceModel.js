const { getConnectionByLocation } = require("../../databaseUtils");
const {
  processVoiceCommand,
  processPerformanceSummary,
} = require("./openAIModel");

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

function sanitizeData(rawData) {
  const now = new Date();
  const currentMonthIndex = now.getMonth(); // 0–11 (Jan=0)
  const currentMonthLabel = now.toLocaleString("en-US", { month: "short" }); // e.g. "Sep"

  // Fiscal year starts in April → shift months by -3
  const fiscalMonthIndex = (currentMonthIndex + 9) % 12; // Apr=0, May=1, ..., Mar=11
  const currentQuarter = Math.floor(fiscalMonthIndex / 3) + 1; // Q1=Apr–Jun, Q2=Jul–Sep, etc.

  const safeMonthly = Object.entries(rawData.Monthly || {}).reduce(
    (acc, [label, obj]) => {
      acc[label] = {
        currentYear: (obj.currentYear || []).filter(
          (m) => m.label !== currentMonthLabel // hide current month
        ),
        previousYear: (obj.previousYear || []).filter(
          (m) => m.label !== currentMonthLabel
        ),
      };
      return acc;
    },
    {}
  );

  const safeQuarterly = Object.entries(rawData.Quarterly || {}).reduce(
    (acc, [label, obj]) => {
      acc[label] = {
        currentYear: (obj.currentYear || []).filter((q) => {
          const qNum = parseInt(q.label.replace("Q", ""), 10);
          // hide current + future quarters
          return qNum < currentQuarter;
        }),
        previousYear: (obj.previousYear || []).filter((q) => {
          const qNum = parseInt(q.label.replace("Q", ""), 10);
          return qNum < currentQuarter;
        }),
      };
      return acc;
    },
    {}
  );

  return {
    ...rawData,
    Monthly: safeMonthly,
    Quarterly: safeQuarterly,
  };
}

// Utility: format DB results into { Monthly: {}, Quarterly: {}, Yearly: {} }

function buildResponse(monthlyData, quarterlyData, yearlyData) {
  return {
    Monthly: {
      "OPD Invoice": {
        currentYear: monthlyData.opdCurrent,
        previousYear: monthlyData.opdPrevious,
      },
      "LAB Invoice": {
        currentYear: monthlyData.labCurrent,
        previousYear: monthlyData.labPrevious,
      },
      "IPD Invoice": {
        currentYear: monthlyData.ipdCurrent,
        previousYear: monthlyData.ipdPrevious,
      },
      "IPD Patients": {
        currentYear: monthlyData.ipdPatientCurrent,
        previousYear: monthlyData.ipdPatientPrevious,
      },
      "New Appointments": {
        currentYear: monthlyData.newCurrent,
        previousYear: monthlyData.newPrevious,
      },
      "Follow-up Appointments": {
        currentYear: monthlyData.followCurrent,
        previousYear: monthlyData.followPrevious,
      },
      "IVR Calls": {
        currentYear: monthlyData.ivrCurrent,
        previousYear: monthlyData.ivrPrevious,
      },
      "Web Leads": {
        currentYear: monthlyData.webCurrent,
        previousYear: monthlyData.webPrevious,
      },
      "Bot Leads": {
        currentYear: monthlyData.botCurrent,
        previousYear: monthlyData.botPrevious,
      },
    },
    Quarterly: {
      "OPD Invoice": {
        currentYear: quarterlyData.opdCurrent,
        previousYear: quarterlyData.opdPrevious,
      },
      "LAB Invoice": {
        currentYear: quarterlyData.labCurrent,
        previousYear: quarterlyData.labPrevious,
      },
      "IPD Invoice": {
        currentYear: quarterlyData.ipdCurrent,
        previousYear: quarterlyData.ipdPrevious,
      },
      "IPD Patients": {
        currentYear: quarterlyData.ipdPatientCurrent,
        previousYear: quarterlyData.ipdPatientPrevious,
      },
      "New Appointments": {
        currentYear: quarterlyData.newCurrent,
        previousYear: quarterlyData.newPrevious,
      },
      "Follow-up Appointments": {
        currentYear: quarterlyData.followCurrent,
        previousYear: quarterlyData.followPrevious,
      },
      "IVR Calls": {
        currentYear: quarterlyData.ivrCurrent,
        previousYear: quarterlyData.ivrPrevious,
      },
      "Web Leads": {
        currentYear: quarterlyData.webCurrent,
        previousYear: quarterlyData.webPrevious,
      },
      "Bot Leads": {
        currentYear: quarterlyData.botCurrent,
        previousYear: quarterlyData.botPrevious,
      },
    },
    Yearly: {
      "OPD Invoice": yearlyData.opd,
      "LAB Invoice": yearlyData.lab,
      "IPD Invoice": yearlyData.ipd,
      "New Appointments": yearlyData.new,
      "Follow-up Appointments": yearlyData.follow,
      "IPD Patients": yearlyData.ipdPatient,
      "IVR Calls": yearlyData.ivr,
      "Web Leads": yearlyData.web,
      "Bot Leads": yearlyData.bot,
    },
  };
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
  AND is_deleted != 1
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
    AND is_deleted != 1
  GROUP BY YEAR(receipt_date), MONTH(receipt_date)
  ORDER BY YEAR(receipt_date), MONTH(receipt_date);
  `
    );

    let labMonthlyCurrent, labMonthlyPrevious;

    if (location === "DP Road") {
      // Current year LAB monthly totals
      labMonthlyCurrent = await runQuery(
        connection,
        `
    SELECT 
      DATE_FORMAT(receipt_date, '%b') AS label,
      SUM(totalamt) AS value
    FROM patient_receipt
    WHERE chargeCondition = 'LabTest'
      AND receipt_date >= DATE_SUB(DATE_ADD(LAST_DAY(CURDATE()), INTERVAL 1 DAY), INTERVAL 6 MONTH)
      AND is_deleted != 1
    GROUP BY YEAR(receipt_date), MONTH(receipt_date)
    ORDER BY YEAR(receipt_date), MONTH(receipt_date);
    `
      );

      // Previous year LAB monthly totals
      labMonthlyPrevious = await runQuery(
        connection,
        `
    SELECT 
      DATE_FORMAT(receipt_date, '%b') AS label,
      SUM(totalamt) AS value
    FROM patient_receipt
    WHERE chargeCondition = 'LabTest'
      AND receipt_date >= DATE_SUB(DATE_ADD(LAST_DAY(DATE_SUB(CURDATE(), INTERVAL 1 YEAR)), INTERVAL 1 DAY), INTERVAL 6 MONTH)
      AND receipt_date < DATE_SUB(DATE_ADD(LAST_DAY(CURDATE()), INTERVAL 1 DAY), INTERVAL 12 MONTH)
      AND is_deleted != 1
    GROUP BY YEAR(receipt_date), MONTH(receipt_date)
    ORDER BY YEAR(receipt_date), MONTH(receipt_date);
    `
      );
    } else {
      // Current year LAB monthly totals (non–DP Road)
      labMonthlyCurrent = await runQuery(
        connection,
        `
    SELECT 
      DATE_FORMAT(item_date, '%b') AS label,
      SUM(total) AS value
    FROM patient_itemreceipt
    WHERE consultation = 'LAB'
      AND item_date >= DATE_SUB(DATE_ADD(LAST_DAY(CURDATE()), INTERVAL 1 DAY), INTERVAL 6 MONTH)
      AND is_deleted != 1
    GROUP BY YEAR(item_date), MONTH(item_date)
    ORDER BY YEAR(item_date), MONTH(item_date);
    `
      );

      // Previous year LAB monthly totals (non–DP Road)
      labMonthlyPrevious = await runQuery(
        connection,
        `
    SELECT 
      DATE_FORMAT(item_date, '%b') AS label,
      SUM(total) AS value
    FROM patient_itemreceipt
    WHERE consultation = 'LAB'
      AND item_date >= DATE_SUB(DATE_ADD(LAST_DAY(DATE_SUB(CURDATE(), INTERVAL 1 YEAR)), INTERVAL 1 DAY), INTERVAL 6 MONTH)
      AND item_date < DATE_SUB(DATE_ADD(LAST_DAY(CURDATE()), INTERVAL 1 DAY), INTERVAL 12 MONTH)
      AND is_deleted != 1
    GROUP BY YEAR(item_date), MONTH(item_date)
    ORDER BY YEAR(item_date), MONTH(item_date);
    `
      );
    }

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
      AND STR_TO_DATE(call_date, '%Y-%d-%m') >= 
    CASE
      WHEN MONTH(CURDATE()) >= 4
      THEN DATE(CONCAT(YEAR(CURDATE()), '-04-01'))
      ELSE DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
    END -- current FY start
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
      AND STR_TO_DATE(call_date, '%Y-%d-%m') >=
    CASE
      WHEN MONTH(CURDATE()) >= 4
      THEN DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
      ELSE DATE(CONCAT(YEAR(CURDATE()) - 2, '-04-01'))
    END
AND STR_TO_DATE(call_date, '%Y-%d-%m') <
    CASE
      WHEN MONTH(CURDATE()) >= 4
      THEN DATE(CONCAT(YEAR(CURDATE()), '-04-01'))
      ELSE DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
    END
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
        AND ap.is_deleted <> 1
        AND ap.confirm_time <> '0'
        AND ap.appointment_timestamp >=
            CASE
              WHEN MONTH(CURDATE()) >= 4
              THEN DATE(CONCAT(YEAR(CURDATE()), '-04-01'))
              ELSE DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
            END
        AND ap.appointment_timestamp <
            DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
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
    AND ap.is_deleted <> 1
    AND ap.confirm_time <> '0'
    AND ap.appointment_timestamp >=
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 2, '-04-01'))
        END
    AND ap.appointment_timestamp <
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()), '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
        END
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
    AND ap.is_deleted <> 1
    AND ap.confirm_time <> '0'
    AND ap.appointment_timestamp >=
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()), '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
        END
    AND ap.appointment_timestamp <
        DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
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
    AND ap.is_deleted <> 1
    AND ap.confirm_time <> '0'
    AND ap.appointment_timestamp >=
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 2, '-04-01'))
        END
    AND ap.appointment_timestamp <
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()), '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
        END
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
  WHERE inv.creation_date >=
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()), '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
        END
    AND inv.creation_date <
        DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
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
  WHERE inv.creation_date >=
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 2, '-04-01'))
        END
    AND inv.creation_date <
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()), '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
        END
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
  WHERE receipt_date >=
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()), '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
        END
    AND receipt_date <
        DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
    AND is_deleted != 1
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
  WHERE receipt_date >=
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 2, '-04-01'))
        END
    AND receipt_date <
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()), '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
        END
    AND is_deleted != 1
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

    let labQuarterlyCurrent, labQuarterlyPrevious;

    if (location === "DP Road") {
      // Current FY LAB quarterly totals
      labQuarterlyCurrent = await runQuery(
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
  WHERE chargeCondition = 'LabTest'
    AND receipt_date >=
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()), '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
        END
    AND receipt_date <
        DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
    AND is_deleted != 1
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

      // Previous FY LAB quarterly totals
      labQuarterlyPrevious = await runQuery(
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
  WHERE chargeCondition = 'LabTest'
    AND receipt_date >=
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 2, '-04-01'))
        END
    AND receipt_date <
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()), '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
        END
    AND is_deleted != 1
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
    } else {
      // Current FY LAB quarterly totals (non–DP Road)
      labQuarterlyCurrent = await runQuery(
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
      WHEN MONTH(item_date) BETWEEN 4 AND 6 THEN 1
      WHEN MONTH(item_date) BETWEEN 7 AND 9 THEN 2
      WHEN MONTH(item_date) BETWEEN 10 AND 12 THEN 3
      ELSE 4
    END AS qtr,
    SUM(total) AS amount
  FROM patient_itemreceipt
  WHERE consultation = 'LAB'
    AND item_date >=
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()), '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
        END
    AND item_date <
        DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
    AND is_deleted != 1
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

      // Previous FY LAB quarterly totals (non–DP Road)
      labQuarterlyPrevious = await runQuery(
        connection,
        `
    SELECT CONCAT('Q', qtrs.qtr) AS label,
       COALESCE(SUM(m.amount), 0) AS value
FROM (
  SELECT 
    CASE 
      WHEN MONTH(item_date) BETWEEN 4 AND 6 THEN 1
      WHEN MONTH(item_date) BETWEEN 7 AND 9 THEN 2
      WHEN MONTH(item_date) BETWEEN 10 AND 12 THEN 3
      ELSE 4
    END AS qtr,
    SUM(total) AS amount
  FROM patient_itemreceipt
  WHERE consultation = 'LAB'
    AND item_date >=
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 2, '-04-01'))
        END
    AND item_date <
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()), '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
        END
    AND is_deleted != 1
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
    }

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
  WHERE creation_date >=
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()), '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
        END
    AND creation_date <
        DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
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
  WHERE creation_date >=
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 2, '-04-01'))
        END
    AND creation_date <
        CASE
          WHEN MONTH(CURDATE()) >= 4
          THEN DATE(CONCAT(YEAR(CURDATE()), '-04-01'))
          ELSE DATE(CONCAT(YEAR(CURDATE()) - 1, '-04-01'))
        END
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
  SELECT 
    CASE 
        WHEN MONTH(STR_TO_DATE(call_date, '%Y-%d-%m')) >= 4 
            THEN CONCAT(YEAR(STR_TO_DATE(call_date, '%Y-%d-%m')), '-', YEAR(STR_TO_DATE(call_date, '%Y-%d-%m')) + 1)
        ELSE CONCAT(YEAR(STR_TO_DATE(call_date, '%Y-%d-%m')) - 1, '-', YEAR(STR_TO_DATE(call_date, '%Y-%d-%m')))
    END AS label,
    COUNT(*) AS value
FROM IVRdata
WHERE STR_TO_DATE(call_date, '%Y-%d-%m') BETWEEN DATE_SUB(CURDATE(), INTERVAL 3 YEAR) AND CURDATE()
  AND destination_name != ''
GROUP BY label
ORDER BY MIN(STR_TO_DATE(call_date, '%Y-%d-%m'));
  `
    );

    const newYearly = await runQuery(
      connection,
      `
 SELECT 
    CASE 
        WHEN MONTH(ap.appointment_timestamp) >= 4 
            THEN CONCAT(YEAR(ap.appointment_timestamp), '-', YEAR(ap.appointment_timestamp) + 1)
        ELSE CONCAT(YEAR(ap.appointment_timestamp) - 1, '-', YEAR(ap.appointment_timestamp))
    END AS label,
    COUNT(*) AS value
FROM appointment ap
WHERE ap.patient_type = 'New'   -- change to 'Follow' or 'Postoperative'
  AND ap.is_deleted != 1
  AND ap.confirm_time != '0'
  AND ap.appointment_timestamp BETWEEN DATE_SUB(CURDATE(), INTERVAL 3 YEAR) AND CURDATE()
GROUP BY label
ORDER BY MIN(ap.appointment_timestamp);

  `
    );

    const followupYearly = await runQuery(
      connection,
      `
 SELECT 
    CASE 
        WHEN MONTH(ap.appointment_timestamp) >= 4 
            THEN CONCAT(YEAR(ap.appointment_timestamp), '-', YEAR(ap.appointment_timestamp) + 1)
        ELSE CONCAT(YEAR(ap.appointment_timestamp) - 1, '-', YEAR(ap.appointment_timestamp))
    END AS label,
    COUNT(*) AS value
FROM appointment ap
WHERE ap.patient_type = 'Follow'   -- or 'New', 'Postoperative'
  AND ap.is_deleted != 1
  AND ap.confirm_time != '0'
  AND ap.appointment_timestamp BETWEEN DATE_SUB(CURDATE(), INTERVAL 3 YEAR) AND CURDATE()
GROUP BY label
ORDER BY MIN(ap.appointment_timestamp);


  `
    );

    const ipdPatientYearly = await runQuery(
      connection,
      `
 SELECT 
    CASE 
        WHEN MONTH(inv.creation_date) >= 4 
            THEN CONCAT(YEAR(inv.creation_date), '-', YEAR(inv.creation_date) + 1)
        ELSE CONCAT(YEAR(inv.creation_date) - 1, '-', YEAR(inv.creation_date))
    END AS label,
    COUNT(DISTINCT inv.patient_id) AS value
FROM invoice inv
WHERE inv.creation_date BETWEEN DATE_SUB(CURDATE(), INTERVAL 3 YEAR) AND CURDATE()
GROUP BY label
ORDER BY MIN(inv.creation_date);

  `
    );

    const opdYearly = await runQuery(
      connection,
      `
 SELECT 
    CASE 
        WHEN MONTH(receipt_date) >= 4 
            THEN CONCAT(YEAR(receipt_date), '-', YEAR(receipt_date) + 1)
        ELSE CONCAT(YEAR(receipt_date) - 1, '-', YEAR(receipt_date))
    END AS label,
    SUM(totalamt) AS value
FROM patient_receipt
WHERE receipt_date BETWEEN DATE_SUB(CURDATE(), INTERVAL 3 YEAR) AND CURDATE()
  AND is_deleted != 1
GROUP BY label
ORDER BY MIN(receipt_date);

  `
    );

    let labYearly;

    if (location === "DP Road") {
      // Yearly LAB totals (DP Road)
      labYearly = await runQuery(
        connection,
        `
    SELECT 
    CASE 
        WHEN MONTH(receipt_date) >= 4 
            THEN CONCAT(YEAR(receipt_date), '-', YEAR(receipt_date) + 1)
        ELSE CONCAT(YEAR(receipt_date) - 1, '-', YEAR(receipt_date))
    END AS label,
    SUM(totalamt) AS value
FROM patient_receipt
WHERE chargeCondition = 'LabTest'
  AND receipt_date BETWEEN DATE_SUB(CURDATE(), INTERVAL 3 YEAR) AND CURDATE()
  AND is_deleted != 1
GROUP BY label
ORDER BY MIN(receipt_date);

    `
      );
    } else {
      // Yearly LAB totals (non–DP Road)
      labYearly = await runQuery(
        connection,
        `
    SELECT 
    CASE 
        WHEN MONTH(item_date) >= 4 
            THEN CONCAT(YEAR(item_date), '-', YEAR(item_date) + 1)
        ELSE CONCAT(YEAR(item_date) - 1, '-', YEAR(item_date))
    END AS label,
    SUM(total) AS value
FROM patient_itemreceipt
WHERE consultation = 'LAB'
  AND item_date BETWEEN DATE_SUB(CURDATE(), INTERVAL 3 YEAR) AND CURDATE()
  AND is_deleted != 1
GROUP BY label
ORDER BY MIN(item_date);

    `
      );
    }

    const ipdYearly = await runQuery(
      connection,
      `
 SELECT 
    CASE 
        WHEN MONTH(creation_date) >= 4 
            THEN CONCAT(YEAR(creation_date), '-', YEAR(creation_date) + 1)
        ELSE CONCAT(YEAR(creation_date) - 1, '-', YEAR(creation_date))
    END AS label,
    SUM(totalamt) AS value
FROM invoice
WHERE creation_date BETWEEN DATE_SUB(CURDATE(), INTERVAL 3 YEAR) AND CURDATE()
GROUP BY label
ORDER BY MIN(creation_date);

  `
    );

    // ✅ Yearly (last 4 calendar years, Jan–Dec)
    const leadsYearly = await runLeadQuery(
      leadConnection,
      `
  SELECT 
    CASE 
      WHEN MONTH(date) >= 4 
        THEN CONCAT(YEAR(date), '-', YEAR(date) + 1)
      ELSE CONCAT(YEAR(date) - 1, '-', YEAR(date))
    END AS label,
    COUNT(*) AS value
  FROM appointments
  WHERE (${areaConditions})
    AND date BETWEEN DATE_SUB(CURDATE(), INTERVAL 3 YEAR) AND CURDATE()
  GROUP BY label
  ORDER BY MIN(date);
  `,
      [...areaParams]
    );

    const chatbotLeadsYearly = await runLeadQuery(
      leadConnection,
      `
  SELECT 
    CASE 
      WHEN MONTH(datetime) >= 4 
        THEN CONCAT(YEAR(datetime), '-', YEAR(datetime) + 1)
      ELSE CONCAT(YEAR(datetime) - 1, '-', YEAR(datetime))
    END AS label,
    COUNT(*) AS value
  FROM chatbot_leads
  WHERE ${whereClause}
    AND datetime BETWEEN DATE_SUB(CURDATE(), INTERVAL 3 YEAR) AND CURDATE()
  GROUP BY label
  ORDER BY MIN(datetime)
  `,
      params
    );

    // ✅ Build final response with plain arrays (no Query objects)
    const rawData = buildResponse(
      {
        opdCurrent: opdMonthlyCurrent,
        opdPrevious: opdMonthlyPrevious,
        labCurrent: labMonthlyCurrent,
        labPrevious: labMonthlyPrevious,
        ipdCurrent: ipdMonthlyCurrent,
        ipdPrevious: ipdMonthlyPrevious,
        ipdPatientCurrent: ipdPatientMonthlyCurrent,
        ipdPatientPrevious: ipdPatientMonthlyPrevious,
        newCurrent: newMonthlyCurrent,
        newPrevious: newMonthlyPrevious,
        followCurrent: followupMonthlyCurrent,
        followPrevious: followupMonthlyPrevious,
        ivrCurrent: ivrMonthlyCurrent,
        ivrPrevious: ivrMonthlyPrevious,
        webCurrent: leadsMonthlyCurrent,
        webPrevious: leadsMonthlyPrevious,
        botCurrent: chatbotLeadsMonthlyCurrent,
        botPrevious: chatbotLeadsMonthlyPrevious,
      },
      {
        opdCurrent: opdQuarterlyCurrent,
        opdPrevious: opdQuarterlyPrevious,
        labCurrent: labQuarterlyCurrent,
        labPrevious: labQuarterlyPrevious,
        ipdCurrent: ipdQuarterlyCurrent,
        ipdPrevious: ipdQuarterlyPrevious,
        ipdPatientCurrent: ipdPatientQuarterlyCurrent,
        ipdPatientPrevious: ipdPatientQuarterlyPrevious,
        newCurrent: newQuarterlyCurrent,
        newPrevious: newQuarterlyPrevious,
        followCurrent: followupQuarterlyCurrent,
        followPrevious: followupQuarterlyPrevious,
        ivrCurrent: ivrQuarterlyCurrent,
        ivrPrevious: ivrQuarterlyPrevious,
        webCurrent: leadsQuarterlyCurrent,
        webPrevious: leadsQuarterlyPrevious,
        botCurrent: chatbotLeadsQuarterlyCurrent,
        botPrevious: chatbotLeadsQuarterlyPrevious,
      },
      {
        opd: opdYearly,
        lab: labYearly,
        ipd: ipdYearly,
        new: newYearly,
        follow: followupYearly,
        ipdPatient: ipdPatientYearly,
        ivr: ivrYearly,
        web: leadsYearly,
        bot: chatbotLeadsYearly,
      }
    );
    let response = { ...rawData };

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

    const labChartDataMonthly = prepareChartData(
      labMonthlyCurrent,
      labMonthlyPrevious
    );
    const labChartDataQuarterly = prepareChartData(
      labQuarterlyCurrent,
      labQuarterlyPrevious
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

    const AIFilteredData = sanitizeData(rawData);

    response.Leads = {
      Monthly: {
        ivrChartData: ivrChartDataMonthly,
        webChartData: webChartDataMonthly,
        botChartData: botChartDataMonthly,
        // summary: LeadSummary.reply,
      },
      Quarterly: {
        ivrChartData: ivrChartDataQuarterly,
        webChartData: webChartDataQuarterly,
        botChartData: botChartDataQuarterly,
        // summary: LeadSummary.reply,
      },
      Yearly: {
        ivrChartData: ivrYearly,
        webChartData: leadsYearly,
        botChartData: chatbotLeadsYearly,
        // summary: LeadSummary.reply,
      },
    };

    response.Patients = {
      Monthly: {
        newPatientChartData: newPatientChartDataMonthly,
        followUpPatientChartData: followUpPatientChartDataMonthly,
        ipdPatientChartData: ipdPatientChartDataMonthly,
        // summary: PatientSummary.reply,
      },
      Quarterly: {
        newPatientChartData: newPatientChartDataQuarterly,
        followUpPatientChartData: followUpPatientChartDataQuarterly,
        ipdPatientChartData: ipdPatientChartDataQuarterly,
        // summary: PatientSummary.reply,
      },
      Yearly: {
        newPatientChartData: newYearly,
        followUpPatientChartData: followupYearly,
        ipdPatientChartData: ipdPatientYearly,
        // summary: PatientSummary.reply,
      },
    };

    response.Opd = {
      Monthly: {
        opdPatientChartData: opdInvoiceChartDataMonthly,
        labChartData: labChartDataMonthly,
        // summary: OPDSummary.reply,
      },
      Quarterly: {
        opdPatientChartData: opdInvoiceChartDataQuarterly,
        labChartData: labChartDataQuarterly,
        // summary: OPDSummary.reply,
      },
      Yearly: {
        opdPatientChartData: opdYearly,
        labChartData: labYearly,
        // summary: OPDSummary.reply,
      },
    };

    response.Ipd = {
      Monthly: {
        ipdPatientChartData: ipdInvoiceChartDataMonthly,
        //summary: IPDSummary.reply,
      },
      Quarterly: {
        ipdPatientChartData: ipdInvoiceChartDataQuarterly,
        //summary: IPDSummary.reply,
      },
      Yearly: {
        ipdPatientChartData: ipdYearly,
        //summary: IPDSummary.reply,
      },
    };

    // response.Leads = {
    //   Monthly: monthlyLeads,
    //   Quarterly: quarterlyLeads,
    //   Yearly: yearlyLeads,
    // };

    //console.log(ivrMonthly, ivrQuarterly);
    response.AIFilteredData = await getMonthlyPerformance(req);
    console.log("Performance data fetched for", response.AIFilteredData);
    return response;
  } catch (error) {
    console.error("Error fetching performance data:", error);
    throw error;
  }
};

const getMonthlyPerformance = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);
  const { connection: leadConnection } = getConnectionByLocation("lead");

  if (!connection)
    throw Object.assign(new Error("Invalid location"), { status: 404 });
  if (!leadConnection)
    throw Object.assign(new Error("Invalid Lead location"), { status: 404 });

  try {
    const { clause: whereClause, params: chatbotParams } =
      buildChatbotWhere(location);

    let areaConditions = "selected_area LIKE CONCAT('%', ?, '%')";
    let areaParams = [location];
    if (location === "DP Road")
      areaConditions =
        "selected_area LIKE CONCAT('%', ?) OR selected_area LIKE '%Tilak Road%' OR selected_area LIKE '%Dhole Patil Road%'";
    else if (location === "Salunke Vihar")
      areaConditions =
        "selected_area LIKE CONCAT('%', ?) OR selected_area LIKE '%Wanowrie%'";
    else if (location === "Hinjewadi")
      areaConditions =
        "selected_area LIKE CONCAT('%', ?) OR selected_area LIKE '%Hinjawadi%'";
    else if (location === "JP Nagar")
      areaConditions =
        "selected_area LIKE CONCAT('%', ?) OR selected_area = 'Bengaluru'";
    else if (location === "Sarjapura")
      areaConditions =
        "selected_area LIKE CONCAT('%', ?) OR selected_area LIKE '%Sarjapur%'";
    else if (location === "Rajaji Nagar")
      areaConditions =
        "selected_area LIKE CONCAT('%', ?) OR selected_area LIKE '%Rajajinagar%'";
    else if (location === "Belgavi")
      areaConditions =
        "selected_area LIKE CONCAT('%', ?) OR selected_area LIKE '%Belagavi%'";
    else if (location === "Sahakar Nagar")
      areaConditions =
        "selected_area LIKE CONCAT('%', ?) OR selected_area LIKE '%Sahakarnagar%'";
    else if (location === "Gurgaon Sector 14")
      areaConditions =
        "selected_area LIKE CONCAT('%', ?) OR selected_area LIKE '%Gurugram - Sector 14%'";
    else if (location === "Gurgaon Sector 49")
      areaConditions =
        "selected_area LIKE CONCAT('%', ?) OR selected_area LIKE '%Gurugram - Sector 49%'";
    else if (location === "Thane")
      areaConditions =
        "selected_area LIKE CONCAT('%', ?) OR selected_area LIKE '%Kapurbawdi%'";

    const now = new Date();
    const lastCompletedMonth = now.getMonth() - 1; // 0-indexed
    const currentYear = now.getFullYear();
    const previousYear = currentYear - 1;

    const monthLabelsFull = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const fyStartMonth = 3; // April (0-indexed)
    const fyLabels = [
      ...monthLabelsFull.slice(fyStartMonth),
      ...monthLabelsFull.slice(0, fyStartMonth),
    ];

    const buildFyMonthValueMap = (rows, monthsCount = 12) => {
      const map = {};
      for (let i = 0; i < monthsCount; i++) map[fyLabels[i]] = 0;
      (rows || []).forEach((r) => {
        const monthIdx = Number(r.month) - 1;
        const fyPos = (monthIdx - fyStartMonth + 12) % 12;
        if (fyPos >= 0 && fyPos < monthsCount)
          map[fyLabels[fyPos]] = Number(r.value) || 0;
      });
      return map;
    };

    const currentFyMonthsCount =
      lastCompletedMonth >= fyStartMonth
        ? lastCompletedMonth - fyStartMonth + 1
        : lastCompletedMonth + 1 + (12 - fyStartMonth);

    // --- Queries (Original structure, no loop) ---
    const ivrThisRows = await runQuery(
      connection,
      `SELECT MONTH(STR_TO_DATE(call_date, '%Y-%d-%m')) AS month, COUNT(*) AS value
       FROM IVRdata
       WHERE YEAR(STR_TO_DATE(call_date, '%Y-%d-%m')) = YEAR(CURDATE())
         AND destination_name != ''
       GROUP BY MONTH(STR_TO_DATE(call_date, '%Y-%d-%m'))
       ORDER BY MONTH(STR_TO_DATE(call_date, '%Y-%d-%m'))`
    );
    const ivrLastRows = await runQuery(
      connection,
      `SELECT MONTH(STR_TO_DATE(call_date, '%Y-%d-%m')) AS month, COUNT(*) AS value
       FROM IVRdata
       WHERE YEAR(STR_TO_DATE(call_date, '%Y-%d-%m')) = YEAR(CURDATE()) - 1
         AND destination_name != ''
       GROUP BY MONTH(STR_TO_DATE(call_date, '%Y-%d-%m'))
       ORDER BY MONTH(STR_TO_DATE(call_date, '%Y-%d-%m'))`
    );

    const newThisRows = await runQuery(
      connection,
      `SELECT MONTH(appointment_timestamp) AS month, COUNT(*) AS value
       FROM appointment
       WHERE patient_type='New' AND is_deleted!=1 AND confirm_time!='0' AND YEAR(appointment_timestamp)=YEAR(CURDATE())
       GROUP BY MONTH(appointment_timestamp)
       ORDER BY MONTH(appointment_timestamp)`
    );
    const newLastRows = await runQuery(
      connection,
      `SELECT MONTH(appointment_timestamp) AS month, COUNT(*) AS value
       FROM appointment
       WHERE patient_type='New' AND is_deleted!=1 AND confirm_time!='0' AND YEAR(appointment_timestamp)=YEAR(CURDATE())-1
       GROUP BY MONTH(appointment_timestamp)
       ORDER BY MONTH(appointment_timestamp)`
    );

    const followThisRows = await runQuery(
      connection,
      `SELECT MONTH(appointment_timestamp) AS month, COUNT(*) AS value
       FROM appointment
       WHERE patient_type='Follow' AND is_deleted!=1 AND confirm_time!='0' AND YEAR(appointment_timestamp)=YEAR(CURDATE())
       GROUP BY MONTH(appointment_timestamp)
       ORDER BY MONTH(appointment_timestamp)`
    );
    const followLastRows = await runQuery(
      connection,
      `SELECT MONTH(appointment_timestamp) AS month, COUNT(*) AS value
       FROM appointment
       WHERE patient_type='Follow' AND is_deleted!=1 AND confirm_time!='0' AND YEAR(appointment_timestamp)=YEAR(CURDATE())-1
       GROUP BY MONTH(appointment_timestamp)
       ORDER BY MONTH(appointment_timestamp)`
    );

    const ipdPatientsThisRows = await runQuery(
      connection,
      `SELECT MONTH(creation_date) AS month, COUNT(DISTINCT patient_id) AS value
       FROM invoice
       WHERE YEAR(creation_date)=YEAR(CURDATE())
       GROUP BY MONTH(creation_date)
       ORDER BY MONTH(creation_date)`
    );
    const ipdPatientsLastRows = await runQuery(
      connection,
      `SELECT MONTH(creation_date) AS month, COUNT(DISTINCT patient_id) AS value
       FROM invoice
       WHERE YEAR(creation_date)=YEAR(CURDATE())-1
       GROUP BY MONTH(creation_date)
       ORDER BY MONTH(creation_date)`
    );

    const opdThisRows = await runQuery(
      connection,
      `SELECT MONTH(receipt_date) AS month, IFNULL(SUM(totalamt),0) AS value
       FROM patient_receipt
       WHERE is_deleted!=1 AND YEAR(receipt_date)=YEAR(CURDATE())
       GROUP BY MONTH(receipt_date)
       ORDER BY MONTH(receipt_date)`
    );
    const opdLastRows = await runQuery(
      connection,
      `SELECT MONTH(receipt_date) AS month, IFNULL(SUM(totalamt),0) AS value
       FROM patient_receipt
       WHERE is_deleted!=1 AND YEAR(receipt_date)=YEAR(CURDATE())-1
       GROUP BY MONTH(receipt_date)
       ORDER BY MONTH(receipt_date)`
    );

    let labThisRows, labLastRows;
    if (location === "DP Road") {
      labThisRows = await runQuery(
        connection,
        `SELECT MONTH(receipt_date) AS month, IFNULL(SUM(totalamt),0) AS value
         FROM patient_receipt
         WHERE chargeCondition='LabTest' AND is_deleted!=1 AND YEAR(receipt_date)=YEAR(CURDATE())
         GROUP BY MONTH(receipt_date)
         ORDER BY MONTH(receipt_date)`
      );
      labLastRows = await runQuery(
        connection,
        `SELECT MONTH(receipt_date) AS month, IFNULL(SUM(totalamt),0) AS value
         FROM patient_receipt
         WHERE chargeCondition='LabTest' AND is_deleted!=1 AND YEAR(receipt_date)=YEAR(CURDATE())-1
         GROUP BY MONTH(receipt_date)
         ORDER BY MONTH(receipt_date)`
      );
    } else {
      labThisRows = await runQuery(
        connection,
        `SELECT MONTH(item_date) AS month, IFNULL(SUM(total),0) AS value
         FROM patient_itemreceipt
         WHERE consultation='LAB' AND is_deleted!=1 AND YEAR(item_date)=YEAR(CURDATE())
         GROUP BY MONTH(item_date)
         ORDER BY MONTH(item_date)`
      );
      labLastRows = await runQuery(
        connection,
        `SELECT MONTH(item_date) AS month, IFNULL(SUM(total),0) AS value
         FROM patient_itemreceipt
         WHERE consultation='LAB' AND is_deleted!=1 AND YEAR(item_date)=YEAR(CURDATE())-1
         GROUP BY MONTH(item_date)
         ORDER BY MONTH(item_date)`
      );
    }

    const ipdRevenueThisRows = await runQuery(
      connection,
      `SELECT MONTH(creation_date) AS month, IFNULL(SUM(totalamt),0) AS value
       FROM invoice
       WHERE YEAR(creation_date)=YEAR(CURDATE())
       GROUP BY MONTH(creation_date)
       ORDER BY MONTH(creation_date)`
    );
    const ipdRevenueLastRows = await runQuery(
      connection,
      `SELECT MONTH(creation_date) AS month, IFNULL(SUM(totalamt),0) AS value
       FROM invoice
       WHERE YEAR(creation_date)=YEAR(CURDATE())-1
       GROUP BY MONTH(creation_date)
       ORDER BY MONTH(creation_date)`
    );

    const leadsThisRows = await runLeadQuery(
      leadConnection,
      `SELECT MONTH(date) AS month, COUNT(*) AS value
       FROM appointments
       WHERE (${areaConditions}) AND YEAR(date)=YEAR(CURDATE())
       GROUP BY MONTH(date)
       ORDER BY MONTH(date)`,
      [...areaParams]
    );
    const leadsLastRows = await runLeadQuery(
      leadConnection,
      `SELECT MONTH(date) AS month, COUNT(*) AS value
       FROM appointments
       WHERE (${areaConditions}) AND YEAR(date)=YEAR(CURDATE())-1
       GROUP BY MONTH(date)
       ORDER BY MONTH(date)`,
      [...areaParams]
    );

    const chatbotThisRows = await runLeadQuery(
      leadConnection,
      `SELECT MONTH(datetime) AS month, COUNT(*) AS value
       FROM chatbot_leads
       WHERE ${whereClause} AND YEAR(datetime)=YEAR(CURDATE())
       GROUP BY MONTH(datetime)
       ORDER BY MONTH(datetime)`,
      [...(chatbotParams || [])]
    );
    const chatbotLastRows = await runLeadQuery(
      leadConnection,
      `SELECT MONTH(datetime) AS month, COUNT(*) AS value
       FROM chatbot_leads
       WHERE ${whereClause} AND YEAR(datetime)=YEAR(CURDATE())-1
       GROUP BY MONTH(datetime)
       ORDER BY MONTH(datetime)`,
      [...(chatbotParams || [])]
    );

    // --- Build response FY-wise ---
    const response = {
      "IVR Calls Data": {
        [`FY ${currentYear}-${currentYear + 1}`]: buildFyMonthValueMap(
          ivrThisRows,
          currentFyMonthsCount
        ),
        [`FY ${previousYear}-${previousYear + 1}`]:
          buildFyMonthValueMap(ivrLastRows),
      },
      "New Appointments Data": {
        [`FY ${currentYear}-${currentYear + 1}`]: buildFyMonthValueMap(
          newThisRows,
          currentFyMonthsCount
        ),
        [`FY ${previousYear}-${previousYear + 1}`]:
          buildFyMonthValueMap(newLastRows),
      },
      "Follow-up appointments Data": {
        [`FY ${currentYear}-${currentYear + 1}`]: buildFyMonthValueMap(
          followThisRows,
          currentFyMonthsCount
        ),
        [`FY ${previousYear}-${previousYear + 1}`]:
          buildFyMonthValueMap(followLastRows),
      },
      "IPD Patients Count Data": {
        [`FY ${currentYear}-${currentYear + 1}`]: buildFyMonthValueMap(
          ipdPatientsThisRows,
          currentFyMonthsCount
        ),
        [`FY ${previousYear}-${previousYear + 1}`]:
          buildFyMonthValueMap(ipdPatientsLastRows),
      },
      "Overall OPD Revenue Data": {
        [`FY ${currentYear}-${currentYear + 1}`]: buildFyMonthValueMap(
          opdThisRows,
          currentFyMonthsCount
        ),
        [`FY ${previousYear}-${previousYear + 1}`]:
          buildFyMonthValueMap(opdLastRows),
      },
      "Lab Revenue Data": {
        [`FY ${currentYear}-${currentYear + 1}`]: buildFyMonthValueMap(
          labThisRows,
          currentFyMonthsCount
        ),
        [`FY ${previousYear}-${previousYear + 1}`]:
          buildFyMonthValueMap(labLastRows),
      },
      "IPD Revenue Data": {
        [`FY ${currentYear}-${currentYear + 1}`]: buildFyMonthValueMap(
          ipdRevenueThisRows,
          currentFyMonthsCount
        ),
        [`FY ${previousYear}-${previousYear + 1}`]:
          buildFyMonthValueMap(ipdRevenueLastRows),
      },
      "Web Leads Data": {
        [`FY ${currentYear}-${currentYear + 1}`]: buildFyMonthValueMap(
          leadsThisRows,
          currentFyMonthsCount
        ),
        [`FY ${previousYear}-${previousYear + 1}`]:
          buildFyMonthValueMap(leadsLastRows),
      },
      "Chat Bot leads Data": {
        [`FY ${currentYear}-${currentYear + 1}`]: buildFyMonthValueMap(
          chatbotThisRows,
          currentFyMonthsCount
        ),
        [`FY ${previousYear}-${previousYear + 1}`]:
          buildFyMonthValueMap(chatbotLastRows),
      },
    };

    return response;
  } catch (error) {
    console.error("Error fetching performance data:", error);
    throw error;
  }
};

module.exports = { getPerformance, getMonthlyPerformance };
