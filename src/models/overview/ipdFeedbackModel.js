// src/models/overview/ipdFeedbackModel.js
// ─────────────────────────────────────────────────────────────────────────────
// Post-surgery feedback captured against ipdpatients.ipdFeedback (JSON).
//
// TWO FIELDS DO NOT MEAN WHAT THEY ARE CALLED
// ───────────────────────────────────────────
// 1. `psi` stores the RAW SCORE, not the index. In the sample row psi = 43 and
//    maxPossibleScore = 50 — the Patient Satisfaction Index is 43/50 × 100 =
//    86%, not 43. `patientSatisfactionIndex` and `totalScoreAchieved` are both
//    the same raw 43. So the percentage is computed here and the stored field
//    is ignored. Showing 43 as a percentage would understate every branch by
//    roughly half.
//
// 2. `nps` stores the raw 0–10 recommend score for ONE patient. NPS is a
//    cohort statistic — %Promoters − %Detractors — and cannot exist for a
//    single respondent. `nps`, `recommendScore` and `netPromoterScore` are all
//    the same number. This model therefore keeps the per-patient value as
//    `recommendScore` and computes the real NPS across the set.
//
// Standard NPS bands, applied to the 0–10 score:
//    9–10 Promoter · 7–8 Passive · 0–6 Detractor
//
// The ten rated questions (3 facility + 4 healing team + 3 transparency), each
// 1–5, give the maximum of 50 the form implies. maxPossibleScore is read from
// the row rather than assumed, so a future eleventh question doesn't silently
// skew the index.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../../databaseUtils");

const makeRunner =
  (connection) =>
  (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) =>
        err ? reject(err) : resolve(rows),
      ),
    );

// The mysql driver returns a JSON column as an object on some versions and as
// a string on others. Handle both rather than depending on driver behaviour
// being identical across forty branch databases.
function parseFeedback(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : null;
  } catch (_) {
    return null;
  }
}

/**
 * Any of the shapes these columns turn up in → { date: 'YYYY-MM-DD', time }.
 * adm_date is not guaranteed to match surgery_date's format across all forty
 * branch databases, so both shapes are handled rather than assumed.
 */
function splitDateTime(value) {
  if (!value) return { date: null, time: null };

  // A driver-parsed DATE/DATETIME column.
  if (value instanceof Date) {
    return { date: value.toISOString().slice(0, 10), time: null };
  }

  const s = String(value).trim();

  // '28-08-2026 08:00 PM'
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(.+))?$/);
  if (dmy) {
    return { date: `${dmy[3]}-${dmy[2]}-${dmy[1]}`, time: dmy[4] || null };
  }

  // '2026-08-28' or '2026-08-28 20:00:00'
  const ymd = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](.+))?$/);
  if (ymd) return { date: ymd[1], time: ymd[2] || null };

  return { date: null, time: null };
}

const numOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Answers arrive as strings ("4"). Clamp to the 1–5 the form allows so one bad
// row cannot push a branch's index above 100%.
const rating = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(5, Math.max(0, n));
};

const band = (score) => {
  if (score == null) return null;
  if (score >= 9) return "promoter";
  if (score >= 7) return "passive";
  return "detractor";
};

// Question layout, mirroring the form exactly — order included, because the
// detail screen renders straight from this.
const SECTIONS = [
  {
    key: "facility",
    title: "The Facility",
    items: [
      { key: "room", label: "Room" },
      { key: "bathroom", label: "Bathroom" },
      { key: "ambience", label: "Ambience" },
    ],
  },
  {
    key: "healingTeam",
    title: "The Healing Team",
    subtitle: "Everyone who supported your care",
    items: [
      { key: "frontDesk", label: "Front Desk" },
      { key: "nursingCare", label: "Nursing Care" },
      { key: "doctorCounselling", label: "Doctor Counselling" },
      { key: "pharmacy", label: "Pharmacy" },
    ],
  },
  {
    key: "transparency",
    title: "Ease and Transparency of Department",
    items: [
      { key: "admission", label: "Admission" },
      { key: "discharge", label: "Discharge" },
      { key: "billingPayments", label: "Billing and Payments" },
    ],
  },
];

// surgery_date is now stored YYYY-MM-DD, so it compares and sorts correctly as
// a plain string — no STR_TO_DATE needed, and the column can use an index
// again, which the function call previously prevented.
//
// LEFT(surgery_date, 10) rather than a bare comparison: if any row still
// carries a time component ('2026-08-28 20:00'), a bare `<= '2026-08-28'`
// would drop it, because the string with a time sorts AFTER the bare date.
const LIST_SQL = `
  SELECT patient_id, uid_no, patient_name, phone, age, sex,
         adm_date, surgery_date, room_type, Surgeon_name, ipdFeedback
  FROM ipdpatients
  WHERE LEFT(surgery_date, 10) BETWEEN ? AND ?
    AND is_deleted != 1
  ORDER BY surgery_date DESC, patient_id DESC
`;

