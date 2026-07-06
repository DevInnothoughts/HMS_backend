const fs = require("fs");
const xlsx = require("xlsx");
const path = require("path");
const nodemailer = require("nodemailer");
const { getConnectionByLocation } = require("../../databaseUtils");

// Create "report" folder in project root if it doesn't exist
const reportsDir = path.join(__dirname, "..", "report"); // ".." goes to project root

// IPD Due report email recipient (hardcoded by design).
// TODO: replace with the real distribution address.
const IPD_DUE_RECIPIENT = "healinghandsclinicacc@gmail.com"; //"shubham.khatod17594@gmail.com";

// Allowed invoice statuses for the IPD Due filter. Anything falsy or "All"
// means no status filter (every due invoice).
const IPD_DUE_STATUSES = [
  "Cashless",
  "Reimbursement",
  "Charity",
  "NonInsurance",
  "PDC",
];

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
  "Ahmedabad",
  "Mohali",
  "Aurangabad",
  "Whitefield",
  "Hadapsar",
  "Kalyan",
  "Bopal",
  "Electronic City",
];

async function getQueryResult(loc, fromDate, toDate) {
  const { connection } = getConnectionByLocation(loc);

  if (!connection) {
    throw new Error(`Invalid location: ${loc}`);
  }

  const executeQ = (query, values = []) =>
    new Promise((resolve, reject) =>
      connection.query(query, values, (err, results) => {
        if (err) return reject(err);
        resolve(results);
      }),
    );

  const ipdInvoiceRows = await executeQ(
    `
    SELECT 
      p.name,
      p.Uid_no,
      p.phone,
      i.ratingInfo,
      i.creation_date
    FROM invoice i
    LEFT JOIN patient p 
      ON i.patient_id = p.patient_id
    WHERE i.creation_date >= ? 
      AND i.creation_date <= ?
      AND i.ratingInfo IS NOT NULL
      AND i.is_deleted != 1
    `,
    [`${fromDate} 00:00:00`, `${toDate} 23:59:59`],
  );

  // Add branch/location in each row
  return ipdInvoiceRows.map((row) => ({
    location: loc,
    patient_name: row.name,
    uhid: row.Uid_no,
    phone: row.phone,
    ratingInfo: row.ratingInfo,
  }));
}

async function generateNPSReport(fromDate, toDate) {
  let finalRows = [];

  for (const loc of locations) {
    try {
      const data = await getQueryResult(loc, fromDate, toDate);

      // Merge rows
      finalRows = [...finalRows, ...data];
    } catch (err) {
      console.error(`Error for ${loc}:`, err.message);
    }
  }

  // Create workbook
  const wb = xlsx.utils.book_new();

  // Create worksheet from flat array
  const ws = xlsx.utils.json_to_sheet(finalRows, {
    header: ["location", "patient_name", "uhid", "phone", "ratingInfo"],
  });

  // Append sheet
  xlsx.utils.book_append_sheet(wb, ws, "NPS Report");

  // File path
  const fileName = `NPS_Report_${fromDate}_to_${toDate}.xlsx`;
  const filePath = path.join(reportsDir, fileName);

  // Write file
  xlsx.writeFile(wb, filePath);

  console.log("Excel file created:", filePath);

  return {
    success: true,
    filePath,
    totalRecords: finalRows.length,
  };
}

// ============================================================
// MYSQL QUERY HELPER
// ============================================================

