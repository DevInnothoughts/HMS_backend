/**
 * tmp_generateTicketSummaryReport.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * Department-wise summary of helpdesk tickets across branches, till date.
 *
 *      Department Summary   one row per department, all branches combined
 *      Dept × Branch        each department broken out by branch, with a
 *                           subtotal row per department
 *      Branch Summary       one row per branch, all departments combined
 *
 * ── WHAT EACH COLUMN MEANS ──────────────────────────────────────────────────
 * Read straight from serviceTicketing.ticket (is_deleted = 0), bucketed so
 * every ticket lands in exactly ONE of the four status columns:
 *
 *   Raised     every ticket                                   (= sum of next 4)
 *   Resolved   status 'Resolved' — the department has fixed it, the branch
 *              has not closed it yet
 *   Closed     status 'Closed'  — finished and confirmed by the raiser
 *   Pending    everything still in the workflow: Open, Approved, Reopened,
 *              Assigned, In Progress, On Hold, Pending Approval,
 *              With Branch, Branch Fixed
 *   Sent Back  rejected by the Cluster Head — never became work, so it is kept
 *              out of Pending and out of the Closure % denominator (same rule
 *              as getDashboard's closurePct)
 *
 *   Overdue    the subset of Pending that is past due_at — the same LATE_SQL
 *              definition the dashboard uses (Resolved is never overdue)
 *   Closure %  Closed ÷ (Raised − Sent Back)
 *   Done %     (Resolved + Closed) ÷ (Raised − Sent Back)
 *
 * Department "N/A" is the unrouted bucket (raised without a department and not
 * yet routed by a Cluster Head); it is shown as "Unrouted (N/A)".
 *
 * ── Place this file in temp/ ────────────────────────────────────────────────
 * (alongside the other tmp_* runners) — the output dir matches theirs.
 *
 * ── Call it from app.js ─────────────────────────────────────────────────────
 *   const { generateTicketSummaryExcel } = require("./temp/tmp_generateTicketSummaryReport");
 *
 *   generateTicketSummaryExcel()                       // all time, till today
 *     .then(r => console.log("Ticket summary:", r.filePath))
 *     .catch(e => console.error("Ticket summary failed:", e.message));
 *
 *   // optional window on raised_at (inclusive, YYYY-MM-DD):
 *   generateTicketSummaryExcel({ from: "2026-04-01", to: "2026-10-27" })
 *
 * ── Or run it standalone ────────────────────────────────────────────────────
 *   node temp/tmp_generateTicketSummaryReport.js
 *   node temp/tmp_generateTicketSummaryReport.js --from 2026-04-01 --to 2026-10-27
 *
 * ── Output ──────────────────────────────────────────────────────────────────
 *   src/report/Ticket_Summary_<YYYY-MM-DD>.xlsx
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx-js-style");
const { getConnectionByLocation } = require("../databaseUtils");

/* ── Config ──────────────────────────────────────────────────────────────── */

const TICKETING_DB_KEY = "ticketing"; // databaseUtils → createPool("serviceTicketing")
const UNASSIGNED_DEPARTMENT = "N/A";
const UNASSIGNED_LABEL = "Unrouted (N/A)";

const reportsDir = path.join(__dirname, "..", "src", "report");

/* ── Palette (matches the other tmp_* reports) ───────────────────────────── */

const INK = "0F1A16";
const BRAND = "184D67";
const BAND_HEAD = "2A4438";
const GREEN = "1E7A5A";
const GREEN_SOFT = "E7F2EC";
const AMBER = "B26A00";
const AMBER_SOFT = "FBF0DD";
const RED = "B3382B";
const RED_SOFT = "F8E6E3";
const GREY = "9AA5B1";
const ZEBRA = "F7F9F8";

