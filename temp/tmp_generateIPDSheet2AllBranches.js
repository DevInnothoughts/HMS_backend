/**
 * tmp_generateIPDSheet2AllBranches.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * Report Center → Reports → IPD · Sheet 2, for ALL branches at once,
 * 1 April → today (override with arguments).
 *
 * ── Same data as the app ────────────────────────────────────────────────────
 * Every branch is read through reportModel.getReport with
 * { reportType: "IPD", sheetType: "Sheet2" } — exactly what the Reports tab
 * calls — and with the same date bounds the app sends:
 *     from = 'YYYY-MM-DD'            to = 'YYYY-MM-DD 23:59:59'
 * so the last day is included whole. It returns two independent sets, each
 * filtered on its own date column:
 *     Patient Payments        ipd_payment.receipt_date
 *     Insurance Settlements   insurance_invoice.paymentdate
 *
 * ── Workbook ────────────────────────────────────────────────────────────────
 *     Summary                 one row per branch: payment count, Cash / Card /
 *                             Cheque / Online, total collected, discount,
 *                             internal discount; settlement count, settled,
 *                             TDS; patient + insurance collected — and a TOTAL
 *     Patient Payments        every branch's rows in one table (Branch first),
 *                             same columns and headers as the app's sheet
 *     Insurance Settlements   likewise
 * Headers use the app's labels ("Receipt Date", "Int. Disc.", "UTR No" …).
 * "Interbranch Location" appears only if some row has one, as in the app.
 *
 * ── Connection resilience (built in) ─────────────────────────────────────────
 * All branch DBs share one MySQL host: 30 s connect timeout, at most 4 queries
 * in flight (REPORT_DB_CONCURRENCY), retries on handshake / network timeouts,
 * and a SELECT 1 check first. A branch that still fails is listed on the
 * Summary — never shown as ₹0. No file is written if every branch fails.
 *
 * ── Place in temp/ and run ───────────────────────────────────────────────────
 *   node temp/tmp_generateIPDSheet2AllBranches.js
 *   node temp/tmp_generateIPDSheet2AllBranches.js 2026-04-01 2026-10-08
 *   node temp/tmp_generateIPDSheet2AllBranches.js 2026-04-01 2026-10-08 "Thane,Andheri"
 *
 * Requires xlsx-js-style (as the due-aging report does).
 *
 * ── Output ──────────────────────────────────────────────────────────────────
 *   src/report/IPD_Sheet2_AllBranches_<from>_to_<to>.xlsx
 *
 * ⚠️ Contains patient names. Share only over approved channels; delete the
 *    script and the file when done.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx-js-style");

const { getReport } = require("../src/models/reportModel");
const { getConnectionByLocation } = require("../databaseUtils");

/* ── Config ──────────────────────────────────────────────────────────────── */

// Same branch set as the other all-branch temp reports. Edit to taste, or pass
// a comma-separated list as the third argument.
const ALL_LOCATIONS = [
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
  "Latur",
  "Ludhiana",
  "Lucknow",
  "Mysore",
  "Nashik",
  "Navi Mumbai",
  "Salunke Vihar",
  "Sahakar Nagar",
  "Secunderabad",
  "Surat",
  "Thane",
  "Undri",
  "Vashi",
  "Rajaji Nagar",
  "Sarjapura",
  "Katraj",
  "Ahmedabad",
  "Mohali",
  "Aurangabad",
  "Whitefield",
  "Hadapsar",
  "Kalyan",
  "Bopal",
  "Electronic City",
  "RR Nagar",
  "Adajan",
  "Raipur",
];

const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const fyStart = () => {
  const [y, m] = todayIST().split("-").map(Number);
  return `${m >= 4 ? y : y - 1}-04-01`;
};

