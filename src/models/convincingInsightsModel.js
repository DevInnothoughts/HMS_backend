// convincingInsightsModel.js
// ─────────────────────────────────────────────────────────────────────────────
// Drill-down data for the Convincing Score screen. This is ADDITIVE — it does
// not touch convincingScoreModel.js. The main screen still calls
// /ConvincingScore/v3 for the summary + doctor cards; when a top tile is tapped
// it calls this endpoint for the breakdown.
//
// For each of the four tile populations it returns:
//   • gender split          (from patient.sex)
//   • doctor-wise counts     (consultant on the patient's latest diagnosis)
//   • disease-wise counts    (speciality on the patient's latest diagnosis)
//
// Populations (each matches its tile):
//   newAppts           – DISTINCT new-appointment patients in range
//   diagnoses          – DISTINCT diagnosed patients in range (latest per patient)
//   surgeryAdvised     – diagnosed patients whose latest advice is Surgery
//   surgeriesPerformed – DISTINCT patients with a surgery invoice in range
//
// It also returns, per surgeon and per assistant surgeon, each speciality's
// sub-types with three counts — seen / advised / surgery — for requirement 3.
//
// Note on "New Appts": doctor & disease come from a patient's diagnosis. New
// patients not yet diagnosed are bucketed as "Not diagnosed". Gender still
// comes from the patient record.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../databaseUtils");

const makeRunner =
  (connection) =>
  (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) =>
        err ? reject(err) : resolve(rows),
      ),
    );

// patient.sex may be Male/Female, M/F, etc. → normalise to Male/Female/Other.
function normSex(sex) {
  const s = String(sex || "")
    .trim()
    .toLowerCase();
  if (s.startsWith("m")) return "Male";
  if (s.startsWith("f")) return "Female";
  return "Other";
}

function capFirst(s) {
  const t = String(s || "").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

// provisionalDiagnosis can be JSON (array/object) or a delimited string.
// Return a de-duplicated list of sub-type names.
function parseSubTypes(provisional) {
  if (provisional == null) return [];
  let val = provisional;
  if (typeof val === "string") {
    const s = val.trim();
    if (!s) return [];
    try {
      val = JSON.parse(s);
    } catch (_) {
      return dedupe(
        s
          .split(/[,;|]/)
          .map((x) => x.trim())
          .filter(Boolean),
      );
    }
  }
  const out = [];
  const pushName = (x) => {
    if (x == null) return;
    if (typeof x === "string") {
      const t = x.trim();
      if (t) out.push(t);
    } else if (typeof x === "object") {
      const n =
        x.name || x.label || x.value || x.title || x.diagnosis || x.subType;
      if (n) out.push(String(n).trim());
    }
  };
  if (Array.isArray(val)) {
    val.forEach(pushName);
  } else if (typeof val === "object") {
    for (const [k, v] of Object.entries(val)) {
      if (v === true) pushName(k);
      else if (typeof v === "string") pushName(v);
      else pushName(k);
    }
  } else {
    pushName(val);
  }
  return dedupe(out);
}

function dedupe(list) {
  const seen = new Set();
  const res = [];
  for (const n of list) {
    const k = n.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      res.push(n);
    }
  }
  return res;
}