const THIN = { style: "thin", color: { rgb: "D9E0DC" } };
const BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };

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
const ST_LABEL = {
  font: { sz: 10, color: { rgb: "16211D" } },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER,
};
const ST_LABEL_ALT = { ...ST_LABEL, fill: { fgColor: { rgb: ZEBRA } } };
const ST_NUM = { ...ST_LABEL, alignment: { horizontal: "center", vertical: "center" } };
const ST_NUM_ALT = { ...ST_NUM, fill: { fgColor: { rgb: ZEBRA } } };
const ST_DEPT_BAND = {
  font: { bold: true, sz: 10, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: BAND_HEAD } },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER,
};
const ST_TOTAL = {
  font: { bold: true, sz: 10, color: { rgb: "16211D" } },
  fill: { fgColor: { rgb: "EDF2EF" } },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER,
};
const ST_TOTAL_NUM = { ...ST_TOTAL, alignment: { horizontal: "center", vertical: "center" } };
const ST_NOTE = {
  font: { italic: true, sz: 9, color: { rgb: "5B6670" } },
  alignment: { horizontal: "left", vertical: "top", wrapText: true },
};

// Coloured cells for the status columns: soft fill when the number is > 0.
const tint = (base, fg, bg) => ({
  ...base,
  font: { ...base.font, bold: true, color: { rgb: fg } },
  fill: { fgColor: { rgb: bg } },
});

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, "0");
const toYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const num = (v) => Number(v) || 0;
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

const deptLabel = (d) => {
  const s = String(d ?? "").trim();
  if (!s) return "(blank)";
  return s === UNASSIGNED_DEPARTMENT ? UNASSIGNED_LABEL : s;
};
const branchLabel = (b) => String(b ?? "").trim() || "(blank)";

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

function query(sql, params = []) {
  const { connection } = getConnectionByLocation(TICKETING_DB_KEY);
  if (!connection) {
    throw new Error(
      "serviceTicketing database not reachable — check the `ticketing` case in databaseUtils.js",
    );
  }
  return new Promise((resolve, reject) =>
    connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))),
  );
}

/* ── Data ────────────────────────────────────────────────────────────────── */

/**
 * One row per (department, branch) with the bucket counts. Buckets are
 * mutually exclusive so Raised = Resolved + Closed + Pending + Sent Back.
 */
async function readCounts({ from, to } = {}) {
  const where = ["t.is_deleted = 0"];
  const params = [];
  if (from) {
    where.push("t.raised_at >= ?");
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    where.push("t.raised_at <= ?");
    params.push(`${to} 23:59:59`);
  }

  const rows = await query(
    `SELECT
        t.department,
        t.branch_name,
        COUNT(*)                                                     AS raised,
        SUM(t.status = 'Resolved')                                   AS resolved,
        SUM(t.status = 'Closed')                                     AS closed,
        SUM(t.status = 'Sent Back')                                  AS sentBack,
        SUM(t.status NOT IN ('Resolved','Closed','Sent Back'))       AS pending,
        SUM(t.status NOT IN ('Closed','Sent Back','Resolved')
            AND t.due_at < NOW())                                    AS overdue,
        MIN(t.raised_at)                                             AS firstRaised,
        MAX(t.raised_at)                                             AS lastRaised
       FROM ticket t
      WHERE ${where.join(" AND ")}
      GROUP BY t.department, t.branch_name`,
    params,
  );

  return rows.map((r) => ({
    department: deptLabel(r.department),
    branch: branchLabel(r.branch_name),
    raised: num(r.raised),
    resolved: num(r.resolved),
    closed: num(r.closed),
    pending: num(r.pending),
    sentBack: num(r.sentBack),
    overdue: num(r.overdue),
    firstRaised: r.firstRaised ? new Date(r.firstRaised) : null,
    lastRaised: r.lastRaised ? new Date(r.lastRaised) : null,
  }));
}

const METRICS = ["raised", "resolved", "closed", "pending", "sentBack", "overdue"];

function emptyAgg() {
  return METRICS.reduce((a, k) => ((a[k] = 0), a), {});
}
function addInto(agg, row) {
  METRICS.forEach((k) => (agg[k] += row[k]));
  return agg;
}

