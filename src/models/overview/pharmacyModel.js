// src/models/overview/pharmacyModel.js
// ─────────────────────────────────────────────────────────────────────────────
// The Pharmacy section:
//   metrics  Revenue · Average bill · Patients billed
//   blocks   Prescription conversion by patient type · Payment mode · Top medicines
//   deltas   optional, against the preceding period of equal length
//
// ⚠️ REVENUE COMES FROM TWO UNRELATED SYSTEMS
// ───────────────────────────────────────────
//   1. pharmacybill        plain SQL, one row per bill, final_total + paymentmode
//   2. evital_pharmacy_invoice   amount and mode live INSIDE a JSON blob, so it
//                                cannot be summed in SQL and is parsed per row
//                                in Node — exactly as reportMailModel does.
//
// The reduction below is a deliberate copy of getLocationSummary's, so this
// section's Revenue equals the Pharmacy slice of the home screen's billing bar.
//
// ⚠️ THE "OTHER" MODE IS EXCLUDED FROM THE HEADLINE — UPSTREAM'S CHOICE
// ────────────────────────────────────────────────────────────────────
// getLocationSummary assembles pharmacy.total = cash + card + online. Any
// eVital invoice whose mode is not Cash / CC-DC / Credit / UPI / Online is
// silently dropped from pharmacy revenue.
//
// That is reproduced here so the numbers tie out, but `otherAmount` is returned
// separately so the screen can SAY the money exists. If it is material, the
// pharmacy figure the business has been reading is understated — an upstream
// issue to raise, not something this section should quietly correct.
//
// ⚠️ SPLIT PAYMENTS
// ─────────────────
// When UpdatedInvoiceDetails carries more than one transaction, each one's own
// amount goes to its own mode — existing behaviour. A single-transaction row
// instead uses invoice.total. If a split's transactions do not sum to
// invoice.total the mode split and the revenue disagree; `modeDrift` reports
// the difference rather than absorbing it.
//
// ⚠️ DP ROAD
// ──────────
// getLocationSummary routes DP Road's "pharmacy" through patient_receipt with
// chargeCondition = 'LabTest'. That looks wrong — it is the lab predicate — but
// it is what the revenue figure everyone reads is built from, so it is
// reproduced rather than corrected. DP Road is currently commented out of the
// branch list, so it changes nothing today.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../../databaseUtils");
const { previousPeriod } = require("./opdModel");

const makeRunner =
  (connection) =>
  (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) =>
        err ? reject(err) : resolve(rows),
      ),
    );

const n0 = (v) => Number(v) || 0;

// Verbatim from reportMailModel / dailyOPDModel.
const normalizeMode = (mode = "") => {
  switch (mode) {
    case "CC/DC":
    case "Credit":
      return "Card";
    case "UPI":
    case "Online":
      return "Online";
    case "Cash":
      return "Cash";
    default:
      return "Other";
  }
};

const safeParse = (raw) => {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : null;
  } catch (_) {
    return null;
  }
};

/* ── SQL ──────────────────────────────────────────────────────────────────── */

const hmsSqlFor = (location) =>
  location === "DP Road"
    ? // See the DP Road note in the header.
      `SELECT COALESCE(SUM(CASE WHEN paymentmode = 'Cash'              THEN totalamt ELSE 0 END), 0) AS cash,
              COALESCE(SUM(CASE WHEN paymentmode = 'Card'              THEN totalamt ELSE 0 END), 0) AS card,
              COALESCE(SUM(CASE WHEN paymentmode IN ('Online','UPI')   THEN totalamt ELSE 0 END), 0) AS online,
              COUNT(*) AS bills
         FROM patient_receipt
        WHERE receipt_date BETWEEN ? AND ?
          AND chargeCondition = 'LabTest'
          AND is_deleted != 1`
    : `SELECT COALESCE(SUM(CASE WHEN paymentmode = 'Cash'                     THEN final_total ELSE 0 END), 0) AS cash,
              COALESCE(SUM(CASE WHEN paymentmode = 'Card'                     THEN final_total ELSE 0 END), 0) AS card,
              COALESCE(SUM(CASE WHEN paymentmode IN ('Online','UPI','Paytm')  THEN final_total ELSE 0 END), 0) AS online,
              COUNT(*) AS bills
         FROM pharmacybill
        WHERE created_at BETWEEN ? AND ?
          AND is_deleted != 1`;

