/**
 * tmp_generateSurgeryPendingReport.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * Patients advised surgery in the last two months who have NOT been operated.
 * A follow-up call list.
 *
 *      Summary        one row per branch: advised, converted, pending, rate
 *      <Branch>       every pending patient, oldest advice first
 *
 * ── ⚠️ HOW "SURGERY ADVISED" IS DECIDED ─────────────────────────────────────
 * convincingScoreModel and DoctorPerformanceModel both classify with:
 *
 *      advice !== "medication"  →  Surgery
 *
 * That sweeps in Test, MCDPA, NULL and blank. For a score it inflates a number;
 * for a CALL LIST it means phoning patients who were never advised surgery.
 *
 * So STRICT_SURGERY (default true) matches advice beginning with "surgery"
 * instead. Set it false to reproduce the legacy behaviour exactly — the row
 * counts will then match the Convincing Score screen. Either way, the raw
 * diagnosisAdvice is printed in its own column so every row can be checked.
 *
 * ── LATEST DIAGNOSIS WINS ───────────────────────────────────────────────────
 * Rows are ordered date-ascending and the last one per patient is kept, which
 * is what convincingScoreModel and DoctorPerformanceModel both do. A patient
 * advised surgery in June and switched to medication in July is NOT on this
 * list, because their current advice is medication.
 *
 * ── "NOT OPERATED" MEANS NO INVOICE AT ALL ──────────────────────────────────
 * The models check for an invoice inside the reporting window. That is wrong
 * for a chase list: a patient advised in July and operated last week would
 * reappear as pending on a June–July run. Here a patient is excluded if they
 * have ANY non-deleted invoice from their diagnosis date up to today.
 *
 * ── Place this file in temp/ ────────────────────────────────────────────────
 * (alongside the other tmp_* runners) — it requires ../databaseUtils.
 *
 * ── ⚠️ REQUIRES xlsx-js-style, NOT xlsx ─────────────────────────────────────
 *      npm i xlsx-js-style
 * Plain `xlsx` accepts the style property and drops it on write — the workbook
 * comes out unformatted with no error.
 *
 * ── Call it from app.js ─────────────────────────────────────────────────────
 *   const {
 *     generateSurgeryPendingExcel,
 *   } = require("./temp/tmp_generateSurgeryPendingReport");
 *
 *   generateSurgeryPendingExcel({ locations })
 *     .then(r => console.log("Pending surgery workbook:", r.filePath))
 *     .catch(e => console.error("Pending surgery failed:", e.message));
 *
 * ── Or run it standalone ────────────────────────────────────────────────────
 *   node temp/tmp_generateSurgeryPendingReport.js
 *   node temp/tmp_generateSurgeryPendingReport.js 2026-07-01 2026-08-31
 *   node temp/tmp_generateSurgeryPendingReport.js 2026-07-01 2026-08-31 "Thane,Andheri"
 *
 * ── Output ──────────────────────────────────────────────────────────────────
 *   src/report/Surgery_Pending_<from>_to_<to>.xlsx
 *
 * ⚠️  Contains patient names, phone numbers and diagnoses. Share only over
 *     approved channels; delete the script and the workbook when done.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx-js-style");

const { getConnectionByLocation } = require("../databaseUtils");

/* ── Config ──────────────────────────────────────────────────────────────── */

// See the header. true = only explicit "Surgery"; false = legacy
// "anything that isn't medication".
const STRICT_SURGERY = true;

// Branches are read a few at a time — each is its own database with a pool
// capped at 5 connections, so firing forty at once just queues them up.
const BATCH = 4;

const reportsDir = path.join(__dirname, "..", "src", "report");