const FROM = process.argv[2] || fyStart(); // 1 April of the current FY
const TO = process.argv[3] || todayIST();
const LOCS = (process.argv[4] || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const BRANCHES = LOCS.length ? LOCS : ALL_LOCATIONS;

const reportsDir = path.join(__dirname, "..", "src", "report");

/* ── App labels (src/admin/ReportScreen.js LABELS) ───────────────────────── */

const LABELS = {
  invoice_id: "Invoice ID",
  patient_name: "Patient Name",
  receipt_date: "Receipt Date",
  invoice_date: "Invoice Date",
  payment_date: "Payment Date",
  status: "Status",
  patient_location: "Interbranch Location",
  insurance_company: "Insurance",
  cashamt: "Cash",
  cardamt: "Card",
  chequeamt: "Cheque",
  onlineamt: "Online",
  discountamt: "Discount",
  internal_discount: "Int. Disc.",
  TDS: "TDS",
  settled_amt: "Settled",
  utrno: "UTR No",
};
const labelFor = (k) =>
  LABELS[k] || k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const MONEY_KEYS = new Set([
  "cashamt",
  "cardamt",
  "chequeamt",
  "onlineamt",
  "discountamt",
  "internal_discount",
  "TDS",
  "settled_amt",
]);
// As in the app: hidden when empty across the whole set.
const OPTIONAL_KEYS = new Set(["patient_location"]);
const hasValue = (v) => v !== null && v !== undefined && String(v).trim() !== "";

/* ── Connection resilience (self-contained) ──────────────────────────────── */

const MAX_CONCURRENT = Math.max(1, Number(process.env.REPORT_DB_CONCURRENCY) || 4);
const TRANSIENT = new Set([
  "PROTOCOL_SEQUENCE_TIMEOUT",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "PROTOCOL_CONNECTION_LOST",
  "ER_CON_COUNT_ERROR",
]);
const isTransient = (e) =>
  !!e && (TRANSIENT.has(e.code) || /handshake|timeout|too many connections/i.test(e.message || ""));
let active = 0;
const waiting = [];
const acquire = () =>
  new Promise((r) => (active < MAX_CONCURRENT ? (active++, r()) : waiting.push(r)));
const release = () => {
  const next = waiting.shift();
  if (next) next();
  else active--;
};
const patched = new Set();
function harden(names) {
  const unknown = [];
  // The insurance-name lookup also reads the master ("lead") pool.
  for (const loc of [...names, "lead"]) {
    const pool = getConnectionByLocation(loc)?.connection;
    if (!pool) {
      if (loc !== "lead") unknown.push(loc);
      continue;
    }
    if (patched.has(pool)) continue;
    patched.add(pool);
    const cc = pool.config && pool.config.connectionConfig;
    if (cc) cc.connectTimeout = 30000;
    const origQuery = pool.query.bind(pool);
    pool.query = function (sql, values, cb) {
      if (typeof values === "function") {
        cb = values;
        values = undefined;
      }
      const attempt = (n) =>
        acquire().then(() =>
          origQuery(sql, values, (err, rows, fields) => {
            release();
            if (err && isTransient(err) && n < 3) {
              console.warn(`  ↻ ${loc}: ${err.message} — retry ${n}/2`);
              return setTimeout(() => attempt(n + 1), 2000 * n);
            }
            if (cb) cb(err, rows, fields);
          }),
        );
      attempt(1);
    };
    const origGet = pool.getConnection.bind(pool);
    pool.getConnection = function (cb) {
      const attempt = (n) =>
        origGet((err, conn) => {
          if (err && isTransient(err) && n < 3) {
            console.warn(`  ↻ ${loc}: ${err.message} — retry ${n}/2`);
            return setTimeout(() => attempt(n + 1), 2000 * n);
          }
          cb(err, conn);
        });
      attempt(1);
    };
  }
  return unknown;
}

/* ── Read one branch — exactly the app's call ────────────────────────────── */

// getReport logs its { location, from, to, reportType, sheetType } on every
// call; across 40+ branches that buries the progress lines. Drop only that.
const _log = console.log;
console.log = (...args) => {
  const a0 = args[0];
  if (args.length === 1 && a0 && typeof a0 === "object" && "reportType" in a0 && "sheetType" in a0) return;
  _log(...args);
};

async function readBranch(branch) {
  const data = await getReport({
    body: { reportType: "IPD", sheetType: "Sheet2" },
    query: { location: branch, from: FROM, to: `${TO} 23:59:59` },
  });
  return {
    payments: data?.patientPayments || [],
    settlements: data?.insuranceSettlements || [],
  };
}

/* ── Styles ──────────────────────────────────────────────────────────────── */

const THIN = { style: "thin", color: { rgb: "D9E0DC" } };
const BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };
const MONEY = '#,##0;(#,##0);"-"';
const ZEBRA = "F7F9F8";
const mk = (v, s) => ({ v, s });
const zebra = (s, alt) => (alt ? { ...s, fill: { fgColor: { rgb: ZEBRA } } } : s);
const S = {
  title: { font: { bold: true, sz: 15, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "0F1A16" } }, alignment: { vertical: "center" } },
  sub: { font: { sz: 10, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "2A4438" } }, alignment: { vertical: "center" } },
  group: { font: { bold: true, sz: 10, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "2A4438" } }, alignment: { horizontal: "center", vertical: "center" }, border: BORDER },
  head: { font: { bold: true, sz: 10, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "14603F" } }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: BORDER },
  text: { font: { sz: 10 }, alignment: { vertical: "center" }, border: BORDER },
  center: { font: { sz: 10 }, alignment: { horizontal: "center", vertical: "center" }, border: BORDER },
  money: { font: { sz: 10 }, numFmt: MONEY, alignment: { horizontal: "right", vertical: "center" }, border: BORDER },
  total: { font: { bold: true, sz: 10 }, fill: { fgColor: { rgb: "EDF2EF" } }, alignment: { vertical: "center" }, border: BORDER },
  note: { font: { italic: true, sz: 9, color: { rgb: "6C7C75" } }, alignment: { wrapText: true, vertical: "top" } },
};
const totalMoney = { ...S.total, numFmt: MONEY, alignment: { horizontal: "right", vertical: "center" } };
const totalCount = { ...S.total, alignment: { horizontal: "center", vertical: "center" } };

