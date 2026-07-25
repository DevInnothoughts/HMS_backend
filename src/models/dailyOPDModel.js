const { getConnectionByLocation } = require("../../databaseUtils");

function formatDate(date) {
  const pad = (n) => n.toString().padStart(2, "0");

  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());

  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());

  return `${year}-${month}-${day}`;
}

const safeParseInvoice = (invoiceDetails) => {
  try {
    if (!invoiceDetails) return null;
    const parsed = JSON.parse(invoiceDetails);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

async function getDailyOPDCollection(req) {
  console.log(req.query.location);
  const { connection, location } = getConnectionByLocation(req.query.location);

  // Get the current date in YYYY-MM-DD format
  const currentDate = new Date(req.query.date).toISOString().split("T")[0];
  const date = currentDate;
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

      //console.log("Prescription Count:", prescriptionCountQuery);

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

      // ✅ Registration Counts

      const newRegiQuery = `
  SELECT COUNT(DISTINCT appointment.patient_id) AS newRegiCount
  FROM appointment
  JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
  WHERE appointment.appointment_timestamp = ?
    AND patient_receipt.receipt_date = ?
    AND patient_receipt.chargeCondition = 'Registration'
    AND appointment.patient_type = 'New'
    AND appointment.executivechk = 2
    AND appointment.is_deleted != 1
    AND patient_receipt.is_deleted != 1
`;

      const followRegiQuery = `
  SELECT COUNT(DISTINCT appointment.patient_id) AS FollowRegiCount
  FROM appointment
  JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
  WHERE appointment.appointment_timestamp = ?
    AND patient_receipt.receipt_date = ?
    AND patient_receipt.chargeCondition = 'Registration'
    AND appointment.patient_type = 'Follow'
    AND appointment.executivechk = 2
    AND appointment.is_deleted != 1
    AND patient_receipt.is_deleted != 1
`;

      const poRegiQuery = `
  SELECT COUNT(DISTINCT appointment.patient_id) AS PORegiCount
  FROM appointment
  JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
  WHERE appointment.appointment_timestamp = ?
    AND patient_receipt.receipt_date = ?
    AND patient_receipt.chargeCondition = 'Registration'
    AND appointment.patient_type = 'Postoperative'
    AND appointment.confirm_time != 0
    AND appointment.is_deleted != 1
    AND patient_receipt.is_deleted != 1
`;

      const [newRegiCount, followRegiCount, poRegiCount] = await Promise.all([
        executeQuery(newRegiQuery, [currentDate, currentDate]),
        executeQuery(followRegiQuery, [currentDate, currentDate]),
        executeQuery(poRegiQuery, [currentDate, currentDate]),
      ]);

      const sumofRegi =
        (newRegiCount[0]?.newRegiCount || 0) +
        (followRegiCount[0]?.FollowRegiCount || 0) +
        (poRegiCount[0]?.PORegiCount || 0);

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

      //       const evitalCashQuery = `
      //   SELECT SUM(
      //   CAST(JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.amount')) AS DECIMAL(10,0))
      // ) AS Total
      // FROM evital_pharmacy_invoice
      // WHERE created_at BETWEEN ? AND ?
      //   AND JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.payment_mode')) IN ('Cash')
      // `;

      //       const evitalCardQuery = `
      //   SELECT SUM(
      //     CAST(JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.amount')) AS DECIMAL(10,0))
      //   ) AS Total
      //   FROM evital_pharmacy_invoice
      //   WHERE created_at BETWEEN ? AND ?
      //     AND JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.payment_mode')) IN ('Card', 'CC/DC')
      // `;

      //       const evitalOnlineQuery = `
      //   SELECT SUM(
      //     CAST(JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.amount')) AS DECIMAL(10,0))
      //   ) AS Total
      //   FROM evital_pharmacy_invoice
      //   WHERE created_at BETWEEN ? AND ?
      //     AND JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.payment_mode')) IN ('UPI', 'Online', 'Paytm')
      // `;

      //       // ✅ Normalize date range

      //       const fromDate = `${date} 00:00:00`;
      //       const toDate = `${date} 23:59:59`;

      //       console.log("From Date:", fromDate);
      //       console.log("To Date:", toDate);

      //       const [evitalCash, evitalCard, evitalOnline] = await Promise.all([
      //         executeQuery(evitalCashQuery, [fromDate, toDate]),
      //         executeQuery(evitalCardQuery, [fromDate, toDate]),
      //         executeQuery(evitalOnlineQuery, [fromDate, toDate]),
      //       ]);

      //       console.log(
      //         "Evital Cash Total:",
      //         evitalCash[0],
      //         evitalCard[0],
      //         evitalOnline[0],
      //       );

      const evitalCollectionData = await getPharmacyCollection(
        req.query.location,
        currentDate,
        currentDate,
      );
      // console.log("Evital Collection Data:", evitalCollectionData);

      const paymentModeTotals = evitalCollectionData.reduce((acc, row) => {
        const invoice = safeParseInvoice(row.invoice_details);
        if (!invoice) return acc;

        const total = Math.round(Number(invoice.total) || 0);

        const normalizeMode = (mode = "") => {
          switch (mode) {
            case "CC/DC":
            case "Credit":
              return "Card";
            case "UPI":
            case "Online":
              return "Online";
            case "Cash":
              return "Cash";
            default:
              return "Other";
          }
        };

        // ✅ If UpdatedInvoiceDetails exists, use its payment transactions
        if (row.UpdatedInvoiceDetails) {
          try {
            const updatedInvoice = JSON.parse(row.UpdatedInvoiceDetails);
            const transactions =
              updatedInvoice?.transaction_summary?.transactions ?? [];

            if (transactions.length === 1) {
              // Single updated payment method
              const mode = normalizeMode(transactions[0].method);
              acc[mode] = (acc[mode] || 0) + total;
              return acc;
            } else if (transactions.length > 1) {
              // Split payment — use each transaction's own amount
              transactions.forEach((txn) => {
                const mode = normalizeMode(txn.method);
                const txnAmount = Math.round(Number(txn.amount) || 0);
                acc[mode] = (acc[mode] || 0) + txnAmount;
              });
              return acc;
            }
          } catch (e) {
            // Parsing failed — fall through to original payment_mode below
          }
        }

        // ✅ Fallback to original invoice payment_mode
        const mode = normalizeMode(invoice.payment_mode);
        acc[mode] = (acc[mode] || 0) + total;

        return acc;
      }, {});

      const pharmacyCashtablesum =
        (pharmacyCashTotal[0].Total || 0) +
        (pharmacyCardTotal[0].Total || 0) +
        (pharmacyOnlineTotal[0].Total || 0) +
        (paymentModeTotals.Cash || 0) +
        (paymentModeTotals.Card || 0) +
        (paymentModeTotals.Online || 0);

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
        "SELECT SUM(total) AS `FOODBILL` FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND REPLACE(LOWER(consultation), ' ', '') = 'foodbill'",
        "SELECT SUM(total) AS `XRAY` FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND REPLACE(LOWER(consultation), ' ', '') = 'x-ray'",
      ];

      const results = await Promise.all(
        queries.map((query) => executeQuery(query, [currentDate])),
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
          "FOODBILL",
          "XRAY",
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
          [
            newRegiCount[0]?.newRegiCount || 0,
            followRegiCount[0]?.FollowRegiCount || 0,
            poRegiCount[0]?.PORegiCount || 0,
            sumofRegi,
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
          consultationTotals.FOODBILL.FOODBILL && [
            "FOODBILL",
            consultationTotals.FOODBILL.FOODBILL,
          ],
          consultationTotals.XRAY.XRAY && [
            "X-RAY",
            consultationTotals.XRAY.XRAY,
          ],
        ].filter(Boolean), // This filters out any `false` values, including `undefined`
        overallCollection: [
          [
            "Cash",
            (cashTotal[0].Total || 0) +
              (pharmacyCashTotal[0].Total || 0) +
              (paymentModeTotals.Cash || 0),
          ],
          [
            "Card",
            (cardTotal[0].Total || 0) +
              (pharmacyCardTotal[0].Total || 0) +
              (paymentModeTotals.Card || 0),
          ],
          [
            "Online",
            (onlineTotal[0].Total || 0) +
              (pharmacyOnlineTotal[0].Total || 0) +
              (paymentModeTotals.Online || 0),
          ],
          ["Total", cashtablesum + pharmacyCashtablesum],
        ],
        labCollection: [
          ["Cash", labCashTotal[0].Total || 0],
          ["Card", labCardTotal[0].Total || 0],
          ["Online", labOnlineTotal[0].Total || 0],
          ["Total", labCashtablesum],
        ],
        pharmacyCollection: [
          [
            "Cash",
            (pharmacyCashTotal[0].Total || 0) + (paymentModeTotals.Cash || 0),
          ],
          [
            "Card",
            (pharmacyCardTotal[0].Total || 0) + (paymentModeTotals.Card || 0),
          ],
          [
            "Online",
            (pharmacyOnlineTotal[0].Total || 0) +
              (paymentModeTotals.Online || 0),
          ],
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

const getPharmacyCollection = async (location, from, to) => {
  const { connection } = getConnectionByLocation(location); // Ensure `req.params.location` is correct

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

        // ✅ Normalize date range
        const fromDate = `${from} 00:00:00`;
        const toDate = `${to} 23:59:59`;

        console.log("From Date:", fromDate);
        console.log("To Date:", toDate);

        // const sql = `
        //    SELECT *
        //   FROM evital_pharmacy_invoice
        //   WHERE created_at BETWEEN ? AND ?
        //   ORDER BY id DESC
        // `;

        const sql = `SELECT *
FROM evital_pharmacy_invoice
WHERE STR_TO_DATE(
        JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.bill_date')),
        '%Y-%m-%d %H:%i:%s'
      ) BETWEEN ? AND ?
ORDER BY id DESC`;

        const queryParams = [fromDate, toDate]; // Parameters for the SQL query

        tempCon.query(sql, queryParams, (error, rows) => {
          tempCon.release();
          if (error) {
            return reject(error);
          }
          resolve(rows);
        });
      });
    });
    //console.log(rows);
    return rows;
  } catch (error) {
    throw error;
  }
};

