// businessHours.js
// ─────────────────────────────────────────────────────────────────────────────
//  Working-day / working-hour arithmetic.
//
//  Monday–Saturday, 10:00–19:00. Sunday, and anything outside those hours, does
//  not count towards a deadline: a ticket raised at 18:00 on Saturday is due at
//  12:00 on Monday, not at 21:00 that same evening. Anything else means pinging
//  a Cluster Head at nine on a Sunday night, which teaches them to ignore the
//  pings — the one outcome a reminder must not produce.
//
//  WHY THIS IS PURE WALL-CLOCK STRING MATH
//  ───────────────────────────────────────
//  Every datetime on the ticket table is a MySQL DATETIME written by
//  toSqlDateTime() and compared against NOW(). Those are the same wall clock, so
//  this module takes a "YYYY-MM-DD HH:MM:SS" string, walks that clock forward,
//  and hands back a string in the same shape. It never converts a timezone,
//  which is precisely why it cannot drift away from the values the database is
//  comparing — the classic "the deadline is five and a half hours out" bug.
//
//  Internally the arithmetic runs on Date.UTC millisecond values used purely as
//  a calendar calculator (month lengths, leap years). The UTC is bookkeeping,
//  not a timezone claim.
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {
  // 0 = Sunday … 6 = Saturday. Monday to Saturday are working days.
  WORK_DAYS: [1, 2, 3, 4, 5, 6],
  START_HOUR: 10, // 10:00
  END_HOUR: 19, // 19:00 — the moment the day closes, so not itself "inside" it
};

const SQL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

/** "YYYY-MM-DD HH:MM:SS" or Date → millisecond calendar value, or null. */
function toMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    // Read the LOCAL parts — a Date built by the app carries the same wall clock
    // the database rows do.
    return Date.UTC(
      value.getFullYear(),
      value.getMonth(),
      value.getDate(),
      value.getHours(),
      value.getMinutes(),
      value.getSeconds(),
    );
  }
  const m = SQL_RE.exec(String(value).trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}

const pad = (n) => String(n).padStart(2, "0");

/** millisecond calendar value → "YYYY-MM-DD HH:MM:SS" */
function toSql(ms) {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

const isWorkDay = (ms) => CONFIG.WORK_DAYS.includes(new Date(ms).getUTCDay());

function dayStart(ms) {
  const d = new Date(ms);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    CONFIG.START_HOUR,
  );
}

function dayEnd(ms) {
  const d = new Date(ms);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    CONFIG.END_HOUR,
  );
}

/**
 * The first working instant at or after `ms`.
 *
 *   Sunday 14:00   → Monday 10:00
 *   Tuesday 07:30  → Tuesday 10:00
 *   Tuesday 21:00  → Wednesday 10:00
 *   Tuesday 11:00  → Tuesday 11:00   (already open — returned untouched)
 */
function nextOpen(ms) {
  let cur = ms;
  // The guard is a safety net, not a limit: every branch either returns or
  // advances a whole day, so this cannot spin.
  for (let guard = 0; guard < 400; guard++) {
    if (!isWorkDay(cur)) {
      cur = dayStart(cur + DAY);
      continue;
    }
    if (cur < dayStart(cur)) return dayStart(cur);
    if (cur >= dayEnd(cur)) {
      cur = dayStart(cur + DAY);
      continue;
    }
    return cur;
  }
  return cur;
}

/**
 * `from` + `minutes` of working time, as a MySQL DATETIME string.
 * A `from` that is outside working hours is first rolled forward to the next
 * open moment — the clock starts when the office does.
 */
function addWorkingMinutes(from, minutes) {
  const start = toMs(from);
  if (start === null) return null;

  let left = Math.max(0, Number(minutes) || 0);
  let cur = nextOpen(start);

  for (let guard = 0; guard < 2000 && left > 0; guard++) {
    const close = dayEnd(cur);
    const available = (close - cur) / MIN;
    if (available >= left) {
      cur += left * MIN;
      left = 0;
      break;
    }
    left -= available;
    cur = nextOpen(close);
  }
  return toSql(cur);
}

/** The same, in hours. This is what the approval deadline uses. */
const addWorkingHours = (from, hours) =>
  addWorkingMinutes(from, Number(hours) * 60);

/**
 * How much working time elapsed between two instants. Used to say "pending for
 * 4 hours" in the reminder rather than quoting wall-clock time, which would
 * read as 40 hours over a weekend and make the message look broken.
 */
function workingMinutesBetween(a, b) {
  const from = toMs(a);
  const to = toMs(b);
  if (from === null || to === null || to <= from) return 0;

  let total = 0;
  let cur = nextOpen(from);
  for (let guard = 0; guard < 2000 && cur < to; guard++) {
    const close = Math.min(dayEnd(cur), to);
    if (close > cur) total += (close - cur) / MIN;
    cur = nextOpen(dayEnd(cur));
  }
  return Math.round(total);
}

/**
 * Is now a sensible moment to send a reminder?
 *
 * A deadline computed by addWorkingHours always lands inside working hours, so
 * the sweep would normally catch it in-hours anyway. This guard exists for the
 * case where it did not — the server was restarting, or down overnight — so a
 * backlog cannot flush itself onto someone's phone at 3 a.m. on Sunday.
 *
 * 19:00 itself is included: a ticket raised at 16:00 is due at exactly 19:00,
 * and that reminder should go out today rather than wait for tomorrow.
 */
function isReminderWindow(when = new Date()) {
  return (
    CONFIG.WORK_DAYS.includes(when.getDay()) &&
    when.getHours() >= CONFIG.START_HOUR &&
    when.getHours() <= CONFIG.END_HOUR
  );
}

module.exports = {
  CONFIG,
  addWorkingHours,
  addWorkingMinutes,
  workingMinutesBetween,
  isReminderWindow,
  // exported for tests
  nextOpen,
  toSql,
  toMs,
};
