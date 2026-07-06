const fs = require("fs");
const xlsx = require("xlsx");
const path = require("path");
const nodemailer = require("nodemailer");
const { getConnectionByLocation } = require("../../databaseUtils");

// Create "report" folder in project root if it doesn't exist
const reportsDir = path.join(__dirname, "..", "report"); // ".." goes to project root

// Daily Sales Report email recipient (hardcoded by design).
// TODO: replace with the real DSR distribution address.
const DSR_RECIPIENT = "healinghandsclinicacc@gmail.com"; // "shubham.khatod17594@gmail.com";

if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true });
}

const locations = [
  "DP Road",
  "Andheri",
  "Baner",
  "Belgavi",
  "Chakan",
  "Chinchwad",
  "Dighi",
  "Gurgaon Sector 14",
  "Gurgaon Sector 49",
  "Hinjewadi",
  "HSR",
  "Hyderabad",
  "Indiranagar",
  "JP Nagar",
  "Kalaburagi",
  "Katraj",
  "Latur",
  "Ludhiana",
  "Lucknow",
  "Mysore",
  "Nashik",
  "Navi Mumbai",
  "Rajaji Nagar",
  "Salunke Vihar",
  "Sahakar Nagar",
  "Sarjapura",
  "Secunderabad",
  "Surat",
  "Thane",
  "Undri",
  "Vashi",
  "Ahmedabad",
  "Mohali",
  "Aurangabad",
  "Whitefield",
  "Hadapsar",
  "Kalyan",
  "Bopal",
  "Electronic City",
];

