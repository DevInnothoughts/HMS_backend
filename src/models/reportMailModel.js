const fs = require("fs");
const xlsx = require("xlsx");
const path = require("path");
const nodemailer = require("nodemailer");
const { getConnectionByLocation } = require("../../databaseUtils");

// Create "report" folder in project root if it doesn't exist
const reportsDir = path.join(__dirname, "..", "report"); // ".." goes to project root

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
  "Indore",
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

// Your function to fetch yesterday collections
async function getYesterdayCollections(location) {
  const { connection } = getConnectionByLocation(location);
  if (!connection) throw new Error("Invalid location");

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yyyy = yesterday.getFullYear();
  const mm = String(yesterday.getMonth() + 1).padStart(2, "0");
  const dd = String(yesterday.getDate()).padStart(2, "0");
  const dateStr = `${yyyy}-${mm}-${dd}`;

  // OPD Queries
  const cashQuery = `SELECT COALESCE(SUM(total),0) AS Total FROM patient_itemreceipt WHERE item_date = ? AND payment_mode='Cash' AND is_deleted!=1`;
  const cardQuery = `SELECT COALESCE(SUM(total),0) AS Total FROM patient_itemreceipt WHERE item_date = ? AND payment_mode='Card' AND is_deleted!=1`;
  const onlineQuery = `SELECT COALESCE(SUM(total),0) AS Total FROM patient_itemreceipt WHERE item_date = ? AND payment_mode IN ('Online','UPI') AND is_deleted!=1`;

  // IPD Query
  const ipdQuery = `SELECT COALESCE(SUM(ip.cashamt),0) AS cashamt, COALESCE(SUM(ip.cardamt),0) AS cardamt, COALESCE(SUM(ip.chequeamt),0) AS chequeamt, COALESCE(SUM(ip.onlineamt),0) AS onlineamt FROM ipd_payment ip WHERE ip.receipt_date = ?`;

  const [opdCash] = await executeQuery(connection, cashQuery, [dateStr]);
  const [opdCard] = await executeQuery(connection, cardQuery, [dateStr]);
  const [opdOnline] = await executeQuery(connection, onlineQuery, [dateStr]);
  const [ipdTotals] = await executeQuery(connection, ipdQuery, [dateStr]);

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
  }));

  // Create workbook
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(excelData);
  xlsx.utils.book_append_sheet(wb, ws, "Collections");

  // Generate the full file path
  const fileName = `Yesterday_Collections_${new Date()
    .toISOString()
    .slice(0, 10)}.xlsx`;
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

// Usage
// generateAndSendReport("recipient@example.com")
//   .then(() => console.log("Report generated and emailed successfully"))
//   .catch((err) => console.error("Error:", err));

module.exports = { generateAndSendReport };
