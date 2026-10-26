/* eslint-disable prettier/prettier */
// src/models/adAgencyLeadsModel.js
// ─────────────────────────────────────────────────────────────────────────────
// Data for the Ad Agency screen (role === 'AdAgency').
//
//   getAgencyStatsV2   branch-wise UNIQUE-lead funnel for Web · Bot · Web call · IVR
//   getBranchLeads     the unique-lead list behind one branch, phones MASKED
//
// Both are built from ONE function, buildBranch(), so the counts on the main
// screen and the rows on the branch screen can never disagree.
//
// UNIQUE LEADS
// ────────────
// A lead is one PERSON, keyed on the last ten digits of the phone number
// (+91 98…, 098…, 98… are the same person; a plain number that starts with 91
// is NOT stripped, which the old /^(\+91|91|0)/ rule got wrong).
//
//   inside a source   every row for that phone is one lead in that source
//                     → source.total = unique people, source.entries = rows
//   across sources    a person who used the website AND called IVR is one lead
//                     in "All" (combined), and appears under both source tabs
//
// THE LATEST LEAD IS KEPT, OLDER ONES ARE ELIMINATED
// ──────────────────────────────────────────────────
// Among a person's rows, the newest (by date; ties → highest row id) is the
// lead. Its status, stage, treatment and source are what is shown and counted;
// every older row only adds to `duplicates`. This applies inside each source
// tab AND in "All", where the kept lead is the newest across all sources —
// so a person who booked on the website and later called IVR is counted in
// All as an IVR lead with the IVR lead's stage.
// (Name is the one exception: IVR and Web call capture no name, so the most
// recent name the person gave is shown. It is display-only, never counted.)
//
//   duplicates = entries − unique            (per source, and for combined)
//   crossSource = Σ source uniques − combined unique   (combined only)
//
// Rows with no usable phone (fewer than ten digits) cannot be matched, so each
// is kept as its own lead rather than merged with strangers.
//
// STAGES — taken from the kept (latest) lead
// ──────────────────────────────────────────
//   booked      the latest row's status is 'Appointment'
//               (IVR has no status: a visit counts as booked, as in the stats)
//   visited     confirmed new-patient visit at the branch, using each source's
//               existing rule:
//                 web, chatbot  only if the latest row is booked, visit inside
//                               [from, to]
//                 ivr           the caller, visit inside [from, to]
//                 web call      the latest request's visit on/after its day
//                               (callLeadsModel.attachVisitFlags)
//   ipd         that visited patient has an invoice
//   not booked  unique leads whose latest row is not booked
//
// PHONE NUMBERS NEVER LEAVE THE SERVER — only maskPhone() → "98XXXXXX45".
// Notes, emails and chat messages are not sent either.
//
// ADDITIVE: GET /leadsStats/all (v1) is untouched.
// ─────────────────────────────────────────────────────────────────────────────

const util = require("util");
const { getConnectionByLocation } = require("../../databaseUtils");
const {
  buildAreaWhere,
  buildBranchWhere,
  ALL_LOCATIONS,
} = require("./leadsStatsModel");
const { getCallLeads, inferTreatment } = require("./callLeadsModel");