function toSortedArray(obj) {
  return Object.entries(obj)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

async function getConvincingInsights(req) {
  const { connection } = getConnectionByLocation(req.query.location);
  if (!connection) {
    const err = new Error(`Invalid location: ${req.query.location}`);
    err.status = 404;
    throw err;
  }
  const { from, to } = req.query;
  if (!from || !to) {
    const err = new Error("`from` and `to` (YYYY-MM-DD) are required");
    err.status = 400;
    throw err;
  }
  const run = makeRunner(connection);

  // Same new-patient filter used by /ConvincingScore/v3.
  const newApptSql = `
    SELECT DISTINCT ap.patient_id
    FROM appointment ap
    WHERE ap.appointment_timestamp >= ? AND ap.appointment_timestamp <= ?
      AND ap.is_deleted != 1
      AND ap.patient_type = 'New'
      AND ap.confirm_time != '0'
      AND ap.executivechk = 2
  `;

  // All diagnosis rows in range with both doctors + speciality resolved.
  // Ordered so the LAST row per patient is their latest diagnosis.
  const diagnosisSql = `
    SELECT d.patient_id,
           d.consultantDoctor, c.name AS consultantName,
           d.assistanceDoctor, a.name AS assistantName,
           d.date_diagnosis, d.diagnosisAdvice,
           d.speciality, d.provisionalDiagnosis
    FROM diagnosis d
    LEFT JOIN doctor c ON c.doctor_id = d.consultantDoctor
    LEFT JOIN doctor a ON a.doctor_id = d.assistanceDoctor
    WHERE d.date_diagnosis >= ? AND d.date_diagnosis <= ?
    ORDER BY d.patient_id, d.date_diagnosis
  `;

  const invoiceSql = `
    SELECT DISTINCT patient_id
    FROM invoice
    WHERE creation_date >= ? AND creation_date <= ? AND is_deleted != 1
  `;

  const [newApptRows, diagRows, invoiceRows] = await Promise.all([
    run(newApptSql, [from, to]),
    run(diagnosisSql, [from, to]),
    run(invoiceSql, [from, to]),
  ]);

  // For surgery-performed patients, their diagnosis may be from an EARLIER month
  // than the selected range. Look up each one's latest diagnosis on record
  // (up to `to`) so doctor/disease resolve instead of falling to "Not diagnosed".
  // Credit surgeries to doctors EXACTLY the way /ConvincingScore/v3 builds
  // invoiceCount: one diagnosis row per invoice-patient (grouped, any date).
  // Same source ⇒ the drill-down's doctor split matches the surgeon cards.
  const invoiceDxRows = invoiceRows.length
    ? await run(
        `SELECT d.patient_id,
                d.consultantDoctor, c.name AS consultantName,
                d.speciality
           FROM diagnosis d
           LEFT JOIN doctor c ON c.doctor_id = d.consultantDoctor
          WHERE d.patient_id IN (
            SELECT patient_id FROM invoice
            WHERE creation_date >= ? AND creation_date <= ? AND is_deleted != 1
          )
          GROUP BY d.patient_id`,
        [from, to],
      )
    : [];

  // Latest diagnosis per patient (rows are date-ascending, so last wins).
  const latestDx = {};
  for (const r of diagRows) {
    latestDx[r.patient_id] = {
      consultantId: r.consultantDoctor,
      consultantName: (r.consultantName || "").trim() || null,
      assistantId: r.assistanceDoctor,
      assistantName: (r.assistantName || "").trim() || null,
      speciality: (r.speciality || "").toString().trim() || "Unspecified",
      surgery:
        String(r.diagnosisAdvice || "")
          .replace(/,$/, "")
          .trim()
          .toLowerCase() !== "medication",
      subTypes: parseSubTypes(r.provisionalDiagnosis),
    };
  }

  const invoiceSet = new Set(invoiceRows.map((r) => String(r.patient_id)));
  const hasInvoice = (pid) => invoiceSet.has(String(pid));
  const newApptIds = newApptRows.map((r) => r.patient_id);

  // Gender lookup for every patient we might report on.
  const idArr = Array.from(
    new Set([
      ...newApptIds,
      ...diagRows.map((r) => r.patient_id),
      ...invoiceRows.map((r) => r.patient_id),
    ]),
  );
  const sexByPatient = {};
  if (idArr.length) {
    const sexRows = await run(
      `SELECT patient_id, sex FROM patient WHERE patient_id IN (?)`,
      [idArr],
    );
    for (const r of sexRows) sexByPatient[r.patient_id] = normSex(r.sex);
  }

  // Build the three breakdowns for a set of patient ids.
  const breakdown = (ids, fallback = {}) => {
    const gender = { Male: 0, Female: 0, Other: 0 };
    const byDoctor = {};
    const byDisease = {};
    for (const pid of ids) {
      gender[sexByPatient[pid] || "Other"]++;
      const dx = latestDx[pid] || fallback[pid];
      const docName =
        dx && dx.consultantName ? dx.consultantName : "Not diagnosed";
      byDoctor[docName] = (byDoctor[docName] || 0) + 1;
      const disease =
        dx && dx.speciality ? capFirst(dx.speciality) : "Not diagnosed";
      byDisease[disease] = (byDisease[disease] || 0) + 1;
    }
    return {
      total: ids.length,
      gender,
      byDoctor: toSortedArray(byDoctor),
      byDisease: toSortedArray(byDisease),
    };
  };

  // Surgeries-performed breakdown from the same rows /v3 credits to doctors.
  // Skipping rows without a consultant mirrors /v3 (which only tallies invoices
  // that have a consultantDoctor), so this total equals the summary-card number
  // and each doctor's count equals their card's "surgeries done".
  const surgeryPerformedBreakdown = () => {
    const gender = { Male: 0, Female: 0, Other: 0 };
    const byDoctor = {};
    const byDisease = {};
    let total = 0;
    for (const r of invoiceDxRows) {
      if (!r.consultantDoctor) continue;
      total++;
      gender[sexByPatient[r.patient_id] || "Other"]++;
      const docName =
        (r.consultantName || "").trim() || `Doctor ${r.consultantDoctor}`;
      byDoctor[docName] = (byDoctor[docName] || 0) + 1;
      const disease = (r.speciality || "").toString().trim()
        ? capFirst(r.speciality)
        : "Unspecified";
      byDisease[disease] = (byDisease[disease] || 0) + 1;
    }
    return {
      total,
      gender,
      byDoctor: toSortedArray(byDoctor),
      byDisease: toSortedArray(byDisease),
    };
  };

  const diagnosedIds = Object.keys(latestDx);
  const surgeryAdvisedIds = diagnosedIds.filter((pid) => latestDx[pid].surgery);
  const surgeriesPerformedIds = invoiceRows.map((r) => r.patient_id);

  // Per-doctor → speciality → sub-type, each with seen / advised / surgery.
  const buildDoctorBreakdown = (role) => {
    const docs = {};
    for (const pid of diagnosedIds) {
      const dx = latestDx[pid];
      const id = role === "consultant" ? dx.consultantId : dx.assistantId;
      const name = role === "consultant" ? dx.consultantName : dx.assistantName;
      if (!id) continue; // patient has no doctor in this role

      if (!docs[id])
        docs[id] = {
          doctorId: id,
          doctorName: name || `Doctor ${id}`,
          specs: {},
        };
      const specRaw = dx.speciality || "Unspecified";
      const specKey = specRaw.toLowerCase();
      if (!docs[id].specs[specKey])
        docs[id].specs[specKey] = {
          label: capFirst(specRaw),
          seen: 0,
          advised: 0,
          surgery: 0,
          subs: {},
        };

      const S = docs[id].specs[specKey];
      S.seen++;
      if (dx.surgery) S.advised++;
      if (hasInvoice(pid)) S.surgery++;

      for (const st of dx.subTypes) {
        const subKey = st.toLowerCase();
        if (!S.subs[subKey])
          S.subs[subKey] = { label: st, seen: 0, advised: 0, surgery: 0 };
        const T = S.subs[subKey];
        T.seen++;
        if (dx.surgery) T.advised++;
        if (hasInvoice(pid)) T.surgery++;
      }
    }
    return Object.values(docs).map((d) => ({
      doctorId: d.doctorId,
      doctorName: d.doctorName,
      specialities: Object.values(d.specs)
        .map((s) => ({
          speciality: s.label,
          seen: s.seen,
          advised: s.advised,
          surgery: s.surgery,
          subTypes: Object.values(s.subs)
            .map((t) => ({
              name: t.label,
              seen: t.seen,
              advised: t.advised,
              surgery: t.surgery,
            }))
            .sort((a, b) => b.seen - a.seen),
        }))
        .sort((a, b) => b.seen - a.seen),
    }));
  };

  return {
    range: { from, to },
    metrics: {
      newAppts: breakdown(newApptIds),
      diagnoses: breakdown(diagnosedIds),
      surgeryAdvised: breakdown(surgeryAdvisedIds),
      surgeriesPerformed: surgeryPerformedBreakdown(),
    },
    consultantDoctors: buildDoctorBreakdown("consultant"),
    assistantDoctors: buildDoctorBreakdown("assistant"),
  };
}

module.exports = { getConvincingInsights };
