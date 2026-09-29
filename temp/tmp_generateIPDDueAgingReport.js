/**
 * tmp_generateIPDDueAgingReport.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * Branch-wise IPD DUE list with AGING, as one workbook:
 *
 *      Summary         one row per branch: invoices, patients, total due and
 *                      the due in each aging bucket, % over 90 days, plus the
 *                      interbranch dues left out — and an ALL BRANCHES row;
 *                      below it, due by STATUS × bucket for the whole group
 *      All Invoices    every outstanding invoice, every branch, one flat
 *                      filterable table (Branch column first)
 *      <Branch>        one sheet per branch: its invoices worst-aged first,
 *                      grouped by bucket with subtotals, then any interbranch
 *                      invoices that were left out
 *
 * ── Same data as the app ────────────────────────────────────────────────────
 * Rows come straight from getStatuswiseIPDDueListV2 (ipdCollectionModel) — the
 * endpoint behind the IPD Due List screen — so the workbook and the screen can
 * never disagree:
 *   • invoice.is_deleted != 1, creation_date >= '2025-04-01', totaldue > 0
 *   • aging from the invoice creation date to TODAY (database CURDATE()):
 *         Under 30 days   0–30      >30 days   31–60
 *         >60 days        61–90     >90 days   91+
 *   • insurer / TPA names resolved per invoice date (pre/post 1 Jul 2026 id
 *     spaces) exactly as the screen does
 *
 * ── Interbranch ─────────────────────────────────────────────────────────────
 * An interbranch surgery has the SAME invoice in two branch DBs; it belongs to
 * the SOURCE branch. The operating branch's copy (rule: src/models/utils/
 * interbranch.js — DP Road always counted) is NOT this branch's due, so it is
 * kept OUT of every total and bucket and listed separately instead, so nothing
 * is hidden and nothing is counted twice across branches.
 *
 * ── Place this file in temp/ ─────────────────────────────────────────────────
 * It requires ../src/models/ipdCollectionModel, ../databaseUtils and
 * ../src/models/utils/interbranch.
 *
 * ── ⚠️ REQUIRES xlsx-js-style (same as tmp_generateFeedbackReport.js) ────────
 *      npm i xlsx-js-style
 * Plain `xlsx` silently drops every style.
 *
 * ── Connection resilience ───────────────────────────────────────────────────
 * Every branch DB lives on the same MySQL host, and dbconfig's pools use the
 * driver's default 10 s connect timeout. Opening many connections at once
 * (or a slow link from the machine running this) produces
 * "Handshake inactivity timeout". So this script:
 *   • raises the connect timeout to 30 s on the pools it uses (runtime only —
 *     dbconfig.js is not changed),
 *   • checks ONE branch first and stops with a clear message if the DB host
 *     can't be reached at all, instead of printing forty timeouts,
 *   • reads branches 2 at a time (DUE_BATCH=1 for strictly one-by-one),
 *   • retries a branch up to 3 times on a timeout / reset, with a pause.
 *
 * ── Run ─────────────────────────────────────────────────────────────────────
 *   node temp/tmp_generateIPDDueAgingReport.js
 *   node temp/tmp_generateIPDDueAgingReport.js "Thane,Andheri,DP Road"
 *   node temp/tmp_generateIPDDueAgingReport.js "" Cashless      # one status only
 *
 * ── Output ──────────────────────────────────────────────────────────────────
 *   src/report/IPD_Due_Aging_AllBranches_<YYYY-MM-DD>.xlsx
 *
 * ⚠️  Contains patient names and phone numbers. Share only over approved
 *     channels, and delete the script and the file when done.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx-js-style");

const {
  getStatuswiseIPDDueListV2,
} = require("../src/models/ipdCollectionModel");
const { getConnectionByLocation } = require("../databaseUtils");
const { interbranchRoleSql } = require("../src/models/utils/interbranch");

/* ── Config ──────────────────────────────────────────────────────────────── */

// Branches read at a time. Kept low: every branch DB is on ONE MySQL host.
const BATCH = Math.max(1, Number(process.env.DUE_BATCH) || 2);
const CONNECT_TIMEOUT_MS = 30000;
const RETRIES = 3;