// databaseUtils exports only getConnectionByLocation; the branch names live in
// a switch. Same reason the other temp runners keep their own list.
// const ALL_LOCATIONS = [
//   "Andheri",
//   "Baner",
//   "Belgavi",
//   "Chakan",
//   "Chinchwad",
//   "Dighi",
//   "Gurgaon Sector 14",
//   "Gurgaon Sector 49",
//   "Hinjewadi",
//   "HSR",
//   "Hyderabad",
//   "Indiranagar",
//   "JP Nagar",
//   "Kalaburagi",
//   "Latur",
//   "Ludhiana",
//   "Lucknow",
//   "Mysore",
//   "Nashik",
//   "Navi Mumbai",
//   "Salunke Vihar",
//   "Sahakar Nagar",
//   "Secunderabad",
//   "Surat",
//   "Thane",
//   "Undri",
//   "Vashi",
//   "Rajaji Nagar",
//   "Sarjapura",
//   "Katraj",
//   "Ahmedabad",
//   "Mohali",
//   "Aurangabad",
//   "Whitefield",
//   "Hadapsar",
//   "Kalyan",
//   "Bopal",
//   "Electronic City",
//   "RR Nagar",
//   "Adajan",
//   "Raipur",
// ];
const ALL_LOCATIONS = ["Andheri", "Navi Mumbai", "Thane"];

/* ── Palette ─────────────────────────────────────────────────────────────── */

const INK = "0F1A16";
const BRAND = "B3523B"; // IPD rust — this is a surgery-conversion report
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
const ST_GROUP = {
  font: { bold: true, sz: 10, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: BAND_HEAD } },
  alignment: { horizontal: "center", vertical: "center" },
  border: BORDER,
};
const ST_LABEL = {
  font: { sz: 10, color: { rgb: "16211D" } },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER,
};
const ST_LABEL_ALT = { ...ST_LABEL, fill: { fgColor: { rgb: ZEBRA } } };
const ST_TOTAL = {
  font: { bold: true, sz: 10, color: { rgb: "16211D" } },
  fill: { fgColor: { rgb: "EDF2EF" } },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER,
};
const ST_TOTAL_NUM = {
  ...ST_TOTAL,
  alignment: { horizontal: "center", vertical: "center" },
};
const ST_NOTE = {
  font: { italic: true, sz: 9, color: { rgb: "6C7C75" } },
  alignment: { horizontal: "left", vertical: "center", wrapText: true },
};
const ST_DASH = {
  font: { sz: 10, color: { rgb: GREY } },
  alignment: { horizontal: "center", vertical: "center" },
  border: BORDER,
};

const centred = (extra = {}) => ({
  font: { sz: 10 },
  alignment: { horizontal: "center", vertical: "center" },
  border: BORDER,
  ...extra,
});

// Older advice is colder and less likely to convert — the call list is worked
// oldest-first, so age is the field that gets the colour.
const ageStyle = (days, alt) => {
  if (days == null)
    return alt ? { ...ST_DASH, fill: { fgColor: { rgb: ZEBRA } } } : ST_DASH;
  const [fg, bg] =
    days >= 45
      ? [RED, RED_SOFT]
      : days >= 21
        ? [AMBER, AMBER_SOFT]
        : [GREEN, GREEN_SOFT];
  return {
    font: { bold: days >= 45, sz: 10, color: { rgb: fg } },
    fill: { fgColor: { rgb: bg } },
    alignment: { horizontal: "center", vertical: "center" },
    border: BORDER,
  };
};

// Conversion: high is good, so the scale runs the other way from age.
const rateStyle = (pct) => {
  if (pct == null) return ST_DASH;
  const [fg, bg] =
    pct >= 60
      ? [GREEN, GREEN_SOFT]
      : pct >= 35
        ? [AMBER, AMBER_SOFT]
        : [RED, RED_SOFT];
  return {
    numFmt: '0"%"',
    font: { bold: true, sz: 10, color: { rgb: fg } },
    fill: { fgColor: { rgb: bg } },
    alignment: { horizontal: "center", vertical: "center" },
    border: BORDER,
  };
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const MONTHS = [
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

const pad2 = (n) => String(n).padStart(2, "0");
const toYmd = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const fmtDate = (d) => {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d).slice(0, 10);
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
};

const daysSince = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - dt.getTime()) / 86400000));
};

const clean = (v) => (v === null || v === undefined ? "" : String(v).trim());

