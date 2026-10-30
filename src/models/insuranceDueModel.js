/* eslint-disable prettier/prettier */
// src/models/insuranceDueModel.js
// ─────────────────────────────────────────────────────────────────────────────
// INSURANCE DUE LIST — outstanding IPD dues grouped by INSURANCE COMPANY, with
// the same ageing buckets as the IPD Due List (getStatuswiseIPDDueListV2):
//   >90 days · >60 days · >30 days · <30 days   (age of invoice.creation_date)
//
//   GET /IPDCollection/insuranceDueList?location=DP Road
//
// ── INSURER OR TPA ──────────────────────────────────────────────────────────
// The same rows are grouped twice — `companies` (by insurer) and `tpas` (by
// TPA) — so the screen's switch is instant. Claims with no TPA, or with the
// insurer recorded as its own TPA, are "Direct with insurer (no TPA)": in
// India many cashless claims are settled by the insurer's in-house team
// (utils/payerGroups.js).
//
// ── WHICH INVOICES ──────────────────────────────────────────────────────────
// Same base as the IPD Due List: invoice.is_deleted != 1,
// creation_date >= 2025-04-01, totaldue > 0 — and STRICTLY status = 'Cashless'
// (no Reimbursement, PDC or other bills, even if they name an insurer). A
// Cashless bill with no insurer on record is listed under "Insurer not
// recorded" rather than dropped.
//
// ── INTERBRANCH (utils/interbranch.js countedSql) ───────────────────────────
// An interbranch invoice is written into both branch DBs; the due belongs to
// the SOURCE branch. The operating branch's copy (counted = 0) is left out of
// every figure and list here, the rule IPD Invoice and the revenue figures
// apply — otherwise the same claim is chased from two branches. What was left
// out is returned as `interbranch: { invoices, totalDue }` so the screen can
// say so.
//
// ── THE INSURANCE MASTER CUTOVER (1 Jul 2026) ───────────────────────────────
// Until 30 Jun 2026 invoice.insurancecompany / invoice.tpa held ids from the
// BRANCH table `insurance_company`; from 1 Jul 2026 they hold ids from the
// master `insuranceMasterData` (hhc_appointments). The id spaces are
// unrelated, so:
//   1. each invoice's id is resolved by ITS OWN date (utils/insuranceNames.js
//      addCompanyNames — the rule the IPD Due List and IPD Invoice use), and
//   2. companies are grouped by resolved NAME, never by id — the same insurer
//      has one id before July and a different one after, and grouping by id
//      would split it in two (or merge two different insurers that happen to
//      share a number across the two tables).
//
// ⚠️ The date handed to addCompanyNames is DATE_FORMAT(...,'%Y-%m-%d'). The
// pool returns DATE/DATETIME columns as JS Date objects, and the helper
// compares the first ten characters of the value with '2026-07-01' — a Date
// stringifies as "Wed Jul 01 2026 …", which never compares correctly. A
// formatted string routes every invoice to the right table.
//
// An id found in neither table is grouped by id and labelled so it can be
// fixed in the master, not hidden.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../databaseUtils");
const { countedSql } = require("./utils/interbranch");
const {
  groupOf,
  insurerOf,
  tpaOf,
  mixNameOf,
  makeMixCounter,
} = require("./utils/payerGroups");
const { attachSurgeries } = require("./utils/invoiceSurgery");
const {
  addCompanyNames,
  INSURANCE_MASTER_CUTOVER,
} = require("./utils/insuranceNames");

const SINCE = "2025-04-01";
const BUCKETS = [">90 days", ">60 days", ">30 days", "<30 days"];

const n0 = (v) => Number(v) || 0;
const emptyBuckets = () =>
  BUCKETS.reduce((a, k) => ({ ...a, [k]: { invoices: 0, totalDue: 0 } }), {});

const SQL = `
  SELECT
      i.invoice_id,
      i.patient_id,
      p.name,
      i.status,
      i.creation_date,
      DATE_FORMAT(i.creation_date, '%Y-%m-%d') AS invoice_date,
      i.totalamt,
      i.totaldue,
      i.insurancecompany,
      i.tpa,
      CASE WHEN ${countedSql("i")} THEN 1 ELSE 0 END AS counted,
      CASE
        WHEN DATEDIFF(CURDATE(), DATE(i.creation_date)) > 90 THEN '>90 days'
        WHEN DATEDIFF(CURDATE(), DATE(i.creation_date)) > 60 THEN '>60 days'
        WHEN DATEDIFF(CURDATE(), DATE(i.creation_date)) > 30 THEN '>30 days'
        ELSE '<30 days'
      END AS due_category
  FROM invoice i
  JOIN patient p ON p.patient_id = i.patient_id
  WHERE i.is_deleted != 1
    AND i.creation_date >= ?
    AND i.totaldue > 0
    AND i.status = 'Cashless'
  ORDER BY i.creation_date ASC
`;