function rollUp(rows, keyFn) {
  const map = new Map();
  rows.forEach((r) => {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, emptyAgg());
    addInto(map.get(k), r);
  });
  return map;
}

// Unrouted and blank always sink to the bottom; otherwise most-pending first.
const sortKeys = (map) =>
  [...map.keys()].sort((a, b) => {
    const sinkA = a === UNASSIGNED_LABEL || a === "(blank)";
    const sinkB = b === UNASSIGNED_LABEL || b === "(blank)";
    if (sinkA !== sinkB) return sinkA ? 1 : -1;
    const d = map.get(b).pending - map.get(a).pending;
    if (d) return d;
    const r = map.get(b).raised - map.get(a).raised;
    return r || a.localeCompare(b);
  });

/* ── Sheet building ──────────────────────────────────────────────────────── */

const HEADERS = [
  "Raised",
  "Resolved\n(awaiting close)",
  "Closed",
  "Pending",
  "Sent Back",
  "Overdue\n(of pending)",
  "Closure %",
  "Done %\n(Resolved + Closed)",
];

/** The 8 numeric cells for one aggregate, styled. */
function metricCells(a, { alt = false, total = false } = {}) {
  const base = total ? ST_TOTAL_NUM : alt ? ST_NUM_ALT : ST_NUM;
  const accountable = a.raised - a.sentBack;
  const closurePct = pct(a.closed, accountable);
  const donePct = pct(a.resolved + a.closed, accountable);

  const colour = (v, fg, bg) => (v > 0 && !total ? tint(base, fg, bg) : base);
  const pctStyle = (p) => {
    if (p === null || total) return { ...base, numFmt: "0.0\"%\"" };
    const [fg, bg] = p >= 90 ? [GREEN, GREEN_SOFT] : p >= 60 ? [AMBER, AMBER_SOFT] : [RED, RED_SOFT];
    return { ...tint(base, fg, bg), numFmt: "0.0\"%\"" };
  };

  return [
    mk(a.raised, { ...base, font: { ...base.font, bold: true } }),
    mk(a.resolved, colour(a.resolved, AMBER, AMBER_SOFT)),
    mk(a.closed, colour(a.closed, GREEN, GREEN_SOFT)),
    mk(a.pending, colour(a.pending, BRAND, "E4EEF3")),
    mk(a.sentBack, a.sentBack > 0 && !total ? { ...base, font: { ...base.font, color: { rgb: GREY } } } : base),
    mk(a.overdue, colour(a.overdue, RED, RED_SOFT)),
    closurePct === null ? mk("—", base) : mk(closurePct, pctStyle(closurePct)),
    donePct === null ? mk("—", base) : mk(donePct, pctStyle(donePct)),
  ];
}

function titleRows(title, subtitle, width) {
  const blank = (s) => Array.from({ length: width - 1 }, () => mk("", s));
  return [
    [mk(title, ST_TITLE), ...blank(ST_TITLE)],
    [mk(subtitle, ST_SUBTITLE), ...blank(ST_SUBTITLE)],
    Array.from({ length: width }, () => mk("", {})),
  ];
}

const NOTE =
  "Raised = Resolved + Closed + Pending + Sent Back. Resolved = fixed by the department, not yet closed by the branch. " +
  "Pending = still in the workflow (Open, Approved, Reopened, Assigned, In Progress, On Hold, Pending Approval, With Branch, Branch Fixed). " +
  "Overdue = pending and past its due date. Closure % and Done % exclude Sent Back from the denominator.";