// Excel sheet names: 31 chars max, none of : \ / ? * [ ]
const sheetName = (name, used) => {
  const base =
    String(name)
      .replace(/[:\\/?*[\]]/g, "-")
      .slice(0, 28)
      .trim() || "Branch";
  let candidate = base;
  let i = 2;
  while (used.has(candidate)) candidate = `${base.slice(0, 26)}-${i++}`;
  used.add(candidate);
  return candidate;
};

/**
 * diagnosisAdvice arrives as 'Surgery', 'Surgery,', 'Medication,', 'Test',
 * '', or NULL — the trailing comma is a storage artefact, so it is stripped
 * before matching, exactly as the models do.
 */
const isSurgeryAdvised = (raw) => {
  const advice = clean(raw).replace(/,$/, "").trim().toLowerCase();
  if (STRICT_SURGERY) return advice.startsWith("surgery");
  return advice !== "medication"; // legacy: everything else counts as surgery
};

const makeRunner =
  (connection) =>
  (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) =>
        err ? reject(err) : resolve(rows),
      ),
    );

/**
 * The `patient` table's name and phone columns are not identically named across
 * every branch database, and a SELECT on a missing column is a hard error that
 * kills the whole branch. So the columns are discovered once per branch and the
 * first match wins.
 */
async function patientColumns(run) {
  const cols = await run("SHOW COLUMNS FROM patient");
  const names = new Set(cols.map((c) => c.Field));
  const pick = (...candidates) => candidates.find((c) => names.has(c)) || null;
  return {
    name: pick("patient_name", "name", "pname", "full_name"),
    phone: pick("phone", "patient_phone", "mobile", "contact_no", "phone_no"),
    sex: pick("sex", "gender"),
    age: pick("age", "patient_age"),
    uid: pick("uid_no", "uid", "mr_no", "patient_uid"),
  };
}

/* ── Per-branch read ─────────────────────────────────────────────────────── */

async function readBranch(location, from, to) {
  const { connection } = getConnectionByLocation(location);
  if (!connection) throw new Error(`Invalid location: ${location}`);
  const run = makeRunner(connection);

  const c = await patientColumns(run);
  if (!c.name) throw new Error("`patient` has no recognisable name column");

  // Ascending, so the LAST row per patient is their latest diagnosis — the
  // same "latest wins" rule convincingScoreModel and DoctorPerformanceModel use.
  const diagRows = await run(
    `SELECT d.patient_id,
            d.date_diagnosis,
            d.diagnosisAdvice,
            d.speciality,
            d.provisionalDiagnosis,
            d.consultantDoctor,
            d.assistanceDoctor,
            cd.name AS consultantName,
            ad.name AS assistantName,
            p.${c.name} AS pname
            ${c.phone ? `, p.${c.phone} AS pphone` : ""}
            ${c.sex ? `, p.${c.sex} AS psex` : ""}
            ${c.age ? `, p.${c.age} AS page` : ""}
            ${c.uid ? `, p.${c.uid} AS puid` : ""}
       FROM diagnosis d
       LEFT JOIN doctor cd ON cd.doctor_id = d.consultantDoctor
       LEFT JOIN doctor ad ON ad.doctor_id = d.assistanceDoctor
       LEFT JOIN patient p ON p.patient_id = d.patient_id
      WHERE d.date_diagnosis >= ? AND d.date_diagnosis <= ?
      ORDER BY d.patient_id, d.date_diagnosis`,
    [from, to],
  );

  // Latest diagnosis per patient.
  const latest = new Map();
  for (const r of diagRows) latest.set(r.patient_id, r);

  const advised = [...latest.values()].filter((r) =>
    isSurgeryAdvised(r.diagnosisAdvice),
  );

  if (!advised.length) {
    return { location, advised: 0, converted: 0, pending: [], all: [] };
  }

  // Any non-deleted invoice from the window's start to TODAY, with its date.
  // The models look only inside the window; that would list a patient advised
  // in July and operated last week as still pending. MIN() gives the first
  // invoice, which is the one that closed the advice.
  const ids = advised.map((r) => r.patient_id);
  const placeholders = ids.map(() => "?").join(",");
  const invRows = await run(
    `SELECT patient_id, MIN(creation_date) AS firstInvoice
       FROM invoice
      WHERE patient_id IN (${placeholders})
        AND is_deleted != 1
        AND creation_date >= ?
      GROUP BY patient_id`,
    [...ids, from],
  );

  const operatedOn = new Map(
    invRows.map((r) => [r.patient_id, r.firstInvoice]),
  );

  const all = advised
    .map((r) => {
      const surgeryDate = operatedOn.get(r.patient_id) || null;
      return {
        patientId: r.patient_id,
        uid: clean(r.puid),
        name: clean(r.pname),
        phone: clean(r.pphone),
        sex: clean(r.psex),
        age: clean(r.page),
        diagnosisDate: r.date_diagnosis,
        days: daysSince(r.date_diagnosis),
        speciality: clean(r.speciality) || "Unspecified",
        advice: clean(r.diagnosisAdvice).replace(/,$/, "").trim() || "(blank)",
        consultant: clean(r.consultantName),
        assistant: clean(r.assistantName),
        operated: surgeryDate != null,
        surgeryDate,
      };
    })
    // Pending first, then oldest advice first within each group — that is the
    // order the list gets worked, with converted cases trailing for reference.
    .sort(
      (a, b) =>
        Number(a.operated) - Number(b.operated) ||
        (b.days ?? 0) - (a.days ?? 0),
    );

  const pending = all.filter((r) => !r.operated);

  return {
    location,
    advised: advised.length,
    converted: advised.length - pending.length,
    pending,
    all,
  };
}

