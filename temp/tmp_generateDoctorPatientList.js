/**
 * tmp_generateDoctorPatientList.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * Exports a PATIENT LIST for a specific doctor:
 *
 *     patient.name, patient.phone, patient.mobile_2, sex, age
 *   + diagnosis.diagnosis, diagnosisAdvice, speciality, date_diagnosis
 *
 * filtered by diagnosis.consultantDoctor and/or diagnosis.assistanceDoctor,
 * with the doctor id(s) set manually in the CONFIG block below.
 *
 * ── Doctor linkage (from convincingScoreModel / DoctorPerformanceModel) ─────
 * A doctor is linked to a patient ONLY through the `diagnosis` table:
 *     Surgeon   / "Main Doctor" = diagnosis.consultantDoctor
 *     Assistant / "Consultant"  = diagnosis.assistanceDoctor
 * Both models join names via LEFT JOIN doctor ON doctor_id, which is what this
 * script does — LEFT, not INNER, so a row with a missing/0 doctor id still
 * appears rather than vanishing silently.
 *
 * ── MATCH_MODE — read this, it changes the row count ────────────────────────
 * The two ids are independent views of the same case, so how you combine them
 * matters:
 *
 *   'consultant' → consultantDoctor = CONSULTANT_DOCTOR_ID          (surgeon)
 *   'assistant'  → assistanceDoctor = ASSISTANCE_DOCTOR_ID          (assistant)
 *   'either'     → OR   — every case the doctor touched in either role [DEFAULT]
 *   'both'       → AND  — only cases where BOTH ids match on the SAME row
 *
 * 'either' with the same id in both slots answers "show me everything Dr X was
 * involved in". 'both' with two DIFFERENT ids answers "show me cases where
 * Dr A operated with Dr B assisting" — it is NOT a superset of the others and
 * will usually return far fewer rows. If you get an unexpectedly small result,
 * check this setting first.
 *
 * The Role column on the output says how each row matched (Consultant /
 * Assistant / Both), so you can always see which rule pulled a row in.
 *
 * ── One row per DIAGNOSIS, not per patient ─────────────────────────────────
 * A patient diagnosed three times appears three times, so the diagnosis /
 * advice / speciality columns stay truthful per visit. The "Unique Patients"
 * sheet collapses to one row per patient (latest diagnosis wins, matching how
 * convincingInsightsModel picks latestDx by ordering date-ascending and letting
 * the last row win). Use that sheet for a contact list; use the main sheet for
 * clinical detail.
 *
 * ── Place this file at the PROJECT ROOT ─────────────────────────────────────
 * (next to app.js / databaseUtils.js / dbconfig.js).
 *
 * ── Run ────────────────────────────────────────────────────────────────────
 *   # edit CONFIG below, then:
 *   node tmp_generateDoctorPatientList.js
 *
 *   # or override from the CLI:
 *   #   <location> <consultantId> <assistantId> <from> <to> [matchMode]
 *   node tmp_generateDoctorPatientList.js "Andheri" 12 12 2026-01-01 2026-07-31
 *   node tmp_generateDoctorPatientList.js "Thane" 12 0 2026-01-01 2026-07-31 consultant
 *
 * ── Output ─────────────────────────────────────────────────────────────────
 *   src/report/DoctorPatientList_<Location>_<from>_to_<to>.xlsx
 *
 * ⚠️  This file contains patient names and phone numbers. Share it only over
 *     approved channels and delete both the script and the workbook when done.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");
const { getConnectionByLocation } = require("../databaseUtils");

/* ── CONFIG — edit these ─────────────────────────────────────────────────── */