function finishSheet(aoa, { width, firstColWidths, headerRow, freezeCols }) {
  const noteRow = aoa.length + 1;
  aoa.push(Array.from({ length: width }, () => mk("", {})));
  aoa.push([mk(NOTE, ST_NOTE), ...Array.from({ length: width - 1 }, () => mk("", ST_NOTE))]);

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [...firstColWidths.map((wch) => ({ wch })), ...HEADERS.map(() => ({ wch: 13 }))];
  ws["!rows"] = [{ hpt: 26 }, { hpt: 18 }];
  ws["!rows"][headerRow] = { hpt: 32 };
  ws["!rows"][noteRow] = { hpt: 48 };
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: width - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: width - 1 } },
    { s: { r: noteRow, c: 0 }, e: { r: noteRow, c: width - 1 } },
  ];
  ws["!freeze"] = { xSplit: freezeCols, ySplit: headerRow + 1 };
  return { ws, merges: ws["!merges"] };
}

function departmentSummarySheet(rows, subtitle) {
  const byDept = rollUp(rows, (r) => r.department);
  const branchesPerDept = new Map();
  rows.forEach((r) => {
    if (!branchesPerDept.has(r.department)) branchesPerDept.set(r.department, new Set());
    if (r.raised > 0) branchesPerDept.get(r.department).add(r.branch);
  });

  const width = 3 + HEADERS.length;
  const aoa = titleRows("Ticket Summary — Department-wise", subtitle, width);
  const headerRow = aoa.length;
  aoa.push(["#", "Department", "Branches\nraising", ...HEADERS].map((h) => mk(h, ST_HEAD)));

  const grand = emptyAgg();
  sortKeys(byDept).forEach((dept, i) => {
    const a = byDept.get(dept);
    addInto(grand, a);
    const alt = i % 2 === 1;
    const L = alt ? ST_LABEL_ALT : ST_LABEL;
    const N = alt ? ST_NUM_ALT : ST_NUM;
    aoa.push([mk(i + 1, N), mk(dept, L), mk(branchesPerDept.get(dept)?.size || 0, N), ...metricCells(a, { alt })]);
  });
  const allBranches = new Set(rows.map((r) => r.branch)).size;
  aoa.push([mk("", ST_TOTAL), mk("All departments", ST_TOTAL), mk(allBranches, ST_TOTAL_NUM), ...metricCells(grand, { total: true })]);

  const { ws } = finishSheet(aoa, { width, firstColWidths: [5, 28, 10], headerRow, freezeCols: 2 });
  return { ws, grand };
}

function deptBranchSheet(rows, subtitle) {
  const byDept = rollUp(rows, (r) => r.department);
  const width = 2 + HEADERS.length;
  const aoa = titleRows("Ticket Summary — Department × Branch", subtitle, width);
  const headerRow = aoa.length;
  aoa.push(["Department / Branch", "#", ...HEADERS].map((h) => mk(h, ST_HEAD)));

  const bandMerges = [];
  sortKeys(byDept).forEach((dept) => {
    // Department band
    const bandRow = aoa.length;
    aoa.push([mk(dept, ST_DEPT_BAND), ...Array.from({ length: width - 1 }, () => mk("", ST_DEPT_BAND))]);
    bandMerges.push({ s: { r: bandRow, c: 0 }, e: { r: bandRow, c: width - 1 } });

    const branchMap = rollUp(
      rows.filter((r) => r.department === dept),
      (r) => r.branch,
    );
    sortKeys(branchMap).forEach((branch, i) => {
      const alt = i % 2 === 1;
      aoa.push([
        mk(`   ${branch}`, alt ? ST_LABEL_ALT : ST_LABEL),
        mk(i + 1, alt ? ST_NUM_ALT : ST_NUM),
        ...metricCells(branchMap.get(branch), { alt }),
      ]);
    });
    aoa.push([mk(`${dept} — total`, ST_TOTAL), mk(branchMap.size, ST_TOTAL_NUM), ...metricCells(byDept.get(dept), { total: true })]);
  });

  const { ws } = finishSheet(aoa, { width, firstColWidths: [32, 5], headerRow, freezeCols: 1 });
  ws["!merges"].push(...bandMerges);
  return ws;
}