/* ── Sheets ──────────────────────────────────────────────────────────────── */

function summarySheet(results, from, to) {
  const head = [
    "Branch",
    "Surgery advised",
    "Operated",
    "Pending",
    "Conversion",
    "Over 45 days",
    "Oldest (days)",
  ];

  const rows = [
    [mk("Surgery Advised — Not Yet Operated", ST_TITLE)],
    [mk(`Diagnosed ${fmtDate(from)} to ${fmtDate(to)}`, ST_SUBTITLE)],
    [],
    head.map((h) => mk(h, ST_HEAD)),
  ];

  const tot = { advised: 0, converted: 0, pending: 0, stale: 0 };

  results
    .filter((r) => r.ok)
    .sort((a, b) => b.data.pending.length - a.data.pending.length)
    .forEach((r, i) => {
      const d = r.data;
      const alt = i % 2 === 1;
      const base = alt ? ST_LABEL_ALT : ST_LABEL;
      const ctr = centred(alt ? { fill: { fgColor: { rgb: ZEBRA } } } : {});

      const stale = d.pending.filter((p) => (p.days ?? 0) >= 45).length;
      const oldest = d.pending.length ? d.pending[0].days : null;
      const rate =
        d.advised > 0 ? Math.round((d.converted / d.advised) * 100) : null;

      tot.advised += d.advised;
      tot.converted += d.converted;
      tot.pending += d.pending.length;
      tot.stale += stale;

      rows.push([
        mk(d.location, base),
        mk(d.advised, ctr),
        mk(d.converted, ctr),
        mk(d.pending.length, ctr),
        rate == null ? mk("—", ST_DASH) : mk(rate, rateStyle(rate)),
        mk(stale, ctr),
        oldest == null ? mk("—", ST_DASH) : mk(oldest, ageStyle(oldest, alt)),
      ]);
    });

  const groupRate =
    tot.advised > 0 ? Math.round((tot.converted / tot.advised) * 100) : null;

  rows.push([
    mk("ALL BRANCHES", ST_TOTAL),
    mk(tot.advised, ST_TOTAL_NUM),
    mk(tot.converted, ST_TOTAL_NUM),
    mk(tot.pending, ST_TOTAL_NUM),
    groupRate == null ? mk("—", ST_DASH) : mk(groupRate, rateStyle(groupRate)),
    mk(tot.stale, ST_TOTAL_NUM),
    mk("", ST_TOTAL_NUM),
  ]);

  rows.push([]);
  rows.push([
    mk(
      `A patient counts as advised when their LATEST diagnosis in the window advises surgery. ` +
        (STRICT_SURGERY
          ? 'Advice is matched strictly on "Surgery" — Test, MCDPA and blank advice are excluded.'
          : 'Advice is matched as "anything that is not medication", matching the Convincing Score screen — this includes Test, MCDPA and blank advice.') +
        " Operated means any non-deleted invoice from the window's start to today.",
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
      rows.push([mk(f.branch, ST_LABEL), mk(f.error, ST_LABEL)]),
    );
  }

  const ws = xlsx.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 26 },
    { wch: 15 },
    { wch: 11 },
    { wch: 10 },
    { wch: 12 },
    { wch: 13 },
    { wch: 14 },
  ];
  ws["!rows"] = [{ hpt: 26 }, { hpt: 18 }];
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 6 } },
  ];
  ws["!freeze"] = { xSplit: 1, ySplit: 4 };
  return ws;
}

