/* eslint-disable prettier/prettier */
// src/models/utils/invoiceSurgery.js
// ─────────────────────────────────────────────────────────────────────────────
// Which SURGERY an IPD invoice was for, from discharge_card.surgeryadvice —
// for the "By Surgery" view of the Insurance Due List and its comparison tabs.
//
// ── LINKING AN INVOICE TO ITS DISCHARGE CARD ────────────────────────────────
// discharge_card has no invoice_id, only patient_id. A patient can have more
// than one surgery, so each invoice takes the patient's card whose discharge
// date (DOD; DOA if DOD is blank) is CLOSEST to the invoice date — the bill is
// raised at discharge. No card for the patient → "Discharge card not found".
//
// ── MAPPING surgeryadvice ───────────────────────────────────────────────────
// surgeryadvice is free text and can name more than one procedure
// ("LHP + SPHINCTEROTOMY"). Every code in SURGERY_MAP found in the text (case-
// and spacing-insensitive, whole words) is mapped; the distinct surgeries are
// joined in the map's order ("Piles + Fissure"), so an invoice sits in exactly
// one group and the groups always add up to the total. Text with no known code
// → "Other (unmapped)", with the raw text kept on the row so new codes can be
// added here.
// ─────────────────────────────────────────────────────────────────────────────

// Code in surgeryadvice → surgery shown. Order = order in combined labels.
const SURGERY_MAP = [
  ["LHP", "Piles"],
  ["MIPH", "Piles"],
  ["FILAC", "Fistula"],
  ["DLPL", "Fistula"],
  ["SPHINCTEROTOMY", "Fissure"],
  ["EUA", "EUA"],
  ["STARR", "Constipation"],
  ["LPP", "Pilonidal Sinus"],
  ["RHOMBOID PLASTY", "Rhombic Flap"],
  ["PROCTITIS", "Proctitis"],
  ["GYNAECOMASTIA", "Gynaecomastia"],
  ["VARICOSE VEINS", "Varicose Veins"],
  ["CIRCUMCISION", "Circumcision"],
  ["HERNIA", "Hernia"],
  ["UROLOGY", "Urology"],
  ["LAP CHOLECYSTECTOMY", "Lap. Chole"],
];

const NO_CARD = "Discharge card not found";
const NO_ADVICE = "Surgery not recorded";
const UNMAPPED = "Other (unmapped)";

const norm = (s) =>
  String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();

// Whole-word matchers, built once. "LAP CHOLECYSTECTOMY" also matches
// "LAP. CHOLECYSTECTOMY" / "lap-cholecystectomy" because both sides are
// normalised to single spaces.
const MATCHERS = SURGERY_MAP.map(([code, label]) => ({
  label,
  re: new RegExp(`(^| )${norm(code)}( |$)`),
}));

/** surgeryadvice text → { label, surgeries: [..], raw } */
function mapSurgery(raw) {
  const text = norm(raw);
  if (!text) return { label: NO_ADVICE, surgeries: [], raw: raw || null };
  const found = [];
  for (const m of MATCHERS) {
    if (m.re.test(text) && !found.includes(m.label)) found.push(m.label);
  }
  if (!found.length) return { label: UNMAPPED, surgeries: [], raw };
  return { label: found.join(" + "), surgeries: found, raw };
}

const dayNum = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ""));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null;
};

/**
 * Adds to every row: surgery (label), surgeries ([..]), surgery_raw,
 * surgery_kind ('named' | 'unmapped' | 'none' | 'nocard').
 * Rows need patient_id and invoice_date ('YYYY-MM-DD'). Never throws — a
 * failed lookup leaves every row as "Discharge card not found".
 */
async function attachSurgeries(rows, connection) {
  const ids = [...new Set(rows.map((r) => r.patient_id).filter(Boolean))];
  let cards = [];
  if (ids.length) {
    try {
      cards = await new Promise((resolve, reject) =>
        connection.query(
          `SELECT patient_id,
                  surgeryadvice,
                  DATE_FORMAT(COALESCE(DOD, DOA), '%Y-%m-%d') AS card_date
             FROM discharge_card
            WHERE patient_id IN (?)`,
          [ids],
          (e, r) => (e ? reject(e) : resolve(r)),
        ),
      );
    } catch (e) {
      console.error("invoiceSurgery: discharge_card lookup failed:", e.message);
    }
  }

  const byPatient = new Map();
  for (const c of cards) {
    const k = String(c.patient_id);
    if (!byPatient.has(k)) byPatient.set(k, []);
    byPatient.get(k).push(c);
  }

  for (const r of rows) {
    const list = byPatient.get(String(r.patient_id)) || [];
    if (!list.length) {
      Object.assign(r, {
        surgery: NO_CARD,
        surgeries: [],
        surgery_raw: null,
        surgery_kind: "nocard",
      });
      continue;
    }
    // Closest discharge to the invoice date (see header).
    const inv = dayNum(r.invoice_date);
    const card =
      list.length === 1 || inv === null
        ? list[0]
        : [...list].sort((a, b) => {
            const da = dayNum(a.card_date);
            const db = dayNum(b.card_date);
            return (
              (da === null ? 1e9 : Math.abs(da - inv)) -
              (db === null ? 1e9 : Math.abs(db - inv))
            );
          })[0];
    const s = mapSurgery(card.surgeryadvice);
    Object.assign(r, {
      surgery: s.label,
      surgeries: s.surgeries,
      surgery_raw: s.raw ? String(s.raw).trim() : null,
      surgery_kind:
        s.label === NO_ADVICE
          ? "none"
          : s.label === UNMAPPED
            ? "unmapped"
            : "named",
    });
  }
  return rows;
}

module.exports = {
  attachSurgeries,
  mapSurgery,
  SURGERY_MAP,
  NO_CARD,
  NO_ADVICE,
  UNMAPPED,
};
