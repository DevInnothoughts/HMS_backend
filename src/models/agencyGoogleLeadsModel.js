/* eslint-disable prettier/prettier */
// src/models/agencyGoogleLeadsModel.js
// ─────────────────────────────────────────────────────────────────────────────
// Lead data for the AD AGENCY login (role === 'AdAgency').
//
// The internal Lead Stats screen (adAgencyLeadsModel.js, LOCKED) shows every
// lead. The agency sees the same structure — unique leads, latest kept,
// booked / visited / IPD / not booked, duplicates, trend — restricted to:
//
//   1. GOOGLE leads only   utm_source ∈ GOOGLE_SOURCES (google, google_ads)
//   2. NO IVR              sources are Web, Bot (chatbot) and Web call only
//   3. CAMPAIGN-wise       grouped by gad_campaignid instead of by city
//   4. SEARCH TERMS        utm_term, rolled up into conditions (Piles, Fistula…)
//
// Non-Google and IVR rows are dropped HERE, before anything is counted or
// returned, so they never reach the agency's phone — not as rows, not as
// totals.
//
// ORDER OF OPERATIONS
// ───────────────────
//   filter to Google → de-duplicate (one person = one phone) → keep the LATEST
// So a person's organic enquiry never hides their Google lead, and among their
// Google leads the newest decides stage, campaign and search term. Every older
// Google lead of theirs is a duplicate.
//
// CAMPAIGN / TERM ATTRIBUTION — by the kept (latest) lead
// ───────────────────────────────────────────────────────
// Each unique person is counted under exactly ONE campaign and ONE term: their
// latest Google lead's. So campaign rows add up to the branch total and the
// table reconciles, exactly like the city table. In a source tab the person is
// attributed by their latest lead IN THAT SOURCE.
//
// WHERE THE UTM VALUES COME FROM — the whole URL string is scanned
// ────────────────────────────────────────────────────────────────
//   web       appointments.utmsource column, then utm_* inside pageurl
//   web call  call_leads.utm_source column, then utm_* inside pageUrl
//   bot       chatbot_leads has no known UTM column, so EVERY text column of
//             the row is scanned for utm_source= / gad_campaignid= / utm_term=.
//             If the bot system stores no UTM data, no bot lead can be proven
//             Google and the Bot figures are zero.
// The URL is percent-decoded (up to 3 times, for double-encoded links) and
// searched anywhere for `gad_campaignid=…`, so the parameter's position, an
// encoded inner URL, or a fragment do not matter.
// ─────────────────────────────────────────────────────────────────────────────

const util = require("util");
const { getConnectionByLocation } = require("../../databaseUtils");
const {
  buildAreaWhere,
  buildBranchWhere,
  ALL_LOCATIONS,
} = require("./leadsStatsModel");
const { getCallLeads } = require("./callLeadsModel");
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
  trendWindow,
  fyStartYear,
} = require("./adAgencyLeadsModel");

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * utm_source values the agency may see, compared after lower-casing and
 * turning spaces / hyphens into underscores ("Google Ads" → "google_ads").
 *
 * ⚠️ callLeadsModel.readableSource also treats "gads" as Google Ads. It is NOT
 * included because the agreed rule is google / google_ads only — add "gads"
 * here if those leads are the agency's too.
 */
const GOOGLE_SOURCES = new Set(["google", "google_ads"]);

const AGENCY_SOURCES = ["web", "chatbot", "webcall"]; // no IVR — ever

/**
 * Optional readable names for campaign IDs, e.g. { "23736255775": "Mumbai –
 * Fistula" }. Anything not listed is shown by its ID.
 */
const CAMPAIGN_NAMES = {};

const NO_CAMPAIGN = "(not tagged)";

/**
 * Search term → condition. First match wins, in this order (pilonidal before
 * piles, so "pilonidal sinus" is not read as piles). Hindi / Marathi words the
 * ads are bought on are included. Edit freely — it only changes the rollup.
 */