// Only the columns needed. Upstream does SELECT * — fine for one day, wasteful
// over a month.
const EVITAL_SQL = `
  SELECT patient_id, invoice_details, UpdatedInvoiceDetails
    FROM evital_pharmacy_invoice
   WHERE STR_TO_DATE(
           JSON_UNQUOTE(JSON_EXTRACT(invoice_details, '$.bill_date')),
           '%Y-%m-%d %H:%i:%s'
         ) BETWEEN ? AND ?
`;

// Reproduces getPrescriptionPurchaseAnalysisQuantityV2's join exactly.
//
// ⚠️ THE PATIENT TYPE IS THE PATIENT'S LATEST APPOINTMENT, NOT THE ONE NEAR
//    THIS BILL. MAX(appointment_id) picks their most recent confirmed visit
//    whenever it happened, so a patient who was New in January and Follow-up in
//    August is labelled Follow-up on their January prescription.
//
//    That is roughly right for "today" and wrong for a historical range. It is
//    reproduced rather than corrected so this section agrees with the Pharmacy
//    Analysis screen — fixing it here alone would make two screens disagree.
//    The correct join is the appointment nearest the bill date; change BOTH,
//    deliberately, as its own task.
//
// Note the date column: created_at, matching the analysis screen. The revenue
// queries above use the bill_date inside the JSON. The two can differ by a day
// at a month boundary — another reason these counts and the revenue figure are
// reported separately rather than divided into each other.
const PRESCRIPTION_SQL = `
  SELECT epi.prescription_details,
         epi.invoice_details,
         epi.patient_id,
         ap.patient_type
    FROM evital_pharmacy_invoice epi
    LEFT JOIN (
      SELECT a1.patient_id, a1.patient_type
        FROM appointment a1
        INNER JOIN (
          SELECT patient_id, MAX(appointment_id) AS latest_id
            FROM appointment
           WHERE confirm_time != 0
           GROUP BY patient_id
        ) a2 ON a1.appointment_id = a2.latest_id
    ) ap ON ap.patient_id = epi.patient_id
   WHERE epi.prescription_details IS NOT NULL
     AND epi.patient_id IS NOT NULL
     AND epi.created_at BETWEEN ? AND ?
`;

/* ── Prescription conversion ─────────────────────────────────────────────── */

// The four buckets, in the order the section renders them. Anything the column
// holds beyond these three named types lands in Other rather than being
// dropped — an unrecognised patient_type is a data question, and hiding it
// stops the question being asked.
const RX_TYPES = [
  { key: "new", label: "New", match: "New" },
  { key: "follow", label: "Follow-up", match: "Follow" },
  { key: "postop", label: "Post-op", match: "Postoperative" },
  { key: "other", label: "Other", match: null },
];

const rxBucket = (patientType) => {
  const t = String(patientType || "").trim();
  const hit = RX_TYPES.find((x) => x.match && x.match === t);
  return hit ? hit.key : "other";
};

/**
 * What one prescribed line is worth — mrp × quantity less the line discount.
 * The same arithmetic getPrescriptionPurchaseAnalysis uses.
 */
const lineValue = (p) => {
  const mrp = parseFloat(p.mrp) || 0;
  const qty = parseFloat(p.quantity) || 0;
  const disc = parseFloat(p.discount_percentage) || 0;
  return mrp * qty - (mrp * qty * disc) / 100;
};

/** Per-unit price, for valuing a partial shortfall. */
const unitValue = (p) => {
  const qty = parseFloat(p.quantity) || 0;
  return qty > 0 ? lineValue(p) / qty : 0;
};

/**
 * Prescription conversion, grouped by patient type.
 *
 * A prescription counts as TAKEN when anything at all was purchased against it
 * and NOT TAKEN when nothing was — the same two-way split
 * getPrescriptionPurchaseAnalysis settled on. Partial purchases sit inside
 * "taken", so their shortfall is reported separately rather than being
 * invisible: a patient who bought one of six medicines is a conversion on paper
 * and a loss in practice.
 *
 * Rows are PRESCRIPTIONS, not patients. A patient with two prescriptions in the
 * window counts twice, because each is a separate opportunity to dispense.
 */
