/**
 * tmp_generateApprovalRecords.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * Exports the daily sign-off RECORDS from each branch's `approval` table to
 * Excel, for the branches and date range given on the command line.
 *
 * ── Run (from the project root) ─────────────────────────────────────────────
 *   node temp/tmp_generateApprovalRecords.js "<locations>" <from> <to>
 *
 *   node temp/tmp_generateApprovalRecords.js "DP Road,Baner,Undri" 2026-09-01 2026-09-30
 *   node temp/tmp_generateApprovalRecords.js "Hinjewadi" 2026-10-01 2026-10-23
 *   node temp/tmp_generateApprovalRecords.js ALL 2026-04-01 2026-09-30
 *
 *   locations  comma-separated branch names exactly as getConnectionByLocation
 *              knows them (quote the list — names have spaces), or ALL
 *   from / to  YYYY-MM-DD, inclusive
 *
 * ── What the table holds (approvalModel.js) ─────────────────────────────────
 *   One row per DATE: `date`, `user1` = Partner/Owner who approved, `user2` =
 *   Cluster Head who approved (NULL = not yet). addApprovalDetails writes it
 *   for YESTERDAY's date, and only when someone signs off — so a day nobody
 *   approved has NO ROW at all.
 *
 * ── Workbook: src/report/Approval_Records_<from>_to_<to>.xlsx ───────────────
 *   1. Approval records   every row in range, every column of the table
 *                         (Branch · Date · Partner · Cluster Head · status,
 *                         then any other columns the table has, e.g. id)
 *   2. Summary            per branch: days in period, rows found, Partner and
 *                         Cluster Head approved / not approved
 *   3. Not approved days  every branch × day missing a Partner and/or Cluster
 *                         Head sign-off — INCLUDING days with no row (counted
 *                         from the calendar, as the summary does)
 *
 *   A branch that cannot be read (unknown name, DB unreachable, no `approval`
 *   table) is still listed in the Summary with the error, so it is never
 *   silently missing.
 *
 * Read-only: SELECTs only.
 * DELETE THIS FILE once the workbook has been generated.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx-js-style");

const ROOT = path.resolve(__dirname, "..");
const { getConnectionByLocation } = require(path.join(ROOT, "databaseUtils"));
const { harden, preflight, getRetriesUsed } = require("./_dbResilience");

/* ── Arguments ───────────────────────────────────────────────────────────── */

// Same list as tmp_generateApprovalStatusReport_Jun_Aug.js (copied from
// targetComparisonNewModel.js DEFAULT_LOCATIONS) — used only for ALL.
const DEFAULT_LOCATIONS = [
  "DP Road", "Andheri", "Baner", "Belgavi", "Chakan", "Chinchwad", "Dighi",
  "Gurgaon Sector 14", "Gurgaon Sector 49", "Hinjewadi", "HSR", "Hyderabad",
  "Indiranagar", "JP Nagar", "Kalaburagi", "Latur", "Ludhiana", "Lucknow",
  "Mysore", "Nashik", "Navi Mumbai", "Salunke Vihar", "Sahakar Nagar",
  "Secunderabad", "Surat", "Thane", "Undri", "Vashi", "Rajaji Nagar",
  "Sarjapura", "Katraj", "Ahmedabad", "Mohali", "Aurangabad", "Whitefield",
  "Hadapsar", "Kalyan", "Bopal", "Electronic City", "RR Nagar", "Adajan",
  "Raipur",
];

const USAGE =
  'Usage: node temp/tmp_generateApprovalRecords.js "<branch1,branch2,...|ALL>" <from YYYY-MM-DD> <to YYYY-MM-DD>\n' +
  'Example: node temp/tmp_generateApprovalRecords.js "DP Road,Baner" 2026-09-01 2026-09-30';

const [, , locArg, FROM, TO] = process.argv;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

