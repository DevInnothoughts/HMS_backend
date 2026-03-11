const { getConnectionByLocation } = require("../../databaseUtils");

async function getDailyOPDCollection(req) {
  const { connection, location } = getConnectionByLocation(req.query.location);

  // Get the current date in YYYY-MM-DD format
  const currentDate = new Date(req.query.date).toISOString().split("T")[0];
  console.log("Current date:", currentDate);
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
      // Counts for patient types
      const newPatientCountQuery = `
        SELECT COUNT(patient_type) AS newpatient
        FROM appointment
        WHERE appointment_timestamp = ?
          AND patient_type = 'New'
          AND is_deleted != 1
          AND executivechk = 2
      `;

      const followPatientCountQuery = `
        SELECT COUNT(patient_type) AS followpatient
        FROM appointment
        WHERE appointment_timestamp = ?
          AND patient_type = 'Follow'
          AND is_deleted != 1
          AND executivechk = 2
      `;
      const poPatientCountQuery = `
        SELECT COUNT(patient_type) AS popatient
        FROM appointment
        WHERE appointment_timestamp = ?
          AND patient_type = 'Postoperative'
          AND is_deleted != 1
          AND executivechk = 2
      `;

      // Proctoscopy count
      const proctoscopyCountQuery = `
        SELECT COUNT(consultation) AS proctoscopy
        FROM patient_itemreceipt
        WHERE item_date = ?
          AND consultation = 'PROCTOSCOPY'
          AND is_deleted != 1
      `;

      const diagnosisCountQuery = `
        SELECT COUNT(*) AS diagnosis
        FROM diagnosis
        WHERE date_diagnosis = ?
      `;

      const prescriptionCountQuery = `
       SELECT 
        COUNT(DISTINCT patient_id) AS prescription
      FROM prescription
      WHERE creation_timestamp = ?
        AND prescription_type != 'surgery_type'
        AND is_deleted != 1;
      `;

      const [
        newPatientCount,
        followPatientCount,
        poPatientCount,
        proctoscopyCount,
        diagnosisCount,
        prescriptionCount,
      ] = await Promise.all([
        executeQuery(newPatientCountQuery, [currentDate]),
        executeQuery(followPatientCountQuery, [currentDate]),
        executeQuery(poPatientCountQuery, [currentDate]),
        executeQuery(proctoscopyCountQuery, [currentDate]),
        executeQuery(diagnosisCountQuery, [currentDate]),
        executeQuery(prescriptionCountQuery, [currentDate]),
      ]);

      console.log("Prescription Count:", prescriptionCountQuery);

      const firstTableSum =
        newPatientCount[0].newpatient +
        followPatientCount[0].followpatient +
        poPatientCount[0].popatient;

      // Counts for DNC
      const newDNCQuery = `
        SELECT COUNT(DISTINCT appointment.patient_id) AS newDNCount
        FROM appointment
        JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
        WHERE appointment.appointment_timestamp = ?
          AND patient_receipt.receipt_date = ?
          AND patient_receipt.chargeCondition = 'DNC'
          AND appointment.patient_type = 'New'
          AND appointment.is_deleted != 1
          AND patient_receipt.is_deleted != 1
          AND appointment.executivechk = 2
      `;
      const followDNCQuery = `
        SELECT COUNT(DISTINCT appointment.patient_id) AS FollowDNCount
        FROM appointment
        JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
        WHERE appointment.appointment_timestamp = ?
          AND patient_receipt.receipt_date = ?
          AND patient_receipt.chargeCondition = 'DNC'
          AND appointment.patient_type = 'Follow'
          AND appointment.executivechk = 2
          AND patient_receipt.is_deleted != 1
      `;
      const poDNCQuery = `
        SELECT COUNT(DISTINCT appointment.patient_id) AS PODNCCount
        FROM appointment
        JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
        WHERE appointment.appointment_timestamp = ?
          AND patient_receipt.receipt_date = ?
          AND patient_receipt.chargeCondition = 'DNC'
          AND appointment.confirm_time !=0
          AND appointment.patient_type = 'Postoperative'
          AND patient_receipt.is_deleted != 1
      `;

      const [newDNCount, followDNCount, poDNCCount] = await Promise.all([
        executeQuery(newDNCQuery, [currentDate, currentDate]),
        executeQuery(followDNCQuery, [currentDate, currentDate]),
        executeQuery(poDNCQuery, [currentDate, currentDate]),
      ]);

      const sumofDNC =
        newDNCount[0].newDNCount +
        followDNCount[0].FollowDNCount +
        poDNCCount[0].PODNCCount;

      // Counts for DNP
      const newDNPQuery = `
        SELECT COUNT(DISTINCT appointment.patient_id) AS newDNPCount
        FROM appointment
        JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
        WHERE appointment.appointment_timestamp = ?
          AND patient_receipt.receipt_date = ?
          AND patient_receipt.chargeCondition = 'DNP'
          AND appointment.patient_type = 'New'
          AND appointment.executivechk = 2
          AND patient_receipt.is_deleted != 1
      `;
      const followDNPQuery = `
        SELECT COUNT(DISTINCT appointment.patient_id) AS FollowDNPCount
        FROM appointment
        JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
        WHERE appointment.appointment_timestamp = ?
          AND patient_receipt.receipt_date = ?
          AND patient_receipt.chargeCondition = 'DNP'
          AND appointment.patient_type = 'Follow'
          AND appointment.executivechk = 2
          AND patient_receipt.is_deleted != 1
      `;
      const poDNPQuery = `
        SELECT COUNT(DISTINCT appointment.patient_id) AS PODNPCount
        FROM appointment
        JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
        WHERE patient_receipt.receipt_date = ?
          AND patient_receipt.chargeCondition = 'DNP'
          AND appointment.confirm_time !=0
          AND appointment.patient_type = 'Postoperative'
          AND patient_receipt.is_deleted != 1
      `;

      const [newDNPCount, followDNPCount, poDNPCount] = await Promise.all([
        executeQuery(newDNPQuery, [currentDate, currentDate]),
        executeQuery(followDNPQuery, [currentDate, currentDate]),
        executeQuery(poDNPQuery, [currentDate]),
      ]);

      const sumofDNP =
        newDNPCount[0].newDNPCount +
        followDNPCount[0].FollowDNPCount +
        poDNPCount[0].PODNPCount;

      // Counts for DNW
      const newDNWQuery = `
        SELECT COUNT(DISTINCT appointment.patient_id) AS newDNWCount
        FROM appointment
        JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
        WHERE patient_receipt.receipt_date = ?
          AND patient_receipt.chargeCondition = 'DNW'
          AND appointment.patient_type = 'New'
          AND appointment.executivechk = 2
          AND patient_receipt.is_deleted != 1
      `;
      const followDNWQuery = `
        SELECT COUNT(DISTINCT appointment.patient_id) AS FollowDNWCount
        FROM appointment
        JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
        WHERE patient_receipt.receipt_date = ?
          AND patient_receipt.chargeCondition = 'DNW'
          AND appointment.patient_type = 'Follow'
          AND appointment.executivechk = 2
          AND patient_receipt.is_deleted != 1
      `;
      const poDNWQuery = `
        SELECT COUNT(DISTINCT appointment.patient_id) AS PODNWCount
        FROM appointment
        JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
        WHERE patient_receipt.receipt_date = ?
          AND patient_receipt.chargeCondition = 'DNW'
          AND appointment.confirm_time !=0
          AND appointment.patient_type = 'Postoperative'
          AND patient_receipt.is_deleted != 1
      `;

      const [newDNWCount, followDNWCount, poDNWCount] = await Promise.all([
        executeQuery(newDNWQuery, [currentDate]),
        executeQuery(followDNWQuery, [currentDate]),
        executeQuery(poDNWQuery, [currentDate]),
      ]);

      const sumofDNW =
        newDNWCount[0].newDNWCount +
        followDNWCount[0].FollowDNWCount +
        poDNWCount[0].PODNWCount;

      // Cancelled patient counts
      const cancelNewPatientCountQuery = `
        SELECT COUNT(is_deleted) AS is_deleted
        FROM appointment
        WHERE appointment_timestamp = ?
          AND patient_type = 'New'
          AND is_deleted = 1
      `;
      const cancelFollowPatientCountQuery = `
        SELECT COUNT(is_deleted) AS is_deleted
        FROM appointment
        WHERE appointment_timestamp = ?
          AND patient_type = 'Follow'
          AND is_deleted = 1
      `;
      const cancelPOPatientCountQuery = `
        SELECT COUNT(is_deleted) AS is_deleted
        FROM appointment
        WHERE appointment_timestamp = ?
          AND patient_type = 'Postoperative'
          AND is_deleted = 1
      `;

      const [
        cancelNewPatientCount,
        cancelFollowPatientCount,
        cancelPOPatientCount,
      ] = await Promise.all([
        executeQuery(cancelNewPatientCountQuery, [currentDate]),
        executeQuery(cancelFollowPatientCountQuery, [currentDate]),
        executeQuery(cancelPOPatientCountQuery, [currentDate]),
      ]);

      const sumofDNT =
        cancelNewPatientCount[0].is_deleted +
        cancelFollowPatientCount[0].is_deleted +
        cancelPOPatientCount[0].is_deleted;

      // Walk-in patient counts
      const walkINNewPatientCountQuery = `
        SELECT COUNT(FDE_Name) AS FDEName
        FROM appointment
        WHERE appointment_timestamp = ?
          AND patient_type = 'New'
          AND executivechk = 2
          AND FDE_Name = 'WALK-IN'
      `;
      const walkINFollowPatientCountQuery = `
        SELECT COUNT(FDE_Name) AS FDEName
        FROM appointment
        WHERE appointment_timestamp = ?
          AND patient_type = 'Follow'
          AND executivechk = 2
          AND FDE_Name = 'WALK-IN'
      `;
      const walkINPOPatientCountQuery = `
        SELECT COUNT(FDE_Name) AS FDEName
        FROM appointment
        WHERE appointment_timestamp = ?
          AND patient_type = 'Postoperative'
          AND executivechk = 2
          AND FDE_Name = 'WALK-IN'
      `;

      const [
        walkINNewPatientCount,
        walkINFollowPatientCount,
        walkINPOPatientCount,
      ] = await Promise.all([
        executeQuery(walkINNewPatientCountQuery, [currentDate]),
        executeQuery(walkINFollowPatientCountQuery, [currentDate]),
        executeQuery(walkINPOPatientCountQuery, [currentDate]),
      ]);

      const sumofWalkIN =
        walkINNewPatientCount[0].FDEName +
        walkINFollowPatientCount[0].FDEName +
        walkINPOPatientCount[0].FDEName;

      // Total cash, card, online, and Paytm
      const cashTotalQuery = `
        SELECT SUM(total) AS Total
        FROM patient_itemreceipt
        WHERE item_date = ?
          AND payment_mode = 'Cash'
          AND is_deleted != 1
      `;
      const cardTotalQuery = `
        SELECT SUM(total) AS Total
        FROM patient_itemreceipt
        WHERE item_date = ?
          AND payment_mode = 'Card'
          AND is_deleted != 1
      `;
      const onlineTotalQuery = `
        SELECT SUM(total) AS Total
  FROM patient_itemreceipt
  WHERE item_date = ?
    AND payment_mode IN ('Online', 'UPI')
    AND is_deleted != 1
      `;
      const chequeTotalQuery = `
        SELECT SUM(total) AS Total
        FROM patient_itemreceipt
        WHERE item_date = ?
          AND payment_mode = 'Cheque'
          AND is_deleted != 1
      `;

      const [cashTotal, cardTotal, onlineTotal] = await Promise.all([
        executeQuery(cashTotalQuery, [currentDate]),
        executeQuery(cardTotalQuery, [currentDate]),
        executeQuery(onlineTotalQuery, [currentDate]),
      ]);

      const cashtablesum =
        (cashTotal[0].Total || 0) +
        (cardTotal[0].Total || 0) +
        (onlineTotal[0].Total || 0);

      let labCashTotalQuery, labCardTotalQuery, labOnlineTotalQuery;

      if (location === "DP Road") {
        labCashTotalQuery = `
            SELECT SUM(totalamt) AS Total
            FROM patient_receipt
            WHERE receipt_date = ?
              AND paymentmode = 'Cash'
              AND chargeCondition = 'LabTest'
              AND is_deleted != 1
          `;
        labCardTotalQuery = `
            SELECT SUM(totalamt) AS Total
            FROM patient_receipt
            WHERE receipt_date = ?
              AND paymentmode = 'Card'
              AND chargeCondition = 'LabTest'
              AND is_deleted != 1
          `;
        labOnlineTotalQuery = `
            SELECT SUM(totalamt) AS Total
            FROM patient_receipt
            WHERE receipt_date = ?
              AND paymentmode IN ('Online', 'UPI')
              AND chargeCondition = 'LabTest'
              AND is_deleted != 1
          `;
      } else {
        labCashTotalQuery = `
            SELECT SUM(total) AS Total
            FROM patient_itemreceipt
            WHERE item_date = ?
              AND payment_mode = 'Cash'
              AND consultation = 'LAB'
              AND is_deleted != 1
          `;
        labCardTotalQuery = `
            SELECT SUM(total) AS Total
            FROM patient_itemreceipt
            WHERE item_date = ?
              AND payment_mode = 'Card'
              AND consultation = 'LAB'
              AND is_deleted != 1
          `;
        labOnlineTotalQuery = `
            SELECT SUM(total) AS Total
            FROM patient_itemreceipt
            WHERE item_date = ?
              AND payment_mode IN ('Online', 'UPI', 'Paytm')
              AND consultation = 'LAB'
              AND is_deleted != 1
          `;
      }

      const [labCashTotal, labCardTotal, labOnlineTotal] = await Promise.all([
        executeQuery(labCashTotalQuery, [currentDate]),
        executeQuery(labCardTotalQuery, [currentDate]),
        executeQuery(labOnlineTotalQuery, [currentDate]),
      ]);

      const labCashtablesum =
        (labCashTotal[0].Total || 0) +
        (labCardTotal[0].Total || 0) +
        (labOnlineTotal[0].Total || 0);

      let pharmacyCashTotalQuery,
        pharmacyCardTotalQuery,
        pharmacyOnlineTotalQuery;

      if (location === "DP Road") {
        pharmacyCashTotalQuery = `
            SELECT SUM(totalamt) AS Total
            FROM patient_receipt
            WHERE receipt_date = ?
              AND paymentmode = 'Cash'
              AND chargeCondition = 'LabTest'
              AND is_deleted != 1
          `;
        pharmacyCardTotalQuery = `
            SELECT SUM(totalamt) AS Total
            FROM patient_receipt
            WHERE receipt_date = ?
              AND paymentmode = 'Card'
              AND chargeCondition = 'LabTest'
              AND is_deleted != 1
          `;
        pharmacyOnlineTotalQuery = `
            SELECT SUM(totalamt) AS Total
            FROM patient_receipt
            WHERE receipt_date = ?
              AND paymentmode IN ('Online', 'UPI')
              AND chargeCondition = 'LabTest'
              AND is_deleted != 1
          `;
      } else {
        pharmacyCashTotalQuery = `
            SELECT SUM(final_total) AS Total
            FROM pharmacybill
            WHERE created_at = ?
              AND paymentmode = 'Cash'
              AND is_deleted != 1
          `;
        pharmacyCardTotalQuery = `
            SELECT SUM(final_total) AS Total
            FROM pharmacybill
            WHERE created_at = ?
              AND paymentmode = 'Card'
              AND is_deleted != 1
          `;
        pharmacyOnlineTotalQuery = `
            SELECT SUM(final_total) AS Total
            FROM pharmacybill
            WHERE created_at = ?
              AND paymentmode IN ('Online', 'UPI', 'Paytm')
              AND is_deleted != 1
          `;
      }

      const [pharmacyCashTotal, pharmacyCardTotal, pharmacyOnlineTotal] =
        await Promise.all([
          executeQuery(pharmacyCashTotalQuery, [currentDate]),
          executeQuery(pharmacyCardTotalQuery, [currentDate]),
          executeQuery(pharmacyOnlineTotalQuery, [currentDate]),
        ]);

      const pharmacyCashtablesum =
        (pharmacyCashTotal[0].Total || 0) +
        (pharmacyCardTotal[0].Total || 0) +
        (pharmacyOnlineTotal[0].Total || 0);

      const queries = [
        "SELECT SUM(total) AS MCDPA FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = 'MCDPA'",
        "SELECT SUM(total) AS CH FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = 'COLON HYDROTHERAPY'",
        "SELECT SUM(total) AS COLONOSCOPY FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = 'COLONOSCOPY'",
        "SELECT SUM(total) AS USG FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = 'USG'",
        "SELECT SUM(total) AS UAAP FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = 'USG ABDOMEN AND PELVIS'",
        "SELECT SUM(total) AS MANOMETRY FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = 'MANOMETRY'",
        "SELECT SUM(total) AS BIOFEEDBACK FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = 'BIOFEEDBACK'",
        "SELECT SUM(total) AS ECHODEFECOGRAPHY FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = 'ECHODEFECOGRAPHY'",
        "SELECT SUM(total) AS US FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = 'USG SCROTUM'",
        "SELECT SUM(total) AS UD FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = 'UNILATERAL DOPPLER'",
        "SELECT SUM(total) AS BD FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = 'BILATERAL DOPPLER'",
        "SELECT SUM(total) AS GASTROSCOPY FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = 'GASTROSCOPY'",
        "SELECT SUM(total) AS ANAL3D FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = '3D ENDO ANAL IMAGING'",
        "SELECT SUM(total) AS PR FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = 'PROCEDURE'",
        "SELECT SUM(total) AS ECG FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = 'ECG'",
        "SELECT SUM(total) AS NUTRITIONIST FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = 'NUTRITIONIST'",
        "SELECT SUM(total) AS `BLOODTEST&ECG` FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND REPLACE(LOWER(consultation), ' ', '') = 'bloodtests+ecg'",
        "SELECT SUM(total) AS `BLOODTESTS` FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND REPLACE(LOWER(consultation), ' ', '') = 'bloodtests'",
        "SELECT SUM(total) AS DRESSING FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = 'DRESSING'",
        "SELECT SUM(total) AS FITNESS FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = 'FITNESS'",
        "SELECT SUM(total) AS Histopathology FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND consultation = 'Histopathology'",
        "SELECT SUM(total) AS `BUGSPEAKS` FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND REPLACE(LOWER(consultation), ' ', '') = 'bugspeaks'",
        "SELECT SUM(total) AS `SITZBATH` FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND REPLACE(LOWER(consultation), ' ', '') = 'sitzbath'",
        "SELECT SUM(total) AS `UROFLOWMETRY` FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND REPLACE(LOWER(consultation), ' ', '') = 'uroflowmetry'",
      ];

      const results = await Promise.all(
        queries.map((query) => executeQuery(query, [currentDate]))
      );
      const consultationTotals = {};
      results.forEach((result, index) => {
        const key = [
          "MCDPA",
          "CH",
          "COLONOSCOPY",
          "USG",
          "UAAP",
          "MANOMETRY",
          "BIOFEEDBACK",
          "ECHODEFECOGRAPHY",
          "US",
          "UD",
          "BD",
          "GASTROSCOPY",
          "ANAL3D",
          "PR",
          "ECG",
          "NUTRITIONIST",
          "BLOODTEST&ECG",
          "BLOODTESTS",
          "DRESSING",
          "FITNESS",
          "Histopathology",
          "BUGSPEAKS",
          "SITZBATH",
          "UROFLOWMETRY",
        ][index];
        consultationTotals[key] = result[0] ? result[0] : 0;
      });
      return {
        dailyOPDReport: [
          [
            newPatientCount[0].newpatient,
            followPatientCount[0].followpatient,
            poPatientCount[0].popatient,
            proctoscopyCount[0].proctoscopy,
            firstTableSum,
          ],
        ],
        detailedData: [
          [
            newDNCount[0].newDNCount,
            followDNCount[0].FollowDNCount,
            poDNCCount[0].PODNCCount,
            sumofDNC,
          ],
          [
            newDNPCount[0].newDNPCount,
            followDNPCount[0].FollowDNPCount,
            poDNPCount[0].PODNPCount,
            sumofDNP,
          ],
          [
            newDNWCount[0].newDNWCount,
            followDNWCount[0].FollowDNWCount,
            poDNWCount[0].PODNWCount,
            sumofDNW,
          ],
          [
            cancelNewPatientCount[0].is_deleted,
            cancelFollowPatientCount[0].is_deleted,
            cancelPOPatientCount[0].is_deleted,
            sumofDNT,
          ],
          [
            walkINNewPatientCount[0].FDEName,
            walkINFollowPatientCount[0].FDEName,
            walkINPOPatientCount[0].FDEName,
            sumofWalkIN,
          ],
        ],
        testReport: [
          consultationTotals.MCDPA.MCDPA && [
            "MCDPA",
            consultationTotals.MCDPA.MCDPA,
          ],
          consultationTotals.CH.CH && [
            "COLON HYDROTHERAPY",
            consultationTotals.CH.CH,
          ],
          consultationTotals.COLONOSCOPY.COLONOSCOPY && [
            "COLONOSCOPY",
            consultationTotals.COLONOSCOPY.COLONOSCOPY,
          ],
          consultationTotals.USG.USG && ["USG", consultationTotals.USG.USG],
          consultationTotals.UAAP.UAAP && [
            "USG ABDOMEN AND PELVIS",
            consultationTotals.UAAP.UAAP,
          ],
          consultationTotals.MANOMETRY.MANOMETRY && [
            "MANOMETRY",
            consultationTotals.MANOMETRY.MANOMETRY,
          ],
          consultationTotals.BIOFEEDBACK.BIOFEEDBACK && [
            "BIOFEEDBACK",
            consultationTotals.BIOFEEDBACK.BIOFEEDBACK,
          ],
          consultationTotals.ECHODEFECOGRAPHY.ECHODEFECOGRAPHY && [
            "ECHODEFECOGRAPHY",
            consultationTotals.ECHODEFECOGRAPHY.ECHODEFECOGRAPHY,
          ],
          consultationTotals.US.US && ["USG SCROTUM", consultationTotals.US.US],
          consultationTotals.UD.UD && [
            "UNILATERAL DOPPLER",
            consultationTotals.UD.UD,
          ],
          consultationTotals.BD.BD && [
            "BILATERAL DOPPLER",
            consultationTotals.BD.BD,
          ],
          consultationTotals.GASTROSCOPY.GASTROSCOPY && [
            "GASTROSCOPY",
            consultationTotals.GASTROSCOPY.GASTROSCOPY,
          ],
          consultationTotals.ANAL3D.ANAL3D && [
            "3D ENDO ANAL IMAGING",
            consultationTotals.ANAL3D.ANAL3D,
          ],
          consultationTotals.PR.PR && ["PROCEDURE", consultationTotals.PR.PR],
          consultationTotals.ECG.ECG && ["ECG", consultationTotals.ECG.ECG],
          consultationTotals.NUTRITIONIST.NUTRITIONIST && [
            "NUTRITIONIST",
            consultationTotals.NUTRITIONIST.NUTRITIONIST,
          ],
          consultationTotals["BLOODTEST&ECG"]["BLOODTEST&ECG"] && [
            "BLOODTEST & ECG",
            consultationTotals["BLOODTEST&ECG"]["BLOODTEST&ECG"],
          ],
          consultationTotals["BLOODTESTS"]["BLOODTESTS"] && [
            "BLOODTESTS",
            consultationTotals["BLOODTESTS"]["BLOODTESTS"],
          ],
          consultationTotals.DRESSING.DRESSING && [
            "DRESSING",
            consultationTotals.DRESSING.DRESSING,
          ],
          consultationTotals.FITNESS.FITNESS && [
            "FITNESS",
            consultationTotals.FITNESS.FITNESS,
          ],
          consultationTotals.Histopathology.Histopathology && [
            "Histopathology",
            consultationTotals.Histopathology.Histopathology,
          ],
          consultationTotals.BUGSPEAKS.BUGSPEAKS && [
            "BUGSPEAKS",
            consultationTotals.BUGSPEAKS.BUGSPEAKS,
          ],
          consultationTotals.SITZBATH.SITZBATH && [
            "SITZBATH",
            consultationTotals.SITZBATH.SITZBATH,
          ],
          consultationTotals.UROFLOWMETRY.UROFLOWMETRY && [
            "UROFLOWMETRY",
            consultationTotals.UROFLOWMETRY.UROFLOWMETRY,
          ],
        ].filter(Boolean), // This filters out any `false` values, including `undefined`
        overallCollection: [
          ["Cash", cashTotal[0].Total || 0],
          ["Card", cardTotal[0].Total || 0],
          ["Online", onlineTotal[0].Total || 0],
          ["Total", cashtablesum],
        ],
        labCollection: [
          ["Cash", labCashTotal[0].Total || 0],
          ["Card", labCardTotal[0].Total || 0],
          ["Online", labOnlineTotal[0].Total || 0],
          ["Total", labCashtablesum],
        ],
        pharmacyCollection: [
          ["Cash", pharmacyCashTotal[0].Total || 0],
          ["Card", pharmacyCardTotal[0].Total || 0],
          ["Online", pharmacyOnlineTotal[0].Total || 0],
          ["Total", pharmacyCashtablesum],
        ],
        diagnosisCount: diagnosisCount[0].diagnosis || 0,
        prescriptionCount: prescriptionCount[0].prescription || 0,
      };
    } catch (error) {
      console.error("Error executing queries:", error);
      throw error;
    }
  };

  return getCounts();
}

module.exports = { getDailyOPDCollection };