// Execute query helper
function executeQuery(connection, query, values = []) {
  return new Promise((resolve, reject) => {
    connection.query(query, values, (err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
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

// Your function to fetch yesterday collections
async function getYesterdayCollections(location, dateStr) {
  const { connection } = getConnectionByLocation(location);
  if (!connection) throw new Error("Invalid location");

  // Use the explicitly provided date when given; otherwise default to
  // "yesterday" in IST regardless of server timezone.
  if (!dateStr) {
    const nowIST = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
    );
    nowIST.setDate(nowIST.getDate() - 1);
    const yyyy = nowIST.getFullYear();
    const mm = String(nowIST.getMonth() + 1).padStart(2, "0");
    const dd = String(nowIST.getDate()).padStart(2, "0");
    dateStr = `${yyyy}-${mm}-${dd}`;
  }

  // OPD Queries
  const cashQuery = `SELECT COALESCE(SUM(total),0) AS Total FROM patient_itemreceipt WHERE item_date = ? AND payment_mode='Cash' AND is_deleted!=1`;
  const cardQuery = `SELECT COALESCE(SUM(total),0) AS Total FROM patient_itemreceipt WHERE item_date = ? AND payment_mode='Card' AND is_deleted!=1`;
  const onlineQuery = `SELECT COALESCE(SUM(total),0) AS Total FROM patient_itemreceipt WHERE item_date = ? AND payment_mode IN ('Online','UPI') AND is_deleted!=1`;

  // IPD Query
  const ipdQuery = `SELECT COALESCE(SUM(ip.cashamt),0) AS cashamt, COALESCE(SUM(ip.cardamt),0) AS cardamt, COALESCE(SUM(ip.chequeamt),0) AS chequeamt, COALESCE(SUM(ip.onlineamt),0) AS onlineamt FROM ipd_payment ip WHERE ip.receipt_date = ?`;

  const insuranceQuery = `SELECT COALESCE(SUM(iv.receivedamt),0) AS settledAmount FROM insurance_invoice iv WHERE iv.paymentdate = ? `;

  let pharmacyCashTotalQuery, pharmacyCardTotalQuery, pharmacyOnlineTotalQuery;

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
      executeQuery(connection, pharmacyCashTotalQuery, [dateStr]),
      executeQuery(connection, pharmacyCardTotalQuery, [dateStr]),
      executeQuery(connection, pharmacyOnlineTotalQuery, [dateStr]),
    ]);

  const evitalCollectionData = await getPharmacyCollection(
    location,
    dateStr,
    dateStr,
  );
  // console.log("Evital Collection Data:", evitalCollectionData);

  // const paymentModeTotals = evitalCollectionData.reduce((acc, row) => {
  //   const invoice = safeParseInvoice(row.invoice_details);
  //   if (!invoice) return acc;

  //   let mode = invoice.payment_mode || "UNKNOWN";
  //   const total = Math.round(Number(invoice.total) || 0); // ✅ round here

  //   // Normalize payment modes
  //   switch (mode) {
  //     case "CC/DC":
  //     case "Credit":
  //       mode = "Card";
  //       break;
  //     case "UPI":
  //     case "Online":
  //       mode = "Online";
  //       break;
  //     case "Cash":
  //       mode = "Cash";
  //       break;
  //     default:
  //       mode = "Other";
  //   }

  //   acc[mode] = (acc[mode] || 0) + total;

  //   return acc;
  // }, {});

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

  const [opdCash] = await executeQuery(connection, cashQuery, [dateStr]);
  const [opdCard] = await executeQuery(connection, cardQuery, [dateStr]);
  const [opdOnline] = await executeQuery(connection, onlineQuery, [dateStr]);
  const [ipdTotals] = await executeQuery(connection, ipdQuery, [dateStr]);
  const [insuranceSettled] = await executeQuery(connection, insuranceQuery, [
    dateStr,
  ]);

  return {
    location,
    date: dateStr,
    OPD: {
      cash: opdCash.Total || 0,
      card: opdCard.Total || 0,
      online: opdOnline.Total || 0,
    },
    IPD: {
      cash: ipdTotals.cashamt || 0,
      card: ipdTotals.cardamt || 0,
      cheque: ipdTotals.chequeamt || 0,
      online: ipdTotals.onlineamt || 0,
      settlmentFromInsurance: insuranceSettled.settledAmount || 0,
    },
    Pharmacy: {
      cash: (pharmacyCashTotal[0].Total || 0) + (paymentModeTotals.Cash || 0),
      card: (pharmacyCardTotal[0].Total || 0) + (paymentModeTotals.Card || 0),
      online:
        (pharmacyOnlineTotal[0].Total || 0) + (paymentModeTotals.Online || 0),
    },
  };
}

// Main function to get data for all locations, create Excel, and send email
async function generateAndSendReport(toEmail) {
  const allData = [];

  for (const loc of locations) {
    try {
      const data = await getYesterdayCollections(loc);
      allData.push(data);
    } catch (err) {
      console.error(`Error for location ${loc}:`, err.message);
    }
  }
  console.log(allData);
  // Prepare data for Excel
  const excelData = allData.map((d) => ({
    Location: d.location,
    Date: d.date,
    "OPD Cash": d.OPD.cash,
    "OPD Card": d.OPD.card,
    "OPD Online": d.OPD.online,
    "IPD Cash": d.IPD.cash,
    "IPD Card": d.IPD.card,
    "IPD Cheque": d.IPD.cheque,
    "IPD Online": d.IPD.online,
    "Pharmacy Cash": d.Pharmacy.cash,
    "Pharmacy Card": d.Pharmacy.card,
    "Pharmacy Online": d.Pharmacy.online,
  }));

  // Create workbook
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(excelData);
  xlsx.utils.book_append_sheet(wb, ws, "Collections");

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yyyy = yesterday.getFullYear();
  const mm = String(yesterday.getMonth() + 1).padStart(2, "0");
  const dd = String(yesterday.getDate()).padStart(2, "0");
  const dateStr = `${yyyy}-${mm}-${dd}`;

  // Generate the full file path
  const fileName = `Collection_Report_of_${dateStr}.xlsx`;
  const filePath = path.join(reportsDir, fileName);

  // Write Excel file
  xlsx.writeFile(wb, filePath);

  console.log("Excel file created:", filePath);

  // Send email with attachment
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: "info@healinghandsclinic.co.in",
      pass: "gigv lofw tugi btvw", // use App Password for Gmail
    },
  });

  const mailOptions = {
    from: "info@healinghandsclinic.co.in",
    to: toEmail,
    subject: "Yesterday Collections Report",
    text: "Please find attached yesterday's collections report for all locations.",
    attachments: [{ filename: path.basename(filePath), path: filePath }],
  };

  const info = await transporter.sendMail(mailOptions);
  console.log("Email sent:", info.messageId);
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
    // console.log(rows);
    return rows;
  } catch (error) {
    throw error;
  }
};