const CONFIG = {
  // Branch name, exactly as getConnectionByLocation expects it.
  location: process.argv[2] || "Andheri",

  // ▼▼ PUT THE DOCTOR IDS HERE ▼▼
  // Same id in both + matchMode 'either' = everything this doctor touched.
  consultantDoctorId: process.argv[3] !== undefined ? process.argv[3] : 0,
  assistanceDoctorId: process.argv[4] !== undefined ? process.argv[4] : 0,

  // Date range on diagnosis.date_diagnosis (a DATE column → plain bounds).
  // Set both to null for ALL TIME (can be very large — see the row-cap note).
  from: process.argv[5] || "2026-01-01",
  to: process.argv[6] || "2026-07-31",

  // 'either' | 'both' | 'consultant' | 'assistant'   (see header)
  matchMode: process.argv[7] || "either",

  // Safety cap so a mistyped filter can't try to pull a whole table into memory.
  maxRows: 50000,
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const reportsDir = path.join(__dirname, "src", "report");
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

// A doctor id counts as "set" only if it's a real non-zero value — mirrors
// isRealDoctor() in DoctorPerformanceModel, where 0 / '0' / '' mean "no doctor".
const isRealDoctor = (id) =>
  id !== null &&
  id !== undefined &&
  id !== 0 &&
  id !== "0" &&
  `${id}`.trim() !== "";

const clean = (v) => (v === null || v === undefined ? "" : String(v).trim());

// diagnosisAdvice arrives as 'Surgery', 'Surgery,', 'Medication,' etc.
// convincingScoreModel strips the trailing comma before comparing; same here.
const normAdvice = (v) => clean(v).replace(/,$/, "").trim();

// provisionalDiagnosis is JSON in some rows and a plain string in others, so
// parse defensively and fall back to the raw text rather than throwing.
function parseProvisional(raw) {
  const s = clean(raw);
  if (!s) return "";
  try {
    const p = JSON.parse(s);
    if (Array.isArray(p)) {
      return p
        .map((x) => (typeof x === "string" ? x : x?.name || x?.label || ""))
        .filter(Boolean)
        .join(", ");
    }
    if (p && typeof p === "object") {
      return Object.values(p)
        .map((x) => (typeof x === "string" ? x : x?.name || x?.label || ""))
        .filter(Boolean)
        .join(", ");
    }
    return String(p);
  } catch {
    return s; // not JSON — show what's actually stored
  }
}

const fmtDate = (d) => {
  if (!d) return "";
  if (d instanceof Date) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return String(d).slice(0, 10);
};

/* ── Query build ─────────────────────────────────────────────────────────── */

function buildQuery(cfg) {
  const cId = cfg.consultantDoctorId;
  const aId = cfg.assistanceDoctorId;
  const mode = String(cfg.matchMode).toLowerCase();

  const where = [];
  const params = [];

  // Doctor predicate. Ids are always bound as parameters, never interpolated.
  if (mode === "consultant") {
    if (!isRealDoctor(cId)) {
      throw new Error(
        "matchMode 'consultant' needs a non-zero consultantDoctorId.",
      );
    }
    where.push("d.consultantDoctor = ?");
    params.push(cId);
  } else if (mode === "assistant") {
    if (!isRealDoctor(aId)) {
      throw new Error(
        "matchMode 'assistant' needs a non-zero assistanceDoctorId.",
      );
    }
    where.push("d.assistanceDoctor = ?");
    params.push(aId);
  } else if (mode === "both") {
    if (!isRealDoctor(cId) || !isRealDoctor(aId)) {
      throw new Error(
        "matchMode 'both' needs BOTH consultantDoctorId and assistanceDoctorId set.",
      );
    }
    where.push("(d.consultantDoctor = ? AND d.assistanceDoctor = ?)");
    params.push(cId, aId);
  } else if (mode === "either") {
    const parts = [];
    if (isRealDoctor(cId)) {
      parts.push("d.consultantDoctor = ?");
      params.push(cId);
    }
    if (isRealDoctor(aId)) {
      parts.push("d.assistanceDoctor = ?");
      params.push(aId);
    }
    if (!parts.length) {
      throw new Error(
        "matchMode 'either' needs at least one non-zero doctor id. " +
          "Set consultantDoctorId and/or assistanceDoctorId in CONFIG.",
      );
    }
    where.push(`(${parts.join(" OR ")})`);
  } else {
    throw new Error(
      `Unknown matchMode '${cfg.matchMode}'. Use either | both | consultant | assistant.`,
    );
  }

  // date_diagnosis is a DATE column — same plain bounds the other models use.
  if (cfg.from && cfg.to) {
    where.push("d.date_diagnosis >= ? AND d.date_diagnosis <= ?");
    params.push(cfg.from, cfg.to);
  }

  const sql = `
    SELECT
      d.patient_id,
      p.name                AS patient_name,
      p.phone               AS phone,
      p.mobile_2            AS mobile_2,
      p.sex                 AS sex,
      p.age                 AS age,
      d.date_diagnosis,
      d.diagnosis,
      d.diagnosisAdvice,
      d.speciality,
      d.provisionalDiagnosis,
      d.consultantDoctor,
      c.name                AS consultantName,
      d.assistanceDoctor,
      a.name                AS assistantName
    FROM diagnosis d
    LEFT JOIN patient p ON p.patient_id      = d.patient_id
    LEFT JOIN doctor  c ON c.doctor_id       = d.consultantDoctor
    LEFT JOIN doctor  a ON a.doctor_id       = d.assistanceDoctor
    WHERE ${where.join("\n      AND ")}
    ORDER BY d.patient_id, d.date_diagnosis
    LIMIT ?
  `;
  params.push(cfg.maxRows);

  return { sql, params };
}

/* ── Fetch ───────────────────────────────────────────────────────────────── */

async function fetchRows(cfg) {
  const { connection } = getConnectionByLocation(cfg.location);
  if (!connection) throw new Error(`Invalid location: ${cfg.location}`);

  const run = (sql, params = []) =>
    new Promise((res, rej) =>
      connection.query(sql, params, (e, r) => (e ? rej(e) : res(r))),
    );

  const { sql, params } = buildQuery(cfg);
  const rows = await run(sql, params);

  const cId = String(cfg.consultantDoctorId);
  const aId = String(cfg.assistanceDoctorId);

  return rows.map((r) => {
    const isC =
      isRealDoctor(cfg.consultantDoctorId) &&
      String(r.consultantDoctor) === cId;
    const isA =
      isRealDoctor(cfg.assistanceDoctorId) &&
      String(r.assistanceDoctor) === aId;
    return {
      patientId: r.patient_id,
      name: clean(r.patient_name),
      phone: clean(r.phone),
      mobile2: clean(r.mobile_2),
      sex: clean(r.sex),
      age: clean(r.age),
      dateDiagnosis: fmtDate(r.date_diagnosis),
      diagnosis: clean(r.diagnosis),
      diagnosisAdvice: normAdvice(r.diagnosisAdvice),
      speciality: clean(r.speciality) || "Unspecified",
      provisional: parseProvisional(r.provisionalDiagnosis),
      consultantId: r.consultantDoctor,
      consultantName: clean(r.consultantName),
      assistantId: r.assistanceDoctor,
      assistantName: clean(r.assistantName),
      role: isC && isA ? "Both" : isC ? "Consultant" : isA ? "Assistant" : "—",
    };
  });
}

/* ── Excel ───────────────────────────────────────────────────────────────── */

const HEADER = [
  "Patient ID",
  "Patient Name",
  "Phone",
  "Alt. Mobile",
  "Sex",
  "Age",
  "Date of Diagnosis",
  "Diagnosis",
  "Diagnosis Advice",
  "Speciality",
  "Provisional Diagnosis",
  "Consultant Doctor",
  "Assistant Doctor",
  "Matched As",
];

const COLS = [
  { wch: 11 },
  { wch: 26 },
  { wch: 14 },
  { wch: 14 },
  { wch: 7 },
  { wch: 6 },
  { wch: 17 },
  { wch: 30 },
  { wch: 17 },
  { wch: 18 },
  { wch: 30 },
  { wch: 24 },
  { wch: 24 },
  { wch: 13 },
];

const rowToArray = (r) => [
  r.patientId,
  r.name,
  r.phone,
  r.mobile2,
  r.sex,
  r.age,
  r.dateDiagnosis,
  r.diagnosis,
  r.diagnosisAdvice,
  r.speciality,
  r.provisional,
  r.consultantName || (r.consultantId ? `#${r.consultantId}` : ""),
  r.assistantName || (r.assistantId ? `#${r.assistantId}` : ""),
  r.role,
];

function buildDetailSheet(rows, title) {
  const aoa = [[title], [], HEADER, ...rows.map(rowToArray)];
  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: HEADER.length - 1 } }];
  ws["!cols"] = COLS;
  // Freeze the header so long lists stay readable while scrolling.
  ws["!freeze"] = { xSplit: 0, ySplit: 3 };
  ws["!autofilter"] = {
    ref: xlsx.utils.encode_range(
      { r: 2, c: 0 },
      { r: 2 + rows.length, c: HEADER.length - 1 },
    ),
  };
  return ws;
}