function executeQuery(connection, query, values = []) {
  return new Promise((resolve, reject) => {
    connection.query(query, values, (err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
}

// ============================================================
// SAFE JSON PARSER
// ============================================================

const safeParseJSON = (data) => {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
};

// ============================================================
// EVITAL CARD COUNT
// ============================================================

async function getEvitalCardCount(location, from, to) {
  const { connection } = getConnectionByLocation(location);

  if (!connection) return 0;

  const fromDate = `${from} 00:00:00`;
  const toDate = `${to} 23:59:59`;

  const rows = await executeQuery(
    connection,
    `
      SELECT invoice_details, UpdatedInvoiceDetails
      FROM evital_pharmacy_invoice
      WHERE STR_TO_DATE(
        JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.bill_date')),
        '%Y-%m-%d %H:%i:%s'
      ) BETWEEN ? AND ?
    `,
    [fromDate, toDate],
  );

  let cardCount = 0;

  const normalizeMode = (mode = "") => {
    switch (mode) {
      case "CC/DC":
      case "Credit":
      case "Card":
        return "Card";

      default:
        return mode;
    }
  };

  rows.forEach((row) => {
    // ========================================================
    // UPDATED PAYMENT DETAILS
    // ========================================================

    if (row.UpdatedInvoiceDetails) {
      const updated = safeParseJSON(row.UpdatedInvoiceDetails);

      const transactions = updated?.transaction_summary?.transactions || [];

      const hasCard = transactions.some(
        (txn) => normalizeMode(txn.method) === "Card",
      );

      if (hasCard) {
        cardCount++;
      }

      return;
    }

    // ========================================================
    // ORIGINAL PAYMENT MODE
    // ========================================================

    const invoice = safeParseJSON(row.invoice_details);

    if (!invoice) return;

    const mode = normalizeMode(invoice.payment_mode);

    if (mode === "Card") {
      cardCount++;
    }
  });

  return cardCount;
}

// ============================================================
// MAIN COLLECTION FUNCTION
// ============================================================

// module scope — single source of truth, order matches the pivot
const AGING_BUCKETS = [
  "Upto 30 days",
  "30-60 days",
  "60-90 days",
  "90 - 180 days",
  "180 - 365 days",
  "365 - 730 days",
  "> 730 days",
];

async function getCollections(location, from, to, statusFilter = null) {
  const { connection } = getConnectionByLocation(location);

  if (!connection) {
    const err = new Error(`Invalid location: ${location}`);
    err.status = 404;
    throw err;
  }

  const rows = await new Promise((resolve, reject) => {
    connection.getConnection((err, tempCon) => {
      if (err) return reject(err);

      // Optional status filter — omitted by default so all due invoices
      // (any status) are included.
      const statusClause = statusFilter ? `AND i.status = ?` : ``;

      const sql = `
        SELECT
            p.patient_id,
            p.name,
            i.invoice_id,
            i.status,
            i.creation_date,
            i.totalamt,
            i.totaldue,
            DATEDIFF(CURDATE(), i.creation_date) AS aging_days,
           CASE
  WHEN DATEDIFF(CURDATE(), i.creation_date) > 730 THEN '> 730 days'
  WHEN DATEDIFF(CURDATE(), i.creation_date) > 365 THEN '365 - 730 days'
  WHEN DATEDIFF(CURDATE(), i.creation_date) > 180 THEN '180 - 365 days'
  WHEN DATEDIFF(CURDATE(), i.creation_date) > 90  THEN '90 - 180 days'
  WHEN DATEDIFF(CURDATE(), i.creation_date) > 60  THEN '60-90 days'
  WHEN DATEDIFF(CURDATE(), i.creation_date) > 30  THEN '30-60 days'
  ELSE 'Upto 30 days'
END AS aging_bucket
        FROM patient p
        JOIN invoice i ON p.patient_id = i.patient_id
        WHERE i.totaldue > 0
          ${statusClause}
          AND i.creation_date >= ?
          AND i.creation_date <= ?
        ORDER BY aging_days DESC, i.creation_date
      `;

      const params = statusFilter ? [statusFilter, from, to] : [from, to];

      tempCon.query(sql, params, (error, result) => {
        tempCon.release(); // always release, even on error
        if (error) return reject(error);
        resolve(result);
      });
    });
  });

  // Bucket summary (oldest first) — totals per aging bucket
  const groupedPatients = {};
  for (const b of AGING_BUCKETS) {
    groupedPatients[b] = { patients: [], totalDue: 0 };
  }

  rows.forEach((row) => {
    const bucket = groupedPatients[row.aging_bucket];
    if (bucket) {
      bucket.patients.push(row);
      bucket.totalDue += Number(row.totaldue) || 0;
    }
  });

  return {
    location,
    pdc: rows, // flat rows, each carrying aging_days + aging_bucket
    summary: groupedPatients, // per-bucket totals
  };
}

// ============================================================
// GENERATE EXCEL + SEND EMAIL
// ============================================================

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// One row per location: { Location, <each aging bucket>, Grand Total },
// sorted by Grand Total desc, with a Grand Total footer row.
function buildLocationSummary(allData) {
  const rows = allData.map((d) => {
    const row = { Location: d.location };
    AGING_BUCKETS.forEach((b) => (row[b] = 0));
    let grand = 0;

    for (const r of d.pdc || []) {
      const due = Number(r.totaldue) || 0;
      if (row[r.aging_bucket] !== undefined) row[r.aging_bucket] += due;
      grand += due;
    }
    AGING_BUCKETS.forEach((b) => (row[b] = round2(row[b])));
    row["Grand Total"] = round2(grand);
    return row;
  });

  rows.sort((a, b) => b["Grand Total"] - a["Grand Total"]);

  const totalRow = { Location: "Grand Total" };
  [...AGING_BUCKETS, "Grand Total"].forEach((col) => {
    totalRow[col] = round2(rows.reduce((s, r) => s + (r[col] || 0), 0));
  });
  rows.push(totalRow);

  // Blank out zero cells in bucket columns to match the pivot's look
  return rows.map((r) => {
    const out = { ...r };
    AGING_BUCKETS.forEach((b) => {
      if (!out[b]) out[b] = "";
    });
    return out;
  });
}

// Flatten one detail row per invoice, with friendly headers.
function buildDetailRows(allData) {
  return allData.flatMap((d) =>
    (d.pdc || []).map((row) => ({
      Location: d.location,
      "Patient ID": row.patient_id,
      Name: row.name,
      "Invoice ID": row.invoice_id,
      Status: row.status,
      "Creation Date": row.creation_date,
      "Total Amount": row.totalamt,
      "Total Due": row.totaldue,
      "Aging Days": row.aging_days,
      "Aging Bucket": row.aging_bucket,
    })),
  );
}

async function generateReport(from, to) {
  try {
    const allData = [];

    for (const location of locations) {
      try {
        console.log(`Processing ${location}...`);

        // Legacy "Cashless" report keeps its original status filter.
        const data = await getCollections(location, from, to, "Cashless");

        allData.push(data);
      } catch (err) {
        console.log(`❌ Error in ${location}`);
        console.log(err.message);
      }
    }

    // ========================================================
    // EXCEL DATA — flatten one row per invoice
    // ========================================================

    const excelData = allData.flatMap((d) =>
      (d.pdc || []).map((row) => ({
        Location: d.location,
        "Patient ID": row.patient_id,
        Name: row.name,
        "Invoice ID": row.invoice_id,
        Status: row.status,
        "Creation Date": row.creation_date,
        "Total Amount": row.totalamt,
        "Total Due": row.totaldue,
        "Aging Days": row.aging_days,
        "Aging Bucket": row.aging_bucket,
      })),
    );

    // ========================================================
    // CREATE EXCEL
    // ========================================================

    const workbook = xlsx.utils.book_new();
    // ── Sheet 1: detailed PDC list (existing) ──
    const worksheet = xlsx.utils.json_to_sheet(excelData);
    xlsx.utils.book_append_sheet(workbook, worksheet, "Cashless Report");

    // ── Sheet 2: location-wise aging summary (pivot) ──
    const summaryRows = buildLocationSummary(allData);
    const summaryHeader = ["Location", ...AGING_BUCKETS, "Grand Total"];
    const summarySheet = xlsx.utils.json_to_sheet(summaryRows, {
      header: summaryHeader, // forces column order
    });
    xlsx.utils.book_append_sheet(workbook, summarySheet, "Location Summary");

    const fileName = `Cashless_${from}_to_${to}.xlsx`;
    const filePath = path.join(reportsDir, fileName);

    xlsx.writeFile(workbook, filePath);

    console.log("✅ Excel Generated:", filePath);

    return { success: true, filePath };
  } catch (error) {
    console.log("❌ Report Generation Failed");
    console.log(error);

    return { success: false, error: error.message };
  }
}

// ============================================================
// IPD DUE REPORT (authorized-branch scoped, date range)
// ============================================================
// Branch-wise list of invoices with outstanding due (totaldue > 0) for a
// date range, plus a location-wise aging summary. `requestedLocations` is the
// list of branches the signed-in user is allowed to see (from the app's redux
// state); it is intersected with the master `locations` list. `statusFilter`
// optionally restricts to one invoice status; falsy/"All" means no filter.
async function buildIPDDueData(from, to, requestedLocations, statusFilter) {
  if (!from || !to) {
    const err = new Error("from and to are required (YYYY-MM-DD)");
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

  // Normalize the status filter: treat empty/"All" as no filter; otherwise it
  // must be one of the allowed statuses.
  let status = null;
  if (statusFilter && statusFilter !== "All") {
    if (!IPD_DUE_STATUSES.includes(statusFilter)) {
      const err = new Error(`Invalid status: ${statusFilter}`);
      err.status = 400;
      throw err;
    }
    status = statusFilter;
  }

  const settled = await Promise.all(
    allowed.map(async (loc) => {
      try {
        return { ok: true, data: await getCollections(loc, from, to, status) };
      } catch (err) {
        console.error(`IPD Due error for ${loc}:`, err.message);
        return { ok: false, location: loc, error: err.message };
      }
    }),
  );

  const allData = settled.filter((s) => s.ok).map((s) => s.data);
  const failed = settled
    .filter((s) => !s.ok)
    .map((s) => ({ location: s.location, error: s.error }));

  if (!allData.length) {
    const err = new Error("No data could be generated for any branch");
    err.status = 502;
    throw err;
  }

  const detail = buildDetailRows(allData);
  const summary = buildLocationSummary(allData);
  const summaryHeader = ["Location", ...AGING_BUCKETS, "Grand Total"];

  return {
    from,
    to,
    status: status || "All",
    branchesProcessed: allData.length,
    branchesRequested: allowed.length,
    failed,
    detail,
    summary,
    summaryHeader,
  };
}

// Data-only path (for in-app download): returns the rows as JSON.
async function getIPDDueData(from, to, requestedLocations, statusFilter) {
  return await buildIPDDueData(from, to, requestedLocations, statusFilter);
}

// Email path: builds the two-sheet workbook on the server and emails it.
async function generateIPDDueEmail(
  from,
  to,
  requestedLocations,
  statusFilter,
  toEmail = IPD_DUE_RECIPIENT,
) {
  const {
    detail,
    summary,
    summaryHeader,
    branchesProcessed,
    branchesRequested,
    failed,
    status,
  } = await buildIPDDueData(from, to, requestedLocations, statusFilter);

  const workbook = xlsx.utils.book_new();
  const ws1 = xlsx.utils.json_to_sheet(detail);
  xlsx.utils.book_append_sheet(workbook, ws1, "IPD Due Report");
  const ws2 = xlsx.utils.json_to_sheet(summary, { header: summaryHeader });
  xlsx.utils.book_append_sheet(workbook, ws2, "Location Summary");

  // Date-only labels for the filename/subject — `to` may carry a time
  // component (e.g. "2024-09-01 23:59:59") for the SQL filter, and ":" is an
  // illegal filename character on Windows.
  const fromLabel = String(from).slice(0, 10);
  const toLabel = String(to).slice(0, 10);

  const fileName = `IPD_Due_${status}_${fromLabel}_to_${toLabel}.xlsx`;
  const filePath = path.join(reportsDir, fileName);
  xlsx.writeFile(workbook, filePath);

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
    subject: `IPD Due Report (${status}) — ${fromLabel} to ${toLabel}`,
    text:
      `Attached: branch-wise IPD due (outstanding) report for ${fromLabel} to ${toLabel}, ` +
      `status: ${status} ` +
      `(${branchesProcessed} of ${branchesRequested} branches, ${detail.length} invoices).`,
    attachments: [{ filename: path.basename(filePath), path: filePath }],
  });

  return {
    success: true,
    from,
    to,
    status,
    sentTo: toEmail,
    branchesProcessed,
    branchesRequested,
    invoices: detail.length,
    failed,
    messageId: info.messageId,
  };
}

//Function to export patient history data for given locations
async function getPatientHistoryByLocation(location, fromDate, toDate) {
  const { connection } = getConnectionByLocation(location);

  if (!connection) {
    throw new Error(`Invalid location: ${location}`);
  }

  const query = `
  SELECT
  p.Uid_no,
  p.name,
  p.sex,
  p.phone,
  ph.patient_date,
  ph.symptoms,
  ph.family_history,
  ph.general_history,
  ph.past_history,
  d.medical_mx,
i.creation_date AS SurgeryDate
FROM patient_history ph
INNER JOIN patient p
  ON p.patient_id = ph.patient_id
LEFT JOIN diagnosis d
  ON d.patient_id = ph.patient_id
LEFT JOIN invoice i
  ON i.patient_id = ph.patient_id
WHERE ph.patient_date BETWEEN ? AND ?
  AND (
    COALESCE(TRIM(ph.family_history), '') <> ''
    OR COALESCE(TRIM(ph.general_history), '') <> ''
    OR COALESCE(TRIM(ph.past_history), '') <> ''
  )
ORDER BY ph.patient_date DESC
`;

  const rows = await executeQuery(connection, query, [fromDate, toDate]);

  return rows.map((row) => ({
    Location: location,
    UID: row.Uid_no,
    Name: row.name,
    Gender: row.sex,
    Phone: row.phone,
    PatientDate: row.patient_date,
    SurgeryDate: row.SurgeryDate || "",
    Symptoms: row.symptoms,
    FamilyHistory: row.family_history,
    GeneralHistory: row.general_history,
    PastHistory: row.past_history,
    TestAdvised: row.medical_mx,
  }));
}

async function generatePatientHistoryReport(
  fromDate,
  toDate,
  requestedLocations,
) {
  if (!fromDate || !toDate) {
    throw new Error("fromDate and toDate are required");
  }

  const allowedLocations =
    Array.isArray(requestedLocations) && requestedLocations.length
      ? requestedLocations.filter((loc) => locations.includes(loc))
      : [];

  if (!allowedLocations.length) {
    throw new Error("No valid locations provided");
  }

  const settledResults = await Promise.allSettled(
    allowedLocations.map((location) =>
      getPatientHistoryByLocation(location, fromDate, toDate),
    ),
  );

  const consolidatedRows = [];
  const failedLocations = [];

  settledResults.forEach((result, index) => {
    if (result.status === "fulfilled") {
      consolidatedRows.push(...result.value);
    } else {
      failedLocations.push({
        location: allowedLocations[index],
        error: result.reason?.message || "Unknown Error",
      });
    }
  });

  const workbook = xlsx.utils.book_new();

  const worksheet = xlsx.utils.json_to_sheet(consolidatedRows);

  xlsx.utils.book_append_sheet(workbook, worksheet, "Patient History");

  const fileName = `Patient_History_${fromDate}_to_${toDate}.xlsx`;

  const filePath = path.join(reportsDir, fileName);

  xlsx.writeFile(workbook, filePath);

  return {
    success: true,
    filePath,
    totalRecords: consolidatedRows.length,
    locationsProcessed: allowedLocations.length - failedLocations.length,
    locationsRequested: allowedLocations.length,
    failedLocations,
  };
}

module.exports = {
  generateNPSReport,
  generateReport,
  getIPDDueData,
  generateIPDDueEmail,
  generatePatientHistoryReport,
};