/**
 * getIpdFeedback({ location, from, to })
 *
 * Returns every operated patient in the window, whether or not they responded,
 * plus the cohort summary. Non-responders are included on purpose: a response
 * rate of 12 out of 80 is the most important thing on the screen, and a list
 * that silently drops the other 68 hides it.
 */
async function getIpdFeedback({ location, from, to }) {
  if (!location) {
    const err = new Error("location is required");
    err.status = 400;
    throw err;
  }
  if (!from || !to) {
    const err = new Error("from and to are required (YYYY-MM-DD)");
    err.status = 400;
    throw err;
  }

  const { connection } = getConnectionByLocation(location);
  if (!connection) {
    const err = new Error(`Invalid location: ${location}`);
    err.status = 404;
    throw err;
  }

  const rows = await makeRunner(connection)(LIST_SQL, [from, to]);

  const patients = rows.map((r) => {
    const fb = parseFeedback(r.ipdFeedback);

    // recommendScore first, then the two aliases — same number in the sample,
    // but if they ever diverge the explicitly-named field is the honest one.
    const recommendScore = fb
      ? (numOrNull(fb.recommendScore) ??
        numOrNull(fb.netPromoterScore) ??
        numOrNull(fb.nps))
      : null;

    const achieved = fb ? numOrNull(fb.totalScoreAchieved) : null;
    const max = fb ? numOrNull(fb.maxPossibleScore) : null;

    // The index, computed — never fb.psi, which holds the raw score.
    const psiPct =
      achieved != null && max ? Math.round((achieved / max) * 100) : null;

    const answers = fb
      ? SECTIONS.map((s) => ({
          key: s.key,
          title: s.title,
          subtitle: s.subtitle || null,
          items: s.items.map((i) => ({
            key: i.key,
            label: i.label,
            value: rating(fb[s.key]?.[i.key]),
          })),
        }))
      : null;

    return {
      patientId: r.patient_id,
      uidNo: r.uid_no,
      name: r.patient_name,
      phone: r.phone,
      age: r.age,
      sex: r.sex,
      // splitDateTime still handles the day-first shape, so any legacy rows
      // that were not migrated still render correctly rather than showing raw.
      admDate: splitDateTime(r.adm_date).date,
      surgeryDate: splitDateTime(r.surgery_date).date,
      surgeryTime: splitDateTime(r.surgery_date).time,
      roomType: r.room_type,
      surgeon: r.Surgeon_name,
      responded: !!fb,
      recommendScore,
      band: band(recommendScore),
      totalScoreAchieved: achieved,
      maxPossibleScore: max,
      psiPct,
      answers,
    };
  });

  const responded = patients.filter(
    (p) => p.responded && p.recommendScore != null,
  );
  const counts = { promoter: 0, passive: 0, detractor: 0 };
  for (const p of responded) if (p.band) counts[p.band]++;

  const n = responded.length;
  const pct = (c) => (n > 0 ? (c / n) * 100 : 0);

  // NPS = %Promoters − %Detractors, rounded once at the end. Rounding the two
  // percentages first can shift the result by a point.
  const nps =
    n > 0 ? Math.round(pct(counts.promoter) - pct(counts.detractor)) : null;

  const psiValues = patients
    .filter((p) => p.psiPct != null)
    .map((p) => p.psiPct);
  const psiAvg = psiValues.length
    ? Math.round(psiValues.reduce((a, b) => a + b, 0) / psiValues.length)
    : null;

  // The eleven counts the NPS block needs. Banding on the client from the raw
  // distribution means the screen and the model can never disagree about where
  // 8 stops and 9 starts.
  const scoreCounts = Array.from({ length: 11 }, () => 0);
  for (const p of responded) {
    const v = Number(p.recommendScore);
    if (Number.isInteger(v) && v >= 0 && v <= 10) scoreCounts[v]++;
  }

  return {
    meta: { location, from, to, generatedAt: new Date().toISOString() },
    summary: {
      operated: patients.length,
      responses: n,
      responseRatePct:
        patients.length > 0 ? Math.round((n / patients.length) * 100) : null,
      nps,
      scoreCounts,
      promoters: counts.promoter,
      passives: counts.passive,
      detractors: counts.detractor,
      promoterPct: Math.round(pct(counts.promoter)),
      passivePct: Math.round(pct(counts.passive)),
      detractorPct: Math.round(pct(counts.detractor)),
      psiAvg,
    },
    patients,
  };
}

module.exports = { getIpdFeedback, SECTIONS };