async function getLocationSummary(location, fromDate, toDate) {
  const { connection } = getConnectionByLocation(location);
  if (!connection) throw new Error(`Invalid location: ${location}`);

  const executeQ = (query, values = []) =>
    new Promise((resolve, reject) =>
      connection.query(query, values, (err, results) => {
        if (err) return reject(err);
        resolve(results);
      }),
    );

  // ── OPD ──────────────────────────────────────────────
  const [opdCash] = await executeQ(
    `SELECT COALESCE(SUM(total),0) AS Total FROM patient_itemreceipt WHERE item_date BETWEEN ? AND ? AND payment_mode='Cash' AND is_deleted!=1`,
    [fromDate, toDate],
  );
  const [opdCard] = await executeQ(
    `SELECT COALESCE(SUM(total),0) AS Total FROM patient_itemreceipt WHERE item_date BETWEEN ? AND ? AND payment_mode='Card' AND is_deleted!=1`,
    [fromDate, toDate],
  );
  const [opdOnline] = await executeQ(
    `SELECT COALESCE(SUM(total),0) AS Total FROM patient_itemreceipt WHERE item_date BETWEEN ? AND ? AND payment_mode IN ('Online','UPI') AND is_deleted!=1`,
    [fromDate, toDate],
  );

  // ── IPD Collection ────────────────────────────────────
  const [ipdTotals] = await executeQ(
    `SELECT
       COALESCE(SUM(cashamt),0)   AS cash,
       COALESCE(SUM(cardamt),0)   AS card,
       COALESCE(SUM(chequeamt),0) AS cheque,
       COALESCE(SUM(onlineamt),0) AS online
     FROM ipd_payment WHERE receipt_date>=? AND receipt_date<=?`,
    [fromDate, toDate],
  );

  // ── IPD Invoice ───────────────────────────────────────
  const ipdInvoiceRows = await executeQ(
    `SELECT i.status, COALESCE(SUM(i.totalamt),0) AS total_amount,  COALESCE(SUM(discount),0) AS discount
     FROM invoice i
     WHERE i.creation_date >= ? AND i.creation_date <= ?
       AND i.is_deleted != 1
     GROUP BY i.status`,
    [`${fromDate} 00:00:00`, `${toDate} 23:59:59`],
  );

  const ipdInvoiceByStatus = {};
  let ipdInvoiceTotal = 0;
  let ipdInvoiceTotalDiscount = 0;
  ipdInvoiceRows.forEach((r) => {
    ipdInvoiceByStatus[r.status] = r.total_amount;
    ipdInvoiceTotal += Number(r.total_amount) || 0;
    ipdInvoiceTotalDiscount += Number(r.discount) || 0;
  });

  // ── Pharmacy (HMS) ────────────────────────────────────
  let pharmacyCashQuery, pharmacyCardQuery, pharmacyOnlineQuery;

  if (location === "DP Road") {
    const base = `SELECT COALESCE(SUM(totalamt),0) AS Total FROM patient_receipt WHERE receipt_date >=? AND receipt_date <=? AND chargeCondition='LabTest' AND is_deleted!=1`;
    pharmacyCashQuery = base + ` AND paymentmode='Cash'`;
    pharmacyCardQuery = base + ` AND paymentmode='Card'`;
    pharmacyOnlineQuery = base + ` AND paymentmode IN ('Online','UPI')`;
  } else {
    const base = `SELECT COALESCE(SUM(final_total),0) AS Total FROM pharmacybill WHERE created_at >=? AND created_at <=? AND is_deleted!=1`;
    pharmacyCashQuery = base + ` AND paymentmode='Cash'`;
    pharmacyCardQuery = base + ` AND paymentmode='Card'`;
    pharmacyOnlineQuery = base + ` AND paymentmode IN ('Online','UPI','Paytm')`;
  }

  const [[pharmacyCash], [pharmacyCard], [pharmacyOnline]] = await Promise.all([
    executeQ(pharmacyCashQuery, [fromDate, toDate]),
    executeQ(pharmacyCardQuery, [fromDate, toDate]),
    executeQ(pharmacyOnlineQuery, [fromDate, toDate]),
  ]);

  // ── Evital Pharmacy ───────────────────────────────────
  const evitalRows = await getPharmacyCollection(location, fromDate, toDate);

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

  const evitalTotals = evitalRows.reduce(
    (acc, row) => {
      const invoice = safeParseInvoice(row.invoice_details);
      if (!invoice) return acc;
      const total = Math.round(Number(invoice.total) || 0);

      if (row.UpdatedInvoiceDetails) {
        try {
          const updated = JSON.parse(row.UpdatedInvoiceDetails);
          const txns = updated?.transaction_summary?.transactions ?? [];
          if (txns.length === 1) {
            const m = normalizeMode(txns[0].method);
            acc[m] = (acc[m] || 0) + total;
            return acc;
          } else if (txns.length > 1) {
            txns.forEach((txn) => {
              const m = normalizeMode(txn.method);
              acc[m] = (acc[m] || 0) + Math.round(Number(txn.amount) || 0);
            });
            return acc;
          }
        } catch (_) {}
      }

      const m = normalizeMode(invoice.payment_mode);
      acc[m] = (acc[m] || 0) + total;
      return acc;
    },
    { Cash: 0, Card: 0, Online: 0, Other: 0 },
  );

  // ── Assemble ──────────────────────────────────────────
  const opd = {
    cash: Number(opdCash.Total) || 0,
    card: Number(opdCard.Total) || 0,
    online: Number(opdOnline.Total) || 0,
  };
  opd.total = opd.cash + opd.card + opd.online;

  const ipdCollection = {
    cash: Number(ipdTotals.cash) || 0,
    card: Number(ipdTotals.card) || 0,
    cheque: Number(ipdTotals.cheque) || 0,
    online: Number(ipdTotals.online) || 0,
  };
  ipdCollection.total =
    ipdCollection.cash +
    ipdCollection.card +
    ipdCollection.cheque +
    ipdCollection.online;

  const ipdInvoice = {
    byStatus: ipdInvoiceByStatus,
    total: ipdInvoiceTotal,
    totalDiscount: ipdInvoiceTotalDiscount,
  };

  const pharmacy = {
    cash: (Number(pharmacyCash.Total) || 0) + evitalTotals.Cash,
    card: (Number(pharmacyCard.Total) || 0) + evitalTotals.Card,
    online: (Number(pharmacyOnline.Total) || 0) + evitalTotals.Online,
  };
  pharmacy.total = pharmacy.cash + pharmacy.card + pharmacy.online;

  const grandTotal = opd.total + ipdInvoice.total + pharmacy.total;

  return {
    location,
    date: `${fromDate} to ${toDate}`,
    opd,
    ipdCollection,
    ipdInvoice,
    pharmacy,
    grandTotal,
  };
}

