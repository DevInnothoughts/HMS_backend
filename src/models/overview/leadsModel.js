// src/models/overview/leadsModel.js
// ─────────────────────────────────────────────────────────────────────────────
// The Leads & Calls section:
//   metrics  Leads · Appointments · Visited · IPD conversions
//   blocks   Source funnel — Website, Chatbot, IVR, Sulekha, Hexa
//   deltas   optional, against the preceding period of equal length
//
// COMPOSED, NOT REWRITTEN
// ───────────────────────
// leadsStatsModel.getLocationStats already returns the whole funnel per channel
// — total, appointment, actualVisitCount, ipd — and partnerLeadsModel returns
// Sulekha and Hexa using the SAME two-phase conversion test. Both are called
// as-is, so this section reconciles with the Lead Stats Report and the Partner
// Leads screen rather than inventing a third definition of "converted".
//
// THE FOUR STAGES, AS THE EXISTING MODELS DEFINE THEM
// ───────────────────────────────────────────────────
//   Lead        one row in the channel's table, DEDUPLICATED BY PHONE — one
//               person enquiring three times is one lead
//   Appointment status synced to 'Appointment' (web/bot), or a matching
//               appointment row
//   Visited     that phone has an appointment with confirm_time != 0 AND
//               patient_type = 'New'
//   IPD         that visit produced an invoice
//
// ⚠️ VISITS ARE COUNTED INSIDE THE WINDOW ONLY
// ────────────────────────────────────────────
// getIpdCount looks for the visit between `from` and `to`. A lead created on
// the last day of the range who visits a week later is NOT counted as visited
// here — so conversion is always understated at the end of a period, and most
// on a one-day range. lostLeadsModel solves this with a 30-day grace window;
// this section does not, because changing it would make the figures disagree
// with the Lead Stats Report. Read conversion on a month, not on today.
//
// ⚠️ HELPLINE IS NOT A SOURCE HERE
// ────────────────────────────────
// leadsStatsModel covers web, chatbot and IVR. Helpline leads exist in
// lostLeadsModel but have no equivalent stats function, so the prototype's
// Helpline funnel row is absent rather than approximated. The Helpline Calls
// page still carries the raw log.
// ─────────────────────────────────────────────────────────────────────────────

const { getLocationStats } = require("../leadsStatsModel");
const { getPartnerLeads } = require("../partnerLeadsModel");
const { previousPeriod } = require("./opdModel");

const n0 = (v) => Number(v) || 0;

const CHANNEL_LABELS = {
  web: "Website",
  chatbot: "Chatbot",
  ivr: "IVR",
};

// The summary names the CATEGORY; the Aggregator Leads screen names the
// specific partner. So a Hexa row reads "Aggregator" here and "Hexa" there.
const PARTNER_LABELS = {
  Hexa: "Aggregator",
};

/**
 * Partner leads come back as rows, not counts, so they are tallied here.
 * The row shape is partnerLeadsModel's: `source` is 'Sulekha' or 'Hexa', and
 * the conversion flags are set by the same clinic-side lookup the other
 * channels use.
 */
function tallyPartner(rows) {
  const bySource = {};
  for (const r of rows || []) {
    const key = r.source || "Partner";
    const b = (bySource[key] = bySource[key] || {
      total: 0,
      appointment: 0,
      actualVisitCount: 0,
      ipd: 0,
    });
    b.total += 1;
    // hexa_leads has no status column, so an appointment can only be inferred
    // from the clinic-side match — which is what `visited` already represents.
    if (r.status === "Appointment" || r.visited) b.appointment += 1;
    if (r.visited) b.actualVisitCount += 1;
    if (r.ipd) b.ipd += 1;
  }
  return bySource;
}

async function gather(location, from, to, detailed) {
  const [stats, partnerRows] = await Promise.all([
    getLocationStats(location, from, to),
    // Partner leads are a separate screen and a separate table; a failure
    // there must not take the three main channels down with it.
    detailed
      ? getPartnerLeads(location, from, to).catch((e) => {
          console.error(`overview/leads: partner leads failed:`, e.message);
          return null;
        })
      : Promise.resolve(null),
  ]);

  const channels = [];
  for (const key of ["web", "chatbot", "ivr"]) {
    const c = stats?.[key];
    if (!c) continue;
    channels.push({
      key,
      label: CHANNEL_LABELS[key],
      total: n0(c.total),
      appointment: n0(c.appointment),
      visited: n0(c.actualVisitCount),
      ipd: n0(c.ipd),
    });
  }

  if (detailed && partnerRows) {
    const rows = partnerRows.leads || partnerRows.rows || partnerRows;
    const tallied = tallyPartner(Array.isArray(rows) ? rows : []);
    for (const [label, b] of Object.entries(tallied)) {
      channels.push({
        // Key stays the raw source, so nothing downstream keyed on it moves.
        key: label.toLowerCase(),
        label: PARTNER_LABELS[label] || label,
        total: b.total,
        appointment: b.appointment,
        visited: b.actualVisitCount,
        ipd: b.ipd,
      });
    }
  }

  // Totals are summed from the channels actually included, NOT from
  // stats.combined — combined covers only web, chatbot and IVR, so using it
  // alongside partner rows would make the metric cards and the funnel disagree.
  const sum = (f) => channels.reduce((a, c) => a + c[f], 0);

  const totals = {
    total: sum("total"),
    appointment: sum("appointment"),
    visited: sum("visited"),
    ipd: sum("ipd"),
  };
  totals.conversionPct =
    totals.total > 0
      ? Math.round((totals.appointment / totals.total) * 100)
      : null;
  totals.visitPct =
    totals.total > 0 ? Math.round((totals.visited / totals.total) * 100) : null;

  return {
    channels: channels
      .filter((c) => c.total > 0)
      .sort((a, b) => b.total - a.total),
    totals,
  };
}

/**
 * getLeadsSection({ location, from, to, compare, preset })
 */
async function getLeadsSection({ location, from, to, compare, preset }) {
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

  const current = await gather(location, from, to, true);

  let prev = null;
  let prevRange = null;
  if (compare === "prev") {
    prevRange = previousPeriod(from, to, preset);
    // Partner leads are skipped for the comparison window — no delta is shown
    // per source, and getPartnerLeads is a second round trip to the master DB.
    prev = await gather(location, prevRange.from, prevRange.to, false);
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
    channels: current.channels,
    totals: current.totals,
    prev: prev ? { totals: prev.totals } : null,
    deltas: prev
      ? {
          total: delta(current.totals.total, prev.totals.total),
          appointment: delta(
            current.totals.appointment,
            prev.totals.appointment,
          ),
          visited: delta(current.totals.visited, prev.totals.visited),
          conversionPct:
            current.totals.conversionPct != null &&
            prev.totals.conversionPct != null
              ? current.totals.conversionPct - prev.totals.conversionPct
              : null,
        }
      : null,
  };
}

module.exports = { getLeadsSection };
