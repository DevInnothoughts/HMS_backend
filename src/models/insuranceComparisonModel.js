/* eslint-disable prettier/prettier */
// src/models/insuranceComparisonModel.js
// ─────────────────────────────────────────────────────────────────────────────
// INSURANCE COMPARISON — for Cashless invoices, insurer-wise:
//   1. BILLED vs APPROVED    how much of the bill the insurer approved
//   2. APPROVED vs SETTLED   how much of the approval was actually paid
//
//   GET /IPDCollection/insuranceComparison?location=DP Road
//
// ── WHICH INVOICES ──────────────────────────────────────────────────────────
// The Insurance Due List's set, without the "still due" condition: Cashless,
// not deleted, created on/after 2025-04-01, and COUNTED under the interbranch
// rule (utils/interbranch.js — the operating branch's copy belongs to the
// source branch). Insurers resolve per invoice date across the 1 Jul 2026
// master cutover and are grouped by NAME (same as insuranceDueModel.js).
//
// ── WHERE EACH AMOUNT COMES FROM (no IHX data) ──────────────────────────────
//   BILLED    invoice.totalamt
//   APPROVED  invoice.receivedamt — the amount approved by the insurer,
//             recorded on the invoice. Empty / 0 → "approval not recorded":
//             left out of the billed-vs-approved figures rather than counted
//             as a 100% deduction.
//   SETTLED   SUM(insurance_invoice.receivedamt + insurance_invoice.tdsamt)
//             for the invoice (joined on invoiceid — the join the IPD
//             collection figures use). TDS is part of the claim settlement:
//             the insurer deducts it at source and the hospital claims it, so
//             it counts as settled. The two parts are also returned on their
//             own — `received` (paid into the bank) and `tds`. No settlement
//             row → "awaiting settlement".
//
// Approved-vs-settled compares ONLY invoices that have both, so a claim still
// in process never reads as a short payment; approved-but-unpaid is reported
// separately as "awaiting settlement".
//
// INSURER OR TPA: `insurers` and `tpas` are the same invoices grouped two
// ways (utils/payerGroups.js); claims with no TPA are "Direct with insurer".
//
// DAYS TO SETTLE = invoice date → latest settlement payment date.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../databaseUtils");
const { countedSql } = require("./utils/interbranch");
const { addCompanyNames } = require("./utils/insuranceNames");
const {
  groupOf,
  insurerOf,
  tpaOf,
  mixNameOf,
  makeMixCounter,
} = require("./utils/payerGroups");
const { attachSurgeries } = require("./utils/invoiceSurgery");

const SINCE = "2025-04-01";

const n0 = (v) => Number(v) || 0;
const round = (v) => Math.round(v);
const pctOf = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

const INVOICE_SQL = `
  SELECT
      i.invoice_id,
      i.patient_id,
      p.name,
      DATE_FORMAT(i.creation_date, '%Y-%m-%d') AS invoice_date,
      i.totalamt,
      i.totaldue,
      i.receivedamt AS approved_amt,
      i.insurancecompany,
      i.tpa
  FROM invoice i
  JOIN patient p ON p.patient_id = i.patient_id
  WHERE i.is_deleted != 1
    AND i.creation_date >= ?
    AND i.status = 'Cashless'
    AND ${countedSql("i")}
  ORDER BY i.creation_date ASC
`;

const SETTLEMENT_SQL = `
  SELECT
      iv.invoiceid AS invoice_id,
      COALESCE(SUM(iv.receivedamt), 0) AS received,
      COALESCE(SUM(iv.tdsamt), 0)      AS tds,
      DATE_FORMAT(MAX(iv.paymentdate), '%Y-%m-%d') AS last_paid
  FROM insurance_invoice iv
  JOIN invoice i ON i.invoice_id = iv.invoiceid
  WHERE i.is_deleted != 1
    AND i.creation_date >= ?
    AND i.status = 'Cashless'
  GROUP BY iv.invoiceid
`;

const daysBetween = (a, b) => {
  const pa = /^(\d{4})-(\d{2})-(\d{2})/.exec(a || "");
  const pb = /^(\d{4})-(\d{2})-(\d{2})/.exec(b || "");
  if (!pa || !pb) return null;
  const d =
    (Date.UTC(+pb[1], +pb[2] - 1, +pb[3]) -
      Date.UTC(+pa[1], +pa[2] - 1, +pa[3])) /
    86400000;
  return d >= 0 ? d : null;
};

const emptyGroup = (key, name) => ({
  key,
  name,
  invoices: 0,
  billed: 0,
  // Billed vs approved — invoices with an approved amount recorded
  approval: { invoices: 0, billed: 0, approved: 0, deduction: 0, pct: null },
  noApproval: { invoices: 0, billed: 0 },
  // Approved vs settled — invoices with an approval AND a settlement
  settlement: {
    invoices: 0,
    approved: 0,
    settled: 0, // received + tds
    received: 0,
    tds: 0,
    shortfall: 0,
    pct: null,
    days: [],
    avgDays: null,
  },
  awaiting: { invoices: 0, approved: 0 },
  rows: [],
});