function branchSheet(data) {
  const head = [
    "Patient",
    "UID",
    "Phone",
    "Age",
    "Sex",
    "Advised on",
    "Days",
    "Status",
    "Operated on",
    "Condition",
    "Advice",
    "Consultant",
    "Assistant",
  ];

  const rows = [
    [mk(`${data.location} — pending surgeries`, ST_GROUP)],
    head.map((h) => mk(h, ST_HEAD)),
  ];

  data.all.forEach((p, i) => {
    const alt = i % 2 === 1;
    const base = alt ? ST_LABEL_ALT : ST_LABEL;
    const ctr = centred(alt ? { fill: { fgColor: { rgb: ZEBRA } } } : {});
    rows.push([
      mk(p.name || "", base),
      mk(p.uid || "", base),
      // Phone as text — a leading-zero or +91 number must not be coerced into
      // a float and shown as 9.19876E+11.
      { v: p.phone || "", t: "s", s: base },
      mk(p.age || "", ctr),
      mk(p.sex || "", ctr),
      mk(fmtDate(p.diagnosisDate), ctr),
      p.days == null ? mk("—", ST_DASH) : mk(p.days, ageStyle(p.days, alt)),
      mk(
        p.operated ? "Operated" : "Pending",
        p.operated
          ? {
              ...centred(),
              font: { bold: true, sz: 10, color: { rgb: GREEN } },
              fill: { fgColor: { rgb: GREEN_SOFT } },
            }
          : ctr,
      ),
      p.surgeryDate ? mk(fmtDate(p.surgeryDate), ctr) : mk("—", ST_DASH),
      mk(p.speciality, base),
      mk(p.advice, ctr),
      mk(p.consultant || "", base),
      mk(p.assistant || "", base),
    ]);
  });

  if (!data.pending.length) {
    rows.push([
      mk("Every advised patient was operated. Nothing to chase.", ST_LABEL),
    ]);
  }

  const ws = xlsx.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 26 },
    { wch: 14 },
    { wch: 15 },
    { wch: 6 },
    { wch: 7 },
    { wch: 14 },
    { wch: 7 },
    { wch: 20 },
    { wch: 13 },
    { wch: 22 },
    { wch: 22 },
  ];
  ws["!freeze"] = { xSplit: 1, ySplit: 2 };
  ws["!rows"] = [{ hpt: 18 }, { hpt: 26 }];
  ws["!autofilter"] = {
    ref: xlsx.utils.encode_range({
      s: { r: 1, c: 0 },
      e: { r: Math.max(rows.length - 1, 2), c: head.length - 1 },
    }),
  };
  return ws;
}

/* ── Main ────────────────────────────────────────────────────────────────── */

/**
 * generateSurgeryPendingExcel({ from, to, locations })
 * Defaults to the last two months ending today.
 */