// Transient network / handshake failures worth retrying. Anything else (bad
// SQL, unknown database) fails immediately.
const TRANSIENT = new Set([
  "PROTOCOL_SEQUENCE_TIMEOUT", // Handshake inactivity timeout
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "PROTOCOL_CONNECTION_LOST",
  "ER_CON_COUNT_ERROR", // server-side "Too many connections"
  "EHOSTUNREACH",
]);
const isTransient = (e) =>
  TRANSIENT.has(e?.code) ||
  /handshake|timeout|too many connections/i.test(e?.message || "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// dbconfig's pools use the driver default (10 s). Raise it on the pools this
// script touches, before they open any connection. Runtime only.
const tunedPools = new Set();
function tunePool(branch) {
  const { connection } = getConnectionByLocation(branch) || {};
  if (!connection || tunedPools.has(connection)) return connection;
  const cc = connection.config?.connectionConfig;
  if (cc) cc.connectTimeout = CONNECT_TIMEOUT_MS;
  tunedPools.add(connection);
  return connection;
}

async function withRetry(label, fn) {
  let last;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isTransient(e) || attempt === RETRIES) break;
      const wait = 3000 * attempt;
      console.warn(
        `  ↻ ${label}: ${e.message} — retry ${attempt}/${RETRIES - 1} in ${wait / 1000}s`,
      );
      await sleep(wait);
    }
  }
  throw last;
}

const reportsDir = path.join(__dirname, "..", "src", "report");

// databaseUtils has no exported list (the names live in a switch, with several
// aliases per database), so the branches are listed here — the same set as
// tmp_generateFeedbackReport.js, plus DP Road. Edit to taste, or pass a
// comma-separated list as the first argument.
const ALL_LOCATIONS = [
  //"DP Road",
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

// Worst first — this is a collection queue. Keys are what the model returns.
const BUCKETS = [
  { key: ">90 days", label: "Over 90 days", range: "91+ days" },
  { key: ">60 days", label: "61–90 days", range: "61–90 days" },
  { key: ">30 days", label: "31–60 days", range: "31–60 days" },
  { key: "<30 days", label: "Under 30 days", range: "0–30 days" },
];
const BUCKET_INDEX = Object.fromEntries(BUCKETS.map((b, i) => [b.key, i]));

/* ── Styles (same family as the feedback / summary exports) ──────────────── */

const INK = "0F1A16";
const BRAND = "14603F";
const BAND_HEAD = "2A4438";
const ZEBRA = "F7F9F8";
const IB = "7A4FB0";
const IB_SOFT = "F1EBF8";
const BUCKET_COLOR = {
  ">90 days": ["B3382B", "F8E6E3"],
  ">60 days": ["C2670E", "FCEBDC"],
  ">30 days": ["B28A00", "FBF4DA"],
  "<30 days": ["1E7A5A", "E7F2EC"],
};

const THIN = { style: "thin", color: { rgb: "D9E0DC" } };
const BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };
const MONEY = '#,##0;(#,##0);"-"';
const COUNT = '0;(0);"-"';

const mk = (v, s) => ({ v, s });

const ST_TITLE = {
  font: { bold: true, sz: 15, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: INK } },
  alignment: { horizontal: "left", vertical: "center" },
};
const ST_SUBTITLE = {
  font: { sz: 10, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: BAND_HEAD } },
  alignment: { horizontal: "left", vertical: "center" },
};
const ST_HEAD = {
  font: { bold: true, sz: 10, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: BRAND } },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
  border: BORDER,
};
const ST_GROUP = {
  font: { bold: true, sz: 10, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: BAND_HEAD } },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER,
};
const ST_TEXT = {
  font: { sz: 10, color: { rgb: "16211D" } },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER,
};
const ST_CENTER = {
  ...ST_TEXT,
  alignment: { horizontal: "center", vertical: "center" },
};
const ST_MONEY = {
  ...ST_TEXT,
  numFmt: MONEY,
  alignment: { horizontal: "right", vertical: "center" },
};
const ST_COUNT = { ...ST_CENTER, numFmt: COUNT };
const zebra = (s, alt) =>
  alt ? { ...s, fill: { fgColor: { rgb: ZEBRA } } } : s;