if (!locArg || !FROM || !TO) {
  console.error(USAGE);
  process.exit(1);
}
if (!ISO.test(FROM) || !ISO.test(TO) || FROM > TO) {
  console.error(`Bad date range: ${FROM} → ${TO} (expected YYYY-MM-DD, from ≤ to)\n${USAGE}`);
  process.exit(1);
}

const LOCATIONS =
  locArg.trim().toUpperCase() === "ALL"
    ? DEFAULT_LOCATIONS
    : [...new Set(locArg.split(",").map((s) => s.trim()).filter(Boolean))];

if (!LOCATIONS.length) {
  console.error(`No branches given.\n${USAGE}`);
  process.exit(1);
}

/** Every date in [FROM, TO] as YYYY-MM-DD (UTC arithmetic — no TZ drift). */
const CALENDAR = (() => {
  const out = [];
  for (let t = Date.parse(`${FROM}T00:00:00Z`); t <= Date.parse(`${TO}T00:00:00Z`); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
})();
const DAYS = CALENDAR.length;

const reportsDir = path.join(ROOT, "src", "report");
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

/* ── SQL ─────────────────────────────────────────────────────────────────── */

// DATE_FORMAT gives a stable 'YYYY-MM-DD' whether `date` is a DATE or the
// 'YYYY-MM-DD' string approvalModel writes, so the driver never hands back a
// JS Date shifted by the server's timezone. SELECT * keeps every other column.
const SQL = `
  SELECT DATE_FORMAT(\`date\`, '%Y-%m-%d') AS _approval_date, a.*
  FROM approval a
  WHERE \`date\` BETWEEN ? AND ?
  ORDER BY \`date\` ASC
`;

const blank = (v) => v == null || String(v).trim() === "";

/** Any remaining value → something Excel shows sensibly. */
const cell = (v) => {
  if (v == null) return "";
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
  }
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  return v;
};

async function readBranch(loc) {
  const { connection } = getConnectionByLocation(loc) || {};
  if (!connection) throw new Error("unknown branch name (no DB connection)");
  return new Promise((res, rej) =>
    connection.query(SQL, [FROM, TO], (e, r) => (e ? rej(e) : res(r))),
  );
}

/* ── Styles ──────────────────────────────────────────────────────────────── */

const BRAND = "14603F";
const S = {
  title: { font: { bold: true, sz: 14, color: { rgb: BRAND } } },
  note: { font: { italic: true, sz: 9, color: { rgb: "6C7C75" } } },
  head: {
    font: { bold: true, color: { rgb: "FFFFFF" } },
    fill: { fgColor: { rgb: BRAND } },
    alignment: { vertical: "center", wrapText: true },
    border: { bottom: { style: "thin", color: { rgb: "0F1A16" } } },
  },
  ok: { font: { color: { rgb: "1E7A5A" } } },
  bad: { font: { color: { rgb: "B3382B" } } },
  total: { font: { bold: true }, fill: { fgColor: { rgb: "EEF2EF" } } },
  err: { font: { color: { rgb: "B3382B" }, italic: true } },
};

/** aoa → sheet with title, note, styled header row, widths and frozen header. */
function sheet({ title, note, headers, rows, widths, styleRow }) {
  const aoa = [[title], [note], [], headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const last = headers.length - 1;
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: last } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: last } },
  ];
  ws["!cols"] = widths.map((wch) => ({ wch }));
  ws["!views"] = [{ state: "frozen", ySplit: 4 }];
  ws["!autofilter"] = {
    ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3 + rows.length, c: last } }),
  };

  const set = (r, c, s) => {
    const a = XLSX.utils.encode_cell({ r, c });
    if (ws[a]) ws[a].s = { ...(ws[a].s || {}), ...s };
  };
  set(0, 0, S.title);
  set(1, 0, S.note);
  headers.forEach((_, c) => set(3, c, S.head));
  rows.forEach((row, i) => {
    const styles = styleRow ? styleRow(row, i) : null;
    if (!styles) return;
    for (const [c, s] of Object.entries(styles)) set(4 + i, Number(c), s);
  });
  return ws;
}

