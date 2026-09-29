/**
 * TEMPORARY SCRIPT — Branch-wise Hospital Certificates Excel report
 * ------------------------------------------------------------------
 * Location:  HMS-BackEnd/temp/temp-certificates-report.js
 *
 * Run from the HMS-BackEnd root (or from inside temp/, either works):
 *
 *   node temp/temp-certificates-report.js
 *
 * Optional flags:
 *   --include-closed      also include shut-down branches (Indore, Kalaburagi, Kemps Corner, Kolhapur)
 *   --out=<file.xlsx>     custom output file name (default: saved inside temp/)
 *
 * Optional .env values:
 *   CERTIFICATE_PUBLIC_BASE_URL  public server address used to build links
 *                                (default: http://194.195.117.79:5100, same as the dashboard)
 *   CERTIFICATE_WEB_PREFIX       web path prefix stored in DB (default: /uploads/certificates)
 *   CERTIFICATE_UPLOAD_DIR       same value the backend uses; lets the script verify the file exists on disk
 *
 * Read-only: the script only runs SELECT queries. It never creates tables or changes data.
 *
 * Needs (run once in HMS_backend if missing):  npm install xlsx-js-style
 */

// CommonJS, same as the rest of HMS_backend (databaseUtils / dbconfig use require)
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx-js-style");
const { getConnectionByLocation } = require("../databaseUtils");

const PROJECT_ROOT = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(PROJECT_ROOT, ".env") });

// dbconfig uses the callback-style `mysql` package, so pool.query() does not
// return a promise. Same promise wrapper the models use (makeRunner).
const makeRunner =
  (connection) =>
  (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) =>
        err ? reject(err) : resolve(rows),
      ),
    );

// ---------------------------------------------------------------- date helpers (no external library)
const pad2 = (n) => String(n).padStart(2, "0");

// Local calendar date -> "YYYY-MM-DD"
const ymd = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// Strict "YYYY-MM-DD" -> local-midnight Date (null if invalid)
function parseYmd(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str).slice(0, 10));
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2] - 1, +m[3]];
  const dt = new Date(y, mo, d);
  return dt.getFullYear() === y && dt.getMonth() === mo && dt.getDate() === d
    ? dt
    : null;
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
const addDays = (d, n) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
// Adds months, clamping to the month's last day (31 Aug + 6 months = 28/29 Feb)
function addMonths(d, n) {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(
    target.getFullYear(),
    target.getMonth() + 1,
    0,
  ).getDate();
  return new Date(
    target.getFullYear(),
    target.getMonth(),
    Math.min(d.getDate(), lastDay),
  );
}

// "DD-MM-YYYY_HH-mm"
const fileStamp = (d = new Date()) =>
  `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}_${pad2(d.getHours())}-${pad2(d.getMinutes())}`;
