/* eslint-disable prettier/prettier */
// src/models/utils/payerGroups.js
// ─────────────────────────────────────────────────────────────────────────────
// Who an insurance invoice is grouped under — by INSURER or by TPA. Shared by
// insuranceDueModel.js and insuranceComparisonModel.js so the Insurance Due
// List and both comparison tabs group identically.
//
// Rows must already carry insurancecompany_name / tpa_name
// (utils/insuranceNames.js addCompanyNames, routed per invoice date across the
// 1 Jul 2026 master cutover). Groups are keyed by resolved NAME, so one payer
// is one row across the cutover.
//
// ── THE NO-TPA CASE (how Indian cashless claims work) ───────────────────────
// A cashless claim is processed either by a TPA (Medi Assist, MD India,
// Paramount, Vidal, …) on the insurer's behalf, or by the insurer's own
// in-house claims team (Star Health, Niva Bupa, Care, and others settle many
// claims without a TPA). So in the TPA view:
//   • tpa blank / 0                  → "Direct with insurer (no TPA)"
//   • tpa resolves to the SAME name  → also "Direct with insurer" — the
//     as the insurer                   insurer was recorded as its own TPA
//   • tpa id not found in either      → "Unknown TPA (id …)", kept visible so
//     master                            it gets fixed
// A missing TPA is therefore never an error and never hidden — it is the
// direct-settlement group, and its card names the insurers in it.
// ─────────────────────────────────────────────────────────────────────────────

const NOT_RECORDED = "Insurer not recorded";
const DIRECT = "Direct with insurer (no TPA)";

const hasId = (v) =>
  v !== null && v !== undefined && String(v).trim() !== "" && Number(v) !== 0;
const nameKey = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

/** { key, name, kind } — kind: 'named' | 'none' | 'direct' | 'unknown' */
function insurerOf(r) {
  if (!hasId(r.insurancecompany))
    return { key: "none", name: NOT_RECORDED, kind: "none" };
  if (r.insurancecompany_name)
    return {
      key: `n:${nameKey(r.insurancecompany_name)}`,
      name: String(r.insurancecompany_name).trim(),
      kind: "named",
    };
  return {
    key: `id:${r.insurancecompany}`,
    name: `Unknown insurer (id ${r.insurancecompany})`,
    kind: "unknown",
  };
}

function tpaOf(r) {
  if (!hasId(r.tpa)) return { key: "direct", name: DIRECT, kind: "direct" };
  if (r.tpa_name) {
    if (
      r.insurancecompany_name &&
      nameKey(r.tpa_name) === nameKey(r.insurancecompany_name)
    )
      return { key: "direct", name: DIRECT, kind: "direct" };
    return {
      key: `n:${nameKey(r.tpa_name)}`,
      name: String(r.tpa_name).trim(),
      kind: "named",
    };
  }
  return {
    key: `id:${r.tpa}`,
    name: `Unknown TPA (id ${r.tpa})`,
    kind: "unknown",
  };
}

/**
 * By SURGERY — rows must carry surgery / surgery_kind
 * (utils/invoiceSurgery.js attachSurgeries).
 */
function surgeryOf(r) {
  const label = r.surgery || "Discharge card not found";
  return {
    key: `s:${nameKey(label)}`,
    name: label,
    kind: r.surgery_kind === "named" ? "named" : r.surgery_kind || "nocard",
  };
}

const groupOf = (r, by) =>
  by === "tpa" ? tpaOf(r) : by === "surgery" ? surgeryOf(r) : insurerOf(r);

/** The name counted in a group's `mix` — the other side of the view. */
const mixNameOf = (r, by) =>
  by === "insurer" ? tpaOf(r).name : insurerOf(r).name;

/**
 * Counts the OTHER dimension inside a group — the insurers a TPA handles, or
 * the TPAs an insurer uses — as [{ name, invoices }], most first.
 */
function makeMixCounter() {
  const m = new Map();
  return {
    add(name) {
      m.set(name, (m.get(name) || 0) + 1);
    },
    list() {
      return [...m.entries()]
        .map(([name, invoices]) => ({ name, invoices }))
        .sort(
          (a, b) => b.invoices - a.invoices || a.name.localeCompare(b.name),
        );
    },
  };
}

module.exports = {
  groupOf,
  insurerOf,
  tpaOf,
  surgeryOf,
  mixNameOf,
  makeMixCounter,
  NOT_RECORDED,
  DIRECT,
};