async function getDailyOPDCollectionV1(req) {
  console.log(req.query.location);
  const { connection, location } = getConnectionByLocation(req.query.location);

  // Get the current date in YYYY-MM-DD format
  const currentDate = new Date(req.query.date).toISOString().split("T")[0];
  const date = currentDate;
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

      const MCDPACountQuery = `
        SELECT COUNT(consultation) AS mcdpa
        FROM patient_itemreceipt
        WHERE item_date = ?
          AND consultation = 'MCDPA'
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
        MCDPACount,
        diagnosisCount,
        prescriptionCount,
      ] = await Promise.all([
        executeQuery(newPatientCountQuery, [currentDate]),
        executeQuery(followPatientCountQuery, [currentDate]),
        executeQuery(poPatientCountQuery, [currentDate]),
        executeQuery(proctoscopyCountQuery, [currentDate]),
        executeQuery(MCDPACountQuery, [currentDate]),
        executeQuery(diagnosisCountQuery, [currentDate]),
        executeQuery(prescriptionCountQuery, [currentDate]),
      ]);

      //console.log("Prescription Count:", prescriptionCountQuery);

      const firstTableSum =
        newPatientCount[0].newpatient +
        followPatientCount[0].followpatient +
        poPatientCount[0].popatient +
        MCDPACount[0].mcdpa;

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

      const mcdpaDNCQuery = `
        SELECT COUNT(DISTINCT appointment.patient_id) AS MCDPACount
        FROM appointment
        JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
        WHERE appointment.appointment_timestamp = ?
          AND patient_receipt.receipt_date = ?
          AND patient_receipt.chargeCondition = 'DNC'
          AND appointment.confirm_time !=0
          AND appointment.patient_type = 'MCDPA'
          AND patient_receipt.is_deleted != 1
      `;

      const [newDNCount, followDNCount, poDNCCount, mcdpaDNCCount] =
        await Promise.all([
          executeQuery(newDNCQuery, [currentDate, currentDate]),
          executeQuery(followDNCQuery, [currentDate, currentDate]),
          executeQuery(poDNCQuery, [currentDate, currentDate]),
          executeQuery(mcdpaDNCQuery, [currentDate, currentDate]),
        ]);

      const sumofDNC =
        newDNCount[0].newDNCount +
        followDNCount[0].FollowDNCount +
        poDNCCount[0].PODNCCount +
        mcdpaDNCCount[0].MCDPACount;

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
      const mcdpaDNPQuery = `
        SELECT COUNT(DISTINCT appointment.patient_id) AS MCDPACount
        FROM appointment
        JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
        WHERE patient_receipt.receipt_date = ?
          AND patient_receipt.chargeCondition = 'DNP'
          AND appointment.confirm_time !=0
          AND appointment.patient_type = 'MCDPA'
          AND patient_receipt.is_deleted != 1
      `;

      const [newDNPCount, followDNPCount, poDNPCount, mcdpaDNPCount] =
        await Promise.all([
          executeQuery(newDNPQuery, [currentDate, currentDate]),
          executeQuery(followDNPQuery, [currentDate, currentDate]),
          executeQuery(poDNPQuery, [currentDate]),
          executeQuery(mcdpaDNPQuery, [currentDate]),
        ]);

      const sumofDNP =
        newDNPCount[0].newDNPCount +
        followDNPCount[0].FollowDNPCount +
        poDNPCount[0].PODNPCount +
        mcdpaDNPCount[0].MCDPACount;

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
      const mcdpaDNWQuery = `
        SELECT COUNT(DISTINCT appointment.patient_id) AS MCDPACount
        FROM appointment
        JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
        WHERE patient_receipt.receipt_date = ?
          AND patient_receipt.chargeCondition = 'DNW'
          AND appointment.confirm_time !=0
          AND appointment.patient_type = 'MCDPA'
          AND patient_receipt.is_deleted != 1
      `;

      const [newDNWCount, followDNWCount, poDNWCount, mcdpaDNWCount] =
        await Promise.all([
          executeQuery(newDNWQuery, [currentDate]),
          executeQuery(followDNWQuery, [currentDate]),
          executeQuery(poDNWQuery, [currentDate]),
          executeQuery(mcdpaDNWQuery, [currentDate]),
        ]);

      const sumofDNW =
        newDNWCount[0].newDNWCount +
        followDNWCount[0].FollowDNWCount +
        poDNWCount[0].PODNWCount +
        mcdpaDNWCount[0].MCDPACount;

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

      const cancelMCDPAPatientCountQuery = `
        SELECT COUNT(is_deleted) AS is_deleted
        FROM appointment
        WHERE appointment_timestamp = ?
          AND patient_type = 'MCDPA'
          AND is_deleted = 1
      `;

      const [
        cancelNewPatientCount,
        cancelFollowPatientCount,
        cancelPOPatientCount,
        cancelMCDPAPatientCount,
      ] = await Promise.all([
        executeQuery(cancelNewPatientCountQuery, [currentDate]),
        executeQuery(cancelFollowPatientCountQuery, [currentDate]),
        executeQuery(cancelPOPatientCountQuery, [currentDate]),
        executeQuery(cancelMCDPAPatientCountQuery, [currentDate]),
      ]);

      const sumofDNT =
        cancelNewPatientCount[0].is_deleted +
        cancelFollowPatientCount[0].is_deleted +
        cancelPOPatientCount[0].is_deleted +
        cancelMCDPAPatientCount[0].is_deleted;

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
      const walkINMCDPAPatientCountQuery = `
        SELECT COUNT(FDE_Name) AS FDEName
        FROM appointment
        WHERE appointment_timestamp = ?
          AND patient_type = 'MCDPA'
          AND executivechk = 2
          AND FDE_Name = 'WALK-IN'
      `;

      const [
        walkINNewPatientCount,
        walkINFollowPatientCount,
        walkINPOPatientCount,
        walkINMCDPAPatientCount,
      ] = await Promise.all([
        executeQuery(walkINNewPatientCountQuery, [currentDate]),
        executeQuery(walkINFollowPatientCountQuery, [currentDate]),
        executeQuery(walkINPOPatientCountQuery, [currentDate]),
        executeQuery(walkINMCDPAPatientCountQuery, [currentDate]),
      ]);

      const sumofWalkIN =
        walkINNewPatientCount[0].FDEName +
        walkINFollowPatientCount[0].FDEName +
        walkINPOPatientCount[0].FDEName +
        walkINMCDPAPatientCount[0].FDEName;

      // ✅ Registration Counts

      const newRegiQuery = `
  SELECT COUNT(DISTINCT appointment.patient_id) AS newRegiCount
  FROM appointment
  JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
  WHERE appointment.appointment_timestamp = ?
    AND patient_receipt.receipt_date = ?
    AND patient_receipt.chargeCondition = 'Registration'
    AND appointment.patient_type = 'New'
    AND appointment.executivechk = 2
    AND appointment.is_deleted != 1
    AND patient_receipt.is_deleted != 1
`;

      const followRegiQuery = `
  SELECT COUNT(DISTINCT appointment.patient_id) AS FollowRegiCount
  FROM appointment
  JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
  WHERE appointment.appointment_timestamp = ?
    AND patient_receipt.receipt_date = ?
    AND patient_receipt.chargeCondition = 'Registration'
    AND appointment.patient_type = 'Follow'
    AND appointment.executivechk = 2
    AND appointment.is_deleted != 1
    AND patient_receipt.is_deleted != 1
`;

      const poRegiQuery = `
  SELECT COUNT(DISTINCT appointment.patient_id) AS PORegiCount
  FROM appointment
  JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
  WHERE appointment.appointment_timestamp = ?
    AND patient_receipt.receipt_date = ?
    AND patient_receipt.chargeCondition = 'Registration'
    AND appointment.patient_type = 'Postoperative'
    AND appointment.confirm_time != 0
    AND appointment.is_deleted != 1
    AND patient_receipt.is_deleted != 1
`;

      const mcdpaRegiQuery = `
  SELECT COUNT(DISTINCT appointment.patient_id) AS MCDPARegiCount
  FROM appointment
  JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
  WHERE appointment.appointment_timestamp = ?
    AND patient_receipt.receipt_date = ?
    AND patient_receipt.chargeCondition = 'Registration'
    AND appointment.patient_type = 'MCDPA'
    AND appointment.confirm_time != 0
    AND appointment.is_deleted != 1
    AND patient_receipt.is_deleted != 1
`;

      const [newRegiCount, followRegiCount, poRegiCount, mcdpaRegiCount] =
        await Promise.all([
          executeQuery(newRegiQuery, [currentDate, currentDate]),
          executeQuery(followRegiQuery, [currentDate, currentDate]),
          executeQuery(poRegiQuery, [currentDate, currentDate]),
          executeQuery(mcdpaRegiQuery, [currentDate, currentDate]),
        ]);

      const sumofRegi =
        (newRegiCount[0]?.newRegiCount || 0) +
        (followRegiCount[0]?.FollowRegiCount || 0) +
        (poRegiCount[0]?.PORegiCount || 0) +
        (mcdpaRegiCount[0]?.MCDPARegiCount || 0);

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

      //       const evitalCashQuery = `
      //   SELECT SUM(
      //   CAST(JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.amount')) AS DECIMAL(10,0))
      // ) AS Total
      // FROM evital_pharmacy_invoice
      // WHERE created_at BETWEEN ? AND ?
      //   AND JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.payment_mode')) IN ('Cash')
      // `;

      //       const evitalCardQuery = `
      //   SELECT SUM(
      //     CAST(JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.amount')) AS DECIMAL(10,0))
      //   ) AS Total
      //   FROM evital_pharmacy_invoice
      //   WHERE created_at BETWEEN ? AND ?
      //     AND JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.payment_mode')) IN ('Card', 'CC/DC')
      // `;

      //       const evitalOnlineQuery = `
      //   SELECT SUM(
      //     CAST(JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.amount')) AS DECIMAL(10,0))
      //   ) AS Total
      //   FROM evital_pharmacy_invoice
      //   WHERE created_at BETWEEN ? AND ?
      //     AND JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.payment_mode')) IN ('UPI', 'Online', 'Paytm')
      // `;

      //       // ✅ Normalize date range

      //       const fromDate = `${date} 00:00:00`;
      //       const toDate = `${date} 23:59:59`;

      //       console.log("From Date:", fromDate);
      //       console.log("To Date:", toDate);

      //       const [evitalCash, evitalCard, evitalOnline] = await Promise.all([
      //         executeQuery(evitalCashQuery, [fromDate, toDate]),
      //         executeQuery(evitalCardQuery, [fromDate, toDate]),
      //         executeQuery(evitalOnlineQuery, [fromDate, toDate]),
      //       ]);

      //       console.log(
      //         "Evital Cash Total:",
      //         evitalCash[0],
      //         evitalCard[0],
      //         evitalOnline[0],
      //       );

      const evitalCollectionData = await getPharmacyCollection(
        req.query.location,
        currentDate,
        currentDate,
      );
      // console.log("Evital Collection Data:", evitalCollectionData);

      const paymentModeTotals = evitalCollectionData.reduce((acc, row) => {
        const invoice = safeParseInvoice(row.invoice_details);
        if (!invoice) return acc;

        const total = Math.round(Number(invoice.total) || 0);

        const normalizeMode = (mode = "") => {
          switch (mode) {
            case "CC/DC":
            case "Credit":
              return "Card";
            case "UPI":
            case "Online":
              return "Online";
            case "Cash":
              return "Cash";
            default:
              return "Other";
          }
        };

        // ✅ If UpdatedInvoiceDetails exists, use its payment transactions
        if (row.UpdatedInvoiceDetails) {
          try {
            const updatedInvoice = JSON.parse(row.UpdatedInvoiceDetails);
            const transactions =
              updatedInvoice?.transaction_summary?.transactions ?? [];

            if (transactions.length === 1) {
              // Single updated payment method
              const mode = normalizeMode(transactions[0].method);
              acc[mode] = (acc[mode] || 0) + total;
              return acc;
            } else if (transactions.length > 1) {
              // Split payment — use each transaction's own amount
              transactions.forEach((txn) => {
                const mode = normalizeMode(txn.method);
                const txnAmount = Math.round(Number(txn.amount) || 0);
                acc[mode] = (acc[mode] || 0) + txnAmount;
              });
              return acc;
            }
          } catch (e) {
            // Parsing failed — fall through to original payment_mode below
          }
        }

        // ✅ Fallback to original invoice payment_mode
        const mode = normalizeMode(invoice.payment_mode);
        acc[mode] = (acc[mode] || 0) + total;

        return acc;
      }, {});

      const pharmacyCashtablesum =
        (pharmacyCashTotal[0].Total || 0) +
        (pharmacyCardTotal[0].Total || 0) +
        (pharmacyOnlineTotal[0].Total || 0) +
        (paymentModeTotals.Cash || 0) +
        (paymentModeTotals.Card || 0) +
        (paymentModeTotals.Online || 0);

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
        "SELECT SUM(total) AS `FOODBILL` FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND REPLACE(LOWER(consultation), ' ', '') = 'foodbill'",
        "SELECT SUM(total) AS `XRAY` FROM patient_itemreceipt WHERE is_deleted != '1' AND item_date = ? AND REPLACE(LOWER(consultation), ' ', '') = 'x-ray'",
      ];

      const results = await Promise.all(
        queries.map((query) => executeQuery(query, [currentDate])),
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
          "FOODBILL",
          "XRAY",
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
            MCDPACount[0].mcdpa,
            firstTableSum,
          ],
        ],
        detailedData: [
          [
            newDNCount[0].newDNCount,
            followDNCount[0].FollowDNCount,
            poDNCCount[0].PODNCCount,
            mcdpaDNCCount[0].MCDPACount,
            sumofDNC,
          ],
          [
            newDNPCount[0].newDNPCount,
            followDNPCount[0].FollowDNPCount,
            poDNPCount[0].PODNPCount,
            mcdpaDNPCount[0].MCDPACount,
            sumofDNP,
          ],
          [
            newDNWCount[0].newDNWCount,
            followDNWCount[0].FollowDNWCount,
            poDNWCount[0].PODNWCount,
            mcdpaDNWCount[0].MCDPACount,
            sumofDNW,
          ],
          [
            cancelNewPatientCount[0].is_deleted,
            cancelFollowPatientCount[0].is_deleted,
            cancelPOPatientCount[0].is_deleted,
            cancelMCDPAPatientCount[0].is_deleted,
            sumofDNT,
          ],
          [
            walkINNewPatientCount[0].FDEName,
            walkINFollowPatientCount[0].FDEName,
            walkINPOPatientCount[0].FDEName,
            walkINMCDPAPatientCount[0].FDEName,
            sumofWalkIN,
          ],
          [
            newRegiCount[0]?.newRegiCount || 0,
            followRegiCount[0]?.FollowRegiCount || 0,
            poRegiCount[0]?.PORegiCount || 0,
            mcdpaRegiCount[0]?.MCDPARegiCount || 0,
            sumofRegi,
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
          consultationTotals.FOODBILL.FOODBILL && [
            "FOODBILL",
            consultationTotals.FOODBILL.FOODBILL,
          ],
          consultationTotals.XRAY.XRAY && [
            "X-RAY",
            consultationTotals.XRAY.XRAY,
          ],
        ].filter(Boolean), // This filters out any `false` values, including `undefined`
        overallCollection: [
          [
            "Cash",
            (cashTotal[0].Total || 0) +
              (pharmacyCashTotal[0].Total || 0) +
              (paymentModeTotals.Cash || 0),
          ],
          [
            "Card",
            (cardTotal[0].Total || 0) +
              (pharmacyCardTotal[0].Total || 0) +
              (paymentModeTotals.Card || 0),
          ],
          [
            "Online",
            (onlineTotal[0].Total || 0) +
              (pharmacyOnlineTotal[0].Total || 0) +
              (paymentModeTotals.Online || 0),
          ],
          ["Total", cashtablesum + pharmacyCashtablesum],
        ],
        opdCollection: [
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
          [
            "Cash",
            (pharmacyCashTotal[0].Total || 0) + (paymentModeTotals.Cash || 0),
          ],
          [
            "Card",
            (pharmacyCardTotal[0].Total || 0) + (paymentModeTotals.Card || 0),
          ],
          [
            "Online",
            (pharmacyOnlineTotal[0].Total || 0) +
              (paymentModeTotals.Online || 0),
          ],
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

async function getDailyOPDCollectionV2(req) {
  console.log(req.query.location);
  const { connection, location } = getConnectionByLocation(req.query.location);

  // Get the current date in YYYY-MM-DD format
  const currentDate = new Date(req.query.date).toISOString().split("T")[0];
  const date = currentDate;
  console.log("Current date:", currentDate);
  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  // Master database (hhc_appointments) always lives on the "lead" connection.
  const { connection: masterConnection } = getConnectionByLocation("lead");
  if (!masterConnection) {
    const err = new Error("Master database connection (lead) not available");
    err.status = 500;
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

  // Same helper, but against the master DB (hhc_appointments) on "lead".
  const executeMasterQuery = (query, values = []) => {
    return new Promise((resolve, reject) => {
      masterConnection.query(query, values, (error, results) => {
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

      const MCDPACountQuery = `
        SELECT COUNT(consultation) AS mcdpa
        FROM patient_itemreceipt
        WHERE item_date = ?
          AND consultation = 'MCDPA'
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
        MCDPACount,
        diagnosisCount,
        prescriptionCount,
      ] = await Promise.all([
        executeQuery(newPatientCountQuery, [currentDate]),
        executeQuery(followPatientCountQuery, [currentDate]),
        executeQuery(poPatientCountQuery, [currentDate]),
        executeQuery(proctoscopyCountQuery, [currentDate]),
        executeQuery(MCDPACountQuery, [currentDate]),
        executeQuery(diagnosisCountQuery, [currentDate]),
        executeQuery(prescriptionCountQuery, [currentDate]),
      ]);

      //console.log("Prescription Count:", prescriptionCountQuery);

      const firstTableSum =
        newPatientCount[0].newpatient +
        followPatientCount[0].followpatient +
        poPatientCount[0].popatient +
        MCDPACount[0].mcdpa;

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

      const mcdpaDNCQuery = `
        SELECT COUNT(DISTINCT appointment.patient_id) AS MCDPACount
        FROM appointment
        JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
        WHERE appointment.appointment_timestamp = ?
          AND patient_receipt.receipt_date = ?
          AND patient_receipt.chargeCondition = 'DNC'
          AND appointment.confirm_time !=0
          AND appointment.patient_type = 'MCDPA'
          AND patient_receipt.is_deleted != 1
      `;

      const [newDNCount, followDNCount, poDNCCount, mcdpaDNCCount] =
        await Promise.all([
          executeQuery(newDNCQuery, [currentDate, currentDate]),
          executeQuery(followDNCQuery, [currentDate, currentDate]),
          executeQuery(poDNCQuery, [currentDate, currentDate]),
          executeQuery(mcdpaDNCQuery, [currentDate, currentDate]),
        ]);

      const sumofDNC =
        newDNCount[0].newDNCount +
        followDNCount[0].FollowDNCount +
        poDNCCount[0].PODNCCount +
        mcdpaDNCCount[0].MCDPACount;

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
      const mcdpaDNPQuery = `
        SELECT COUNT(DISTINCT appointment.patient_id) AS MCDPACount
        FROM appointment
        JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
        WHERE patient_receipt.receipt_date = ?
          AND patient_receipt.chargeCondition = 'DNP'
          AND appointment.confirm_time !=0
          AND appointment.patient_type = 'MCDPA'
          AND patient_receipt.is_deleted != 1
      `;

      const [newDNPCount, followDNPCount, poDNPCount, mcdpaDNPCount] =
        await Promise.all([
          executeQuery(newDNPQuery, [currentDate, currentDate]),
          executeQuery(followDNPQuery, [currentDate, currentDate]),
          executeQuery(poDNPQuery, [currentDate]),
          executeQuery(mcdpaDNPQuery, [currentDate]),
        ]);

      const sumofDNP =
        newDNPCount[0].newDNPCount +
        followDNPCount[0].FollowDNPCount +
        poDNPCount[0].PODNPCount +
        mcdpaDNPCount[0].MCDPACount;

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
      const mcdpaDNWQuery = `
        SELECT COUNT(DISTINCT appointment.patient_id) AS MCDPACount
        FROM appointment
        JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
        WHERE patient_receipt.receipt_date = ?
          AND patient_receipt.chargeCondition = 'DNW'
          AND appointment.confirm_time !=0
          AND appointment.patient_type = 'MCDPA'
          AND patient_receipt.is_deleted != 1
      `;

      const [newDNWCount, followDNWCount, poDNWCount, mcdpaDNWCount] =
        await Promise.all([
          executeQuery(newDNWQuery, [currentDate]),
          executeQuery(followDNWQuery, [currentDate]),
          executeQuery(poDNWQuery, [currentDate]),
          executeQuery(mcdpaDNWQuery, [currentDate]),
        ]);

      const sumofDNW =
        newDNWCount[0].newDNWCount +
        followDNWCount[0].FollowDNWCount +
        poDNWCount[0].PODNWCount +
        mcdpaDNWCount[0].MCDPACount;

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

      const cancelMCDPAPatientCountQuery = `
        SELECT COUNT(is_deleted) AS is_deleted
        FROM appointment
        WHERE appointment_timestamp = ?
          AND patient_type = 'MCDPA'
          AND is_deleted = 1
      `;

      const [
        cancelNewPatientCount,
        cancelFollowPatientCount,
        cancelPOPatientCount,
        cancelMCDPAPatientCount,
      ] = await Promise.all([
        executeQuery(cancelNewPatientCountQuery, [currentDate]),
        executeQuery(cancelFollowPatientCountQuery, [currentDate]),
        executeQuery(cancelPOPatientCountQuery, [currentDate]),
        executeQuery(cancelMCDPAPatientCountQuery, [currentDate]),
      ]);

      const sumofDNT =
        cancelNewPatientCount[0].is_deleted +
        cancelFollowPatientCount[0].is_deleted +
        cancelPOPatientCount[0].is_deleted +
        cancelMCDPAPatientCount[0].is_deleted;

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
      const walkINMCDPAPatientCountQuery = `
        SELECT COUNT(FDE_Name) AS FDEName
        FROM appointment
        WHERE appointment_timestamp = ?
          AND patient_type = 'MCDPA'
          AND executivechk = 2
          AND FDE_Name = 'WALK-IN'
      `;

      const [
        walkINNewPatientCount,
        walkINFollowPatientCount,
        walkINPOPatientCount,
        walkINMCDPAPatientCount,
      ] = await Promise.all([
        executeQuery(walkINNewPatientCountQuery, [currentDate]),
        executeQuery(walkINFollowPatientCountQuery, [currentDate]),
        executeQuery(walkINPOPatientCountQuery, [currentDate]),
        executeQuery(walkINMCDPAPatientCountQuery, [currentDate]),
      ]);

      const sumofWalkIN =
        walkINNewPatientCount[0].FDEName +
        walkINFollowPatientCount[0].FDEName +
        walkINPOPatientCount[0].FDEName +
        walkINMCDPAPatientCount[0].FDEName;

      // ✅ Registration Counts

      const newRegiQuery = `
  SELECT COUNT(DISTINCT appointment.patient_id) AS newRegiCount
  FROM appointment
  JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
  WHERE appointment.appointment_timestamp = ?
    AND patient_receipt.receipt_date = ?
    AND patient_receipt.chargeCondition = 'Registration'
    AND appointment.patient_type = 'New'
    AND appointment.executivechk = 2
    AND appointment.is_deleted != 1
    AND patient_receipt.is_deleted != 1
`;

      const followRegiQuery = `
  SELECT COUNT(DISTINCT appointment.patient_id) AS FollowRegiCount
  FROM appointment
  JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
  WHERE appointment.appointment_timestamp = ?
    AND patient_receipt.receipt_date = ?
    AND patient_receipt.chargeCondition = 'Registration'
    AND appointment.patient_type = 'Follow'
    AND appointment.executivechk = 2
    AND appointment.is_deleted != 1
    AND patient_receipt.is_deleted != 1
`;

      const poRegiQuery = `
  SELECT COUNT(DISTINCT appointment.patient_id) AS PORegiCount
  FROM appointment
  JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
  WHERE appointment.appointment_timestamp = ?
    AND patient_receipt.receipt_date = ?
    AND patient_receipt.chargeCondition = 'Registration'
    AND appointment.patient_type = 'Postoperative'
    AND appointment.confirm_time != 0
    AND appointment.is_deleted != 1
    AND patient_receipt.is_deleted != 1
`;

      const mcdpaRegiQuery = `
  SELECT COUNT(DISTINCT appointment.patient_id) AS MCDPARegiCount
  FROM appointment
  JOIN patient_receipt ON patient_receipt.patient_id = appointment.patient_id
  WHERE appointment.appointment_timestamp = ?
    AND patient_receipt.receipt_date = ?
    AND patient_receipt.chargeCondition = 'Registration'
    AND appointment.patient_type = 'MCDPA'
    AND appointment.confirm_time != 0
    AND appointment.is_deleted != 1
    AND patient_receipt.is_deleted != 1
`;

      const [newRegiCount, followRegiCount, poRegiCount, mcdpaRegiCount] =
        await Promise.all([
          executeQuery(newRegiQuery, [currentDate, currentDate]),
          executeQuery(followRegiQuery, [currentDate, currentDate]),
          executeQuery(poRegiQuery, [currentDate, currentDate]),
          executeQuery(mcdpaRegiQuery, [currentDate, currentDate]),
        ]);

      const sumofRegi =
        (newRegiCount[0]?.newRegiCount || 0) +
        (followRegiCount[0]?.FollowRegiCount || 0) +
        (poRegiCount[0]?.PORegiCount || 0) +
        (mcdpaRegiCount[0]?.MCDPARegiCount || 0);

      // Total cash, card, online, and Paytm
      // ---------------------------------------------------------------
      // V2: consultation master list (hhc_appointments.consultationMasterData)
      // Fetched once, up-front, because it now drives BOTH:
      //   (a) the OPD / LAB split of the day's collection, and
      //   (b) the per-consultation testReport totals further down.
      // ---------------------------------------------------------------
      const masterConsultations = await executeMasterQuery(
        `SELECT consultation_name, consultation_type
         FROM consultationMasterData
         WHERE is_deleted = '0'
         ORDER BY consultation_name`,
      );

      // Normalization used everywhere. Mirrors SQL's REPLACE(LOWER(x), ' ', '').
      const normalizeName = (v) =>
        String(v ?? "")
          .toLowerCase()
          .split(" ")
          .join("");

      // Drop blank names, de-duplicate on the normalized name.
      const seenConsultation = new Set();
      const consultations = [];
      for (const row of masterConsultations) {
        const name = (row.consultation_name || "").trim();
        if (!name) continue;
        const normKey = normalizeName(name);
        if (seenConsultation.has(normKey)) continue;
        seenConsultation.add(normKey);
        consultations.push({
          name,
          type: String(row.consultation_type ?? "")
            .trim()
            .toUpperCase(), // "OPD" | "LAB"
        });
      }

      // The LAB consultations drive both the OPD/LAB split and testReport.
      // Everything else is OPD.
      const labConsultations = consultations.filter((c) => c.type === "LAB");
      const labNormNames = labConsultations.map((c) => normalizeName(c.name));

      const opdConsultations = consultations.filter((c) => c.type === "OPD");

      const hasLab = labNormNames.length > 0;
      const labPlaceholders = labNormNames.map(() => "?").join(", ");

      // COALESCE keeps rows with a NULL consultation on the OPD side; without it
      // `NOT IN (...)` evaluates to NULL for those rows and silently drops them.
      const NORM_COL = "REPLACE(LOWER(COALESCE(consultation, '')), ' ', '')";
      const labMatchSql = hasLab
        ? `${NORM_COL} IN (${labPlaceholders})`
        : "1 = 0"; // no LAB consultations configured -> lab totals are 0
      const opdMatchSql = hasLab
        ? `${NORM_COL} NOT IN (${labPlaceholders})`
        : "1 = 1";

      // Payment-mode buckets, IDENTICAL for OPD and LAB so that
      // opdCollection + labCollection always reconciles to the day's total.
      const MODE_SQL = {
        Cash: "payment_mode = 'Cash'",
        Card: "payment_mode = 'Card'",
        Online: "payment_mode IN ('Online', 'UPI')",
      };

      const bucketTotalQuery = (matchSql, modeSql) => `
        SELECT SUM(total) AS Total
        FROM patient_itemreceipt
        WHERE item_date = ?
          AND is_deleted != 1
          AND ${modeSql}
          AND ${matchSql}
      `;

      // Preserved from V1 (declared but not executed there either).
      const chequeTotalQuery = `
        SELECT SUM(total) AS Total
        FROM patient_itemreceipt
        WHERE item_date = ?
          AND payment_mode = 'Cheque'
          AND is_deleted != 1
      `;

      const opdParams = [currentDate, ...labNormNames];
      const labParams = [currentDate, ...labNormNames];

      const [
        opdCashTotal,
        opdCardTotal,
        opdOnlineTotal,
        labCashTotal,
        labCardTotal,
        labOnlineTotal,
      ] = await Promise.all([
        executeQuery(bucketTotalQuery(opdMatchSql, MODE_SQL.Cash), opdParams),
        executeQuery(bucketTotalQuery(opdMatchSql, MODE_SQL.Card), opdParams),
        executeQuery(bucketTotalQuery(opdMatchSql, MODE_SQL.Online), opdParams),
        executeQuery(bucketTotalQuery(labMatchSql, MODE_SQL.Cash), labParams),
        executeQuery(bucketTotalQuery(labMatchSql, MODE_SQL.Card), labParams),
        executeQuery(bucketTotalQuery(labMatchSql, MODE_SQL.Online), labParams),
      ]);

      const amt = (rows) =>
        rows && rows[0] && rows[0].Total != null ? Number(rows[0].Total) : 0;

      const opdCashAmt = amt(opdCashTotal);
      const opdCardAmt = amt(opdCardTotal);
      const opdOnlineAmt = amt(opdOnlineTotal);
      const opdTotalAmt = opdCashAmt + opdCardAmt + opdOnlineAmt;

      const labCashAmt = amt(labCashTotal);
      const labCardAmt = amt(labCardTotal);
      const labOnlineAmt = amt(labOnlineTotal);
      const labTotalAmt = labCashAmt + labCardAmt + labOnlineAmt;

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

      //       const evitalCashQuery = `
      //   SELECT SUM(
      //   CAST(JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.amount')) AS DECIMAL(10,0))
      // ) AS Total
      // FROM evital_pharmacy_invoice
      // WHERE created_at BETWEEN ? AND ?
      //   AND JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.payment_mode')) IN ('Cash')
      // `;

      //       const evitalCardQuery = `
      //   SELECT SUM(
      //     CAST(JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.amount')) AS DECIMAL(10,0))
      //   ) AS Total
      //   FROM evital_pharmacy_invoice
      //   WHERE created_at BETWEEN ? AND ?
      //     AND JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.payment_mode')) IN ('Card', 'CC/DC')
      // `;

      //       const evitalOnlineQuery = `
      //   SELECT SUM(
      //     CAST(JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.amount')) AS DECIMAL(10,0))
      //   ) AS Total
      //   FROM evital_pharmacy_invoice
      //   WHERE created_at BETWEEN ? AND ?
      //     AND JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.payment_mode')) IN ('UPI', 'Online', 'Paytm')
      // `;

      //       // ✅ Normalize date range

      //       const fromDate = `${date} 00:00:00`;
      //       const toDate = `${date} 23:59:59`;

      //       console.log("From Date:", fromDate);
      //       console.log("To Date:", toDate);

      //       const [evitalCash, evitalCard, evitalOnline] = await Promise.all([
      //         executeQuery(evitalCashQuery, [fromDate, toDate]),
      //         executeQuery(evitalCardQuery, [fromDate, toDate]),
      //         executeQuery(evitalOnlineQuery, [fromDate, toDate]),
      //       ]);

      //       console.log(
      //         "Evital Cash Total:",
      //         evitalCash[0],
      //         evitalCard[0],
      //         evitalOnline[0],
      //       );

      const evitalCollectionData = await getPharmacyCollection(
        req.query.location,
        currentDate,
        currentDate,
      );
      // console.log("Evital Collection Data:", evitalCollectionData);

      const paymentModeTotals = evitalCollectionData.reduce((acc, row) => {
        const invoice = safeParseInvoice(row.invoice_details);
        if (!invoice) return acc;

        const total = Math.round(Number(invoice.total) || 0);

        const normalizeMode = (mode = "") => {
          switch (mode) {
            case "CC/DC":
            case "Credit":
              return "Card";
            case "UPI":
            case "Online":
              return "Online";
            case "Cash":
              return "Cash";
            default:
              return "Other";
          }
        };

        // ✅ If UpdatedInvoiceDetails exists, use its payment transactions
        if (row.UpdatedInvoiceDetails) {
          try {
            const updatedInvoice = JSON.parse(row.UpdatedInvoiceDetails);
            const transactions =
              updatedInvoice?.transaction_summary?.transactions ?? [];

            if (transactions.length === 1) {
              // Single updated payment method
              const mode = normalizeMode(transactions[0].method);
              acc[mode] = (acc[mode] || 0) + total;
              return acc;
            } else if (transactions.length > 1) {
              // Split payment — use each transaction's own amount
              transactions.forEach((txn) => {
                const mode = normalizeMode(txn.method);
                const txnAmount = Math.round(Number(txn.amount) || 0);
                acc[mode] = (acc[mode] || 0) + txnAmount;
              });
              return acc;
            }
          } catch (e) {
            // Parsing failed — fall through to original payment_mode below
          }
        }

        // ✅ Fallback to original invoice payment_mode
        const mode = normalizeMode(invoice.payment_mode);
        acc[mode] = (acc[mode] || 0) + total;

        return acc;
      }, {});

      const pharmacyCashtablesum =
        (pharmacyCashTotal[0].Total || 0) +
        (pharmacyCardTotal[0].Total || 0) +
        (pharmacyOnlineTotal[0].Total || 0) +
        (paymentModeTotals.Cash || 0) +
        (paymentModeTotals.Card || 0) +
        (paymentModeTotals.Online || 0);

      // Per-consultation totals for testReport. Only LAB consultations are
      // reported, so only those are queried. Both sides are normalized in SQL
      // (LOWER + spaces stripped), which covers V1's exact matches ('MCDPA')
      // and its normalized matches ('bloodtests', 'x-ray') alike.
      const consultationTotalQuery = `
        SELECT SUM(total) AS total
        FROM patient_itemreceipt
        WHERE is_deleted != '1'
          AND item_date = ?
          AND REPLACE(LOWER(consultation), ' ', '') = REPLACE(LOWER(?), ' ', '')
      `;

      const consultationResults = await Promise.all(
        labConsultations.map((c) =>
          executeQuery(consultationTotalQuery, [currentDate, c.name]),
        ),
      );

      // consultationTotals: { [consultation_name]: { name, type, total } }
      const consultationTotals = {};
      labConsultations.forEach((c, index) => {
        const row = consultationResults[index][0];
        const total = row && row.total != null ? Number(row.total) : 0;
        consultationTotals[c.name] = { name: c.name, type: c.type, total };
      });

      // OPD per-consultation totals (consultation_type = 'OPD'), same shape as LAB.
      const opdConsultationResults = await Promise.all(
        opdConsultations.map((c) =>
          executeQuery(consultationTotalQuery, [currentDate, c.name]),
        ),
      );

      const opdConsultationTotals = {};
      opdConsultations.forEach((c, index) => {
        const row = opdConsultationResults[index][0];
        const total = row && row.total != null ? Number(row.total) : 0;
        opdConsultationTotals[c.name] = { name: c.name, type: c.type, total };
      });
      return {
        dailyOPDReport: [
          [
            newPatientCount[0].newpatient,
            followPatientCount[0].followpatient,
            poPatientCount[0].popatient,
            proctoscopyCount[0].proctoscopy,
            MCDPACount[0].mcdpa,
            firstTableSum,
          ],
        ],
        detailedData: [
          [
            newDNCount[0].newDNCount,
            followDNCount[0].FollowDNCount,
            poDNCCount[0].PODNCCount,
            mcdpaDNCCount[0].MCDPACount,
            sumofDNC,
          ],
          [
            newDNPCount[0].newDNPCount,
            followDNPCount[0].FollowDNPCount,
            poDNPCount[0].PODNPCount,
            mcdpaDNPCount[0].MCDPACount,
            sumofDNP,
          ],
          [
            newDNWCount[0].newDNWCount,
            followDNWCount[0].FollowDNWCount,
            poDNWCount[0].PODNWCount,
            mcdpaDNWCount[0].MCDPACount,
            sumofDNW,
          ],
          [
            cancelNewPatientCount[0].is_deleted,
            cancelFollowPatientCount[0].is_deleted,
            cancelPOPatientCount[0].is_deleted,
            cancelMCDPAPatientCount[0].is_deleted,
            sumofDNT,
          ],
          [
            walkINNewPatientCount[0].FDEName,
            walkINFollowPatientCount[0].FDEName,
            walkINPOPatientCount[0].FDEName,
            walkINMCDPAPatientCount[0].FDEName,
            sumofWalkIN,
          ],
          [
            newRegiCount[0]?.newRegiCount || 0,
            followRegiCount[0]?.FollowRegiCount || 0,
            poRegiCount[0]?.PORegiCount || 0,
            mcdpaRegiCount[0]?.MCDPARegiCount || 0,
            sumofRegi,
          ],
        ],
        // V2: LAB consultations only (consultation_type = 'LAB' in the master).
        // Same [name, total] shape as V1; zero/null totals are dropped.
        testReport: labConsultations
          .map((c) => {
            const total = consultationTotals[c.name].total;
            return total ? [c.name, total] : null;
          })
          .filter(Boolean),
        // OPD only: consultation_type = 'OPD' in consultationMasterData.
        opdReport: opdConsultations
          .map((c) => {
            const total = opdConsultationTotals[c.name].total;
            return total ? [c.name, total] : null;
          })
          .filter(Boolean),
        overallCollection: [
          [
            "Cash",
            opdCashAmt +
              labCashAmt +
              (pharmacyCashTotal[0].Total || 0) +
              (paymentModeTotals.Cash || 0),
          ],
          [
            "Card",
            opdCardAmt +
              labCardAmt +
              (pharmacyCardTotal[0].Total || 0) +
              (paymentModeTotals.Card || 0),
          ],
          [
            "Online",
            opdOnlineAmt +
              labOnlineAmt +
              (pharmacyOnlineTotal[0].Total || 0) +
              (paymentModeTotals.Online || 0),
          ],
          ["Total", opdTotalAmt + labTotalAmt + pharmacyCashtablesum],
        ],
        // OPD only: every consultation that is NOT typed LAB in the master.
        opdCollection: [
          ["Cash", opdCashAmt],
          ["Card", opdCardAmt],
          ["Online", opdOnlineAmt],
          ["Total", opdTotalAmt],
        ],
        // LAB only: consultation_type = 'LAB' in consultationMasterData.
        labCollection: [
          ["Cash", labCashAmt],
          ["Card", labCardAmt],
          ["Online", labOnlineAmt],
          ["Total", labTotalAmt],
        ],
        pharmacyCollection: [
          [
            "Cash",
            (pharmacyCashTotal[0].Total || 0) + (paymentModeTotals.Cash || 0),
          ],
          [
            "Card",
            (pharmacyCardTotal[0].Total || 0) + (paymentModeTotals.Card || 0),
          ],
          [
            "Online",
            (pharmacyOnlineTotal[0].Total || 0) +
              (paymentModeTotals.Online || 0),
          ],
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

module.exports = {
  getDailyOPDCollection,
  getDailyOPDCollectionV1,
  getDailyOPDCollectionV2,
};