async function generateSummaryReport(fromDate, toDate) {
  const results = [];
  const summary = {
    opd: { cash: 0, card: 0, online: 0, total: 0 },
    ipdCollection: { cash: 0, card: 0, cheque: 0, online: 0, total: 0 },
    ipdInvoice: { byStatus: {}, total: 0, totalDiscount: 0 },
    pharmacy: { cash: 0, card: 0, online: 0, total: 0 },
    grandTotal: 0,
  };

  for (const loc of locations) {
    try {
      const data = await getLocationSummary(loc, fromDate, toDate);
      results.push(data);

      summary.opd.cash += data.opd.cash;
      summary.opd.card += data.opd.card;
      summary.opd.online += data.opd.online;
      summary.opd.total += data.opd.total;

      summary.ipdCollection.cash += data.ipdCollection.cash;
      summary.ipdCollection.card += data.ipdCollection.card;
      summary.ipdCollection.cheque += data.ipdCollection.cheque;
      summary.ipdCollection.online += data.ipdCollection.online;
      summary.ipdCollection.total += data.ipdCollection.total;

      Object.entries(data.ipdInvoice.byStatus).forEach(([status, amt]) => {
        summary.ipdInvoice.byStatus[status] =
          (summary.ipdInvoice.byStatus[status] || 0) + Number(amt);
      });
      summary.ipdInvoice.total += data.ipdInvoice.total;
      summary.ipdInvoice.totalDiscount += data.ipdInvoice.totalDiscount;
      summary.pharmacy.cash += data.pharmacy.cash;
      summary.pharmacy.card += data.pharmacy.card;
      summary.pharmacy.online += data.pharmacy.online;
      summary.pharmacy.total += data.pharmacy.total;

      // ✅ Grand total = OPD + IPD Invoice + Pharmacy (IPD Collection excluded)
      summary.grandTotal +=
        data.opd.total + data.ipdInvoice.total + data.pharmacy.total;
    } catch (err) {
      console.error(`Error for ${loc}:`, err.message);
      results.push({ location: loc, error: err.message });
    }
  }

  return { branches: results, summary };
}