// One row per patient — latest diagnosis wins (rows arrive date-ascending, so
// the last one seen for a patient is the latest; same rule as convincingInsights).
function uniquePatients(rows) {
  const byPatient = new Map();
  for (const r of rows) byPatient.set(String(r.patientId), r);
  return Array.from(byPatient.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

function buildSummarySheet(rows, unique, cfg) {
  const tally = (key) => {
    const m = new Map();
    for (const r of unique) {
      const k = r[key] || "—";
      m.set(k, (m.get(k) || 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  };

  const aoa = [
    ["Doctor Patient List — filter used"],
    [],
    ["Location", cfg.location],
    [
      "Consultant Doctor ID",
      isRealDoctor(cfg.consultantDoctorId)
        ? cfg.consultantDoctorId
        : "(not set)",
    ],
    [
      "Assistance Doctor ID",
      isRealDoctor(cfg.assistanceDoctorId)
        ? cfg.assistanceDoctorId
        : "(not set)",
    ],
    ["Match mode", cfg.matchMode],
    [
      "Date range",
      cfg.from && cfg.to ? `${cfg.from} to ${cfg.to}` : "All time",
    ],
    [],
    ["Diagnosis rows", rows.length],
    ["Unique patients", unique.length],
    [],
    ["Matched as (unique patients)"],
    ...tally("role").map(([k, v]) => ["  " + k, v]),
    [],
    ["By speciality (unique patients)"],
    ...tally("speciality").map(([k, v]) => ["  " + k, v]),
    [],
    ["By advice (unique patients)"],
    ...tally("diagnosisAdvice").map(([k, v]) => ["  " + (k || "—"), v]),
    [],
    [
      "Note",
      "The detail sheet has one row PER DIAGNOSIS, so a patient seen more than " +
        "once appears more than once. Counts above are unique patients, taking " +
        "each patient's LATEST diagnosis in range.",
    ],
    ["Generated at", new Date().toISOString()],
  ];

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
  ws["!cols"] = [{ wch: 28 }, { wch: 80 }];
  return ws;
}

/* ── Run ─────────────────────────────────────────────────────────────────── */

(async () => {
  const t0 = Date.now();
  const cfg = CONFIG;

  console.log("──────────────────────────────────────────────────────────");
  console.log("Doctor Patient List (temporary export)");
  console.log(`Location   : ${cfg.location}`);
  console.log(
    `Consultant : ${isRealDoctor(cfg.consultantDoctorId) ? cfg.consultantDoctorId : "(not set)"}`,
  );
  console.log(
    `Assistant  : ${isRealDoctor(cfg.assistanceDoctorId) ? cfg.assistanceDoctorId : "(not set)"}`,
  );
  console.log(`Match mode : ${cfg.matchMode}`);
  console.log(
    `Range      : ${cfg.from && cfg.to ? `${cfg.from} → ${cfg.to}` : "ALL TIME"}`,
  );
  console.log("──────────────────────────────────────────────────────────");

  try {
    const rows = await fetchRows(cfg);

    if (!rows.length) {
      console.warn(
        "\n⚠️  No rows matched. Things worth checking, in order:\n" +
          "   • Is the doctor id right for THIS branch? Ids are per-branch DB —\n" +
          "     the same doctor has different ids at different locations.\n" +
          "   • If matchMode is 'both', it needs BOTH ids on the SAME diagnosis\n" +
          "     row; try 'either' instead.\n" +
          "   • Does the date range actually cover any diagnoses?",
      );
      process.exit(0);
    }

    if (rows.length >= cfg.maxRows) {
      console.warn(
        `\n⚠️  Hit the ${cfg.maxRows}-row cap — the list is TRUNCATED. ` +
          `Narrow the date range or raise CONFIG.maxRows.`,
      );
    }

    const unique = uniquePatients(rows);

    const wb = xlsx.utils.book_new();
    const title =
      `Patients — ${cfg.location} — ` +
      `${cfg.from && cfg.to ? `${cfg.from} to ${cfg.to}` : "all time"} ` +
      `(match: ${cfg.matchMode})`;
    xlsx.utils.book_append_sheet(
      wb,
      buildDetailSheet(rows, title),
      "Patient Diagnoses",
    );
    xlsx.utils.book_append_sheet(
      wb,
      buildDetailSheet(
        unique,
        `${title} — one row per patient (latest diagnosis)`,
      ),
      "Unique Patients",
    );
    xlsx.utils.book_append_sheet(
      wb,
      buildSummarySheet(rows, unique, cfg),
      "Filter & Summary",
    );

    const safe = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "");
    const fileName =
      `DoctorPatientList_${safe(cfg.location)}_` +
      `${cfg.from && cfg.to ? `${cfg.from}_to_${cfg.to}` : "alltime"}.xlsx`;
    const filePath = path.join(reportsDir, fileName);
    xlsx.writeFile(wb, filePath);

    console.log(`\n✅ Workbook written: ${filePath}`);
    console.log(`   Diagnosis rows  : ${rows.length}`);
    console.log(`   Unique patients : ${unique.length}`);

    const roles = rows.reduce(
      (m, r) => ((m[r.role] = (m[r.role] || 0) + 1), m),
      {},
    );
    console.log(
      `   Matched as      : ${Object.entries(roles)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
    );

    const noPhone = unique.filter((r) => !r.phone && !r.mobile2).length;
    if (noPhone) {
      console.warn(`   ⓘ ${noPhone} patient(s) have no phone on record.`);
    }
    const noName = unique.filter((r) => !r.name).length;
    if (noName) {
      console.warn(
        `   ⓘ ${noName} patient(s) have no patient row (orphaned diagnosis.patient_id).`,
      );
    }

    console.warn(
      `\n🔒 This file contains patient names and phone numbers — share it only ` +
        `over approved channels, and delete it when you're done.`,
    );

    console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Export failed:", err?.message || err);
    console.error(err?.stack || "");
    process.exit(1);
  }
})();