async function gatherPrescriptions(run, fromDt, toDt) {
  const rows = await run(PRESCRIPTION_SQL, [fromDt, toDt]).catch((e) => {
    console.error("overview/pharmacy: prescription query failed:", e.message);
    return null;
  });
  if (!rows) return null;

  const blank = () => ({
    total: 0,
    taken: 0,
    notTaken: 0,
    prescribedValue: 0,
    purchasedValue: 0,
    lostNotTaken: 0,
    lostPartial: 0,
  });

  const buckets = {};
  for (const t of RX_TYPES) buckets[t.key] = blank();

  let badJson = 0;

  for (const row of rows) {
    let prescription = [];
    let invoice = {};
    try {
      prescription = JSON.parse(row.prescription_details || "[]");
    } catch (_) {
      badJson++;
      continue;
    }
    try {
      invoice = JSON.parse(row.invoice_details || "{}");
    } catch (_) {
      invoice = {};
    }

    if (!Array.isArray(prescription) || !prescription.length) continue;

    const items = invoice.items || [];
    const b = buckets[rxBucket(row.patient_type)];

    let prescribedValue = 0;
    let shortfallValue = 0;
    let purchasedQty = 0;

    for (const p of prescription) {
      const pQty = Number(p.quantity) || 0;
      const bought = items.find((i) => i.medicine_id === p.medicine_id);
      const bQty = bought ? Number(bought.quantity) || 0 : 0;

      prescribedValue += lineValue(p);
      purchasedQty += bQty;

      // Only a SHORTFALL is a loss. Buying more than prescribed is not negative
      // loss, so the gap is floored at zero per line — an extra purchase on one
      // medicine cannot cancel out a shortfall on another.
      const missing = Math.max(0, pQty - bQty);
      shortfallValue += missing * unitValue(p);
    }

    b.total += 1;
    b.prescribedValue += prescribedValue;
    b.purchasedValue += Number(invoice.total) || 0;

    if (purchasedQty === 0) {
      b.notTaken += 1;
      b.lostNotTaken += shortfallValue;
    } else {
      b.taken += 1;
      b.lostPartial += shortfallValue;
    }
  }

  const byType = RX_TYPES.map((t) => {
    const b = buckets[t.key];
    return {
      key: t.key,
      label: t.label,
      total: b.total,
      taken: b.taken,
      notTaken: b.notTaken,
      conversionPct: b.total > 0 ? Math.round((b.taken / b.total) * 100) : null,
      prescribedValue: Math.round(b.prescribedValue),
      purchasedValue: Math.round(b.purchasedValue),
      lostNotTaken: Math.round(b.lostNotTaken),
      lostPartial: Math.round(b.lostPartial),
      lostTotal: Math.round(b.lostNotTaken + b.lostPartial),
    };
  }).filter((t) => t.total > 0);

  const sum = (f) => byType.reduce((a, t) => a + t[f], 0);

  return {
    byType,
    totals: {
      total: sum("total"),
      taken: sum("taken"),
      notTaken: sum("notTaken"),
      lostNotTaken: sum("lostNotTaken"),
      lostPartial: sum("lostPartial"),
      lostTotal: sum("lostTotal"),
      conversionPct:
        sum("total") > 0
          ? Math.round((sum("taken") / sum("total")) * 100)
          : null,
    },
    badJson,
  };
}

/* ── eVital reduction ────────────────────────────────────────────────────── */

function reduceEvital(rows, wantMedicines) {
  const modes = { Cash: 0, Card: 0, Online: 0, Other: 0 };
  const patients = new Set();
  const medicines = new Map();

  let bills = 0;
  let badJson = 0;
  let modeDrift = 0;
  let splitBills = 0;

  for (const row of rows) {
    const invoice = safeParse(row.invoice_details);
    if (!invoice) {
      badJson++;
      continue;
    }

    const total = Math.round(n0(invoice.total));
    bills++;
    if (row.patient_id != null) patients.add(row.patient_id);

    if (wantMedicines) {
      for (const item of invoice.items || []) {
        const name = String(item.medicine_name || "").trim();
        if (!name) continue;
        const key = name.toLowerCase();
        const qty = n0(item.quantity);
        // The item amount key is not consistent across eVital versions, so the
        // first present wins rather than assuming one name.
        const amount = n0(item.total ?? item.amount ?? item.net_amount ?? 0);
        const hit = medicines.get(key) || {
          label: name,
          qty: 0,
          amount: 0,
          bills: 0,
        };
        hit.qty += qty;
        hit.amount += amount;
        hit.bills += 1;
        medicines.set(key, hit);
      }
    }

    const updated = safeParse(row.UpdatedInvoiceDetails);
    const txns = updated?.transaction_summary?.transactions ?? [];

    if (txns.length === 1) {
      modes[normalizeMode(txns[0].method)] += total;
      continue;
    }
    if (txns.length > 1) {
      splitBills++;
      let sum = 0;
      for (const t of txns) {
        const amt = Math.round(n0(t.amount));
        modes[normalizeMode(t.method)] += amt;
        sum += amt;
      }
      modeDrift += sum - total;
      continue;
    }

    modes[normalizeMode(invoice.payment_mode)] += total;
  }

  return {
    modes,
    bills,
    patients: patients.size,
    badJson,
    modeDrift,
    splitBills,
    medicines: wantMedicines
      ? [...medicines.values()]
          .map((m) => ({
            key: m.label.toLowerCase(),
            label: m.label,
            qty: m.qty,
            bills: m.bills,
            amount: Math.round(m.amount),
          }))
          .sort((a, b) => b.amount - a.amount || b.qty - a.qty)
      : [],
  };
}

