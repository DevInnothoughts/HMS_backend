// src/utils/dateRange.js
// Shared validation for `from` / `to` query params on range endpoints.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

function bad(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/**
 * Validates req.query.from / req.query.to.
 * Returns { from, to, days } or throws a 400.
 *
 * maxDays guards the IN (?) patient-id expansion in the score queries —
 * see note in convincingScoreModel.
 */
function validateDateRange(req, { maxDays = 366 } = {}) {
  const from = (req.query.from || "").trim();
  const to = (req.query.to || "").trim();

  if (!from || !to) {
    throw bad("`from` and `to` (YYYY-MM-DD) are required");
  }
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    throw bad("`from` and `to` must be in YYYY-MM-DD format");
  }

  const f = new Date(`${from}T00:00:00Z`);
  const t = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) {
    throw bad("`from` and `to` must be valid calendar dates");
  }
  if (f > t) {
    throw bad("`from` must be on or before `to`");
  }

  const days = Math.round((t - f) / DAY_MS) + 1;
  if (days > maxDays) {
    throw bad(`Date range too large: ${days} days (max ${maxDays})`);
  }

  return { from, to, days };
}

module.exports = { validateDateRange };