const ST_TOTAL = {
  font: { bold: true, sz: 10, color: { rgb: "16211D" } },
  fill: { fgColor: { rgb: "EDF2EF" } },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER,
};
const ST_TOTAL_MONEY = {
  ...ST_TOTAL,
  numFmt: MONEY,
  alignment: { horizontal: "right", vertical: "center" },
};
const ST_TOTAL_COUNT = {
  ...ST_TOTAL,
  numFmt: COUNT,
  alignment: { horizontal: "center", vertical: "center" },
};
const ST_NOTE = {
  font: { italic: true, sz: 9, color: { rgb: "6C7C75" } },
  alignment: { horizontal: "left", vertical: "top", wrapText: true },
};
const bucketHead = (key) => ({
  font: { bold: true, sz: 10, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: BUCKET_COLOR[key][0] } },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER,
});
const bucketMoney = (key, strong) => ({
  font: { bold: !!strong, sz: 10, color: { rgb: BUCKET_COLOR[key][0] } },
  fill: { fgColor: { rgb: BUCKET_COLOR[key][1] } },
  numFmt: MONEY,
  alignment: { horizontal: "right", vertical: "center" },
  border: BORDER,
});
const ST_IB_HEAD = {
  font: { bold: true, sz: 10, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: IB } },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER,
};
const ST_IB_TEXT = {
  ...ST_TEXT,
  font: { sz: 10, color: { rgb: IB } },
  fill: { fgColor: { rgb: IB_SOFT } },
};
const ST_IB_MONEY = {
  ...ST_IB_TEXT,
  numFmt: MONEY,
  alignment: { horizontal: "right", vertical: "center" },
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const n0 = (v) => Number(v) || 0;
const MON = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const ymd = (d) => {
  if (!d) return "";
  if (d instanceof Date) {
    // Driver-parsed DATETIME: format in IST so the day matches the app.
    const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
    return ist.toISOString().slice(0, 10);
  }
  return String(d).slice(0, 10);
};
const fmtDate = (d) => {
  const s = ymd(d);
  const [y, m, day] = s.split("-");
  return m ? `${Number(day)} ${MON[Number(m) - 1]} ${y}` : s;
};
const todayIST = () =>
  new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

const sheetName = (name, used) => {
  const base =
    String(name)
      .replace(/[:\\/?*[\]]/g, "-")
      .slice(0, 28)
      .trim() || "Branch";
  let c = base;
  let i = 2;
  while (used.has(c)) c = `${base.slice(0, 26)}-${i++}`;
  used.add(c);
  return c;
};

const runQuery = (connection, sql, params) =>
  new Promise((resolve, reject) =>
    connection.query(sql, params, (e, r) => (e ? reject(e) : resolve(r))),
  );

/* ── Read one branch ─────────────────────────────────────────────────────── */

// Role and exact age for the invoices the due list returned. Age uses the
// database's CURDATE(), the same clock the model's buckets use, so a row's
// "days" can never disagree with its bucket.
const ROLE_SQL = `
  SELECT i.invoice_id,
         ${interbranchRoleSql("i")}                   AS role,
         NULLIF(TRIM(i.patient_location), '')        AS other_branch,
         DATEDIFF(CURDATE(), DATE(i.creation_date))  AS age_days
    FROM invoice i
   WHERE i.invoice_id IN (?)
`;

async function readBranch(branch, status) {
  tunePool(branch);
  const grouped = await getStatuswiseIPDDueListV2({
    query: { location: branch, status },
  });

  const rows = [];
  for (const b of BUCKETS) {
    for (const p of grouped?.[b.key]?.patients || []) rows.push(p);
  }

  const roles = new Map();
  if (rows.length) {
    const { connection } = getConnectionByLocation(branch);
    const ids = rows.map((r) => r.invoice_id);
    // Chunked so a very long due list can't hit max_allowed_packet.
    for (let i = 0; i < ids.length; i += 1000) {
      const part = await runQuery(connection, ROLE_SQL, [
        ids.slice(i, i + 1000),
      ]);
      part.forEach((r) => roles.set(r.invoice_id, r));
    }
  }

  const invoices = rows.map((r) => {
    const x = roles.get(r.invoice_id) || {};
    return {
      branch,
      invoiceId: r.invoice_id,
      patientId: r.patient_id,
      name: r.name || "",
      phone: r.phone || "",
      status: r.status || "",
      insurer: r.insurancecompany_name || "",
      tpa:
        r.tpa_name && r.tpa_name !== r.insurancecompany_name ? r.tpa_name : "",
      date: ymd(r.creation_date),
      ageDays: x.age_days == null ? null : Number(x.age_days),
      bucket: r.due_category,
      billed: n0(r.totalamt),
      due: n0(r.totaldue),
      role: x.role || null, // 'operating' | 'source' | null
      otherBranch: x.other_branch || "",
    };
  });

  // Worst-aged first, then largest due.
  invoices.sort(
    (a, b) =>
      (BUCKET_INDEX[a.bucket] ?? 9) - (BUCKET_INDEX[b.bucket] ?? 9) ||
      (b.ageDays ?? 0) - (a.ageDays ?? 0) ||
      b.due - a.due,
  );

  return {
    counted: invoices.filter((i) => i.role !== "operating"),
    excluded: invoices.filter((i) => i.role === "operating"),
  };
}

/* ── Aggregation ─────────────────────────────────────────────────────────── */

function summarise(list) {
  const out = {
    invoices: list.length,
    patients: new Set(list.map((i) => i.patientId)).size,
    billed: 0,
    due: 0,
    buckets: Object.fromEntries(
      BUCKETS.map((b) => [b.key, { count: 0, due: 0 }]),
    ),
  };
  for (const i of list) {
    out.billed += i.billed;
    out.due += i.due;
    const b = out.buckets[i.bucket];
    if (b) {
      b.count += 1;
      b.due += i.due;
    }
  }
  return out;
}

/* ── Sheets ──────────────────────────────────────────────────────────────── */

function summarySheet(results, asOf, status) {
  const head = [
    "Branch",
    "Invoices",
    "Patients",
    "Total due (₹)",
    ...BUCKETS.map((b) => `${b.label} (₹)`),
    "% over 90 days",
    "Oldest (days)",
    "Interbranch excl. (#)",
    "Interbranch excl. due (₹)",
  ];
  const LAST = head.length - 1;
  const rows = [
    [mk("IPD Due List with Aging — All Branches", ST_TITLE)],
    [
      mk(
        `As of ${fmtDate(asOf)} · invoices from 1 Apr 2025 with a balance due` +
          (status ? ` · status: ${status}` : ""),
        ST_SUBTITLE,
      ),
    ],
    [],
    head.map((h) => mk(h, ST_HEAD)),
  ];

  const all = [];
  const allIB = [];
  const ok = results
    .filter((r) => r.ok)
    .sort((a, b) => summarise(b.counted).due - summarise(a.counted).due);

  const lineFor = (label, s, ib, oldest, alt, total) => {
    const T = total;
    const txt = T ? ST_TOTAL : zebra(ST_TEXT, alt);
    const cnt = T ? ST_TOTAL_COUNT : zebra(ST_COUNT, alt);
    const mon = T ? ST_TOTAL_MONEY : zebra(ST_MONEY, alt);
    const over90 = s.due > 0 ? s.buckets[">90 days"].due / s.due : 0;
    return [
      mk(label, txt),
      mk(s.invoices, cnt),
      mk(s.patients, cnt),
      mk(Math.round(s.due), {
        ...mon,
        font: { ...(mon.font || {}), bold: true },
      }),
      ...BUCKETS.map((b) =>
        mk(Math.round(s.buckets[b.key].due), bucketMoney(b.key, T)),
      ),
      mk(over90, {
        ...(T ? ST_TOTAL_COUNT : zebra(ST_CENTER, alt)),
        numFmt: "0%",
      }),
      mk(oldest ?? "", cnt),
      mk(ib.invoices, {
        ...ST_IB_TEXT,
        numFmt: COUNT,
        alignment: { horizontal: "center", vertical: "center" },
      }),
      mk(Math.round(ib.due), ST_IB_MONEY),
    ];
  };

  ok.forEach((r, i) => {
    const s = summarise(r.counted);
    const ib = summarise(r.excluded);
    const oldest =
      r.counted.reduce((m, x) => Math.max(m, x.ageDays ?? 0), 0) || null;
    all.push(...r.counted);
    allIB.push(...r.excluded);
    rows.push(lineFor(r.branch, s, ib, oldest, i % 2 === 1, false));
  });

  const gs = summarise(all);
  const gib = summarise(allIB);
  const gOld = all.reduce((m, x) => Math.max(m, x.ageDays ?? 0), 0) || null;
  rows.push(lineFor("ALL BRANCHES", gs, gib, gOld, false, true));

  // ── Status × bucket for the whole group ───────────────────────────────
  rows.push([]);
  rows.push([
    mk("DUE BY STATUS — ALL BRANCHES", ST_GROUP),
    ...Array(LAST).fill(mk("", ST_GROUP)),
  ]);
  const statusHeadRow = rows.length;
  rows.push(
    [
      "Status",
      "Invoices",
      "Patients",
      "Total due (₹)",
      ...BUCKETS.map((b) => `${b.label} (₹)`),
      "% over 90 days",
    ].map((h) => mk(h, ST_HEAD)),
  );
  const byStatus = {};
  all.forEach((i) =>
    (byStatus[i.status || "—"] = byStatus[i.status || "—"] || []).push(i),
  );
  Object.entries(byStatus)
    .map(([k, list]) => [k, summarise(list)])
    .sort((a, b) => b[1].due - a[1].due)
    .forEach(([k, s], i) => {
      const alt = i % 2 === 1;
      rows.push([
        mk(k, zebra(ST_TEXT, alt)),
        mk(s.invoices, zebra(ST_COUNT, alt)),
        mk(s.patients, zebra(ST_COUNT, alt)),
        mk(Math.round(s.due), {
          ...zebra(ST_MONEY, alt),
          font: { bold: true, sz: 10 },
        }),
        ...BUCKETS.map((b) =>
          mk(Math.round(s.buckets[b.key].due), bucketMoney(b.key)),
        ),
        mk(s.due > 0 ? s.buckets[">90 days"].due / s.due : 0, {
          ...zebra(ST_CENTER, alt),
          numFmt: "0%",
        }),
      ]);
    });

  rows.push([]);
  const noteRow = rows.length;
  rows.push([
    mk(
      "Source: the IPD Due List screen's endpoint (getStatuswiseIPDDueListV2) — non-deleted " +
        "invoices created on or after 1 Apr 2025 with totaldue > 0. Age = days from invoice " +
        "creation to today; buckets 0–30 / 31–60 / 61–90 / 91+. Interbranch invoices (operated " +
        "at this branch for another branch's patient; DP Road always counted) belong to the " +
        "SOURCE branch and are kept out of every total and bucket — shown in the last two " +
        "columns and listed at the foot of each branch sheet.",
      ST_NOTE,
    ),
  ]);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    rows.push([]);
    rows.push([
      mk("Branches that could not be read", ST_GROUP),
      mk("Reason", ST_GROUP),
    ]);
    failed.forEach((f) =>
      rows.push([mk(f.branch, ST_TEXT), mk(f.error, ST_TEXT)]),
    );
  }

  const ws = xlsx.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 24 },
    { wch: 9 },
    { wch: 9 },
    { wch: 15 },
    ...BUCKETS.map(() => ({ wch: 15 })),
    { wch: 11 },
    { wch: 10 },
    { wch: 12 },
    { wch: 16 },
  ];
  ws["!rows"] = [{ hpt: 26 }, { hpt: 18 }, {}, { hpt: 30 }];
  ws["!rows"][statusHeadRow] = { hpt: 30 };
  ws["!rows"][noteRow] = { hpt: 52 };
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: LAST } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: LAST } },
    { s: { r: statusHeadRow - 1, c: 0 }, e: { r: statusHeadRow - 1, c: LAST } },
    { s: { r: noteRow, c: 0 }, e: { r: noteRow, c: LAST } },
  ];
  ws["!freeze"] = { xSplit: 1, ySplit: 4 };
  return ws;
}