async function generateSurgeryPendingExcel({ from, to, locations } = {}) {
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !to) {
    throw new Error("`from` and `to` are required (YYYY-MM-DD)");
  }
  if (!ymd.test(from) || !ymd.test(to)) {
    throw new Error("`from` and `to` must be YYYY-MM-DD");
  }
  if (from > to) throw new Error("`from` cannot be after `to`");

  if (!Array.isArray(locations)) {
    throw new Error("`locations` must be an array of branch names");
  }
  // Trim, drop blanks, and de-duplicate — the same branch twice would open the
  // same pool twice and produce two identical sheets ("Thane" and "Thane-2").
  const wanted = [
    ...new Set(locations.map((l) => String(l || "").trim()).filter(Boolean)),
  ];
  if (!wanted.length) {
    throw new Error("`locations` must contain at least one branch name");
  }

  const results = [];
  for (let i = 0; i < wanted.length; i += BATCH) {
    const slice = wanted.slice(i, i + BATCH);
    const settled = await Promise.all(
      slice.map(async (branch) => {
        try {
          return { branch, ok: true, data: await readBranch(branch, from, to) };
        } catch (err) {
          // One unreachable database must not cost the rest.
          console.error(`  ✗ ${branch}: ${err.message}`);
          return { branch, ok: false, error: err.message };
        }
      }),
    );
    results.push(...settled);
    console.log(`  … ${results.length}/${wanted.length} branches read`);
  }

  const good = results.filter((r) => r.ok);
  if (!good.length) throw new Error("No branch returned any data");

  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, summarySheet(results, from, to), "Summary");

  const used = new Set(["Summary"]);
  good
    // Biggest chase list first — the branch that needs the calls is the first
    // tab after the summary.
    .sort((a, b) => b.data.pending.length - a.data.pending.length)
    .forEach((r) => {
      xlsx.utils.book_append_sheet(
        wb,
        branchSheet(r.data),
        sheetName(r.branch, used),
      );
    });

  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const fileName = `Surgery_Pending_${from}_to_${to}.xlsx`;
  const filePath = path.join(reportsDir, fileName);
  xlsx.writeFile(wb, filePath);

  const totalPending = good.reduce((a, r) => a + r.data.pending.length, 0);
  const totalAdvised = good.reduce((a, r) => a + r.data.advised, 0);

  return {
    filePath,
    fileName,
    from,
    to,
    totalAdvised,
    totalPending,
    branchesProcessed: good.length,
    branchesRequested: wanted.length,
    failed: results
      .filter((r) => !r.ok)
      .map((r) => ({ location: r.branch, error: r.error })),
  };
}

module.exports = { generateSurgeryPendingExcel };

/* ── Standalone runner ───────────────────────────────────────────────────── */

if (require.main === module) {
  const [, , from, to, locationsArg] = process.argv;
  const locations = (locationsArg || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!from || !to || !locations.length) {
    console.error(
      'Usage: node temp/tmp_generateSurgeryPendingReport.js <from> <to> "Branch A,Branch B"\n' +
        '   e.g. node temp/tmp_generateSurgeryPendingReport.js 2026-07-01 2026-08-31 "Thane,Andheri"',
    );
    process.exit(2);
  }

  (async () => {
    const t0 = Date.now();
    console.log("──────────────────────────────────────────────────────────");
    console.log("Surgery Advised — Not Yet Operated (temporary runner)");
    console.log(
      `Matching : ${STRICT_SURGERY ? 'strict "Surgery"' : "legacy (not medication)"}`,
    );
    console.log(`Branches : ${locations.length}`);
    console.log("──────────────────────────────────────────────────────────");

    try {
      const r = await generateSurgeryPendingExcel({ from, to, locations });
      console.log(`\n✅ Workbook written: ${r.filePath}`);
      console.log(`   Window   : ${r.from} → ${r.to}`);
      console.log(
        `   ${r.totalPending} pending of ${r.totalAdvised} advised, ` +
          `${r.branchesProcessed}/${r.branchesRequested} branches, ` +
          `${Math.round((Date.now() - t0) / 1000)}s`,
      );
      r.failed.forEach((f) => console.log(`   ✗ ${f.location}: ${f.error}`));
      // mysql pools keep the event loop alive; without this the process hangs
      // after writing the file and looks like it failed.
      process.exit(r.failed.length ? 1 : 0);
    } catch (err) {
      console.error(`\n❌ ${err.message}`);
      process.exit(2);
    }
  })();
}