async function getInsuranceDueList({ location }) {
  const { connection } = getConnectionByLocation(location);
  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const all = await new Promise((resolve, reject) =>
    connection.query(SQL, [SINCE], (e, r) => (e ? reject(e) : resolve(r))),
  );

  // Operating-branch copies of interbranch invoices belong to the source
  // branch — excluded here, reported as a count (see header).
  const rows = all.filter((r) => Number(r.counted) === 1);
  const excluded = all.filter((r) => Number(r.counted) !== 1);
  const interbranch = {
    invoices: excluded.length,
    totalDue: Math.round(excluded.reduce((a, r) => a + n0(r.totaldue), 0)),
  };

  // Routed per invoice by invoice_date (see header) → *_name keys.
  await addCompanyNames(rows, connection, "invoice_date", [
    "insurancecompany",
    "tpa",
  ]);

  // Surgery from the patient's discharge card (utils/invoiceSurgery.js).
  await attachSurgeries(rows, connection);

  const companies = buildGroups(rows, "insurer");
  const tpas = buildGroups(rows, "tpa");
  const surgeries = buildGroups(rows, "surgery");

  const buckets = emptyBuckets();
  for (const r of rows) {
    buckets[r.due_category].invoices += 1;
    buckets[r.due_category].totalDue += n0(r.totaldue);
  }

  return {
    meta: {
      location,
      since: SINCE,
      cutover: INSURANCE_MASTER_CUTOVER,
      generatedAt: new Date().toISOString(),
    },
    totalDue: Math.round(rows.reduce((a, r) => a + n0(r.totaldue), 0)),
    invoices: rows.length,
    // Ids found in neither insurance master, per view.
    unresolved: rows.filter((r) => insurerOf(r).kind === "unknown").length,
    unresolvedTpa: rows.filter((r) => tpaOf(r).kind === "unknown").length,
    interbranch,
    buckets,
    companies, // by insurer
    tpas, // by TPA — "Direct with insurer (no TPA)" for claims without one
    surgeries, // by surgery (discharge_card.surgeryadvice, mapped)
  };
}

/**
 * Groups the due rows by insurer or by TPA (utils/payerGroups.js). Each group
 * also lists the OTHER side (`mix`): the TPAs an insurer's claims go through,
 * or the insurers a TPA handles.
 */
function buildGroups(rows, by) {
  const groups = new Map();
  for (const r of rows) {
    const due = n0(r.totaldue);
    const era = r.invoice_date < INSURANCE_MASTER_CUTOVER ? "legacy" : "master";
    const g = groupOf(r, by);
    const ins = insurerOf(r);
    const tpa = tpaOf(r);

    if (!groups.has(g.key)) {
      groups.set(g.key, {
        key: g.key,
        name: g.name,
        kind: g.kind,
        totalDue: 0,
        totalBilled: 0,
        invoices: 0,
        buckets: emptyBuckets(),
        rows: [],
        _mix: makeMixCounter(),
      });
    }
    const c = groups.get(g.key);
    // Rows are oldest first, so the LAST resolved spelling is the newest —
    // usually the master's, which is the one to show.
    if (g.kind === "named") c.name = g.name;
    c.totalDue += due;
    c.totalBilled += n0(r.totalamt);
    c.invoices += 1;
    c.buckets[r.due_category].invoices += 1;
    c.buckets[r.due_category].totalDue += due;
    c._mix.add(mixNameOf(r, by));
    c.rows.push({
      invoice_id: r.invoice_id,
      patient_id: r.patient_id,
      name: r.name,
      status: r.status,
      creation_date: r.invoice_date,
      totalamt: n0(r.totalamt),
      totaldue: due,
      due_category: r.due_category,
      insurancecompany: r.insurancecompany,
      insurer: ins.name,
      // null when the claim has no TPA (direct with insurer)
      tpa: tpa.kind === "direct" ? null : tpa.name,
      surgery: r.surgery,
      surgery_raw: r.surgery_raw,
      era,
    });
  }

  return [...groups.values()]
    .map(({ _mix, ...c }) => ({
      ...c,
      totalDue: Math.round(c.totalDue),
      totalBilled: Math.round(c.totalBilled),
      mix: _mix.list(),
    }))
    .sort((a, b) => b.totalDue - a.totalDue || a.name.localeCompare(b.name));
}

module.exports = { getInsuranceDueList };