const INVOICE_HEAD = [
  "Invoice #",
  "Patient",
  "Phone",
  "Status",
  "Insurer",
  "TPA",
  "Invoice date",
  "Age (days)",
  "Aging bucket",
  "Billed (₹)",
  "Due (₹)",
];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const bucketLabel = (k) => BUCKETS.find((b) => b.key === k)?.label || k || "";

const invoiceCells = (i, alt, ib) => {
  const t = ib ? ST_IB_TEXT : zebra(ST_TEXT, alt);
  const c = ib
    ? { ...ST_IB_TEXT, alignment: { horizontal: "center", vertical: "center" } }
    : zebra(ST_CENTER, alt);
  const m = ib ? ST_IB_MONEY : zebra(ST_MONEY, alt);
  return [
    mk(i.invoiceId, c),
    mk(i.name, t),
    mk(i.phone, t),
    mk(i.status, c),
    mk(i.insurer, t),
    mk(i.tpa, t),
    mk(fmtDate(i.date), c),
    mk(i.ageDays ?? "", { ...c, numFmt: COUNT }),
    mk(bucketLabel(i.bucket), c),
    mk(Math.round(i.billed), m),
    ib
      ? mk(Math.round(i.due), m)
      : mk(Math.round(i.due), bucketMoney(i.bucket, true)),
  ];
};