// Build an inclusive list of 'YYYY-MM-DD' strings between two dates (IST-safe).
function buildDateRange(startStr, endStr) {
  const dates = [];
  // Parse as local Y/M/D parts to avoid UTC parsing shifts.
  const [sy, sm, sd] = startStr.split("-").map(Number);
  const [ey, em, ed] = endStr.split("-").map(Number);
  const cur = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  while (cur <= end) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, "0");
    const d = String(cur.getDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

async function generateRangeReport(startStr, endStr, toEmail) {
  const dateList = buildDateRange(startStr, endStr);
  const allRows = [];

  for (const dateStr of dateList) {
    console.log(`\n=== Processing ${dateStr} ===`);
    for (const loc of locations) {
      try {
        const data = await getYesterdayCollections(loc, dateStr);
        allRows.push({
          Date: data.date,
          Location: data.location,
          "OPD Cash": data.OPD.cash,
          "OPD Card": data.OPD.card,
          "OPD Online": data.OPD.online,
          "IPD Cash": data.IPD.cash,
          "IPD Card": data.IPD.card,
          "IPD Cheque": data.IPD.cheque,
          "IPD Online": data.IPD.online,
          "Insurance Settlment": data.IPD.settlmentFromInsurance,
          "Pharmacy Cash": data.Pharmacy.cash,
          "Pharmacy Card": data.Pharmacy.card,
          "Pharmacy Online": data.Pharmacy.online,
        });
      } catch (err) {
        console.error(`  ✗ ${loc} on ${dateStr}:`, err.message);
        // Push a zero/blank row so missing days are visible rather than silently skipped
        allRows.push({
          Date: dateStr,
          Location: loc,
          "OPD Cash": "ERR",
          "OPD Card": "",
          "OPD Online": "",
          "IPD Cash": "",
          "IPD Card": "",
          "IPD Cheque": "",
          "IPD Online": "",
          "Pharmacy Cash": "",
          "Pharmacy Card": "",
          "Pharmacy Online": "",
        });
      }
    }
  }

  // One workbook, all days stacked, sorted by Date then Location.
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(allRows);
  xlsx.utils.book_append_sheet(wb, ws, "Collections");

  const fileName = `Collection_Report_${startStr}_to_${endStr}.xlsx`;
  const filePath = path.join(reportsDir, fileName);
  xlsx.writeFile(wb, filePath);
  console.log("\nExcel file created:", filePath);

  if (toEmail) {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: "info@healinghandsclinic.co.in",
        pass: "gigv lofw tugi btvw",
      },
    });
    const info = await transporter.sendMail({
      from: "info@healinghandsclinic.co.in",
      to: toEmail,
      subject: `Collections Report ${startStr} to ${endStr}`,
      text: `Attached: collections for all locations, ${startStr} to ${endStr}.`,
      attachments: [{ filename: path.basename(filePath), path: filePath }],
    });
    console.log("Email sent:", info.messageId);
  }

  return filePath;
}

// generateRangeReport("2026-0-01", "2026-04-30", "shubham.khatod17594@gmail.com")
//   .then((fp) => {
//     console.log("Done:", fp);
//     process.exit(0);
//   })
//   .catch((e) => {
//     console.error(e);
//     process.exit(1);
//   });
// Usage
// generateAndSendReport("recipient@example.com")
//   .then(() => console.log("Report generated and emailed successfully"))
//   .catch((err) => console.error("Error:", err));

