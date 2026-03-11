const { getConnectionByLocation } = require("../../databaseUtils");

const getOPDCollection = async (req) => {
  console.log(req.params.location);
  console.log(req.params.from);
  console.log(req.params.to);
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
          SELECT ip.patient_id, p.name, ip.item_date, ip.consultation, ip.payment_mode, ip.total
          FROM patient_itemreceipt ip
          JOIN patient p ON ip.patient_id = p.patient_id
          WHERE ip.is_deleted != 1
          AND ip.item_date >= ?  
          AND ip.item_date <= ?
          ORDER BY ip.item_date DESC
        `;

        const queryParams = [req.query.from, req.query.to]; // Parameters for the SQL query

        tempCon.query(sql, queryParams, (error, rows) => {
          tempCon.release();
          if (error) {
            return reject(error);
          }
          // Convert UPI to Online
          const modifiedRows = rows.map((row) => ({
            ...row,
            payment_mode:
              row.payment_mode === "UPI" ? "Online" : row.payment_mode,
          }));

          resolve(modifiedRows);
        });
      });
    });
    console.log(rows);
    return rows;
  } catch (error) {
    throw error;
  }
};

const getOPDIPDCollection = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    let rows = await getMergedData(connection, req.query.from, req.query.to);
    console.log(rows);
    return rows;
  } catch (error) {
    throw error;
  }
};

const getMergedData = async (connection, fromDate, toDate) => {
  try {
    const executeQuery = (query, params) => {
      return new Promise((resolve, reject) => {
        connection.query(query, params, (error, results) => {
          if (error) {
            return reject(error);
          }
          resolve(results);
        });
      });
    };

    // SQL query for OPD data remains the same
    const sql1 = `
      SELECT 
        ip.item_date AS date,
        SUM(CASE WHEN ip.payment_mode = 'Cash' THEN ip.total ELSE 0 END) AS total_cash,
        SUM(CASE WHEN ip.payment_mode = 'Card' THEN ip.total ELSE 0 END) AS total_card,
        SUM(CASE WHEN ip.payment_mode IN ('Online', 'UPI') THEN ip.total ELSE 0 END) AS total_online
      FROM patient_itemreceipt ip
      JOIN patient p ON ip.patient_id = p.patient_id
      WHERE ip.is_deleted != 1
      AND ip.item_date >= ?  
      AND ip.item_date <= ?
      GROUP BY ip.item_date
      ORDER BY ip.item_date ASC
    `;

    // SQL query for IPD data with date extraction
    const sql2 = `
      SELECT 
        DATE(ip.receipt_date) AS date,
        SUM(ip.cashamt) AS total_cashamt,
        SUM(ip.cardamt) AS total_cardamt,
        SUM(ip.onlineamt) AS total_onlineamt,
        SUM(ip.discountamt) AS total_discountamt
      FROM ipd_payment ip
      WHERE DATE(ip.receipt_date) >= ?  
      AND DATE(ip.receipt_date) <= ?
      GROUP BY DATE(ip.receipt_date)
      ORDER BY DATE(ip.receipt_date) ASC
    `;

    // Execute queries
    const [opdResults, ipdResults] = await Promise.all([
      executeQuery(sql1, [fromDate, toDate]),
      executeQuery(sql2, [fromDate, toDate]),
    ]);

    // Merge the results date-wise
    const mergedData = {};
    let total_opd_cash = 0,
      total_opd_card = 0,
      total_opd_online = 0;
    let total_ipd_cash = 0,
      total_ipd_card = 0,
      total_ipd_online = 0,
      total_ipd_discount = 0;

    // Process OPD data
    opdResults.forEach((opd) => {
      const dateKey = opd.date; // No need to split, date is already correct
      if (!mergedData[dateKey]) {
        mergedData[dateKey] = {
          date: dateKey,
          opd_cash: opd.total_cash || 0,
          opd_card: opd.total_card || 0,
          opd_online: opd.total_online || 0,
          ipd_cash: 0,
          ipd_card: 0,
          ipd_online: 0,
          ipd_discount: 0,
        };
      } else {
        mergedData[dateKey].opd_cash += opd.total_cash || 0;
        mergedData[dateKey].opd_card += opd.total_card || 0;
        mergedData[dateKey].opd_online += opd.total_online || 0;
      }
      // Update overall OPD totals
      total_opd_cash += opd.total_cash || 0;
      total_opd_card += opd.total_card || 0;
      total_opd_online += opd.total_online || 0;
    });

    // Process IPD data
    ipdResults.forEach((ipd) => {
      const dateKey = new Date(ipd.date).toISOString().split("T")[0]; // new Date(ipd.date).toLocaleDateString("en-CA"); // No need to split, date is already correct
      if (!mergedData[dateKey]) {
        mergedData[dateKey] = {
          date: dateKey,
          opd_cash: 0,
          opd_card: 0,
          opd_online: 0,
          ipd_cash: ipd.total_cashamt || 0,
          ipd_card: ipd.total_cardamt || 0,
          ipd_online: ipd.total_onlineamt || 0,
          ipd_discount: ipd.total_discountamt || 0,
        };
      } else {
        mergedData[dateKey].ipd_cash += ipd.total_cashamt || 0;
        mergedData[dateKey].ipd_card += ipd.total_cardamt || 0;
        mergedData[dateKey].ipd_online += ipd.total_onlineamt || 0;
        mergedData[dateKey].ipd_discount += ipd.total_discountamt || 0;
      }

      // Update overall IPD totals
      total_ipd_cash += ipd.total_cashamt || 0;
      total_ipd_card += ipd.total_cardamt || 0;
      total_ipd_online += ipd.total_onlineamt || 0;
      total_ipd_discount += ipd.total_discountamt || 0;
    });

    const overallCollection = [
      [total_ipd_cash, total_opd_cash],
      [total_ipd_card, total_opd_card],
      [total_ipd_online, total_opd_online],

      [total_ipd_discount, 0],
      [
        total_ipd_cash + total_ipd_card + total_ipd_online - total_ipd_discount,
        total_opd_cash + total_opd_card + total_opd_online,
      ],
    ];

    // Convert mergedData object to an array of objects
    const mergedArray = Object.values(mergedData);
    const transformedData = mergedArray.map((item) => {
      const {
        date,
        ipd_cash,
        ipd_card,
        ipd_online,
        ipd_discount,
        opd_cash,
        opd_card,
        opd_online,
      } = item;

      const total_cash = ipd_cash + opd_cash;
      const total_card = ipd_card + opd_card;
      const total_online = ipd_online + opd_online;
      const total_discount = ipd_discount;

      return [
        date,
        [
          [ipd_cash, ipd_card, ipd_online, ipd_discount],
          [opd_cash, opd_card, opd_online, 0],
          [total_cash, total_card, total_online, total_discount],
        ],
      ];
    });

    // console.log(transformedData);

    return { transformedData, overallCollection };
  } catch (error) {
    console.error("Error merging data:", error);
    throw error;
  }
};

const getOPDCollectionV2 = async (req) => {
  const { connection } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        const sql = `
          SELECT ip.patient_id, p.name, ip.item_date, ip.consultation, ip.payment_mode, ip.total
          FROM patient_itemreceipt ip
          JOIN patient p ON ip.patient_id = p.patient_id
          WHERE ip.is_deleted != 1
          AND ip.item_date >= ?
          AND ip.item_date <= ?
          ORDER BY ip.item_date DESC
        `;

        const queryParams = [req.query.from, req.query.to];

        tempCon.query(sql, queryParams, (error, rows) => {
          tempCon.release();
          if (error) return reject(error);

          const modifiedRows = rows.map((row) => ({
            ...row,
            payment_mode:
              row.payment_mode === "UPI" ? "Online" : row.payment_mode,
          }));

          resolve(modifiedRows);
        });
      });
    });

    const targetConsultations = [
      "CONSULTATION",
      "PROCTOSCOPY",
      "FOLLOW-UP",
      "BUGSPEAKS",
    ];

    const paymentModes = ["Cash", "Card", "Online"];
    const consultationTotals = {};
    const consultationPaymentModeTotals = {};

    for (const row of rows) {
      const consultationType = row.consultation || "UNKNOWN";
      const paymentMode = row.payment_mode || "UNKNOWN";
      const amount = Number(row.total);

      const groupKey = targetConsultations.includes(consultationType)
        ? consultationType
        : "OTHER";

      // Initialize total
      if (!consultationTotals[groupKey]) {
        consultationTotals[groupKey] = 0;
      }
      consultationTotals[groupKey] += amount;

      // Initialize paymentMode map
      if (!consultationPaymentModeTotals[groupKey]) {
        consultationPaymentModeTotals[groupKey] = {};
      }
      if (!consultationPaymentModeTotals[groupKey][paymentMode]) {
        consultationPaymentModeTotals[groupKey][paymentMode] = 0;
      }
      consultationPaymentModeTotals[groupKey][paymentMode] += amount;
    }

    // Ensure all target types + "OTHER" have Cash, Card, Online set to 0 if missing
    const allGroups = [...targetConsultations, "OTHER"];
    for (const type of allGroups) {
      if (!consultationPaymentModeTotals[type]) {
        consultationPaymentModeTotals[type] = {};
      }
      for (const mode of paymentModes) {
        if (!consultationPaymentModeTotals[type][mode]) {
          consultationPaymentModeTotals[type][mode] = 0;
        }
      }

      if (!consultationTotals[type]) {
        consultationTotals[type] = 0;
      }
    }
    console.log("Consultation Totals:", consultationPaymentModeTotals);
    return {
      data: rows,
      consultationTotals,
      consultationPaymentModeTotals,
    };
  } catch (error) {
    throw error;
  }
};

const getOPDCollectionV3 = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const { from, to } = req.query;

  const normalizeMode = (m) => {
    if (!m) return "UNKNOWN";
    const s = String(m).trim();
    if (/^upi$/i.test(s) || /^paytm$/i.test(s)) return "Online";
    if (/^card$/i.test(s)) return "Card";
    if (/^cash$/i.test(s)) return "Cash";
    return s;
  };

  const runWithPool = (sql, params = []) =>
    new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);
        tempCon.query(sql, params, (error, rows) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(rows);
        });
      });
    });

  const computeAggregates = (rows, targetConsultations) => {
    const paymentModes = ["Cash", "Card", "Online"];
    const consultationTotals = {};
    const consultationPaymentModeTotals = {};

    for (const row of rows) {
      const rawConsult = row.consultation || "UNKNOWN";
      const paymentMode = normalizeMode(row.payment_mode);
      const amount = Number(row.total) || 0;

      const groupKey = targetConsultations.includes(rawConsult)
        ? rawConsult
        : "OTHER";

      consultationTotals[groupKey] =
        (consultationTotals[groupKey] || 0) + amount;

      if (!consultationPaymentModeTotals[groupKey]) {
        consultationPaymentModeTotals[groupKey] = {};
      }
      consultationPaymentModeTotals[groupKey][paymentMode] =
        (consultationPaymentModeTotals[groupKey][paymentMode] || 0) + amount;
    }

    const allGroups = [...targetConsultations, "OTHER"];
    for (const g of allGroups) {
      if (!consultationTotals[g]) consultationTotals[g] = 0;
      if (!consultationPaymentModeTotals[g])
        consultationPaymentModeTotals[g] = {};
      for (const pm of paymentModes) {
        if (!consultationPaymentModeTotals[g][pm]) {
          consultationPaymentModeTotals[g][pm] = 0;
        }
      }
    }

    return { consultationTotals, consultationPaymentModeTotals };
  };

  try {
    // ---------------- LAB rows ----------------
    let labRowsSql;
    if (location === "DP Road") {
      labRowsSql = `
        SELECT pr.receipt_id, pr.patient_id, p.name,
               pr.receipt_date AS item_date,
               'LAB' AS consultation,
               pr.paymentmode AS payment_mode,
               pr.totalamt AS total
        FROM patient_receipt pr
        JOIN patient p ON pr.patient_id = p.patient_id
        WHERE pr.chargeCondition = 'LabTest'
          AND pr.receipt_date >= ?
          AND pr.receipt_date <= ?
          AND pr.is_deleted != 1
        ORDER BY pr.receipt_date DESC
      `;
    } else {
      labRowsSql = `
        SELECT ip.receipt_id, ip.patient_id, p.name,
               ip.item_date,
               'LAB' AS consultation,
               ip.payment_mode, ip.total
        FROM patient_itemreceipt ip
        JOIN patient p ON ip.patient_id = p.patient_id
        WHERE ip.consultation = 'LAB'
          AND ip.item_date >= ?
          AND ip.item_date <= ?
          AND ip.is_deleted != 1
        ORDER BY ip.item_date DESC
      `;
    }

    const labRawRows = await runWithPool(labRowsSql, [from, to]);
    const labRows = labRawRows.map((r) => ({
      ...r,
      payment_mode: normalizeMode(r.payment_mode),
    }));
    const labForAggregate = labRows.map((r) => ({ ...r, consultation: "LAB" }));

    const {
      consultationTotals: labConsultationTotals,
      consultationPaymentModeTotals: labConsultationPaymentModeTotals,
    } = computeAggregates(labForAggregate, ["LAB"]);

    // ---------------- OPD rows ----------------
    let opdSql, opdParams;
    if (location === "DP Road") {
      // fetch OPD rows, exclude LAB by receipt_id
      const labIds = labRows.map((r) => r.receipt_id); // collected above
      opdSql = `
        SELECT ip.receipt_id, ip.patient_id, p.name, ip.item_date,
               ip.consultation, ip.payment_mode, ip.total
        FROM patient_itemreceipt ip
        JOIN patient p ON ip.patient_id = p.patient_id
        WHERE ip.is_deleted != 1
          AND ip.item_date >= ?
          AND ip.item_date <= ?
      `;
      opdParams = [from, to];
      if (labIds.length > 0) {
        opdSql += ` AND ip.receipt_id NOT IN (?) `;
        opdParams.push(labIds);
      }
    } else {
      // other locations → just exclude LAB by consultation
      opdSql = `
        SELECT ip.receipt_id, ip.patient_id, p.name, ip.item_date,
               ip.consultation, ip.payment_mode, ip.total
        FROM patient_itemreceipt ip
        JOIN patient p ON ip.patient_id = p.patient_id
        WHERE ip.is_deleted != 1
          AND ip.item_date >= ?
          AND ip.item_date <= ?
          AND ip.consultation != 'LAB'
        ORDER BY ip.item_date DESC
      `;
      opdParams = [from, to];
    }

    const opdRawRows = await runWithPool(opdSql, opdParams);
    const opdRows = opdRawRows.map((r) => ({
      ...r,
      payment_mode: normalizeMode(r.payment_mode),
    }));

    const opdTargetConsultations = [
      "CONSULTATION",
      "PROCTOSCOPY",
      "FOLLOW-UP",
      "BUGSPEAKS",
    ];
    const {
      consultationTotals: opdConsultationTotals,
      consultationPaymentModeTotals: opdConsultationPaymentModeTotals,
    } = computeAggregates(opdRows, opdTargetConsultations);

    // ---------------- FINAL RESPONSE ----------------
    return {
      data: [...opdRows, ...labRows],
      consultationTotals: {
        ...opdConsultationTotals,
        LAB: labConsultationTotals.LAB,
      },
      consultationPaymentModeTotals: {
        ...opdConsultationPaymentModeTotals,
        LAB: labConsultationPaymentModeTotals.LAB,
      },
    };
  } catch (error) {
    throw error;
  }
};

module.exports = {
  getOPDCollection,
  getOPDIPDCollection,
  getOPDCollectionV2,
  getOPDCollectionV3,
};
