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

const getPharmacyCollection = async (req) => {
  const { location, from, to } = req.query;
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

        const sql = `
           SELECT *
          FROM evital_pharmacy_invoice
          WHERE created_at BETWEEN ? AND ?
          ORDER BY id DESC
        `;

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
    console.log(rows);
    return rows;
  } catch (error) {
    throw error;
  }
};

const getPharmacyCollectionV1 = async (req) => {
  const { location, from, to } = req.query;
  const { connection } = getConnectionByLocation(location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        const fromDate = `${from} 00:00:00`;
        const toDate = `${to} 23:59:59`;

        // const sql = `
        //   SELECT *
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

        tempCon.query(sql, [fromDate, toDate], (error, rows) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(rows);
        });
      });
    });

    // ✅ BACKEND CALCULATIONS
    const paymentModeTotals = {};
    let grandTotal = 0;

    rows.forEach((row) => {
      let invoice;

      try {
        if (!row.invoice_details) return; // skip null/empty

        invoice = JSON.parse(row.invoice_details);

        if (!invoice || typeof invoice !== "object") return; // extra safety
      } catch (e) {
        return; // skip invalid JSON
      }

      const mode = invoice.payment_mode || "UNKNOWN";
      const total = Number(invoice.total) || 0;

      let normalizedMode = mode;

      if (mode === "CC/DC" || mode === "Credit") {
        normalizedMode = "Card";
      }

      paymentModeTotals[normalizedMode] =
        (paymentModeTotals[normalizedMode] || 0) + total;

      grandTotal += total;
    });

    return {
      invoices: rows,
      paymentModeTotals: {
        Cash: paymentModeTotals.Cash || 0,
        Card: paymentModeTotals.Card || 0,
        UPI: paymentModeTotals.UPI || 0,
        Other:
          Object.keys(paymentModeTotals)
            .filter((k) => !["Cash", "Card", "UPI"].includes(k))
            .reduce((sum, k) => sum + paymentModeTotals[k], 0) || 0,
      },
      grandTotal,
    };
  } catch (error) {
    throw error;
  }
};

const getPharmacyCollectionV2 = async (req) => {
  const { location, from, to } = req.query;
  const { connection } = getConnectionByLocation(location);

  ///console.log("FRom and To:", from, to);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        const fromDate = `${from} 00:00:00`;
        const toDate = `${to} 23:59:59`;

        // const sql = `
        //   SELECT *
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

        //         const sql = `
        //   SELECT *
        //   FROM evital_pharmacy_invoice
        //   WHERE STR_TO_DATE(
        //           JSON_UNQUOTE(
        //             JSON_EXTRACT(invoice_details, '$.payment_date')
        //           ),
        //           '%Y-%m-%d %H:%i:%s'
        //         ) BETWEEN ? AND ?
        //   ORDER BY id DESC
        // `;
        tempCon.query(sql, [fromDate, toDate], (error, rows) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(rows);
        });
      });
    });

    console.log(rows);

    // ✅ BACKEND CALCULATIONS
    const paymentModeTotals = {};
    let grandTotal = 0;

    rows.forEach((row) => {
      let invoice;

      try {
        if (!row.invoice_details) return;
        invoice = JSON.parse(row.invoice_details);
        if (!invoice || typeof invoice !== "object") return;
      } catch (e) {
        return;
      }

      const total = Number(invoice.total) || 0;

      // ✅ Use UpdatedInvoiceDetails payment if available
      let mode;

      if (row.UpdatedInvoiceDetails) {
        try {
          const updatedInvoice = JSON.parse(row.UpdatedInvoiceDetails);
          const transactions =
            updatedInvoice?.transaction_summary?.transactions ?? [];

          if (transactions.length === 1) {
            // Single payment method — use it directly
            mode = transactions[0].method;
          } else if (transactions.length > 1) {
            // Split payment — distribute each transaction amount individually
            transactions.forEach((txn) => {
              const txnMode = normalizeMode(txn.method);
              const txnAmount = Number(txn.amount) || 0;
              paymentModeTotals[txnMode] =
                (paymentModeTotals[txnMode] || 0) + txnAmount;
            });
            grandTotal += total;
            return; // skip the single-mode assignment below
          }
        } catch (e) {
          // fallback to original mode if parsing fails
          mode = invoice.payment_mode;
        }
      } else {
        mode = invoice.payment_mode;
      }

      const normalizedMode = normalizeMode(mode);
      paymentModeTotals[normalizedMode] =
        (paymentModeTotals[normalizedMode] || 0) + total;
      grandTotal += total;
    });

    return {
      invoices: rows,
      paymentModeTotals: {
        Cash: paymentModeTotals.Cash || 0,
        Card: paymentModeTotals.Card || 0,
        UPI: paymentModeTotals.UPI || 0,
        Other:
          Object.keys(paymentModeTotals)
            .filter((k) => !["Cash", "Card", "UPI"].includes(k))
            .reduce((sum, k) => sum + paymentModeTotals[k], 0) || 0,
      },
      grandTotal,
    };
  } catch (error) {
    throw error;
  }
};