/* ── Main ────────────────────────────────────────────────────────────────── */

(async () => {
  console.log(`Approval records ${FROM} → ${TO} (${DAYS} days), ${LOCATIONS.length} branch(es)`);

  const { unknown, maxConcurrent } = harden(LOCATIONS);
  if (unknown.length) console.log(`  ⚠ unknown branch name(s), will be reported: ${unknown.join(", ")}`);
  console.log(`  (DB: 30 s connect timeout, ≤${maxConcurrent} queries at once, transient errors retried)`);

  const firstKnown = LOCATIONS.find((l) => !unknown.includes(l));
  if (firstKnown) await preflight(firstKnown);

  const results = [];
  const extraCols = new Set(); // table columns beyond date / user1 / user2

  for (const branch of LOCATIONS) {
    try {
      const rows = (await readBranch(branch)).filter(
        // Belt and braces: drop anything outside the range or undated.
        (r) => r._approval_date && r._approval_date >= FROM && r._approval_date <= TO,
      );
      for (const r of rows) {
        for (const k of Object.keys(r)) {
          if (!["_approval_date", "date", "user1", "user2"].includes(k)) extraCols.add(k);
        }
      }
      results.push({ branch, rows });

      const partner = new Set(rows.filter((r) => !blank(r.user1)).map((r) => r._approval_date)).size;
      const ch = new Set(rows.filter((r) => !blank(r.user2)).map((r) => r._approval_date)).size;
      console.log(
        `  ✓ ${branch.padEnd(20)} ${String(rows.length).padStart(4)} rows · partner ${String(partner).padStart(3)}/${DAYS} · cluster head ${String(ch).padStart(3)}/${DAYS}`,
      );
    } catch (e) {
      results.push({ branch, error: e.message });
      console.log(`  ✗ ${branch.padEnd(20)} ${e.message}`);
    }
  }

  const extras = [...extraCols];

  /* 1. Approval records ─────────────────────────────────────────────────── */
  const recHeaders = [
    "Branch",
    "Date",
    "Partner (user1)",
    "Partner status",
    "Cluster Head (user2)",
    "Cluster Head status",
    ...extras,
  ];
  const recRows = [];
  for (const r of results) {
    if (r.error) continue;
    for (const x of r.rows) {
      recRows.push([
        r.branch,
        x._approval_date,
        blank(x.user1) ? "" : cell(x.user1),
        blank(x.user1) ? "Not approved" : "Approved",
        blank(x.user2) ? "" : cell(x.user2),
        blank(x.user2) ? "Not approved" : "Approved",
        ...extras.map((k) => cell(x[k])),
      ]);
    }
  }
  const wsRecords = sheet({
    title: `Approval records — ${FROM} to ${TO}`,
    note:
      "One row per row in each branch's `approval` table. user1 = Partner/Owner, user2 = Cluster Head; " +
      "blank = not approved. Days with no row at all are listed on 'Not approved days'.",
    headers: recHeaders,
    rows: recRows,
    widths: [22, 12, 24, 14, 24, 18, ...extras.map(() => 16)],
    styleRow: (row) => ({
      3: row[3] === "Approved" ? S.ok : S.bad,
      5: row[5] === "Approved" ? S.ok : S.bad,
    }),
  });

  /* 2. Summary ──────────────────────────────────────────────────────────── */
  const sumHeaders = [
    "Branch",
    "Days in period",
    "Rows found",
    "Partner — Approved",
    "Partner — Not approved",
    "Cluster Head — Approved",
    "Cluster Head — Not approved",
    "Both approved (days)",
    "Note",
  ];
  const tot = { days: 0, rows: 0, p: 0, c: 0, both: 0, n: 0 };
  const sumRows = results.map((r) => {
    if (r.error) return [r.branch, DAYS, "", "", "", "", "", "", `Not read: ${r.error}`];
    // A date counts once even if it somehow has two rows.
    const byDay = new Map();
    for (const x of r.rows) {
      const d = byDay.get(x._approval_date) || { p: false, c: false };
      if (!blank(x.user1)) d.p = true;
      if (!blank(x.user2)) d.c = true;
      byDay.set(x._approval_date, d);
    }
    const days = [...byDay.values()];
    const p = days.filter((d) => d.p).length;
    const c = days.filter((d) => d.c).length;
    const both = days.filter((d) => d.p && d.c).length;
    tot.days += DAYS;
    tot.rows += r.rows.length;
    tot.p += p;
    tot.c += c;
    tot.both += both;
    tot.n += 1;
    return [r.branch, DAYS, r.rows.length, p, DAYS - p, c, DAYS - c, both, ""];
  });
  sumRows.push([
    `Total (${tot.n} branch${tot.n === 1 ? "" : "es"} read)`,
    tot.days,
    tot.rows,
    tot.p,
    tot.days - tot.p,
    tot.c,
    tot.days - tot.c,
    tot.both,
    "",
  ]);
  const wsSummary = sheet({
    title: `Approval summary — ${FROM} to ${TO} (${DAYS} days)`,
    note:
      "Not approved = days in period − approved days, so days with no approval row count as not approved. " +
      "Branches that could not be read are excluded from the total.",
    headers: sumHeaders,
    rows: sumRows,
    widths: [26, 14, 12, 18, 22, 22, 26, 20, 44],
    styleRow: (row, i) =>
      i === sumRows.length - 1
        ? Object.fromEntries(sumHeaders.map((_, c) => [c, S.total]))
        : row[8]
        ? { 8: S.err }
        : null,
  });

  /* 3. Not approved days ────────────────────────────────────────────────── */
  const gapRows = [];
  for (const r of results) {
    if (r.error) continue;
    const byDay = new Map();
    for (const x of r.rows) {
      const d = byDay.get(x._approval_date) || { p: false, c: false, row: true };
      if (!blank(x.user1)) d.p = true;
      if (!blank(x.user2)) d.c = true;
      byDay.set(x._approval_date, d);
    }
    for (const day of CALENDAR) {
      const d = byDay.get(day) || { p: false, c: false, row: false };
      if (d.p && d.c) continue;
      gapRows.push([
        r.branch,
        day,
        d.p ? "Approved" : "Missing",
        d.c ? "Approved" : "Missing",
        d.row ? "" : "No approval row for this date",
      ]);
    }
  }
  const wsGaps = sheet({
    title: `Days not fully approved — ${FROM} to ${TO}`,
    note: "Every branch × day missing a Partner and/or Cluster Head sign-off, including days with no row.",
    headers: ["Branch", "Date", "Partner", "Cluster Head", "Note"],
    rows: gapRows,
    widths: [22, 12, 12, 14, 32],
    styleRow: (row) => ({
      2: row[2] === "Approved" ? S.ok : S.bad,
      3: row[3] === "Approved" ? S.ok : S.bad,
    }),
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsRecords, "Approval records");
  XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");
  XLSX.utils.book_append_sheet(wb, wsGaps, "Not approved days");

  const file = path.join(reportsDir, `Approval_Records_${FROM}_to_${TO}.xlsx`);
  XLSX.writeFile(wb, file);

  const failed = results.filter((r) => r.error).length;
  console.log(`\nWritten: ${file}`);
  console.log(`  ${recRows.length} record(s) · ${gapRows.length} day(s) not fully approved`);
  if (failed) console.log(`⚠ ${failed} branch(es) not read — see the Note column on Summary.`);
  if (getRetriesUsed()) console.log(`  (${getRetriesUsed()} transient DB error(s) retried — see ↻ lines)`);

  // The DB pools keep the event loop alive; exit explicitly.
  process.exit(0);
})().catch((e) => {
  console.error("Failed:", e.message || e);
  process.exit(1);
});