const SOURCES = ["web", "chatbot", "webcall", "ivr"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const phone10 = (p) =>
  String(p || "")
    .replace(/\D/g, "")
    .slice(-10);

/** "9876543245" → "98XXXXXX45". Anything too short is fully hidden. */
function maskPhone(raw) {
  const d = phone10(raw);
  if (d.length < 6) return d ? "X".repeat(d.length) : "";
  return `${d.slice(0, 2)}${"X".repeat(d.length - 4)}${d.slice(-2)}`;
}

const pad = (n) => String(n).padStart(2, "0");

/** Any stored date shape → "YYYY-MM-DD HH:mm" (wall clock as stored). */
function toWallClock(v) {
  if (!v) return "";
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(
      v.getHours(),
    )}:${pad(v.getMinutes())}`;
  }
  return String(v).replace("T", " ").slice(0, 16);
}

/** IVRdata.call_date is 'YYYY-DD-MM'. */
function ivrDate(callDate, callTime) {
  const [y, d, m] = String(callDate || "").split("-");
  const date =
    y && m && d ? `${y}-${pad(m)}-${pad(d)}` : String(callDate || "");
  return callTime ? `${date} ${String(callTime).slice(0, 5)}` : date;
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

function assertLocation(location) {
  if (!ALL_LOCATIONS.includes(location)) {
    const err = new Error(`Unknown branch: ${location}`);
    err.status = 400;
    throw err;
  }
}

function assertRange(from, to) {
  if (!isDate(from) || !isDate(to)) {
    const err = new Error("from and to are required (YYYY-MM-DD)");
    err.status = 400;
    throw err;
  }
}

/** "DP Road,Baner" → known branches among them; none valid → every branch. */
function resolveLocations(param) {
  if (!param) return ALL_LOCATIONS;
  // A caller that NAMES its branches gets only those — never every branch.
  // (It used to fall back to all branches when none of the names matched,
  // which would show a restricted user the whole estate.)
  return String(param)
    .split(",")
    .map((s) => s.trim())
    .filter((w) => ALL_LOCATIONS.includes(w));
}

/**
 * Clinic-side flags for ten-digit phones: confirmed new-patient visit with
 * appointment_timestamp in [from, to]; IPD = that patient has an invoice.
 * → Map(phone10 → { visited, ipd })
 */
async function visitFlagsInRange(location, phones, from, to) {
  const out = new Map();
  const list = [...new Set(phones.filter((p) => p && p.length === 10))];
  if (list.length === 0) return out;

  const { connection: clinicDB } = getConnectionByLocation(location);
  if (!clinicDB) return out;
  const q = util.promisify(clinicDB.query).bind(clinicDB);

  const visits = await q(
    `SELECT patient_id, patient_phone
       FROM appointment
      WHERE patient_phone IN (?)
        AND appointment_timestamp BETWEEN ? AND ?
        AND confirm_time != 0
        AND patient_type = 'New'`,
    [list, from, to],
  );
  if (visits.length === 0) return out;

  const ids = [...new Set(visits.map((v) => v.patient_id))];
  const invoiced = new Set(
    (
      await q(
        `SELECT DISTINCT patient_id FROM invoice WHERE patient_id IN (?)`,
        [ids],
      )
    ).map((r) => r.patient_id),
  );

  for (const v of visits) {
    const k = phone10(v.patient_phone);
    const cur = out.get(k) || { visited: false, ipd: false };
    cur.visited = true;
    if (invoiced.has(v.patient_id)) cur.ipd = true;
    out.set(k, cur);
  }
  return out;
}

// ─── Raw entries per source ───────────────────────────────────────────────────
// Each returns every row in range as an "entry" (not de-duplicated):
//   { source, rowId, key, phone, date, name, treatment, status, extra }

const keyFor = (source, rowId, phone) => {
  const d = phone10(phone);
  return d.length === 10 ? d : `nophone-${source}-${rowId}`;
};

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
  return rows.map((r) => ({
    source: "web",
    rowId: r.appointment_id,
    key: keyFor("web", r.appointment_id, r.phoneno),
    phone: r.phoneno,
    date: toWallClock(r.date),
    name: r.name || r.patient_name || null,
    treatment: r.disease || r.treatment || null,
    status: r.status || "New",
  }));
}

async function botEntries(location, from, to) {
  const { connection: leadDB } = getConnectionByLocation("lead");
  const q = util.promisify(leadDB.query).bind(leadDB);
  const { whereClause, params } = buildBranchWhere(location);

  const rows = await q(
    `SELECT id, datetime, name, contact, disease, status
       FROM chatbot_leads
      WHERE ${whereClause} AND DATE(datetime) BETWEEN ? AND ?
      ORDER BY id DESC`,
    [...params, `${from}T00:00:00+05:30`, `${to}T23:59:59+05:30`],
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

async function webCallEntries(location, from, to, { withVisits = true } = {}) {
  // Branch alias map + per-row visit flags come from callLeadsModel.
  const rows = await getCallLeads(location, { from, to, withVisits });
  return rows.map((r) => ({
    source: "webcall",
    rowId: r.appointment_id,
    key: keyFor("webcall", r.appointment_id, r.phoneno),
    phone: r.phoneno,
    date: toWallClock(r.date),
    name: r.name || null,
    treatment: r.disease || inferTreatment(r.pageUrl) || null,
    status: r.status || "New",
    extra: { visited: !!r.visited, ipd: !!r.ipd, channel: r.source || null },
  }));
}

async function ivrEntries(location, from, to) {
  const { connection: clinicDB } = getConnectionByLocation(location);
  const q = util.promisify(clinicDB.query).bind(clinicDB);

  const rows = await q(
    `SELECT ivr_id, call_date, call_time, call_status, caller_no
       FROM IVRdata
      WHERE STR_TO_DATE(call_date, '%Y-%d-%m') BETWEEN ? AND ?
        AND destination_no != ''
      ORDER BY ivr_id DESC`,
    [from, to],
  );
  return rows.map((r) => ({
    source: "ivr",
    rowId: r.ivr_id,
    key: keyFor("ivr", r.ivr_id, r.caller_no),
    phone: r.caller_no,
    date: ivrDate(r.call_date, r.call_time),
    name: null,
    treatment: null,
    status: r.call_status || "Call",
  }));
}

const FETCHERS = {
  web: webEntries,
  chatbot: botEntries,
  webcall: webCallEntries,
  ivr: ivrEntries,
};

// ─── De-duplicate one source → unique leads with flags ───────────────────────

// Newest first by date; same minute → the higher row id is the later insert.
const newestFirst = (a, b) => {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return (Number(b.rowId) || 0) - (Number(a.rowId) || 0);
};

/** entries → Map(key → entries[] newest first) */
function groupByKey(entries) {
  const m = new Map();
  for (const e of entries) {
    if (!m.has(e.key)) m.set(e.key, []);
    m.get(e.key).push(e);
  }
  for (const list of m.values()) list.sort(newestFirst);
  return m;
}

async function uniqueForSource(source, location, entries, from, to) {
  const groups = groupByKey(entries);
  const keys = [...groups.keys()];

  // The latest row is the lead (list is newest first); older rows are dropped.
  const bookedOf = (list) => list[0].status === "Appointment";

  // Visit / IPD — each source keeps its existing rule (see header).
  let flags = new Map();
  if (source === "web" || source === "chatbot") {
    flags = await visitFlagsInRange(
      location,
      keys.filter((k) => bookedOf(groups.get(k))),
      from,
      to,
    );
  } else if (source === "ivr") {
    flags = await visitFlagsInRange(location, keys, from, to);
  }

  const out = new Map();
  for (const [key, list] of groups) {
    const latest = list[0];
    let booked,
      visited,
      ipd,
      detail = null;

    if (source === "webcall") {
      booked = bookedOf(list);
      visited = !!latest.extra?.visited;
      ipd = !!latest.extra?.ipd;
      detail = latest.extra?.channel || null;
    } else if (source === "ivr") {
      const f = flags.get(key);
      visited = !!f?.visited;
      ipd = !!f?.ipd;
      booked = visited; // IVR: a visit counts as the appointment
      detail = `${list.length} call${list.length === 1 ? "" : "s"} · last ${String(
        latest.status,
      ).toLowerCase()}`;
    } else {
      booked = bookedOf(list);
      const f = booked ? flags.get(key) : null;
      visited = !!f?.visited;
      ipd = !!f?.ipd;
    }

    out.set(key, {
      key,
      rowId: latest.rowId,
      phone: latest.phone,
      entries: list.length,
      date: latest.date,
      firstDate: list[list.length - 1].date,
      // Display name may come from an older row (see header); nothing else does.
      name: list.find((e) => e.name)?.name || null,
      treatment: latest.treatment || null,
      status: source === "ivr" && visited ? "Visited" : latest.status,
      booked,
      visited,
      ipd,
      detail,
    });
  }
  return out;
}

// ─── One branch: unique leads across sources + stats ─────────────────────────

const emptyBucket = () => ({
  total: 0, // unique leads
  entries: 0, // raw rows
  duplicates: 0, // entries − total
  appointment: 0, // booked (unique)
  actualVisitCount: 0, // visited (unique)
  ipd: 0,
  notBooked: 0,
});

function bucketFrom(items) {
  const b = emptyBucket();
  for (const x of items) {
    b.total += 1;
    b.entries += x.entries;
    if (x.booked) b.appointment += 1;
    else b.notBooked += 1;
    if (x.visited) b.actualVisitCount += 1;
    if (x.ipd) b.ipd += 1;
  }
  b.duplicates = b.entries - b.total;
  return b;
}

async function buildBranch(location, from, to) {
  const errors = [];
  const perSource = {};

  await Promise.all(
    SOURCES.map(async (s) => {
      try {
        const entries = await FETCHERS[s](location, from, to);
        perSource[s] = await uniqueForSource(s, location, entries, from, to);
      } catch (e) {
        console.error(`adAgency ${s} ${location}:`, e.message);
        errors.push(s);
        perSource[s] = new Map();
      }
    }),
  );

  // Merge across sources on the same key: the NEWEST lead across all sources
  // is kept and decides source, status and stage; older ones are eliminated.
  const byKey = new Map();
  for (const s of SOURCES) {
    for (const [key, u] of perSource[s]) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ s, u });
    }
  }

  const merged = [];
  for (const list of byKey.values()) {
    // Newest first; a same-minute tie across tables keeps SOURCES order
    // (row ids from different tables are not comparable). Sort is stable.
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
      };
    }

    merged.push({
      id: `${src}-${kept.rowId}`,
      phone: maskPhone(kept.phone),
      source: src, // the kept lead's source
      sources: list.map((x) => x.s), // kept source first, then older ones
      perSource: perSourceOut,
      entries: list.reduce((a, x) => a + x.u.entries, 0),
      date: kept.date,
      firstDate: list.reduce(
        (m, x) => (x.u.firstDate && x.u.firstDate < m ? x.u.firstDate : m),
        kept.firstDate || kept.date,
      ),
      // Display-only fallback: IVR / Web call carry no name (see header).
      name: kept.name || list.find((x) => x.u.name)?.u.name || null,
      treatment: kept.treatment || null,
      status: kept.status,
      detail: kept.detail,
      booked: kept.booked,
      visited: kept.visited,
      ipd: kept.ipd,
      // A row's rowId is used for the tie-break in newestFirst below.
      rowId: kept.rowId,
    });
  }

  const leads = merged.sort(newestFirst).map(({ rowId, ...l }) => l);

  const stats = { location };
  for (const s of SOURCES) stats[s] = bucketFrom([...perSource[s].values()]);
  stats.combined = bucketFrom(leads);
  stats.combined.crossSource =
    SOURCES.reduce((a, s) => a + stats[s].total, 0) - stats.combined.total;
  stats.partial = errors.length > 0;
  stats.errors = errors;

  return { stats, leads, errors };
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

/**
 * GET /leadsStats/v2/all?from&to&locations=DP Road,Baner
 * → [{ location, web, chatbot, webcall, ivr, combined, partial, errors }]
 * bucket: { total (unique), entries, duplicates, appointment, actualVisitCount,
 *           ipd, notBooked }; combined also has crossSource.
 */
async function getAgencyStatsV2({ from, to, locations }) {
  assertRange(from, to);
  const locs = resolveLocations(locations);
  const rows = await Promise.all(
    locs.map(async (loc) => (await buildBranch(loc, from, to)).stats),
  );
  return rows.sort((a, b) => a.location.localeCompare(b.location));
}

/**
 * GET /leadsStats/v2/leads?location&from&to
 * → { meta, stats, counts, leads, errors }
 * One row per unique person. `perSource[src]` holds that person's de-duplicated
 * figures within each source they came through; `entries` is their raw row
 * count across all sources.
 */
async function getBranchLeads({ location, from, to }) {
  assertLocation(location);
  assertRange(from, to);
  const { stats, leads, errors } = await buildBranch(location, from, to);

  const counts = { total: stats.combined.total };
  for (const s of SOURCES) counts[s] = stats[s].total;

  return {
    meta: { location, from, to },
    stats,
    counts,
    leads,
    errors,
  };
}

// ─── Trend: unique leads per month, last three financial years ───────────────
//
// GET /leadsStats/v2/trend?location
//
// Window: 1 Apr of (current FY − 2) → today (IST). FY = Apr–Mar. So in Oct 2026
// that is FY 24-25, FY 25-26 and FY 26-27 to date.
//
// Same identity rule as the rest of this file: a person is one phone (last
// ten digits). Per month:
//   source.unique    distinct people in that source that month
//   source.entries   rows that month;  duplicates = entries − unique
//   combined.unique  distinct people across ALL sources that month (a person
//                    who used web and IVR in the same month is one)
// Per FY the same, de-duplicated over the whole year — so an FY's unique is
// NOT the sum of its months (someone who enquired in May and again in Aug is
// one lead for the year, one in each month).
//
// Counts only: no clinic visit/IPD lookups, which over ~30 months would be the
// whole cost. The current month and FY are marked `partial`.
//
// FY TO DATE: every FY also carries `ytd` — the same counts from 1 Apr up to
// today's day-and-month in that FY (e.g. 1 Apr → 24 Oct of each year), so the
// current part-year can be compared with earlier years like for like.

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const FY_YEARS = 3;

function istToday() {
  const d = new Date(Date.now() + 330 * 60 * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
const fyStartYear = (y, m) => (m >= 4 ? y : y - 1);
const fyLabel = (fy) => `FY ${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;

function trendWindow() {
  const t = istToday();
  const curFY = fyStartYear(t.y, t.m);
  const firstFY = curFY - (FY_YEARS - 1);
  const months = [];
  let y = firstFY;
  let m = 4;
  while (y < t.y || (y === t.y && m <= t.m)) {
    months.push({
      key: `${y}-${pad(m)}`,
      label: `${MONTH_SHORT[m - 1]} '${String(y).slice(2)}`,
      fy: fyStartYear(y, m),
      partial: y === t.y && m === t.m,
    });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  const fys = [];
  for (let fy = firstFY; fy <= curFY; fy++) {
    fys.push({ fy, label: fyLabel(fy), partial: fy === curFY });
  }
  // Position of today inside an FY: fiscal month index (Apr = 0) + day.
  const fiscalIdx = (m) => (m + 8) % 12;
  return {
    from: `${firstFY}-04-01`,
    to: `${t.y}-${pad(t.m)}-${pad(t.d)}`,
    months,
    fys,
    // true when a date (y, m, d) falls on or before today's point in its FY
    inYtd: (m, d) =>
      fiscalIdx(m) < fiscalIdx(t.m) ||
      (fiscalIdx(m) === fiscalIdx(t.m) && d <= t.d),
    ytdLabel: `1 Apr – ${t.d} ${MONTH_SHORT[t.m - 1]}`,
  };
}

const counter = () => {
  const o = {};
  for (const s of [...SOURCES, "combined"])
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

async function getBranchLeadTrend({ location }) {
  assertLocation(location);
  const win = trendWindow();
  const errors = [];

  const lists = await Promise.all(
    SOURCES.map((s) =>
      (s === "webcall"
        ? webCallEntries(location, win.from, win.to, { withVisits: false })
        : FETCHERS[s](location, win.from, win.to)
      ).catch((e) => {
        console.error(`adAgency trend ${s} ${location}:`, e.message);
        errors.push(s);
        return [];
      }),
    ),
  );

  const byMonth = new Map(win.months.map((mo) => [mo.key, counter()]));
  const byFY = new Map(win.fys.map((f) => [f.fy, counter()]));
  const byFYtd = new Map(win.fys.map((f) => [f.fy, counter()]));

  lists.flat().forEach((e) => {
    const mk = String(e.date).slice(0, 7); // "YYYY-MM"
    const mc = byMonth.get(mk);
    if (!mc) return; // outside the window (bad / future date)
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
  getAgencyStatsV2,
  getBranchLeads,
  getBranchLeadTrend,
  trendWindow,
  // exported for tests
  maskPhone,
  toWallClock,
  ivrDate,
  resolveLocations,
  bucketFrom,
  // Shared with agencyGoogleLeadsModel.js (Google-only agency view) so both
  // use one definition of unique / latest-kept / booked / visited / IPD.
  // Exports only — nothing above changed for them.
  SOURCES,
  phone10,
  keyFor,
  assertLocation,
  assertRange,
  visitFlagsInRange,
  uniqueForSource,
  newestFirst,
  emptyBucket,
  fyStartYear,
};