const n0 = (v) => Number(v) || 0;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (d) => {
  const [y, m, dd] = d.split("-");
  return `${Number(dd)} ${MON[Number(m) - 1]} ${y}`;
};

/* ── Sheets ──────────────────────────────────────────────────────────────── */

// One table for every branch, Branch first, the app's columns and headers.
function rowsSheet(title, results, key) {
  const all = results.filter((r) => r.ok).flatMap((r) => r[key].map((row) => ({ branch: r.branch, row })));
  const keys = all.length ? Object.keys(all[0].row) : [];
  const cols = keys.filter((k) => !OPTIONAL_KEYS.has(k) || all.some((x) => hasValue(x.row[k])));
  const aoa = [[mk("Branch", S.head), ...cols.map((k) => mk(labelFor(k), S.head))]];
  all.forEach(({ branch, row }, i) => {
    const alt = i % 2 === 1;
    aoa.push([
      mk(branch, zebra(S.text, alt)),
      ...cols.map((k) =>
        MONEY_KEYS.has(k)
          ? mk(n0(row[k]), zebra(S.money, alt))
          : mk(row[k] == null ? "" : row[k], zebra(/date|invoice_id|status/.test(k) ? S.center : S.text, alt)),
      ),
    ]);
  });
  if (!all.length) aoa.push([mk(`No ${title.toLowerCase()} in this period.`, S.text)]);
  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 18 }, ...cols.map((k) => ({ wch: k === "patient_name" ? 26 : k === "utrno" ? 22 : k === "patient_location" ? 18 : 13 }))];
  ws["!freeze"] = { xSplit: 1, ySplit: 1 };
  ws["!rows"] = [{ hpt: 28 }];
  if (all.length) {
    ws["!autofilter"] = {
      ref: xlsx.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: cols.length } }),
    };
  }
  return { ws, count: all.length };
}