// ✅ Extracted helper to normalize payment mode strings
const normalizeMode = (mode = "") => {
  if (mode === "CC/DC" || mode === "Credit") return "Card";
  return mode || "UNKNOWN";
};

const getPrescriptionPurchaseAnalysisQuantity = async (req) => {
  const { location, from, to } = req.query;
  // ✅ Normalize date range
  const formatedFrom = formatDate(new Date(from));
  const formatedTo = formatDate(new Date(to));
  const fromDate = `${formatedFrom} 00:00:00`;
  const toDate = `${formatedTo} 23:59:59`;

  const { connection } = getConnectionByLocation(location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    const rows = await new Promise((resolve, reject) => {
      const sql = `
        SELECT
            epi.prescription_details,
            epi.invoice_details,
            epi.created_at,
            p.name AS patient_name,
            p.phone
        FROM evital_pharmacy_invoice epi
        LEFT JOIN patient p ON p.patient_id = epi.patient_id
        WHERE epi.prescription_details IS NOT NULL
        AND epi.patient_id IS NOT NULL
        AND epi.created_at BETWEEN ? AND ?
        ORDER BY epi.id DESC
      `;

      connection.query(sql, [fromDate, toDate], (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });

    const analysis = [];

    rows.forEach((row) => {
      let prescription = [];
      let invoiceObj = {};
      let invoiceItems = [];

      try {
        prescription = JSON.parse(row.prescription_details || "[]");
      } catch {}

      try {
        invoiceObj = JSON.parse(row.invoice_details || "{}");
        invoiceItems = invoiceObj.items || [];
      } catch {}

      const patientName = invoiceObj.patient_name || row.patient_name || "";
      const mobile = invoiceObj.mobile || row.phone || "";
      const billDate = row.created_at
        ? new Date(row.created_at).toLocaleDateString("en-GB")
        : "Unknown";

      let totalPrescribed = 0;
      let totalPurchased = 0;

      const medicineAnalysis = [];

      prescription.forEach((p) => {
        const prescribedQty = Number(p.quantity) || 0;

        const invoiceItem = invoiceItems.find(
          (i) => i.medicine_id === p.medicine_id,
        );

        const purchasedQty = invoiceItem ? Number(invoiceItem.quantity) : 0;

        totalPrescribed += prescribedQty;
        totalPurchased += purchasedQty;

        medicineAnalysis.push({
          medicine_id: p.medicine_id,
          medicine_name: invoiceItem?.medicine_name || "Unknown",
          prescribed_qty: prescribedQty,
          purchased_qty: purchasedQty,
          difference: prescribedQty - purchasedQty,
        });
      });

      const compliance =
        totalPrescribed > 0
          ? ((totalPurchased / totalPrescribed) * 100).toFixed(1)
          : 0;

      analysis.push({
        patient_name: patientName,
        mobile,
        date: billDate,
        total_prescribed: totalPrescribed,
        total_purchased: totalPurchased,
        difference: totalPrescribed - totalPurchased,
        compliance_percent: compliance,
        medicine_analysis: medicineAnalysis,
      });
    });

    // ⭐ Categorize patients
    const categorized = {
      taken: [],
      partially_taken: [],
      not_taken: [],
    };

    analysis.forEach((patient) => {
      if (patient.total_purchased === 0) {
        categorized.not_taken.push(patient);
      } else if (patient.total_purchased >= patient.total_prescribed) {
        categorized.taken.push(patient); // fully + extra
      } else if (patient.total_purchased < patient.total_prescribed) {
        categorized.partially_taken.push(patient);
      }
    });

    return categorized;
  } catch (error) {
    console.error("Error in prescription analysis:", error);
    throw error;
  }
};

const getPrescriptionPurchaseAnalysis = async (req) => {
  const { location, from, to } = req.query;

  // ✅ Format dates
  const formatedFrom = formatDate(new Date(from));
  const formatedTo = formatDate(new Date(to));
  const fromDate = `${formatedFrom} 00:00:00`;
  const toDate = `${formatedTo} 23:59:59`;

  const { connection } = getConnectionByLocation(location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    const rows = await new Promise((resolve, reject) => {
      const sql = `
        SELECT
            epi.prescription_details,
            epi.invoice_details,
            epi.created_at,
            p.name AS patient_name,
            p.phone
        FROM evital_pharmacy_invoice epi
        LEFT JOIN patient p ON p.patient_id = epi.patient_id
        WHERE epi.prescription_details IS NOT NULL
        AND epi.patient_id IS NOT NULL
        AND epi.created_at BETWEEN ? AND ?
        ORDER BY epi.id DESC
      `;

      connection.query(sql, [fromDate, toDate], (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });

    const analysis = [];

    rows.forEach((row) => {
      let prescription = [];
      let invoiceObj = {};

      // ✅ Parse JSON safely
      try {
        prescription = JSON.parse(row.prescription_details || "[]");
      } catch {}

      try {
        invoiceObj = JSON.parse(row.invoice_details || "{}");
      } catch {}

      const patientName = invoiceObj.patient_name || row.patient_name || "";
      const mobile = invoiceObj.mobile || row.phone || "";

      const billDate = row.created_at
        ? new Date(row.created_at).toLocaleDateString("en-GB")
        : "Unknown";

      // ✅ Calculate prescribed amount
      let totalPrescribedAmount = 0;

      prescription.forEach((p) => {
        const mrp = parseFloat(p.mrp) || 0;
        const qty = parseFloat(p.quantity) || 0;
        const discount = parseFloat(p.discount_percentage) || 0;

        const prescribedAmount = mrp * qty - (mrp * qty * discount) / 100;

        totalPrescribedAmount += prescribedAmount;
      });

      // ✅ Use invoice total directly
      const totalPurchasedAmount = parseFloat(invoiceObj.total || 0);

      // ✅ Compliance %
      const compliance =
        totalPrescribedAmount > 0
          ? ((totalPurchasedAmount / totalPrescribedAmount) * 100).toFixed(1)
          : 0;

      analysis.push({
        patient_name: patientName,
        mobile,
        date: billDate,
        total_prescribed_amount: totalPrescribedAmount.toFixed(2),
        total_purchased_amount: totalPurchasedAmount.toFixed(2),
        difference: (totalPrescribedAmount - totalPurchasedAmount).toFixed(2),
        compliance_percent: compliance,
      });
    });

    // ⭐ Categorization
    const categorized = {
      taken: [],
      partially_taken: [],
      not_taken: [],
    };

    const tolerance = 10; // ₹10 buffer (optional but recommended)

    analysis.forEach((patient) => {
      const prescribed = Number(patient.total_prescribed_amount);
      const purchased = Number(patient.total_purchased_amount);

      if (purchased === 0) {
        categorized.not_taken.push(patient);
      } else if (Math.abs(purchased - prescribed) <= tolerance) {
        categorized.taken.push(patient);
      } else if (purchased < prescribed) {
        categorized.partially_taken.push(patient);
      } else {
        // extra purchase also considered taken
        categorized.taken.push(patient);
      }
    });
    console.log(categorized);
    return categorized;
  } catch (error) {
    console.error("Error in prescription analysis:", error);
    throw error;
  }
};

const getPrescriptionPurchaseAnalysisQuantityV2 = async (req) => {
  const { location, from, to } = req.query;
  // ✅ Normalize date range
  const formatedFrom = formatDate(new Date(from));
  const formatedTo = formatDate(new Date(to));
  const fromDate = `${formatedFrom} 00:00:00`;
  const toDate = `${formatedTo} 23:59:59`;

  const { connection } = getConnectionByLocation(location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    const rows = await new Promise((resolve, reject) => {
      const sql = `
                    SELECT
            epi.prescription_details,
            epi.invoice_details,
            epi.created_at,
            p.name AS patient_name,
            p.phone,
            ap.patient_type
        FROM evital_pharmacy_invoice epi
        LEFT JOIN patient p 
            ON p.patient_id = epi.patient_id

        -- ✅ Latest appointment per patient using appointment_timestamp
                LEFT JOIN (
            SELECT a1.patient_id, a1.patient_type
            FROM appointment a1
            INNER JOIN (
                SELECT patient_id, MAX(appointment_id) AS latest_id
                FROM appointment
                WHERE confirm_time != 0   -- ✅ filter here
                GROUP BY patient_id
            ) a2 
            ON a1.appointment_id = a2.latest_id
        ) ap 
        ON ap.patient_id = epi.patient_id

        WHERE epi.prescription_details IS NOT NULL
        AND epi.patient_id IS NOT NULL
        AND epi.created_at BETWEEN ? AND ?
        ORDER BY epi.id DESC;
      `;

      connection.query(sql, [fromDate, toDate], (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });

    const analysis = [];

    rows.forEach((row) => {
      let prescription = [];
      let invoiceObj = {};
      let invoiceItems = [];

      try {
        prescription = JSON.parse(row.prescription_details || "[]");
      } catch {}

      try {
        invoiceObj = JSON.parse(row.invoice_details || "{}");
        invoiceItems = invoiceObj.items || [];
      } catch {}

      const patientName = invoiceObj.patient_name || row.patient_name || "";
      const mobile = invoiceObj.mobile || row.phone || "";
      const billDate = row.created_at
        ? new Date(row.created_at).toLocaleDateString("en-GB")
        : "Unknown";

      let totalPrescribed = 0;
      let totalPurchased = 0;

      const medicineAnalysis = [];

      prescription.forEach((p) => {
        const prescribedQty = Number(p.quantity) || 0;

        const invoiceItem = invoiceItems.find(
          (i) => i.medicine_id === p.medicine_id,
        );

        const purchasedQty = invoiceItem ? Number(invoiceItem.quantity) : 0;

        totalPrescribed += prescribedQty;
        totalPurchased += purchasedQty;

        medicineAnalysis.push({
          medicine_id: p.medicine_id,
          medicine_name: invoiceItem?.medicine_name || "Unknown",
          prescribed_qty: prescribedQty,
          purchased_qty: purchasedQty,
          difference: prescribedQty - purchasedQty,
        });
      });

      const prescribedMedicines = prescription.map((p) => ({
        medicine_id: p.medicine_id,
        medicine_name: p.medicine_name,
        prescribed_qty: Number(p.quantity) || 0,
      }));

      const purchasedMedicines = invoiceItems.map((i) => ({
        medicine_id: i.medicine_id,
        medicine_name: i.medicine_name,
        purchased_qty: Number(i.quantity) || 0,
      }));

      const extraPurchased = invoiceItems.filter(
        (i) => !prescription.some((p) => p.medicine_id === i.medicine_id),
      );

      const compliance =
        totalPrescribed > 0
          ? ((totalPurchased / totalPrescribed) * 100).toFixed(1)
          : 0;

      analysis.push({
        patient_name: patientName,
        mobile,
        patient_type: row.patient_type || "Unknown",
        date: billDate,

        total_prescribed: totalPrescribed,
        total_purchased: totalPurchased,
        difference: totalPrescribed - totalPurchased,
        compliance_percent: compliance,

        medicine_analysis: medicineAnalysis,

        // ✅ NEW DATA
        prescribed_medicines: prescribedMedicines,
        purchased_medicines: purchasedMedicines,
        extraPurchased: extraPurchased,
      });
    });

    // ⭐ Categorize patients
    const categorized = {
      taken: [],
      not_taken: [],
    };

    analysis.forEach((patient) => {
      if (patient.total_purchased === 0) {
        categorized.not_taken.push(patient);
      } else {
        categorized.taken.push(patient); // ✅ everything else goes here
      }
    });

    console.log(categorized);

    return categorized;
  } catch (error) {
    console.error("Error in prescription analysis:", error);
    throw error;
  }
};

module.exports = {
  getPharmacyCollection,
  getPrescriptionPurchaseAnalysis,
  getPrescriptionPurchaseAnalysisQuantity,
  getPrescriptionPurchaseAnalysisQuantityV2,
  getPharmacyCollectionV1,
  getPharmacyCollectionV2,
};
