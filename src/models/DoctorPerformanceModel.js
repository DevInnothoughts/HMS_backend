// doctorPerformanceModel.js
// ─────────────────────────────────────────────────────────────────────────────
// Doctor performance per branch, for a date range.
//
// A doctor is linked to a patient ONLY through the `diagnosis` table:
//   • Surgeon  / "Main Doctor" = diagnosis.consultantDoctor
//   • Assistant / "Consultant" = diagnosis.assistanceDoctor
// (Same convention used by convincingScoreModel.js — so these numbers reconcile
//  with the Convincing Score screen.)
//
// Revenue tables join back to a doctor BY patient_id (they carry no doctor_id
// of their own in the schema we have), so a doctor's revenue = the revenue of
// the patients that doctor diagnosed in the range:
//   • IPD revenue  = SUM(invoice.<IPD_REVENUE_COLUMN>) for those patients
//   • OPD revenue  = SUM(patient_receipt.totalamt)      for those patients
//   • IPD conversion = those patients who have ANY invoice in the range
//   • New-patient conversion = NEW patients (appointment.patient_type='New')
//                              that were diagnosed AND have an invoice
//
// ── CONFIRMED DECISIONS ──────────────────────────────────────────────────────
//   1. IPD revenue column → invoice.totalamt (gross). See CONFIG below.
//   2. OPD revenue → summed from patient_receipt.totalamt and attributed to the
//      doctor via the diagnosis link. patient_receipt has a doctor_id but no
//      consultant/assistant column, so the diagnosis link is what lets us split
//      revenue across BOTH the surgeon (consultantDoctor) and the assistant
//      (assistanceDoctor) on a case.
//   3. Attribution caveat: if one patient is diagnosed by two different surgeons
//      across visits in the range, BOTH surgeons get that patient's revenue/
//      conversion. Surgeon vs Assistant lists are independent views, so the
//      same case legitimately appears in both. branchTotal is therefore computed
//      from the raw tables (not by summing the doctor rows) to avoid double counts.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../databaseUtils");

const CONFIG = {
  // Column on `invoice` treated as IPD revenue (gross). Hardcoded constant
  // (NOT user input), so the string interpolation below is safe.
  IPD_REVENUE_COLUMN: "totalamt",
};

const round2 = (n) =>
  Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

// A doctor id is "real" only if it's a non-zero value.
const isRealDoctor = (id) =>
  id !== null &&
  id !== undefined &&
  id !== 0 &&
  id !== "0" &&
  `${id}`.trim() !== "";

// Capitalize the first character only (leaves the rest of the label untouched).
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// For the same case-insensitive key, prefer the label that already starts with a
// capital letter (e.g. keep "Piles" over "piles"); otherwise keep what we have.
function preferLabel(existing, candidate) {
  if (!existing) return candidate;
  const eCap = /^[A-Z]/.test(existing);
  const cCap = /^[A-Z]/.test(candidate);
  return !eCap && cCap ? candidate : existing;
}