// "DD-MM-YYYY hh:mm AM/PM"
function displayStamp(d = new Date()) {
  const h = d.getHours() % 12 || 12;
  return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(h)}:${pad2(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
}

// ---------------------------------------------------------------- settings
const PUBLIC_BASE_URL = (
  process.env.CERTIFICATE_PUBLIC_BASE_URL || "http://194.195.117.79:5100"
).replace(/\/$/, "");
const WEB_PREFIX = (
  process.env.CERTIFICATE_WEB_PREFIX || "/uploads/certificates"
).replace(/\/$/, "");
const UPLOAD_DIR =
  process.env.CERTIFICATE_UPLOAD_DIR ||
  path.join(PROJECT_ROOT, "uploads", "certificates");

const args = process.argv.slice(2);
const INCLUDE_CLOSED = args.includes("--include-closed");
const outArg = args.find((a) => a.startsWith("--out="));
const OUTPUT_FILE = outArg
  ? path.resolve(outArg.slice(6))
  : path.join(
      __dirname,
      `Hospital_Certificates_Branchwise_${fileStamp()}.xlsx`,
    );

// Same list as the dashboard dropdown (HospitalCertificates.jsx)
const CERTIFICATE_TYPES = [
  "Bio Medical Certificate",
  "Fire NOC",
  "Hospital License",
  "ISO Certificate",
  "NABH Certificate",
  "Pollution Control Certificate",
  "Rent Agreement",
];

// Same list as certificate-expiry-scheduler.js
const SHUTDOWN_LOCATIONS = [
  "indore",
  "kalaburagi",
  "gulbarga",
  "kemps-corner",
  "kemps corner",
  "kolhapur",
];
// Databases that are not clinic branches
const NON_BRANCH_LOCATIONS = ["demo", "demo server", "lead", "ticketing"];

// One key per branch database, exactly as databaseUtils.js getConnectionByLocation()
// accepts them. There is no "demo" DB / location table in this backend, so the
// branch list comes from here. Keys that resolve to the same pool are merged below.
const BRANCH_KEYS = [
  "Adajan",
  "Ahmedabad",
  "Andheri",
  "Aurangabad",
  "Baner",
  "Belagavi",
  "Bopal",
  "Chakan",
  "Chinchwad",
  "Dighi",
  "DP Road",
  "Electronic City",
  "Gurgaon Sector 14",
  "Gurgaon Sector 49",
  "Hadapsar",
  "Hinjewadi",
  "HSR",
  "Hyderabad",
  "Indiranagar",
  "Indore",
  "JP Nagar",
  "Kalaburagi",
  "Kalyan",
  "Katraj",
  "Kemps Corner",
  "Kolhapur",
  "Latur",
  "Lucknow",
  "Ludhiana",
  "Mohali",
  "Mysore",
  "Nashik",
  "Navi Mumbai",
  "Raipur",
  "Rajaji Nagar",
  "RR Nagar",
  "Sahakar Nagar",
  "Salunke Vihar",
  "Sarjapura",
  "Secunderabad",
  "Surat",
  "Thane",
  "Undri",
  "Vashi",
  "Whitefield",
];

const NOT_UPLOADED = "Not yet uploaded";

const isShutdown = (name) =>
  !!name &&
  SHUTDOWN_LOCATIONS.some((l) => name.toLowerCase().trim().includes(l));
const isNonBranch = (name) =>
  !!name && NON_BRANCH_LOCATIONS.includes(name.toLowerCase().trim());

// ---------------------------------------------------------------- helpers
// Same rules as the dashboard's getStatus()
function getStatus(expiry) {
  if (!expiry) return "Active";
  const e = parseYmd(expiry);
  if (!e) return "Active";
  const today = startOfToday();
  const t = e.getTime();
  if (t < today.getTime()) return "Expired";
  if (t === today.getTime()) return "Expiring today";
  if (t === addDays(today, 1).getTime()) return "Expiring tomorrow";
  if (t <= addMonths(today, 6).getTime()) return "Expires soon";
  return "Active";
}

function toPublicUrl(dbPath) {
  if (!dbPath) return null;
  if (/^https?:\/\//i.test(dbPath)) return dbPath;
  const p = dbPath.startsWith("/") ? dbPath : `/${dbPath}`;
  return encodeURI(`${PUBLIC_BASE_URL}${p}`);
}

// Only checks disk when the script runs on the server that holds the uploads folder
const canCheckDisk = fs.existsSync(UPLOAD_DIR);
function fileExistsOnDisk(dbPath) {
  if (!canCheckDisk || !dbPath || /^https?:\/\//i.test(dbPath)) return true;
  if (!dbPath.startsWith(WEB_PREFIX)) return true; // unknown layout, don't guess
  return fs.existsSync(path.join(UPLOAD_DIR, dbPath.slice(WEB_PREFIX.length)));
}

// "YYYY-MM-DD" -> Excel date serial number (so the cell is a real, sortable date)
function toExcelSerial(str) {
  if (!str) return null;
  const d = parseYmd(str);
  if (!d) return null;
  return (
    (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) -
      Date.UTC(1899, 11, 30)) /
    86400000
  );
}

// ---------------------------------------------------------------- data
async function getBranches() {
  const byPool = new Map(); // pool -> { name, aliases[] }

  for (const name of BRANCH_KEYS) {
    const { connection, location } = getConnectionByLocation(name);
    if (!connection) continue;
    const resolved = location || name;
    if (isNonBranch(resolved)) continue;
    if (!INCLUDE_CLOSED && (isShutdown(name) || isShutdown(resolved))) continue;
    if (!byPool.has(connection))
      byPool.set(connection, { name: resolved, pool: connection, aliases: [] });
    byPool.get(connection).aliases.push(name);
  }
  return [...byPool.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function getBranchCertificates(branch) {
  const rows = [];
  let note = null;
  let latestByName = new Map();

  try {
    const run = makeRunner(branch.pool);
    const tables = await run("SHOW TABLES LIKE 'certificates'");
    if (tables.length > 0) {
      const certs = await run(
        `SELECT certificate_id, certificate_name, certificate_path, certificate_expiry
           FROM certificates
          WHERE is_deleted = 0
          ORDER BY certificate_id DESC`,
      );
      for (const c of certs) {
        const key = (c.certificate_name || "").trim();
        if (c.certificate_expiry instanceof Date)
          c.certificate_expiry = ymd(c.certificate_expiry);
        else if (c.certificate_expiry)
          c.certificate_expiry = String(c.certificate_expiry).slice(0, 10);
        if (key && !latestByName.has(key)) latestByName.set(key, c); // newest row wins
      }
    }
  } catch (err) {
    note = `Could not read database: ${err.message}`;
    latestByName = new Map();
  }

  // Standard types first, then any non-standard names that exist in the DB
  const extraNames = [...latestByName.keys()]
    .filter((n) => !CERTIFICATE_TYPES.includes(n))
    .sort();
  for (const certName of [...CERTIFICATE_TYPES, ...extraNames]) {
    const c = latestByName.get(certName);
    if (note) {
      rows.push({
        branch: branch.name,
        certName,
        expiry: null,
        status: "Error",
        url: null,
        urlText: note,
      });
    } else if (!c || !c.certificate_path) {
      rows.push({
        branch: branch.name,
        certName,
        expiry: null,
        status: "Not uploaded",
        url: null,
        urlText: NOT_UPLOADED,
      });
    } else if (!fileExistsOnDisk(c.certificate_path)) {
      rows.push({
        branch: branch.name,
        certName,
        expiry: c.certificate_expiry,
        status: "File missing",
        url: null,
        urlText: `${NOT_UPLOADED} (record exists, file missing on server)`,
      });
    } else {
      rows.push({
        branch: branch.name,
        certName,
        expiry: c.certificate_expiry,
        status: getStatus(c.certificate_expiry),
        url: toPublicUrl(c.certificate_path),
        urlText: null,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------- excel (xlsx-js-style)
const COLORS = {
  brandDark: "007C91",
  brand: "00ACC1",
  headerFill: "B2EBF2",
  subtitleFill: "E0F7FA",
  bandA: "FFFFFF",
  bandB: "F1FBFD",
  border: "90CAF9",
  link: "0563C1",
  missing: "C62828",
};
const STATUS_STYLE = {
  Active: { fill: "E8F5E9", font: "2E7D32" },
  "Expires soon": { fill: "FFF3E0", font: "E65100" },
  "Expiring tomorrow": { fill: "FFEBEE", font: "C62828" },
  "Expiring today": { fill: "FFEBEE", font: "C62828" },
  Expired: { fill: "FFEBEE", font: "C62828" },
  "Not uploaded": { fill: "ECEFF1", font: "546E7A" },
  "File missing": { fill: "ECEFF1", font: "C62828" },
  Error: { fill: "FFF8E1", font: "F57F17" },
};

const thin = { style: "thin", color: { rgb: COLORS.border } };
const medium = { style: "medium", color: { rgb: COLORS.brandDark } };
const allThin = { top: thin, left: thin, bottom: thin, right: thin };
const fill = (rgb) => ({ patternType: "solid", fgColor: { rgb } });
const font = (opts = {}) => ({ name: "Calibri", sz: 11, ...opts });

const addr = (r, c) => XLSX.utils.encode_cell({ r, c }); // 0-based
const colLetter = (c) => XLSX.utils.encode_col(c); // 0-based

// Cell builders
const strCell = (v, s) => ({ t: "s", v: v == null ? "" : String(v), s });
const numCell = (v, s, z) => ({ t: "n", v, s, ...(z ? { z } : {}) });
const fmlCell = (f, v, s, z) => ({ t: "n", f, v, s, ...(z ? { z } : {}) });

function newSheet() {
  return { "!merges": [], "!rows": [], "!cols": [], _maxR: 0, _maxC: 0 };
}
function put(ws, r, c, cell) {
  ws[addr(r, c)] = cell;
  ws._maxR = Math.max(ws._maxR, r);
  ws._maxC = Math.max(ws._maxC, c);
}
function finishSheet(ws) {
  ws["!ref"] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: ws._maxR, c: ws._maxC },
  });
  delete ws._maxR;
  delete ws._maxC;
  return ws;
}

function addTitle(ws, title, lastCol, subtitle) {
  // lastCol is 1-based (as in the original), converted to 0-based here
  const lc = lastCol - 1;
  const titleStyle = {
    font: font({ sz: 16, bold: true, color: { rgb: "FFFFFF" } }),
    fill: fill(COLORS.brandDark),
    alignment: { horizontal: "center", vertical: "center" },
  };
  const subStyle = {
    font: font({ sz: 10, italic: true, color: { rgb: "37474F" } }),
    fill: fill(COLORS.subtitleFill),
    alignment: { horizontal: "center", vertical: "center" },
  };
  for (let c = 0; c <= lc; c++) {
    put(ws, 0, c, strCell(c === 0 ? title : "", titleStyle));
    put(ws, 1, c, strCell(c === 0 ? subtitle : "", subStyle));
  }
  ws["!merges"].push({ s: { r: 0, c: 0 }, e: { r: 0, c: lc } });
  ws["!merges"].push({ s: { r: 1, c: 0 }, e: { r: 1, c: lc } });
  ws["!rows"][0] = { hpt: 30 };
  ws["!rows"][1] = { hpt: 18 };
}

function writeHeader(ws, r, labels) {
  const style = {
    font: font({ bold: true, color: { rgb: "000000" } }),
    fill: fill(COLORS.headerFill),
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
    border: { top: medium, left: thin, bottom: medium, right: thin },
  };
  labels.forEach((label, c) => put(ws, r, c, strCell(label, style)));
  ws["!rows"][r] = { hpt: 22 };
}

function buildDetailSheet(rows, subtitle) {
  const ws = newSheet();
  ws["!cols"] = [
    { wch: 7 },
    { wch: 20 },
    { wch: 32 },
    { wch: 14 },
    { wch: 18 },
    { wch: 90 },
  ];
  addTitle(
    ws,
    "Healing Hands Clinic — Hospital Certificates (Branch-wise)",
    6,
    subtitle,
  );

  const HEADER_ROW = 2; // 0-based → Excel row 3
  writeHeader(ws, HEADER_ROW, [
    "Sr No",
    "Branch",
    "Certificate Name",
    "Expiry Date",
    "Status",
    "Certificate URL",
  ]);

  let band = false;
  let prevBranch = null;
  rows.forEach((r, i) => {
    const isNewBranch = r.branch !== prevBranch;
    if (isNewBranch) band = !band;
    prevBranch = r.branch;

    const R = HEADER_ROW + 1 + i;
    const bg = band ? COLORS.bandA : COLORS.bandB;
    const border = {
      ...allThin,
      ...(isNewBranch && i > 0 ? { top: medium } : {}),
    };
    const base = (col, extra = {}) => ({
      font: font(),
      fill: fill(bg),
      border,
      alignment: {
        vertical: "center",
        horizontal: col === 5 || col === 2 ? "left" : "center",
      },
      ...extra,
    });

    // Sr No
    put(ws, R, 0, numCell(i + 1, base(0)));
    // Branch
    put(
      ws,
      R,
      1,
      strCell(
        r.branch,
        base(1, {
          font: font({ bold: true, color: { rgb: COLORS.brandDark } }),
        }),
      ),
    );
    // Certificate Name
    put(ws, R, 2, strCell(r.certName, base(2)));
    // Expiry Date
    const serial = toExcelSerial(r.expiry);
    put(
      ws,
      R,
      3,
      serial != null
        ? numCell(serial, base(3), "dd-mm-yyyy")
        : strCell("-", base(3)),
    );
    // Status
    const st = STATUS_STYLE[r.status] || STATUS_STYLE["Not uploaded"];
    put(
      ws,
      R,
      4,
      strCell(
        r.status,
        base(4, {
          fill: fill(st.fill),
          font: font({ bold: true, color: { rgb: st.font } }),
        }),
      ),
    );
    // Certificate URL
    if (r.url) {
      const cell = strCell(
        r.url,
        base(5, {
          font: font({ color: { rgb: COLORS.link }, underline: true }),
        }),
      );
      cell.l = { Target: r.url, Tooltip: `Open ${r.certName} (${r.branch})` };
      put(ws, R, 5, cell);
    } else {
      put(
        ws,
        R,
        5,
        strCell(
          r.urlText,
          base(5, {
            font: font({
              italic: true,
              bold: true,
              color: { rgb: COLORS.missing },
            }),
          }),
        ),
      );
    }
    ws["!rows"][R] = { hpt: 18 };
  });

  ws["!autofilter"] = { ref: `A3:F${3 + rows.length}` };
  return finishSheet(ws);
}

function buildSummarySheet(branches, rows, subtitle) {
  const ws = newSheet();
  const certCols = CERTIFICATE_TYPES.length;
  const lastCol = 2 + certCols + 4; // 1-based, as in the original
  addTitle(ws, "Certificate Upload Summary — All Branches", lastCol, subtitle);

  const HEADER_ROW = 2;
  writeHeader(ws, HEADER_ROW, [
    "Sr No",
    "Branch",
    ...CERTIFICATE_TYPES,
    "Uploaded",
    "Not Yet Uploaded",
    "Expired",
    "Completion %",
  ]);

  ws["!cols"][0] = { wch: 7 };
  ws["!cols"][1] = { wch: 20 };
  for (let c = 2; c < 2 + certCols; c++) ws["!cols"][c] = { wch: 16 };
  for (let c = 2 + certCols; c < lastCol; c++) ws["!cols"][c] = { wch: 13 };

  // 0-based column indexes of the count columns
  const cUploaded = 2 + certCols;
  const cNotUp = cUploaded + 1;
  const cExpired = cUploaded + 2;
  const cPct = cUploaded + 3;
  const firstCertL = colLetter(2);
  const lastCertL = colLetter(1 + certCols);

  const firstDataExcelRow = 4;
  const totals = { uploaded: 0, notUp: 0, expired: 0 };

  branches.forEach((b, i) => {
    const R = HEADER_ROW + 1 + i; // 0-based
    const rowNum = firstDataExcelRow + i; // Excel row number
    const bg = i % 2 === 0 ? COLORS.bandA : COLORS.bandB;
    const cellStyle = (extra = {}) => ({
      border: allThin,
      alignment: { horizontal: "center", vertical: "center" },
      font: font({ sz: 10 }),
      fill: fill(bg),
      ...extra,
    });

    const branchRows = rows.filter(
      (r) => r.branch === b.name && CERTIFICATE_TYPES.includes(r.certName),
    );
    const cells = CERTIFICATE_TYPES.map((t) => {
      const r = branchRows.find((x) => x.certName === t);
      if (!r || r.status === "Not uploaded" || r.status === "File missing")
        return "Not uploaded";
      return r.status;
    });

    put(ws, R, 0, numCell(i + 1, cellStyle()));
    put(
      ws,
      R,
      1,
      strCell(
        b.name,
        cellStyle({
          font: font({ bold: true, color: { rgb: COLORS.brandDark } }),
        }),
      ),
    );
    cells.forEach((v, k) => {
      const st = STATUS_STYLE[v] || STATUS_STYLE["Not uploaded"];
      put(
        ws,
        R,
        2 + k,
        strCell(
          v,
          cellStyle({
            fill: fill(st.fill),
            font: font({ sz: 10, bold: true, color: { rgb: st.font } }),
          }),
        ),
      );
    });

    // Same formulas as before; cached values computed here so they show even before Excel recalculates
    const notUp = cells.filter((v) => v === "Not uploaded").length;
    const errors = cells.filter((v) => v === "Error").length;
    const expired = cells.filter((v) => v === "Expired").length;
    const uploaded = certCols - notUp - errors;
    totals.uploaded += uploaded;
    totals.notUp += notUp;
    totals.expired += expired;

    const certRange = `${firstCertL}${rowNum}:${lastCertL}${rowNum}`;
    const countStyle = cellStyle({ font: font({ bold: true }) });
    put(
      ws,
      R,
      cUploaded,
      fmlCell(
        `${certCols}-COUNTIF(${certRange},"Not uploaded")-COUNTIF(${certRange},"Error")`,
        uploaded,
        countStyle,
      ),
    );
    put(
      ws,
      R,
      cNotUp,
      fmlCell(`COUNTIF(${certRange},"Not uploaded")`, notUp, countStyle),
    );
    put(
      ws,
      R,
      cExpired,
      fmlCell(`COUNTIF(${certRange},"Expired")`, expired, countStyle),
    );
    put(
      ws,
      R,
      cPct,
      fmlCell(
        `${colLetter(cUploaded)}${rowNum}/${certCols}`,
        uploaded / certCols,
        countStyle,
        "0%",
      ),
    );
    ws["!rows"][R] = { hpt: 18 };
  });

  // Grand total row
  const lastDataExcelRow = firstDataExcelRow + branches.length - 1;
  const totalR = HEADER_ROW + 1 + branches.length;
  const totalExcelRow = lastDataExcelRow + 1;
  const totalStyle = {
    font: font({ bold: true, color: { rgb: "FFFFFF" } }),
    fill: fill(COLORS.brand),
    alignment: { horizontal: "center", vertical: "center" },
    border: { top: medium, left: thin, bottom: medium, right: thin },
  };
  put(ws, totalR, 0, strCell("", totalStyle));
  put(ws, totalR, 1, strCell("TOTAL", totalStyle));
  for (let c = 2; c < cUploaded; c++)
    put(ws, totalR, c, strCell("", totalStyle));
  const sumF = (c) =>
    `SUM(${colLetter(c)}${firstDataExcelRow}:${colLetter(c)}${lastDataExcelRow})`;
  put(
    ws,
    totalR,
    cUploaded,
    fmlCell(sumF(cUploaded), totals.uploaded, totalStyle),
  );
  put(ws, totalR, cNotUp, fmlCell(sumF(cNotUp), totals.notUp, totalStyle));
  put(
    ws,
    totalR,
    cExpired,
    fmlCell(sumF(cExpired), totals.expired, totalStyle),
  );
  const totalSlots = branches.length * certCols;
  put(
    ws,
    totalR,
    cPct,
    fmlCell(
      `IFERROR(${colLetter(cUploaded)}${totalExcelRow}/(${branches.length}*${certCols}),0)`,
      totalSlots ? totals.uploaded / totalSlots : 0,
      totalStyle,
      "0%",
    ),
  );
  ws["!rows"][totalR] = { hpt: 22 };

  // Legend (one blank row after the total)
  let R = totalR + 2;
  put(ws, R, 1, strCell("Legend", { font: font({ bold: true }) }));
  ["Active", "Expires soon", "Expired", "Not uploaded"].forEach((s) => {
    R += 1;
    put(
      ws,
      R,
      1,
      strCell(s, {
        fill: fill(STATUS_STYLE[s].fill),
        font: font({ bold: true, color: { rgb: STATUS_STYLE[s].font } }),
        border: allThin,
        alignment: { horizontal: "center" },
      }),
    );
  });
  R += 1;
  put(
    ws,
    R,
    1,
    strCell(
      '"Expires soon" = expiry within the next 6 months (same rule as the HMS dashboard).',
      {
        font: font({ italic: true, sz: 9, color: { rgb: "78909C" } }),
      },
    ),
  );

  return finishSheet(ws);
}

// ---------------------------------------------------------------- main
async function main() {
  console.log("Fetching branch list...");
  const branches = await getBranches();
  if (branches.length === 0) {
    console.log("No branches found.");
    return;
  }

  const allRows = [];
  for (const b of branches) {
    process.stdout.write(`  • ${b.name.padEnd(22)}`);
    const rows = await getBranchCertificates(b);
    const uploaded = rows.filter((r) => r.url).length;
    console.log(
      rows[0]?.status === "Error"
        ? "ERROR (see sheet)"
        : `${uploaded}/${rows.length} uploaded`,
    );
    allRows.push(...rows);
  }

  const subtitle =
    `Generated on ${displayStamp()}  •  ${branches.length} branches` +
    `${INCLUDE_CLOSED ? " (including closed branches)" : ""}` +
    `${canCheckDisk ? "  •  File presence verified on server" : ""}`;

  const wb = XLSX.utils.book_new();
  wb.Props = { Author: "HMS Dashboard", CreatedDate: new Date() };
  XLSX.utils.book_append_sheet(
    wb,
    buildDetailSheet(allRows, subtitle),
    "Branch-wise Certificates",
  );
  XLSX.utils.book_append_sheet(
    wb,
    buildSummarySheet(branches, allRows, subtitle),
    "Summary",
  );

  XLSX.writeFile(wb, OUTPUT_FILE, { bookType: "xlsx", cellStyles: true });

  const uploaded = allRows.filter((r) => r.url).length;
  console.log(
    `\nDone. ${uploaded} of ${allRows.length} certificate slots have a file.`,
  );
  console.log(`Saved: ${OUTPUT_FILE}\n`);
}

main()
  .catch((err) => {
    console.error("\nReport failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    // DB pools keep the process alive — exit explicitly
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  });