function branchSheet(r, asOf) {
  const s = summarise(r.counted);
  const LAST = INVOICE_HEAD.length - 1;
  const rows = [
    [mk(`IPD Due List with Aging — ${r.branch}`, ST_TITLE)],
    [
      mk(
        `As of ${fmtDate(asOf)} · ${plural(s.invoices, "invoice", "invoices")} · ${plural(s.patients, "patient", "patients")} · ` +
          `total due ₹${Math.round(s.due).toLocaleString("en-IN")}`,
        ST_SUBTITLE,
      ),
    ],
    [],
  ];
  const merges = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: LAST } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: LAST } },
  ];

  // Bucket summary strip.
  rows.push(
    ["Aging bucket", "Invoices", "Due (₹)", "Share"].map((h) => mk(h, ST_HEAD)),
  );
  BUCKETS.forEach((b) => {
    const x = s.buckets[b.key];
    rows.push([
      mk(`${b.label} (${b.range})`, bucketHead(b.key)),
      mk(x.count, ST_COUNT),
      mk(Math.round(x.due), bucketMoney(b.key, true)),
      mk(s.due > 0 ? x.due / s.due : 0, { ...ST_CENTER, numFmt: "0%" }),
    ]);
  });
  rows.push([
    mk("Total", ST_TOTAL),
    mk(s.invoices, ST_TOTAL_COUNT),
    mk(Math.round(s.due), ST_TOTAL_MONEY),
    mk(s.due > 0 ? 1 : 0, { ...ST_TOTAL_COUNT, numFmt: "0%" }),
  ]);
  rows.push([]);

  // Invoices, grouped by bucket, worst first, with subtotals.
  const headerRow = rows.length;
  rows.push(INVOICE_HEAD.map((h) => mk(h, ST_HEAD)));
  BUCKETS.forEach((b) => {
    const list = r.counted.filter((i) => i.bucket === b.key);
    if (!list.length) return;
    merges.push({
      s: { r: rows.length, c: 0 },
      e: { r: rows.length, c: LAST },
    });
    rows.push([
      mk(
        `${b.label.toUpperCase()} · ${plural(list.length, "invoice", "invoices")}`,
        bucketHead(b.key),
      ),
      ...Array(LAST).fill(mk("", bucketHead(b.key))),
    ]);
    list.forEach((i, idx) => rows.push(invoiceCells(i, idx % 2 === 1, false)));
    const sub = summarise(list);
    rows.push([
      mk(`Subtotal — ${b.label}`, ST_TOTAL),
      ...Array(8).fill(mk("", ST_TOTAL)),
      mk(Math.round(sub.billed), ST_TOTAL_MONEY),
      mk(Math.round(sub.due), ST_TOTAL_MONEY),
    ]);
  });
  if (!r.counted.length) rows.push([mk("No outstanding IPD dues.", ST_TEXT)]);

  // Interbranch copies — listed, not counted.
  if (r.excluded.length) {
    const ib = summarise(r.excluded);
    rows.push([]);
    merges.push({
      s: { r: rows.length, c: 0 },
      e: { r: rows.length, c: LAST },
    });
    rows.push([
      mk(
        `INTERBRANCH — NOT COUNTED ABOVE · ${plural(ib.invoices, "invoice", "invoices")} · due ₹${Math.round(ib.due).toLocaleString("en-IN")} · ` +
          "operated here for another branch's patient; the due belongs to the source branch",
        ST_IB_HEAD,
      ),
      ...Array(LAST).fill(mk("", ST_IB_HEAD)),
    ]);
    rows.push([...INVOICE_HEAD, "Source branch"].map((h) => mk(h, ST_HEAD)));
    r.excluded.forEach((i) =>
      rows.push([
        ...invoiceCells(i, false, true),
        mk(i.otherBranch, ST_IB_TEXT),
      ]),
    );
  }

  const ws = xlsx.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 22 },
    { wch: 24 },
    { wch: 13 },
    { wch: 14 },
    { wch: 24 },
    { wch: 20 },
    { wch: 13 },
    { wch: 10 },
    { wch: 14 },
    { wch: 13 },
    { wch: 13 },
    { wch: 18 },
  ];
  ws["!rows"] = [{ hpt: 26 }, { hpt: 18 }];
  ws["!rows"][headerRow] = { hpt: 28 };
  ws["!merges"] = merges;
  ws["!freeze"] = { xSplit: 2, ySplit: headerRow + 1 };
  return ws;
}

