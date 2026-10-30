/* eslint-disable prettier/prettier */
// src/models/metaLeadsModel.js
// ─────────────────────────────────────────────────────────────────────────────
// META LEADS — the internal Lead Stats Report's "Meta leads" tab (Oct 2026).
//
//   WHAT COUNTS   chatbot_leads rows whose lead_source is "mumbai_chatbot"
//                 (compared lower-cased, trimmed, spaces / hyphens as "_"),
//                 whatever their utm_source. Bot only — no Web, Web call or
//                 IVR.
//   EVERY OTHER   bot lead is Google or not by its utm_source alone (google /
//                 google_ads), exactly as before.
//   NOT GOOGLE    the same rows are dropped from every Google figure
//                 (agencyGoogleLeadsModel.botEntries uses isMetaBotLead), so a
//                 lead is never counted as both Meta and Google.
//
// Counting is exactly the Google tab's, borrowed from adAgencyLeadsModel:
// one person = one phone, the LATEST row is the lead and decides the stage,
// every older row is a duplicate; booked / visited / IPD follow the chatbot
// rule (uniqueForSource('chatbot', …)).
//
// Response shapes match the Google endpoints so the app can reuse its table
// and branch lead list unchanged:
//   GET /leadsStats/meta/stats?from&to&locations → { branches: [stats] }
//       stats = { location, chatbot, combined, partial, errors }
//   GET /leadsStats/meta/leads?location&from&to
//       → { meta, stats, counts, leads, errors }
// ─────────────────────────────────────────────────────────────────────────────

const util = require("util");
const { getConnectionByLocation } = require("../../databaseUtils");
const { buildBranchWhere, ALL_LOCATIONS } = require("./leadsStatsModel");
const {
  maskPhone,
  toWallClock,
  resolveLocations,
  bucketFrom,
  keyFor,
  assertLocation,
  assertRange,
  uniqueForSource,
  newestFirst,
} = require("./adAgencyLeadsModel");

/** chatbot_leads.lead_source values that are Meta (Facebook / Instagram) ads. */
const META_BOT_SOURCES = new Set(["mumbai_chatbot"]);

// "Mumbai Chatbot", "mumbai-chatbot" and " mumbai_chatbot " all match.
const normLeadSource = (v) =>
  String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

/** True for a chatbot_leads row that belongs to the Meta leads tab. */
const isMetaBotLead = (row) =>
  META_BOT_SOURCES.has(normLeadSource(row && row.lead_source));

// ─── Raw Meta entries for one branch ──────────────────────────────────────────

async function metaBotEntries(location, from, to) {
  const { connection: leadDB } = getConnectionByLocation("lead");
  const q = util.promisify(leadDB.query).bind(leadDB);
  const { whereClause, params } = buildBranchWhere(location);
  const sources = [...META_BOT_SOURCES];
  const rows = await q(
    `SELECT * FROM chatbot_leads
      WHERE ${whereClause}
        AND REPLACE(REPLACE(LOWER(TRIM(lead_source)), ' ', '_'), '-', '_')
            IN (${sources.map(() => "?").join(",")})
        AND DATE(datetime) BETWEEN ? AND ?
      ORDER BY id DESC`,
    [...params, ...sources, `${from}T00:00:00+05:30`, `${to}T23:59:59+05:30`],
  );
  return rows.map((r) => ({
    source: "chatbot",
    rowId: r.id,
    key: keyFor("chatbot", r.id, r.contact),
    phone: r.contact,
    date: toWallClock(r.datetime),
    name: r.name || null,
    treatment: r.disease || null,
    status: r.status || "New",
  }));
}

// ─── One branch ───────────────────────────────────────────────────────────────

async function buildMetaBranch(location, from, to) {
  const errors = [];
  let uniq = new Map();
  try {
    const entries = await metaBotEntries(location, from, to);
    uniq = await uniqueForSource("chatbot", location, entries, from, to);
  } catch (e) {
    console.error(`metaLeads chatbot ${location}:`, e.message);
    errors.push("chatbot");
  }

  const leads = [...uniq.values()]
    .map((u) => ({
      id: `chatbot-${u.rowId}`,
      phone: maskPhone(u.phone),
      source: "chatbot",
      sources: ["chatbot"],
      perSource: {
        chatbot: {
          entries: u.entries,
          date: u.date,
          firstDate: u.firstDate,
          status: u.status,
          booked: u.booked,
          visited: u.visited,
          ipd: u.ipd,
          detail: u.detail,
          treatment: u.treatment,
        },
      },
      entries: u.entries,
      date: u.date,
      firstDate: u.firstDate,
      name: u.name || null,
      treatment: u.treatment || null,
      status: u.status,
      detail: u.detail,
      booked: u.booked,
      visited: u.visited,
      ipd: u.ipd,
    }))
    .sort(newestFirst);

  const stats = {
    location,
    chatbot: bucketFrom([...uniq.values()]),
    combined: bucketFrom(leads),
    partial: errors.length > 0,
    errors,
  };
  stats.combined.crossSource = 0; // one source only

  return { stats, leads, errors };
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

/** GET /leadsStats/meta/stats?from&to[&locations=a,b] → { branches } */
async function getMetaStats({ from, to, locations }) {
  assertRange(from, to);
  const locs = locations ? resolveLocations(locations) : ALL_LOCATIONS;
  const branches = await Promise.all(
    locs.map(async (loc) => (await buildMetaBranch(loc, from, to)).stats),
  );
  branches.sort((a, b) => a.location.localeCompare(b.location));
  return { branches };
}

/** GET /leadsStats/meta/leads?location&from&to → { meta, stats, counts, leads, errors } */
async function getMetaLeads({ location, from, to }) {
  assertLocation(location);
  assertRange(from, to);
  const { stats, leads, errors } = await buildMetaBranch(location, from, to);
  return {
    meta: { location, from, to },
    stats,
    counts: { total: stats.combined.total, chatbot: stats.chatbot.total },
    leads,
    errors,
  };
}

module.exports = {
  getMetaStats,
  getMetaLeads,
  isMetaBotLead,
  META_BOT_SOURCES,
};