const CONDITION_RULES = [
  ["Pilonidal sinus", ["pilonidal"]],
  [
    "Piles",
    [
      "piles",
      "pile ",
      "hemorrhoid",
      "haemorrhoid",
      "hemorroid",
      "bawasir",
      "bawaseer",
      "bavasir",
      "bawaasir",
      "mulvyadh",
      "moolvyadh",
      "mulvyad",
      "मूळव्याध",
      "बवासीर",
    ],
  ],
  ["Fistula", ["fistula", "bhagandar", "भगंदर"]],
  ["Fissure", ["fissure", "fisher"]],
  ["Hernia", ["hernia"]],
  ["Varicose veins", ["varicose"]],
  ["Gallstones", ["gallstone", "gall stone", "gallbladder", "gall bladder"]],
  ["Circumcision / Phimosis", ["circumcision", "phimosis"]],
  ["Lipoma", ["lipoma"]],
  ["Hydrocele", ["hydrocele"]],
];
const NO_TERM = "(no search term)";
const OTHER = "Other";

// ─── UTM parsing ──────────────────────────────────────────────────────────────

function decodeAll(s) {
  let x = String(s || "");
  for (let i = 0; i < 3; i++) {
    let d;
    try {
      d = decodeURIComponent(x.replace(/\+/g, " "));
    } catch (_) {
      break; // a stray % — keep what we have
    }
    if (d === x) break;
    x = d;
  }
  return x;
}

/** The value of `name=` anywhere in a URL / text, or null. */
function utmParam(text, name) {
  if (!text || typeof text !== "string" || !text.toLowerCase().includes(name))
    return null;
  const t = decodeAll(text);
  const re = new RegExp(`(?:^|[?&#;\\s/])${name}=([^&#]*)`, "i");
  const m = re.exec(t);
  const v = m ? m[1].trim() : "";
  return v || null;
}

const normSource = (v) =>
  String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

/**
 * CAMPAIGN ID — `gad_campaignid`, the id Google Ads itself appends to every
 * auto-tagged click. It is the ONLY source of the id: `utm_campaignid` and
 * `utm_campaign` are not used as fall-backs, because on the same click they
 * can carry a different number (seen: gad 24348746075 vs utm 24348676988),
 * and mixing them would split one campaign into two rows. A Google lead with
 * no gad_campaignid is counted under "Not tagged".
 *
 * A real `utm_campaign` NAME (not a {placeholder}, not just digits) is still
 * kept, as the campaign's display name only.
 */
const isPlaceholder = (v) => /^\{.*\}$/.test(String(v || "").trim());
const isDigits = (v) => /^\d+$/.test(String(v || "").trim());

function campaignFrom(idValue, nameValue) {
  const id = String(idValue || "").trim();
  const name = String(nameValue || "").trim();
  if (!id || isPlaceholder(id)) return { id: null, title: null };
  return {
    id,
    title: name && !isPlaceholder(name) && !isDigits(name) ? name : null,
  };
}

/**
 * { source, campaign, campaignTitle, term } for a row. Explicit columns
 * first, then every text field of the row is scanned (that is how the bot
 * table is covered).
 */
function utmOf(row, explicit = {}) {
  const texts = Object.values(row).filter(
    (v) => typeof v === "string" && /utm_|gad_/i.test(v),
  );
  const scan = (name) => {
    for (const t of texts) {
      const v = utmParam(t, name);
      if (v) return v;
    }
    return null;
  };
  return {
    source: normSource(explicit.source || scan("utm_source")),
    ...(() => {
      const c = campaignFrom(
        explicit.campaignId || scan("gad_campaignid"),
        explicit.campaign || scan("utm_campaign"),
      );
      return { campaign: c.id, campaignTitle: c.title };
    })(),
    term:
      (explicit.term || scan("utm_term") || "").trim().toLowerCase() || null,
  };
}

const isGoogle = (utm) => GOOGLE_SOURCES.has(utm.source);

function conditionOf(term) {
  if (!term) return NO_TERM;
  const t = ` ${term.toLowerCase()} `;
  for (const [name, words] of CONDITION_RULES) {
    if (words.some((w) => t.includes(w))) return name;
  }
  return OTHER;
}

// id → display name: CAMPAIGN_NAMES first, then the utm_campaign name seen on
// the leads (titles), else the id itself.
const campaignName = (id, titles = {}) =>
  id === NO_CAMPAIGN ? "Not tagged" : CAMPAIGN_NAMES[id] || titles[id] || id;

// ─── Raw Google entries per source ────────────────────────────────────────────
// Same shape as adAgencyLeadsModel's entries, plus { campaign, term, condition }.

const withUtm = (entry, utm) => ({
  ...entry,
  campaign: utm.campaign || NO_CAMPAIGN,
  campaignTitle: utm.campaignTitle || null,
  term: utm.term || null,
  condition: conditionOf(utm.term),
});