// Parse the provisionalDiagnosis TEXT column into an object, safely. It stores
// JSON like {"piles":["Grade 2"],"fistula":["Fistula in Ano"]} — keys are
// specialities, values are sub-type arrays. Handles null / '' / '{}' / malformed.
function parseProvisional(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw; // already parsed (JSON column type)
  const s = raw.toString().trim();
  if (s === "" || s === "{}" || s.toLowerCase() === "null") return null;
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

// Sub-types recorded for a given speciality (case-insensitive key match),
// de-duplicated. e.g. subTypesFor({"piles":["Grade 2"]}, "Piles") -> ["Grade 2"].
function subTypesFor(provisional, speciality) {
  if (!provisional) return [];
  const target = speciality.toLowerCase();
  for (const key of Object.keys(provisional)) {
    if (key.toLowerCase() === target) {
      const val = provisional[key];
      if (!Array.isArray(val)) return [];
      const cleaned = val
        .map((v) => (v == null ? "" : v.toString().trim()))
        .filter((v) => v !== "");
      return [...new Set(cleaned)];
    }
  }
  return [];
}

// ─── Per-patient revenue / invoice maps for the whole branch (in range) ───────

// IPD invoices grouped by patient → { revenue, count }.
// creation_date treated as DATETIME (like targetComparisonModel), so the upper
// bound is widened to 23:59:59 to keep the last day's invoices.
function buildInvoiceByPatient(rows) {
  const map = {};
  for (const r of rows) {
    map[r.patient_id] = {
      revenue: Number(r.ipdRevenue) || 0,
      count: Number(r.invoiceCount) || 0,
    };
  }
  return map;
}

// OPD receipts grouped by patient → revenue.
function buildOpdByPatient(rows) {
  const map = {};
  for (const r of rows) {
    map[r.patient_id] = Number(r.opdRevenue) || 0;
  }
  return map;
}

// ─── Aggregate diagnosis rows into one entry per doctor ───────────────────────
function aggregateDoctors(rows, idKey, nameKey, ctx) {
  const { newPatientIds, invoiceByPatient, opdByPatient } = ctx;
  const map = {};

  for (const row of rows) {
    const id = row[idKey];
    if (!isRealDoctor(id)) continue; // skip rows with no doctor in this role

    if (!map[id]) {
      map[id] = {
        doctorId: id,
        doctorName: row[nameKey] || `Doctor ${id}`,
        patientIds: new Set(),
        newPatientIds: new Set(),
        // patient_id -> { speciality, surgeryAdvised } (latest wins); drives both
        // the funnel and the doctor-level Surgery/Medication patient counts
        patientSpeciality: new Map(),
      };
    }
    const d = map[id];
    d.patientIds.add(row.patient_id);
    if (newPatientIds.has(row.patient_id)) d.newPatientIds.add(row.patient_id);

    // Advice classification — anything that isn't "medication" counts as Surgery.
    const advice = (row.diagnosisAdvice || "")
      .toString()
      .replace(/,$/, "")
      .trim()
      .toLowerCase();

    // Assign each patient to ONE speciality (latest diagnosis wins — rows are
    // ordered by date_diagnosis). Covers every diagnosed patient, so the
    // per-speciality counts sum to patientsDiagnosed. Carry the latest advice
    // so we can count surgery-advised patients per speciality.
    const speciality =
      (row.speciality || "").toString().trim() || "Unspecified";
    const provisional = parseProvisional(row.provisionalDiagnosis);
    d.patientSpeciality.set(row.patient_id, {
      speciality,
      surgeryAdvised: advice !== "medication",
      subTypes: subTypesFor(provisional, speciality),
    });
  }

  return (
    Object.values(map)
      .map((d) => {
        let ipdRevenue = 0;
        let opdRevenue = 0;
        let ipdConversions = 0; // distinct diagnosed patients with any invoice
        let newPatientConversions = 0; // NEW diagnosed patients with any invoice

        for (const pid of d.patientIds) {
          const inv = invoiceByPatient[pid];
          if (inv) {
            ipdRevenue += inv.revenue;
            ipdConversions += 1;
            if (d.newPatientIds.has(pid)) newPatientConversions += 1;
          }
          const opd = opdByPatient[pid];
          if (opd) opdRevenue += opd;
        }

        const patientsDiagnosed = d.patientIds.size;
        const newPatients = d.newPatientIds.size;

        // Per-condition breakdown, one speciality per patient (latest wins) so the
        // per-speciality counts sum to patientsDiagnosed. Also counts surgery-advised
        // patients and IPD conversions within each speciality. Speciality and
        // sub-type names are grouped case-insensitively, so "Piles"/"piles" merge.
        // e.g. { speciality: "Piles", patientCount: 5, surgeryAdvised: 4, ipdCount: 3, conversionRate: 60 }
        const specLabel = {}; // specKey -> best display label
        const specCount = {};
        const specSurgery = {};
        const specIpd = {};
        const specSubTypes = {}; // specKey -> { subKey -> { label, count } }
        // Doctor-level Surgery / Medication as DISTINCT patients (by latest
        // diagnosis), so they equal the sum of the funnel and partition
        // patientsDiagnosed (Surgery + Medication === patientsDiagnosed).
        let surgeryPatients = 0;
        let medicationPatients = 0;
        for (const [pid, info] of d.patientSpeciality) {
          const rawSpec = (info.speciality || "Unspecified").toString().trim();
          const spec = rawSpec.toLowerCase();
          specLabel[spec] = preferLabel(specLabel[spec], rawSpec);
          specCount[spec] = (specCount[spec] || 0) + 1;
          if (info.surgeryAdvised) {
            specSurgery[spec] = (specSurgery[spec] || 0) + 1;
            surgeryPatients++;
          } else {
            medicationPatients++;
          }
          if (invoiceByPatient[pid]) specIpd[spec] = (specIpd[spec] || 0) + 1;
          if (info.subTypes && info.subTypes.length) {
            if (!specSubTypes[spec]) specSubTypes[spec] = {};
            for (const st of info.subTypes) {
              const raw = st.toString().trim();
              const subKey = raw.toLowerCase();
              if (!specSubTypes[spec][subKey]) {
                specSubTypes[spec][subKey] = { label: raw, count: 0 };
              } else {
                specSubTypes[spec][subKey].label = preferLabel(
                  specSubTypes[spec][subKey].label,
                  raw,
                );
              }
              specSubTypes[spec][subKey].count += 1;
            }
          }
        }
        const specialities = Object.keys(specCount)
          .map((specKey) => {
            const patientCount = specCount[specKey];
            const surgeryAdvised = specSurgery[specKey] || 0;
            const ipdCount = specIpd[specKey] || 0;
            return {
              speciality: capFirst(specLabel[specKey]),
              patientCount,
              surgeryAdvised,
              ipdCount,
              conversionRate:
                patientCount > 0 ? round2((ipdCount / patientCount) * 100) : 0,
              subTypes: Object.values(specSubTypes[specKey] || {})
                .map((s) => ({
                  name: capFirst(s.label),
                  patientCount: s.count,
                }))
                .sort((a, b) => b.patientCount - a.patientCount),
            };
          })
          .sort(
            (a, b) =>
              b.patientCount - a.patientCount || b.ipdCount - a.ipdCount,
          );

        return {
          doctorId: d.doctorId,
          doctorName: d.doctorName,
          patientsDiagnosed,
          newPatients,
          medicationAdvised: medicationPatients,
          surgeryAdvised: surgeryPatients,
          ipdConversions,
          newPatientConversions,
          // headline KPI: NEW patient → IPD conversion %
          conversionRate:
            newPatients > 0
              ? round2((newPatientConversions / newPatients) * 100)
              : 0,
          // all diagnosed → IPD conversion %
          ipdConversionRate:
            patientsDiagnosed > 0
              ? round2((ipdConversions / patientsDiagnosed) * 100)
              : 0,
          opdRevenue: round2(opdRevenue),
          ipdRevenue: round2(ipdRevenue),
          avgIpdRevenue:
            ipdConversions > 0 ? round2(ipdRevenue / ipdConversions) : 0,
          specialities,
        };
      })
      // Most impactful first; tie-break by patients seen.
      .sort(
        (a, b) =>
          b.ipdRevenue - a.ipdRevenue ||
          b.patientsDiagnosed - a.patientsDiagnosed,
      )
  );
}

// ─── Main entry point ─────────────────────────────────────────────────────────
async function getDoctorPerformance(req) {
  const { connection } = getConnectionByLocation(req.query.location);
  const { from, to } = req.query;

  if (!connection) {
    const err = new Error(`Invalid location: ${req.query.location}`);
    err.status = 404;
    throw err;
  }
  if (!from || !to) {
    const err = new Error("`from` and `to` (YYYY-MM-DD) are required");
    err.status = 400;
    throw err;
  }

  const run = (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (error, rows) =>
        error ? reject(error) : resolve(rows),
      ),
    );

  // 1) New-patient ids in range (same filter as Convincing Score / Target Comparison).
  //    appointment_timestamp is a DATE column → plain date bounds.
  const newPatientSql = `
    SELECT DISTINCT patient_id
    FROM appointment
    WHERE appointment_timestamp BETWEEN ? AND ?
      AND patient_type = 'New'
      AND is_deleted != 1
      AND confirm_time != '0'
      AND executivechk = 2
  `;

  // 2) Diagnosis rows in range, with both surgeon & assistant names resolved.
  const diagnosisSql = `
    SELECT
      d.patient_id,
      d.date_diagnosis,
      d.diagnosisAdvice,
      d.speciality,
      d.provisionalDiagnosis,
      d.consultantDoctor,
      sd.name AS surgeonName,
      d.assistanceDoctor,
      ad.name AS assistantName
    FROM diagnosis d
    LEFT JOIN doctor sd ON sd.doctor_id = d.consultantDoctor
    LEFT JOIN doctor ad ON ad.doctor_id = d.assistanceDoctor
    WHERE d.date_diagnosis >= ? AND d.date_diagnosis <= ?
    ORDER BY d.patient_id, d.date_diagnosis
  `;

  // 3) IPD invoices grouped by patient (creation_date as DATETIME bounds).
  const invoiceSql = `
    SELECT
      patient_id,
      SUM(COALESCE(${CONFIG.IPD_REVENUE_COLUMN}, 0)) AS ipdRevenue,
      COUNT(*) AS invoiceCount
    FROM invoice
    WHERE creation_date >= ? AND creation_date <= ?
      AND is_deleted != 1
    GROUP BY patient_id
  `;

  // 4) OPD receipts grouped by patient.
  const opdSql = `
    SELECT
      patient_id,
      SUM(COALESCE(totalamt, 0)) AS opdRevenue
    FROM patient_receipt
    WHERE is_deleted = '0'
      AND receipt_date BETWEEN ? AND ?
    GROUP BY patient_id
  `;

  try {
    const [newPatientRows, diagnosisRows, invoiceRows, opdRows] =
      await Promise.all([
        run(newPatientSql, [from, to]),
        run(diagnosisSql, [from, to]),
        run(invoiceSql, [`${from} 00:00:00`, `${to} 23:59:59`]),
        run(opdSql, [from, to]),
      ]);

    const newPatientIds = new Set(newPatientRows.map((r) => r.patient_id));
    const invoiceByPatient = buildInvoiceByPatient(invoiceRows);
    const opdByPatient = buildOpdByPatient(opdRows);

    const ctx = { newPatientIds, invoiceByPatient, opdByPatient };

    const surgeons = aggregateDoctors(
      diagnosisRows,
      "consultantDoctor",
      "surgeonName",
      ctx,
    );
    const assistants = aggregateDoctors(
      diagnosisRows,
      "assistanceDoctor",
      "assistantName",
      ctx,
    );

    // ── Branch totals: computed from raw tables (never by summing doctor rows,
    //    which would double-count shared patients). ──
    const allDiagnosedPatients = new Set(
      diagnosisRows.map((r) => r.patient_id),
    );
    let branchIpdConversions = 0;
    for (const pid of allDiagnosedPatients) {
      if (invoiceByPatient[pid]) branchIpdConversions++;
    }

    const branchTotal = {
      newPatients: newPatientIds.size,
      patientsDiagnosed: allDiagnosedPatients.size,
      ipdConversions: branchIpdConversions,
      opdRevenue: round2(
        opdRows.reduce((s, r) => s + (Number(r.opdRevenue) || 0), 0),
      ),
      ipdRevenue: round2(
        invoiceRows.reduce((s, r) => s + (Number(r.ipdRevenue) || 0), 0),
      ),
    };

    return {
      meta: { location: req.query.location, from, to },
      branchTotal,
      surgeons,
      assistants,
    };
  } catch (error) {
    console.error("Error in getDoctorPerformance:", error);
    throw error;
  }
}

module.exports = {
  getDoctorPerformance,
};
