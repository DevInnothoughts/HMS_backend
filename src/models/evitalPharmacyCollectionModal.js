const { getConnectionByLocation } = require("../../databaseUtils");

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

const getPrescriptionPurchaseAnalysis = async (req) => {
  const { location, from, to } = req.query;
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

      connection.query(sql, [from, to], (err, result) => {
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

module.exports = {
  getPharmacyCollection,
  getPrescriptionPurchaseAnalysis,
};