async function webEntries(location, from, to) {
  const { connection: leadDB } = getConnectionByLocation("lead");
  const q = util.promisify(leadDB.query).bind(leadDB);
  const { whereClause, params } = buildAreaWhere(location);
  const rows = await q(
    `SELECT * FROM appointments
      WHERE ${whereClause} AND date BETWEEN ? AND ?
      ORDER BY appointment_id DESC`,
    [...params, `${from}T00:00:00+05:30`, `${to}T23:59:59+05:30`],
  );
  const out = [];
  for (const r of rows) {
    const utm = utmOf(r, { source: r.utmsource || r.utm_source });
    if (!isGoogle(utm)) continue;
    out.push(
      withUtm(
        {
          source: "web",
          rowId: r.appointment_id,
          key: keyFor("web", r.appointment_id, r.phoneno),
          phone: r.phoneno,
          date: toWallClock(r.date),
          name: r.name || r.patient_name || null,
          treatment: r.disease || r.treatment || null,
          status: r.status || "New",
        },
        utm,
      ),
    );
  }
  return out;
}

async function botEntries(location, from, to) {
  const { connection: leadDB } = getConnectionByLocation("lead");
  const q = util.promisify(leadDB.query).bind(leadDB);
  const { whereClause, params } = buildBranchWhere(location);
  // SELECT * so every column can be scanned for UTM values (see header).
  const rows = await q(
    `SELECT * FROM chatbot_leads
      WHERE ${whereClause} AND DATE(datetime) BETWEEN ? AND ?
      ORDER BY id DESC`,
    [...params, `${from}T00:00:00+05:30`, `${to}T23:59:59+05:30`],
  );
  const out = [];
  for (const r of rows) {
    const utm = utmOf(r, {
      source: r.utm_source || r.utmsource,
      campaign: r.utm_campaign,
      campaignId: r.gad_campaignid,
      term: r.utm_term,
    });
    if (!isGoogle(utm)) continue;
    out.push(
      withUtm(
        {
          source: "chatbot",
          rowId: r.id,
          key: keyFor("chatbot", r.id, r.contact),
          phone: r.contact,
          date: toWallClock(r.datetime),
          name: r.name || null,
          treatment: r.disease || null,
          status: r.status || "New",
        },
        utm,
      ),
    );
  }
  return out;
}

async function webCallEntries(location, from, to, { withVisits = true } = {}) {
  const rows = await getCallLeads(location, { from, to, withVisits });
  const out = [];
  for (const r of rows) {
    // getCallLeads returns utm_source and pageUrl; nothing else is scanned so
    // its derived fields (source, disease) cannot be mistaken for UTM values.
    const utm = utmOf({ pageUrl: r.pageUrl }, { source: r.utm_source });
    if (!isGoogle(utm)) continue;
    out.push(
      withUtm(
        {
          source: "webcall",
          rowId: r.appointment_id,
          key: keyFor("webcall", r.appointment_id, r.phoneno),
          phone: r.phoneno,
          date: toWallClock(r.date),
          name: r.name || null,
          treatment: r.disease || null,
          status: r.status || "New",
          extra: { visited: !!r.visited, ipd: !!r.ipd, channel: "Google Ads" },
        },
        utm,
      ),
    );
  }
  return out;
}

const FETCHERS = {
  web: webEntries,
  chatbot: botEntries,
  webcall: webCallEntries,
};

// ─── One branch ───────────────────────────────────────────────────────────────

const emptyGroup = () => ({ web: [], chatbot: [], webcall: [], combined: [] });

function groupBuckets(groups) {
  const out = {};
  for (const [k, g] of Object.entries(groups)) {
    out[k] = {
      web: bucketFrom(g.web),
      chatbot: bucketFrom(g.chatbot),
      webcall: bucketFrom(g.webcall),
      combined: bucketFrom(g.combined),
    };
  }
  return out;
}