function summarySheet(results) {
  const head = [
    "Branch",
    "Payments (#)",
    "Cash",
    "Card",
    "Cheque",
    "Online",
    "Patient collected",
    "Discount",
    "Int. Disc.",
    "Settlements (#)",
    "Settled",
    "TDS",
    "Total collected",
  ];
  const LAST = head.length - 1;
  const aoa = [
    [mk("IPD Sheet 2 — All Branches", S.title)],
    [mk(`${fmt(FROM)} to ${fmt(TO)} · patient payments by receipt date, insurance settlements by payment date`, S.sub)],
    [],
    [
      mk("", S.group),
      mk("PATIENT PAYMENTS", S.group),
      ...Array(7).fill(mk("", S.group)),
      mk("INSURANCE SETTLEMENTS", S.group),
      mk("", S.group),
      mk("", S.group),
      mk("", S.group),
    ],
    head.map((h) => mk(h, S.head)),
  ];

  const tot = { n: 0, cash: 0, card: 0, cheque: 0, online: 0, disc: 0, idisc: 0, sn: 0, settled: 0, tds: 0 };
  const ok = results.filter((r) => r.ok);
  const lineOf = (r) => {
    const s = { n: r.payments.length, cash: 0, card: 0, cheque: 0, online: 0, disc: 0, idisc: 0, sn: r.settlements.length, settled: 0, tds: 0 };
    for (const p of r.payments) {
      s.cash += n0(p.cashamt);
      s.card += n0(p.cardamt);
      s.cheque += n0(p.chequeamt);
      s.online += n0(p.onlineamt);
      s.disc += n0(p.discountamt);
      s.idisc += n0(p.internal_discount);
    }
    for (const x of r.settlements) {
      s.settled += n0(x.settled_amt);
      s.tds += n0(x.TDS);
    }
    return s;
  };
  const lines = ok.map((r) => ({ branch: r.branch, s: lineOf(r) }));
  const pt = (s) => s.cash + s.card + s.cheque + s.online;
  lines.sort((a, b) => pt(b.s) + b.s.settled - (pt(a.s) + a.s.settled));

  lines.forEach(({ branch, s }, i) => {
    const alt = i % 2 === 1;
    for (const k of Object.keys(tot)) tot[k] += s[k];
    const m = zebra(S.money, alt);
    aoa.push([
      mk(branch, zebra(S.text, alt)),
      mk(s.n, zebra(S.center, alt)),
      mk(s.cash, m),
      mk(s.card, m),
      mk(s.cheque, m),
      mk(s.online, m),
      mk(pt(s), { ...m, font: { bold: true, sz: 10 } }),
      mk(s.disc, m),
      mk(s.idisc, m),
      mk(s.sn, zebra(S.center, alt)),
      mk(s.settled, m),
      mk(s.tds, m),
      mk(pt(s) + s.settled, { ...m, font: { bold: true, sz: 10 } }),
    ]);
  });
  aoa.push([
    mk("TOTAL", S.total),
    mk(tot.n, totalCount),
    mk(tot.cash, totalMoney),
    mk(tot.card, totalMoney),
    mk(tot.cheque, totalMoney),
    mk(tot.online, totalMoney),
    mk(pt(tot), totalMoney),
    mk(tot.disc, totalMoney),
    mk(tot.idisc, totalMoney),
    mk(tot.sn, totalCount),
    mk(tot.settled, totalMoney),
    mk(tot.tds, totalMoney),
    mk(pt(tot) + tot.settled, totalMoney),
  ]);
  aoa.push([]);
  const noteRow = aoa.length;
  aoa.push([
    mk(
      "Same data as Report Center → Reports → IPD · Sheet 2, run for every branch. Patient collected = Cash + Card + " +
        "Cheque + Online (discount and internal discount are shown, not added). Total collected = patient collected + " +
        "insurance settled. Rows for each set are on the 'Patient Payments' and 'Insurance Settlements' sheets.",
      S.note,
    ),
  ]);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    aoa.push([]);
    aoa.push([mk("Branches NOT included (could not be read)", S.group), mk("Reason", S.group)]);
    failed.forEach((f) => aoa.push([mk(f.branch, S.text), mk(f.error, S.text)]));
  }

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 20 }, { wch: 11 }, ...Array(7).fill({ wch: 14 }), { wch: 13 }, { wch: 14 }, { wch: 12 }, { wch: 16 }];
  ws["!rows"] = [{ hpt: 26 }, { hpt: 18 }, {}, { hpt: 18 }, { hpt: 30 }];
  ws["!rows"][noteRow] = { hpt: 40 };
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: LAST } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: LAST } },
    { s: { r: 3, c: 1 }, e: { r: 3, c: 8 } },
    { s: { r: 3, c: 9 }, e: { r: 3, c: 12 } },
    { s: { r: noteRow, c: 0 }, e: { r: noteRow, c: LAST } },
  ];
  ws["!freeze"] = { xSplit: 1, ySplit: 5 };
  return { ws, tot, pt: pt(tot) };
}