// ── Daily Sales Report (DSR) ────────────────────────────────
// Builds the branch-wise collection rows for ONE selected date. The caller
// passes the list of branches the signed-in user is authorized to see (from
// the app's redux state); we intersect it with the master `locations` list so
// a request can never pull branches outside the allowed set. Branches are
// fetched in parallel and per-branch failures are isolated.
async function buildDSRRows(dateStr, requestedLocations) {
  if (!dateStr) {
    const err = new Error("date is required (YYYY-MM-DD)");
    err.status = 400;
    throw err;
  }

  const allowed =
    Array.isArray(requestedLocations) && requestedLocations.length
      ? requestedLocations.filter((l) => locations.includes(l))
      : [];

  if (!allowed.length) {
    const err = new Error("No valid locations provided");
    err.status = 400;
    throw err;
  }

  const settled = await Promise.all(
    allowed.map(async (loc) => {
      try {
        return { ok: true, data: await getYesterdayCollections(loc, dateStr) };
      } catch (err) {
        console.error(`DSR error for ${loc}:`, err.message);
        return { ok: false, location: loc, error: err.message };
      }
    }),
  );

  const allData = settled.filter((s) => s.ok).map((s) => s.data);
  const failed = settled
    .filter((s) => !s.ok)
    .map((s) => ({ location: s.location, error: s.error }));

  if (!allData.length) {
    const err = new Error(
      "No collection data could be generated for any branch",
    );
    err.status = 502;
    throw err;
  }

  const rows = allData.map((d) => ({
    Location: d.location,
    Date: d.date,
    "OPD Cash": d.OPD.cash,
    "OPD Card": d.OPD.card,
    "OPD Online": d.OPD.online,
    "IPD Cash": d.IPD.cash,
    "IPD Card": d.IPD.card,
    "IPD Cheque": d.IPD.cheque,
    "IPD Online": d.IPD.online,
    "Insurance Settlement": d.IPD.settlmentFromInsurance,
    "Pharmacy Cash": d.Pharmacy.cash,
    "Pharmacy Card": d.Pharmacy.card,
    "Pharmacy Online": d.Pharmacy.online,
  }));

  return {
    rows,
    date: dateStr,
    branchesProcessed: allData.length,
    branchesRequested: allowed.length,
    failed,
  };
}

// Data-only path (for in-app download): returns the rows as JSON so the app
// can build the Excel on-device. No file is written, no email is sent.
async function getDSRData(dateStr, requestedLocations) {
  return await buildDSRRows(dateStr, requestedLocations);
}

// Email path: builds the workbook on the server and mails it to the
// hardcoded recipient.
async function generateDSRForDate(
  dateStr,
  requestedLocations,
  toEmail = DSR_RECIPIENT,
) {
  const { rows, date, branchesProcessed, branchesRequested, failed } =
    await buildDSRRows(dateStr, requestedLocations);

  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(rows);
  xlsx.utils.book_append_sheet(wb, ws, "Collections");

  const fileName = `DSR_${String(date).slice(0, 10)}.xlsx`;
  const filePath = path.join(reportsDir, fileName);
  xlsx.writeFile(wb, filePath);

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: "info@healinghandsclinic.co.in",
      pass: "gigv lofw tugi btvw",
    },
  });

  const info = await transporter.sendMail({
    from: "info@healinghandsclinic.co.in",
    to: toEmail,
    subject: `Daily Sales Report — ${date}`,
    text:
      `Attached: branch-wise collections for ${date} ` +
      `(${branchesProcessed} of ${branchesRequested} branches).`,
    attachments: [{ filename: path.basename(filePath), path: filePath }],
  });

  return {
    success: true,
    date,
    sentTo: toEmail,
    branchesProcessed,
    branchesRequested,
    failed,
    messageId: info.messageId,
  };
}