async function buildAgencyBranch(location, from, to) {
  const errors = [];
  const perSource = {};
  const titles = {}; // campaign id → utm_campaign name seen on its leads

  await Promise.all(
    AGENCY_SOURCES.map(async (s) => {
      try {
        const entries = await FETCHERS[s](location, from, to);
        for (const e of entries) {
          if (e.campaignTitle && !titles[e.campaign])
            titles[e.campaign] = e.campaignTitle;
        }
        const byRow = new Map(entries.map((e) => [String(e.rowId), e]));
        const uniq = await uniqueForSource(s, location, entries, from, to);
        // Attach the KEPT (latest) lead's campaign / term to each person.
        for (const u of uniq.values()) {
          const e = byRow.get(String(u.rowId)) || {};
          u.campaign = e.campaign || NO_CAMPAIGN;
          u.term = e.term || null;
          u.condition = e.condition || NO_TERM;
        }
        perSource[s] = uniq;
      } catch (e) {
        console.error(`agencyGoogle ${s} ${location}:`, e.message);
        errors.push(s);
        perSource[s] = new Map();
      }
    }),
  );

  // Merge across sources — the newest Google lead is kept (same rule as the
  // internal screen); a same-minute tie keeps AGENCY_SOURCES order.
  const byKey = new Map();
  for (const s of AGENCY_SOURCES) {
    for (const [key, u] of perSource[s]) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ s, u });
    }
  }

  const merged = [];
  for (const list of byKey.values()) {
    list.sort((a, b) =>
      a.u.date === b.u.date ? 0 : a.u.date < b.u.date ? 1 : -1,
    );
    const { s: src, u: kept } = list[0];
    const perSourceOut = {};
    for (const { s, u } of list) {
      perSourceOut[s] = {
        entries: u.entries,
        date: u.date,
        firstDate: u.firstDate,
        status: u.status,
        booked: u.booked,
        visited: u.visited,
        ipd: u.ipd,
        detail: u.detail,
        treatment: u.treatment,
        campaign: u.campaign,
        campaignName: campaignName(u.campaign, titles),
        term: u.term,
        condition: u.condition,
      };
    }
    merged.push({
      id: `${src}-${kept.rowId}`,
      rowId: kept.rowId,
      phone: maskPhone(kept.phone),
      source: src,
      sources: list.map((x) => x.s),
      perSource: perSourceOut,
      entries: list.reduce((a, x) => a + x.u.entries, 0),
      date: kept.date,
      firstDate: list.reduce(
        (m, x) => (x.u.firstDate && x.u.firstDate < m ? x.u.firstDate : m),
        kept.firstDate || kept.date,
      ),
      name: kept.name || list.find((x) => x.u.name)?.u.name || null,
      treatment: kept.treatment || null,
      status: kept.status,
      detail: kept.detail,
      booked: kept.booked,
      visited: kept.visited,
      ipd: kept.ipd,
      campaign: kept.campaign,
      campaignName: campaignName(kept.campaign, titles),
      term: kept.term,
      condition: kept.condition,
    });
  }
  const leads = merged.sort(newestFirst).map(({ rowId, ...l }) => l);

  // Stats: per source, combined, and by campaign / condition / raw term.
  const stats = { location };
  for (const s of AGENCY_SOURCES)
    stats[s] = bucketFrom([...perSource[s].values()]);
  stats.combined = bucketFrom(leads);
  stats.combined.crossSource =
    AGENCY_SOURCES.reduce((a, s) => a + stats[s].total, 0) -
    stats.combined.total;

  const camp = {};
  const cond = {};
  const terms = {};
  const into = (groups, k, slot, item) => {
    (groups[k] = groups[k] || emptyGroup())[slot].push(item);
  };
  for (const s of AGENCY_SOURCES) {
    for (const u of perSource[s].values()) {
      into(camp, u.campaign, s, u);
      into(cond, u.condition, s, u);
      if (u.term) {
        const t = (terms[u.term] = terms[u.term] || {
          condition: u.condition,
          web: 0,
          chatbot: 0,
          webcall: 0,
          combined: 0,
        });
        t[s] += 1;
      }
    }
  }
  for (const l of leads) {
    into(camp, l.campaign, "combined", l);
    into(cond, l.condition, "combined", l);
    if (l.term) {
      const t = (terms[l.term] = terms[l.term] || {
        condition: l.condition,
        web: 0,
        chatbot: 0,
        webcall: 0,
        combined: 0,
      });
      t.combined += 1;
    }
  }
  stats.campaigns = groupBuckets(camp);
  stats.campaignTitles = titles;
  stats.conditions = groupBuckets(cond);
  stats.terms = terms;
  stats.partial = errors.length > 0;
  stats.errors = errors;

  return { stats, leads, errors };
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