function branchSummarySheet(rows, subtitle) {
  const byBranch = rollUp(rows, (r) => r.branch);
  const width = 2 + HEADERS.length;
  const aoa = titleRows("Ticket Summary — Branch-wise (all departments)", subtitle, width);
  const headerRow = aoa.length;
  aoa.push(["#", "Branch", ...HEADERS].map((h) => mk(h, ST_HEAD)));

  const grand = emptyAgg();
  sortKeys(byBranch).forEach((branch, i) => {
    const a = byBranch.get(branch);
    addInto(grand, a);
    const alt = i % 2 === 1;
    aoa.push([mk(i + 1, alt ? ST_NUM_ALT : ST_NUM), mk(branch, alt ? ST_LABEL_ALT : ST_LABEL), ...metricCells(a, { alt })]);
  });
  aoa.push([mk("", ST_TOTAL), mk("All branches", ST_TOTAL), ...metricCells(grand, { total: true })]);

  const { ws } = finishSheet(aoa, { width, firstColWidths: [5, 26], headerRow, freezeCols: 2 });
  return ws;
}

/* ── Main ────────────────────────────────────────────────────────────────── */

/** Pure workbook builder — separated so it can be exercised without a DB. */
function buildWorkbook(rows, { from, to, today }) {
  const window = from || to ? `${from || "start"} to ${to || today}` : `All tickets till ${today}`;
  const subtitle = `${window}  ·  generated ${today}  ·  source: serviceTicketing.ticket`;

  const wb = xlsx.utils.book_new();
  const { ws: deptWs, grand } = departmentSummarySheet(rows, subtitle);
  xlsx.utils.book_append_sheet(wb, deptWs, "Department Summary");
  xlsx.utils.book_append_sheet(wb, deptBranchSheet(rows, subtitle), "Dept x Branch");
  xlsx.utils.book_append_sheet(wb, branchSummarySheet(rows, subtitle), "Branch Summary");
  return { wb, grand };
}

async function generateTicketSummaryExcel({ from = null, to = null } = {}) {
  if (from && !isYmd(from)) throw new Error(`from must be YYYY-MM-DD, got "${from}"`);
  if (to && !isYmd(to)) throw new Error(`to must be YYYY-MM-DD, got "${to}"`);

  const today = toYmd(new Date());
  const rows = await readCounts({ from, to });
  const { wb, grand } = buildWorkbook(rows, { from, to, today });

  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const suffix = from || to ? `${from || "start"}_to_${to || today}` : today;
  const fileName = `Ticket_Summary_${suffix}.xlsx`;
  const filePath = path.join(reportsDir, fileName);
  xlsx.writeFile(wb, filePath);

  return {
    filePath,
    fileName,
    departments: new Set(rows.map((r) => r.department)).size,
    branches: new Set(rows.map((r) => r.branch)).size,
    ...grand,
  };
}

module.exports = { generateTicketSummaryExcel, buildWorkbook };

/* ── Standalone runner ───────────────────────────────────────────────────── */

if (require.main === module) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : null;
  };
  const from = arg("from");
  const to = arg("to");

  (async () => {
    const t0 = Date.now();
    console.log("──────────────────────────────────────────────────────────");
    console.log("Ticket Summary (Department × Branch) → Excel (temporary runner)");
    console.log(`Window   : ${from || to ? `${from || "start"} → ${to || "today"}` : "all time, till date"}`);
    console.log("──────────────────────────────────────────────────────────");

    try {
      const r = await generateTicketSummaryExcel({ from, to });
      console.log(`\n✅ Workbook written: ${r.filePath}`);
      console.log(`   ${r.departments} departments, ${r.branches} branches`);
      console.log(
        `   Raised ${r.raised} · Resolved ${r.resolved} · Closed ${r.closed} · ` +
          `Pending ${r.pending} (overdue ${r.overdue}) · Sent back ${r.sentBack}`,
      );
      console.log(`   ${Math.round((Date.now() - t0) / 1000)}s`);
      // mysql pools keep the event loop alive — exit explicitly.
      process.exit(0);
    } catch (err) {
      console.error(`\n❌ ${err.message}`);
      process.exit(2);
    }
  })();
}