//DCR for all locations for selected time range
async function getDSRRangeData(fromDate, toDate, requestedLocations) {
  if (!fromDate || !toDate) {
    const err = new Error("fromDate and toDate are required");
    err.status = 400;
    throw err;
  }

  const allowed =
    Array.isArray(requestedLocations) && requestedLocations.length
      ? requestedLocations.filter((l) => locations.includes(l))
      : locations;

  if (!allowed.length) {
    const err = new Error("No valid locations provided");
    err.status = 400;
    throw err;
  }

  const from = `${fromDate} 00:00:00`;
  const to = `${toDate} 23:59:59`;

  const settled = await Promise.all(
    allowed.map(async (loc) => {
      try {
        const data = await getCollectionsForDateRange(loc, from, to);

        return {
          ok: true,
          row: {
            Location: data.location,
            Period: `${fromDate} to ${toDate}`,

            "OPD Cash": data.OPD.cash,
            "OPD Card": data.OPD.card,
            "OPD Online": data.OPD.online,

            "IPD Collection Cash": data.IPD.cash,
            "IPD Collection Card": data.IPD.card,
            "IPD Collection Cheque": data.IPD.cheque,
            "IPD Collection Online": data.IPD.online,
            "Insurance Settlement": data.IPD.settlmentFromInsurance,

            "Pharmacy Cash": data.Pharmacy.cash,
            "Pharmacy Card": data.Pharmacy.card,
            "Pharmacy Online": data.Pharmacy.online,
          },
        };
      } catch (err) {
        return {
          ok: false,
          location: loc,
          error: err.message,
        };
      }
    }),
  );

  const rows = settled.filter((r) => r.ok).map((r) => r.row);

  const failed = settled
    .filter((r) => !r.ok)
    .map((r) => ({
      location: r.location,
      error: r.error,
    }));

  return {
    rows,
    fromDate,
    toDate,
    branchesProcessed: rows.length,
    branchesRequested: allowed.length,
    failed,
  };
}

async function generateDSRRangeExcel(fromDate, toDate, requestedLocations) {
  const { rows, branchesProcessed, branchesRequested, failed } =
    await getDSRRangeData(fromDate, toDate, requestedLocations);

  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(rows);

  xlsx.utils.book_append_sheet(wb, ws, "Collection Report");

  const fileName = `Collection_Report_${fromDate}_to_${toDate}.xlsx`;

  const filePath = path.join(reportsDir, fileName);

  xlsx.writeFile(wb, filePath);

  return {
    success: true,
    filePath,
    branchesProcessed,
    branchesRequested,
    failed,
  };
}