function allInvoicesSheet(results) {
  const head = ["Branch", ...INVOICE_HEAD, "Interbranch"];
  const rows = [head.map((h) => mk(h, ST_HEAD))];
  const list = results
    .filter((r) => r.ok)
    .flatMap((r) => [...r.counted, ...r.excluded]);
  list.sort(
    (a, b) =>
      (BUCKET_INDEX[a.bucket] ?? 9) - (BUCKET_INDEX[b.bucket] ?? 9) ||
      (b.ageDays ?? 0) - (a.ageDays ?? 0) ||
      b.due - a.due,
  );
  list.forEach((i, idx) => {
    const ib = i.role === "operating";
    rows.push([
      mk(i.branch, ib ? ST_IB_TEXT : zebra(ST_TEXT, idx % 2 === 1)),
      ...invoiceCells(i, idx % 2 === 1, ib),
      mk(
        ib
          ? `Excluded — source: ${i.otherBranch}`
          : i.role === "source"
            ? `Counted — operated at ${i.otherBranch}`
            : "",
        ib ? ST_IB_TEXT : zebra(ST_TEXT, idx % 2 === 1),
      ),
    ]);
  });
  const ws = xlsx.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 18 },
    { wch: 11 },
    { wch: 24 },
    { wch: 13 },
    { wch: 14 },
    { wch: 24 },
    { wch: 20 },
    { wch: 13 },
    { wch: 10 },
    { wch: 14 },
    { wch: 13 },
    { wch: 13 },
    { wch: 30 },
  ];
  ws["!freeze"] = { xSplit: 1, ySplit: 1 };
  ws["!autofilter"] = {
    ref: xlsx.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: Math.max(rows.length - 1, 1), c: head.length - 1 },
    }),
  };
  ws["!rows"] = [{ hpt: 28 }];
  return ws;
}