function finish(g) {
  g.billed = round(g.billed);
  const a = g.approval;
  a.billed = round(a.billed);
  a.approved = round(a.approved);
  a.deduction = round(a.billed - a.approved);
  a.pct = pctOf(a.approved, a.billed);
  g.noApproval.billed = round(g.noApproval.billed);
  const s = g.settlement;
  s.approved = round(s.approved);
  s.settled = round(s.settled);
  s.received = round(s.received);
  s.tds = round(s.tds);
  s.shortfall = round(s.approved - s.settled);
  s.pct = pctOf(s.settled, s.approved);
  s.avgDays = s.days.length
    ? Math.round(s.days.reduce((x, y) => x + y, 0) / s.days.length)
    : null;
  delete s.days;
  g.awaiting.approved = round(g.awaiting.approved);
  return g;
}

async function getInsuranceComparison({ location }) {
  const { connection } = getConnectionByLocation(location);
  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }
  const q = (sql, params) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (e, r) => (e ? reject(e) : resolve(r))),
    );

  const [rows, settlements] = await Promise.all([
    q(INVOICE_SQL, [SINCE]),
    q(SETTLEMENT_SQL, [SINCE]),
  ]);
  const paid = new Map(settlements.map((s) => [String(s.invoice_id), s]));

  await addCompanyNames(rows, connection, "invoice_date", [
    "insurancecompany",
    "tpa",
  ]);

  // Surgery from the patient's discharge card (utils/invoiceSurgery.js).
  await attachSurgeries(rows, connection);

  // Per-invoice figures, computed once and grouped three ways.
  const facts = rows.map((r) => {
    const billed = n0(r.totalamt);
    const approved = n0(r.approved_amt) > 0 ? n0(r.approved_amt) : null;
    const s = paid.get(String(r.invoice_id));
    const received = s ? n0(s.received) : 0;
    const tds = s ? n0(s.tds) : 0;
    // Settled = bank receipt + TDS deducted at source (see header).
    const settled = received + tds > 0 ? received + tds : null;
    const days =
      settled !== null ? daysBetween(r.invoice_date, s.last_paid) : null;
    return { r, s, billed, approved, received, tds, settled, days };
  });

  const total = emptyGroup("all", "All payers");
  for (const f of facts) addTo(total, f);
  delete total.rows;

  return {
    meta: { location, since: SINCE, generatedAt: new Date().toISOString() },
    totals: finish(total),
    insurers: groupBy(facts, "insurer"),
    // "Direct with insurer (no TPA)" for claims without a TPA
    tpas: groupBy(facts, "tpa"),
    surgeries: groupBy(facts, "surgery"),
  };
}

function addTo(t, f) {
  const { billed, approved, received, tds, settled, days } = f;
  t.invoices += 1;
  t.billed += billed;
  if (approved !== null) {
    t.approval.invoices += 1;
    t.approval.billed += billed;
    t.approval.approved += approved;
    if (settled !== null) {
      t.settlement.invoices += 1;
      t.settlement.approved += approved;
      t.settlement.settled += settled;
      t.settlement.received += received;
      t.settlement.tds += tds;
      if (days !== null) t.settlement.days.push(days);
    } else {
      t.awaiting.invoices += 1;
      t.awaiting.approved += approved;
    }
  } else {
    t.noApproval.invoices += 1;
    t.noApproval.billed += billed;
  }
}

/**
 * Groups by insurer or TPA (utils/payerGroups.js). Each group also lists the
 * OTHER side (`mix`): the TPAs an insurer's claims go through, or the insurers
 * a TPA handles.
 */
function groupBy(facts, by) {
  const groups = new Map();
  for (const f of facts) {
    const { r, s, billed, approved, received, tds, settled, days } = f;
    const g0 = groupOf(r, by);
    const ins = insurerOf(r);
    const tpa = tpaOf(r);
    if (!groups.has(g0.key)) {
      const g = emptyGroup(g0.key, g0.name);
      g.kind = g0.kind;
      g._mix = makeMixCounter();
      groups.set(g0.key, g);
    }
    const g = groups.get(g0.key);
    if (g0.kind === "named") g.name = g0.name; // newest spelling wins
    addTo(g, f);
    g._mix.add(mixNameOf(r, by));
    g.rows.push({
      invoice_id: r.invoice_id,
      patient_id: r.patient_id,
      name: r.name,
      invoice_date: r.invoice_date,
      billed: round(billed),
      approved: approved === null ? null : round(approved),
      settled: settled === null ? null : round(settled),
      received: s ? round(received) : null,
      tds: s ? round(tds) : null,
      due: round(n0(r.totaldue)),
      deduction: approved === null ? null : round(billed - approved),
      shortfall:
        approved === null || settled === null
          ? null
          : round(approved - settled),
      daysToSettle: days,
      insurer: ins.name,
      tpa: tpa.kind === "direct" ? null : tpa.name,
      surgery: r.surgery,
      surgery_raw: r.surgery_raw,
    });
  }
  return [...groups.values()]
    .map(({ _mix, ...g }) => ({ ...finish(g), mix: _mix.list() }))
    .sort((a, b) => b.billed - a.billed || a.name.localeCompare(b.name));
}

module.exports = { getInsuranceComparison };