/**
 * GET /agencyLeads/stats?from&to[&locations=a,b]
 * → { branches: [stats], campaignNames }
 * The agency sees EVERY branch: with no `locations` all branches are read.
 * `locations` is optional and only narrows the list (unknown names dropped).
 * The data is Google-only, no-IVR either way.
 */
async function getAgencyGoogleStats({ from, to, locations }) {
  assertRange(from, to);
  const locs = locations ? resolveLocations(locations) : ALL_LOCATIONS;
  const branches = await Promise.all(
    locs.map(async (loc) => (await buildAgencyBranch(loc, from, to)).stats),
  );
  branches.sort((a, b) => a.location.localeCompare(b.location));

  const names = {};
  for (const b of branches) {
    for (const id of Object.keys(b.campaigns)) {
      const n = campaignName(id, b.campaignTitles);
      if (!names[id] || names[id] === id) names[id] = n;
    }
  }
  return { branches, campaignNames: names };
}

/** GET /agencyLeads/leads?location&from&to → { meta, stats, counts, leads, errors } */
async function getAgencyGoogleLeads({ location, from, to }) {
  assertLocation(location);
  assertRange(from, to);
  const { stats, leads, errors } = await buildAgencyBranch(location, from, to);
  const counts = { total: stats.combined.total };
  for (const s of AGENCY_SOURCES) counts[s] = stats[s].total;
  return { meta: { location, from, to }, stats, counts, leads, errors };
}

/**
 * GET /agencyLeads/trend?location
 * Same shape and window as the internal trend (last three FYs, per month and
 * per FY, with FY-to-date) — Google leads only, Web / Bot / Web call only.
 */
async function getAgencyGoogleTrend({ location }) {
  assertLocation(location);
  const win = trendWindow();
  const errors = [];

  const lists = await Promise.all(
    AGENCY_SOURCES.map((s) =>
      (s === "webcall"
        ? webCallEntries(location, win.from, win.to, { withVisits: false })
        : FETCHERS[s](location, win.from, win.to)
      ).catch((e) => {
        console.error(`agencyGoogle trend ${s} ${location}:`, e.message);
        errors.push(s);
        return [];
      }),
    ),
  );

  const counter = () => {
    const o = {};
    for (const s of [...AGENCY_SOURCES, "combined"])
      o[s] = { keys: new Set(), entries: 0 };
    return o;
  };
  const finish = (c) => {
    const o = {};
    for (const [s, v] of Object.entries(c)) {
      o[s] = {
        unique: v.keys.size,
        entries: v.entries,
        duplicates: v.entries - v.keys.size,
      };
    }
    return o;
  };

  const byMonth = new Map(win.months.map((mo) => [mo.key, counter()]));
  const byFY = new Map(win.fys.map((f) => [f.fy, counter()]));
  const byFYtd = new Map(win.fys.map((f) => [f.fy, counter()]));

  lists.flat().forEach((e) => {
    const mk = String(e.date).slice(0, 7);
    const mc = byMonth.get(mk);
    if (!mc) return;
    const [y, m] = mk.split("-").map(Number);
    const d = Number(String(e.date).slice(8, 10)) || 1;
    const fc = byFY.get(fyStartYear(y, m));
    const yc = win.inYtd(m, d) ? byFYtd.get(fyStartYear(y, m)) : null;
    for (const c of [mc, fc, yc]) {
      if (!c) continue;
      c[e.source].keys.add(e.key);
      c[e.source].entries += 1;
      c.combined.keys.add(e.key);
      c.combined.entries += 1;
    }
  });

  return {
    meta: {
      location,
      from: win.from,
      to: win.to,
      ytdLabel: win.ytdLabel,
      googleOnly: true,
      generatedAt: new Date().toISOString(),
    },
    months: win.months.map((mo) => ({ ...mo, ...finish(byMonth.get(mo.key)) })),
    fys: win.fys.map((f) => ({
      ...f,
      ...finish(byFY.get(f.fy)),
      ytd: finish(byFYtd.get(f.fy)),
    })),
    errors,
  };
}

module.exports = {
  getAgencyGoogleStats,
  getAgencyGoogleLeads,
  getAgencyGoogleTrend,
  // exported for tests
  utmParam,
  utmOf,
  conditionOf,
  isGoogle,
  GOOGLE_SOURCES,
};