/* ── Main ────────────────────────────────────────────────────────────────── */

async function generateIPDDueAgingExcel(options = {}) {
  const status = (options.status || "").trim();
  const wanted =
    Array.isArray(options.locations) && options.locations.length
      ? options.locations
      : ALL_LOCATIONS.slice();

  // Pre-flight: one tiny query against the first branch. If the DB host is
  // unreachable from this machine there is no point queueing forty timeouts.
  {
    const first = wanted[0];
    const conn = tunePool(first);
    if (!conn) throw new Error(`Unknown branch: ${first}`);
    try {
      await withRetry(`pre-flight (${first})`, () =>
        runQuery(conn, "SELECT 1", []),
      );
      console.log(`  ✓ database host reachable (checked via ${first})`);
    } catch (e) {
      throw new Error(
        `Cannot reach the branch database host (${e.code || "error"}: ${e.message}). ` +
          "Check that this machine can reach the MySQL server (network / VPN / IP whitelist) — " +
          "or run the script on the backend server itself — then try again.",
      );
    }
  }

  const results = [];
  for (let i = 0; i < wanted.length; i += BATCH) {
    const slice = wanted.slice(i, i + BATCH);
    const settled = await Promise.all(
      slice.map(async (branch) => {
        try {
          const d = await withRetry(branch, () => readBranch(branch, status));
          return { branch, ok: true, ...d };
        } catch (err) {
          console.error(`  ✗ ${branch}: ${err.message}`);
          return { branch, ok: false, error: err.message };
        }
      }),
    );
    results.push(...settled);
    console.log(`  … ${results.length}/${wanted.length} branches read`);
  }

  const good = results.filter((r) => r.ok);
  if (!good.length) throw new Error("No branch could be read");

  const asOf = todayIST();
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(
    wb,
    summarySheet(results, asOf, status),
    "Summary",
  );
  xlsx.utils.book_append_sheet(wb, allInvoicesSheet(results), "All Invoices");
  const used = new Set(["Summary", "All Invoices"]);
  good
    .sort((a, b) => summarise(b.counted).due - summarise(a.counted).due)
    .forEach((r) =>
      xlsx.utils.book_append_sheet(
        wb,
        branchSheet(r, asOf),
        sheetName(r.branch, used),
      ),
    );

  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const fileName = `IPD_Due_Aging_AllBranches_${asOf}${status ? `_${status}` : ""}.xlsx`;
  const filePath = path.join(reportsDir, fileName);
  xlsx.writeFile(wb, filePath);

  const all = good.flatMap((r) => r.counted);
  const allIB = good.flatMap((r) => r.excluded);
  return {
    filePath,
    branchesProcessed: good.length,
    branchesRequested: wanted.length,
    failed: results
      .filter((r) => !r.ok)
      .map((r) => ({ location: r.branch, error: r.error })),
    totals: summarise(all),
    interbranch: summarise(allIB),
  };
}