async function getCollectionsForDateRange(location, fromDate, toDate) {
  const { connection } = getConnectionByLocation(location);

  if (!connection) {
    throw new Error(`Invalid location: ${location}`);
  }

  // ---------------- OPD ----------------
  const cashQuery = `
    SELECT COALESCE(SUM(total),0) AS Total
    FROM patient_itemreceipt
    WHERE item_date BETWEEN ? AND ?
      AND payment_mode='Cash'
      AND is_deleted!=1
  `;

  const cardQuery = `
    SELECT COALESCE(SUM(total),0) AS Total
    FROM patient_itemreceipt
    WHERE item_date BETWEEN ? AND ?
      AND payment_mode='Card'
      AND is_deleted!=1
  `;

  const onlineQuery = `
    SELECT COALESCE(SUM(total),0) AS Total
    FROM patient_itemreceipt
    WHERE item_date BETWEEN ? AND ?
      AND payment_mode IN ('Online','UPI')
      AND is_deleted!=1
  `;

  // ---------------- IPD ----------------
  const ipdQuery = `
    SELECT
      COALESCE(SUM(ip.cashamt),0) AS cashamt,
      COALESCE(SUM(ip.cardamt),0) AS cardamt,
      COALESCE(SUM(ip.chequeamt),0) AS chequeamt,
      COALESCE(SUM(ip.onlineamt),0) AS onlineamt
    FROM ipd_payment ip
    WHERE ip.receipt_date BETWEEN ? AND ?
  `;

  const insuranceQuery = `
    SELECT
      COALESCE(SUM(iv.receivedamt),0) AS settledAmount
    FROM insurance_invoice iv
    WHERE iv.paymentdate BETWEEN ? AND ?
  `;

  // ---------------- Pharmacy HMS ----------------
  let pharmacyCashTotalQuery;
  let pharmacyCardTotalQuery;
  let pharmacyOnlineTotalQuery;

  if (location === "DP Road") {
    pharmacyCashTotalQuery = `
      SELECT COALESCE(SUM(totalamt),0) AS Total
      FROM patient_receipt
      WHERE receipt_date BETWEEN ? AND ?
        AND paymentmode='Cash'
        AND chargeCondition='LabTest'
        AND is_deleted!=1
    `;

    pharmacyCardTotalQuery = `
      SELECT COALESCE(SUM(totalamt),0) AS Total
      FROM patient_receipt
      WHERE receipt_date BETWEEN ? AND ?
        AND paymentmode='Card'
        AND chargeCondition='LabTest'
        AND is_deleted!=1
    `;

    pharmacyOnlineTotalQuery = `
      SELECT COALESCE(SUM(totalamt),0) AS Total
      FROM patient_receipt
      WHERE receipt_date BETWEEN ? AND ?
        AND paymentmode IN ('Online','UPI')
        AND chargeCondition='LabTest'
        AND is_deleted!=1
    `;
  } else {
    pharmacyCashTotalQuery = `
      SELECT COALESCE(SUM(final_total),0) AS Total
      FROM pharmacybill
      WHERE created_at BETWEEN ? AND ?
        AND paymentmode='Cash'
        AND is_deleted!=1
    `;

    pharmacyCardTotalQuery = `
      SELECT COALESCE(SUM(final_total),0) AS Total
      FROM pharmacybill
      WHERE created_at BETWEEN ? AND ?
        AND paymentmode='Card'
        AND is_deleted!=1
    `;

    pharmacyOnlineTotalQuery = `
      SELECT COALESCE(SUM(final_total),0) AS Total
      FROM pharmacybill
      WHERE created_at BETWEEN ? AND ?
        AND paymentmode IN ('Online','UPI','Paytm')
        AND is_deleted!=1
    `;
  }

  // ---------------- Execute Queries ----------------
  const [
    opdCash,
    opdCard,
    opdOnline,
    ipdTotals,
    insuranceSettled,
    pharmacyCashTotal,
    pharmacyCardTotal,
    pharmacyOnlineTotal,
  ] = await Promise.all([
    executeQuery(connection, cashQuery, [fromDate, toDate]),
    executeQuery(connection, cardQuery, [fromDate, toDate]),
    executeQuery(connection, onlineQuery, [fromDate, toDate]),

    executeQuery(connection, ipdQuery, [fromDate, toDate]),
    executeQuery(connection, insuranceQuery, [fromDate, toDate]),

    executeQuery(connection, pharmacyCashTotalQuery, [fromDate, toDate]),
    executeQuery(connection, pharmacyCardTotalQuery, [fromDate, toDate]),
    executeQuery(connection, pharmacyOnlineTotalQuery, [fromDate, toDate]),
  ]);

  // ---------------- Evital Collection ----------------
  const evitalCollectionData = await getPharmacyCollection(
    location,
    fromDate,
    toDate,
  );

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

    if (row.UpdatedInvoiceDetails) {
      try {
        const updatedInvoice = JSON.parse(row.UpdatedInvoiceDetails);

        const transactions =
          updatedInvoice?.transaction_summary?.transactions || [];

        if (transactions.length === 1) {
          const mode = normalizeMode(transactions[0].method);

          acc[mode] = (acc[mode] || 0) + total;
          return acc;
        }

        if (transactions.length > 1) {
          transactions.forEach((txn) => {
            const mode = normalizeMode(txn.method);

            acc[mode] = (acc[mode] || 0) + Math.round(Number(txn.amount) || 0);
          });

          return acc;
        }
      } catch (e) {}
    }

    const mode = normalizeMode(invoice.payment_mode);

    acc[mode] = (acc[mode] || 0) + total;

    return acc;
  }, {});

  return {
    location,
    fromDate,
    toDate,

    OPD: {
      cash: opdCash[0]?.Total || 0,
      card: opdCard[0]?.Total || 0,
      online: opdOnline[0]?.Total || 0,
    },

    IPD: {
      cash: ipdTotals[0]?.cashamt || 0,
      card: ipdTotals[0]?.cardamt || 0,
      cheque: ipdTotals[0]?.chequeamt || 0,
      online: ipdTotals[0]?.onlineamt || 0,
      settlmentFromInsurance: insuranceSettled[0]?.settledAmount || 0,
    },

    Pharmacy: {
      cash: (pharmacyCashTotal[0]?.Total || 0) + (paymentModeTotals.Cash || 0),

      card: (pharmacyCardTotal[0]?.Total || 0) + (paymentModeTotals.Card || 0),

      online:
        (pharmacyOnlineTotal[0]?.Total || 0) + (paymentModeTotals.Online || 0),
    },
  };
}

module.exports = {
  generateAndSendReport,
  generateSummaryReport,
  generateDSRForDate,
  getDSRData,
  generateDSRRangeExcel,
  getLocationSummary,
};