/* ── Run ─────────────────────────────────────────────────────────────────── */

(async () => {
  const t0 = Date.now();
  const inr = (n) => Math.round(n0(n)).toLocaleString("en-IN");
  console.log("──────────────────────────────────────────────────────────");
  console.log(`IPD Sheet 2 — all branches · ${FROM} → ${TO}`);
  console.log(`Branches : ${LOCS.length ? BRANCHES.join(", ") : `all (${BRANCHES.length})`}`);
  console.log("──────────────────────────────────────────────────────────");

  try {
    if (FROM > TO) throw new Error("`from` is after `to`.");
    const unknown = harden(BRANCHES);
    if (unknown.length) throw new Error(`Unknown branch name(s): ${unknown.join(", ")}`);
    await new Promise((res, rej) =>
      getConnectionByLocation(BRANCHES[0]).connection.query("SELECT 1", [], (e) =>
        e
          ? rej(new Error(`Cannot reach the branch database host (${e.code || "error"}: ${e.message}). Check network / VPN / IP whitelist, or run on the backend server.`))
          : res(),
      ),
    );
    console.log("  ✓ database host reachable");

    const results = [];
    // Two branches at a time; the shared query cap keeps the host comfortable.
    for (let i = 0; i < BRANCHES.length; i += 2) {
      const slice = BRANCHES.slice(i, i + 2);
      const done = await Promise.all(
        slice.map(async (branch) => {
          try {
            const d = await readBranch(branch);
            console.log(`  ✓ ${branch.padEnd(18)} ${String(d.payments.length).padStart(5)} payments · ${String(d.settlements.length).padStart(4)} settlements`);
            return { branch, ok: true, ...d };
          } catch (e) {
            console.error(`  ✗ ${branch}: ${e.message}`);
            return { branch, ok: false, error: e.message };
          }
        }),
      );
      results.push(...done);
    }
    if (!results.some((r) => r.ok)) throw new Error("No branch could be read — no workbook written.");

    const wb = xlsx.utils.book_new();
    const { ws, tot, pt } = summarySheet(results);
    xlsx.utils.book_append_sheet(wb, ws, "Summary");
    xlsx.utils.book_append_sheet(wb, rowsSheet("Patient Payments", results, "payments").ws, "Patient Payments");
    xlsx.utils.book_append_sheet(wb, rowsSheet("Insurance Settlements", results, "settlements").ws, "Insurance Settlements");

    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    const filePath = path.join(reportsDir, `IPD_Sheet2_AllBranches_${FROM}_to_${TO}.xlsx`);
    xlsx.writeFile(wb, filePath);

    const failed = results.filter((r) => !r.ok);
    console.log(`\n✅ Workbook written: ${filePath}`);
    console.log(`   Patient payments      ${tot.n} rows · collected ₹${inr(pt)} (discount ₹${inr(tot.disc)}, int. disc ₹${inr(tot.idisc)})`);
    console.log(`   Insurance settlements ${tot.sn} rows · settled ₹${inr(tot.settled)} (TDS ₹${inr(tot.tds)})`);
    console.log(`   Total collected       ₹${inr(pt + tot.settled)}`);
    if (failed.length) console.warn(`\n⚠️  NOT included: ${failed.map((f) => f.branch).join(", ")}`);
    console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exit(failed.length ? 1 : 0);
  } catch (e) {
    console.error(`\n❌ ${e.message}`);
    process.exit(2);
  }
})();