module.exports = { generateIPDDueAgingExcel };

/* ── Standalone runner ───────────────────────────────────────────────────── */

if (require.main === module) {
  const locations = (process.argv[2] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const status = process.argv[3] || "";

  (async () => {
    const t0 = Date.now();
    const inr = (n) => Math.round(Number(n) || 0).toLocaleString("en-IN");
    console.log("──────────────────────────────────────────────────────────");
    console.log("IPD Due List with Aging — all branches (temporary runner)");
    console.log(
      `Branches : ${locations.length ? locations.join(", ") : "all"}`,
    );
    if (status) console.log(`Status   : ${status}`);
    console.log("──────────────────────────────────────────────────────────");

    try {
      const r = await generateIPDDueAgingExcel({ locations, status });
      console.log(`\n✅ Workbook written: ${r.filePath}`);
      console.log(
        `   ${r.branchesProcessed} of ${r.branchesRequested} branches`,
      );
      console.log(
        `\n   Total due        ₹ ${inr(r.totals.due).padStart(14)}   ${r.totals.invoices} invoices · ${r.totals.patients} patients`,
      );
      BUCKETS.forEach((b) =>
        console.log(
          `   ${b.label.padEnd(16)} ₹ ${inr(r.totals.buckets[b.key].due).padStart(14)}   ${r.totals.buckets[b.key].count} invoices`,
        ),
      );
      console.log(
        `   [interbranch excluded: ₹ ${inr(r.interbranch.due)} across ${r.interbranch.invoices} invoices — counted at their source branch]`,
      );
      r.failed.forEach((f) => console.log(`   ✗ ${f.location}: ${f.error}`));
      console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      process.exit(r.failed.length ? 1 : 0);
    } catch (err) {
      console.error(`\n❌ ${err.message}`);
      process.exit(2);
    }
  })();
}