/* ── gather ──────────────────────────────────────────────────────────────── */

async function gather(run, location, from, to, detailed) {
  const fromDt = `${from} 00:00:00`;
  const toDt = `${to} 23:59:59`;

  const [hmsRows, evitalRows, prescriptions] = await Promise.all([
    run(hmsSqlFor(location), [fromDt, toDt]).catch((e) => {
      console.error(`overview/pharmacy: HMS query failed:`, e.message);
      return null;
    }),
    run(EVITAL_SQL, [fromDt, toDt]).catch((e) => {
      console.error(`overview/pharmacy: eVital query failed:`, e.message);
      return [];
    }),
    // Current window only — nothing shows a prescription delta, and parsing
    // every prescription twice would double the heaviest work in this model.
    detailed ? gatherPrescriptions(run, fromDt, toDt) : Promise.resolve(null),
  ]);

  const hms = hmsRows?.[0] || {};
  const hmsCash = Math.round(n0(hms.cash));
  const hmsCard = Math.round(n0(hms.card));
  const hmsOnline = Math.round(n0(hms.online));
  const hmsBills = n0(hms.bills);
  const hmsTotal = hmsCash + hmsCard + hmsOnline;

  const ev = reduceEvital(evitalRows || [], detailed);
  const evTotal = ev.modes.Cash + ev.modes.Card + ev.modes.Online;

  // getLocationSummary's assembly, exactly: Other is never added.
  const revenue = hmsTotal + evTotal;
  const bills = hmsBills + ev.bills;

  return {
    revenue,
    bills,
    // Still computed and returned even though no card shows it — it is the
    // honest denominator for avgBill, and the export may want it.
    avgBill: bills > 0 ? Math.round(revenue / bills) : null,
    patients: ev.patients, // eVital only — pharmacybill exposes no patient link
    otherAmount: ev.modes.Other,
    modes: {
      Cash: hmsCash + ev.modes.Cash,
      Card: hmsCard + ev.modes.Card,
      Online: hmsOnline + ev.modes.Online,
      Other: ev.modes.Other,
    },
    sources: [
      { key: "inhouse", label: "In-house", amount: hmsTotal, bills: hmsBills },
      {
        key: "evital",
        label: "eVital counter",
        amount: evTotal,
        bills: ev.bills,
      },
    ],
    medicines: ev.medicines,
    prescriptions,
    quality: {
      badJson: ev.badJson,
      splitBills: ev.splitBills,
      modeDrift: ev.modeDrift,
      prescriptionBadJson: prescriptions?.badJson ?? 0,
    },
  };
}

/**
 * getPharmacySection({ location, from, to, compare, preset })
 */
async function getPharmacySection({ location, from, to, compare, preset }) {
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
  const run = makeRunner(connection);

  const current = await gather(run, location, from, to, true);

  let prev = null;
  let prevRange = null;
  if (compare === "prev") {
    prevRange = previousPeriod(from, to, preset);
    // Medicines and prescriptions are skipped for the comparison window.
    prev = await gather(run, location, prevRange.from, prevRange.to, false);
  }

  const delta = (cur, before) => {
    if (cur == null || before == null || before === 0) return null;
    return Math.round(((cur - before) / before) * 100);
  };

  return {
    meta: {
      location,
      from,
      to,
      compare: prevRange,
      singleDay: from === to,
      generatedAt: new Date().toISOString(),
    },
    revenue: current.revenue,
    bills: current.bills,
    avgBill: current.avgBill,
    patients: current.patients,
    otherAmount: current.otherAmount,
    modes: current.modes,
    sources: current.sources,
    prescriptions: current.prescriptions,
    // Ten is the list, not a page of one. A month can produce hundreds of
    // distinct medicines, and the tail is reported as a count instead.
    medicines: current.medicines.slice(0, 10),
    distinctMedicines: current.medicines.length,
    quality: current.quality,
    prev: prev
      ? { revenue: prev.revenue, bills: prev.bills, avgBill: prev.avgBill }
      : null,
    deltas: prev
      ? {
          revenue: delta(current.revenue, prev.revenue),
          bills: delta(current.bills, prev.bills),
          avgBill: delta(current.avgBill, prev.avgBill),
        }
      : null,
  };
}

module.exports = { getPharmacySection };
