// src/utils/phoneCallLogTime.js
// ─────────────────────────────────────────────────────────────────────────────
// One place that knows how to turn a phonecalllogs row into an epoch-millis
// time, whatever the branch's call-logger app wrote.
//
// WHY THIS EXISTS
// Most branches write `timestamp` as epoch millis ("1758000382000"), and every
// helpline query filtered on `timestamp BETWEEN <ms> AND <ms>`. Adajan's device
// writes a text date in `dateTime` instead — "16 Sept 2026 10:36:22" — so those
// rows never matched a range and never showed up in the app.
//
// WHAT IT DOES
// Builds a SQL expression (`epochExpr`) that yields epoch millis for any row:
//   1. `timestamp` when it holds 12–13 digits (epoch millis) — unchanged path
//      for every branch that already worked.
//   2. otherwise `dateTime`, parsed as IST wall-clock time, in either form:
//        "16 Sept 2026 10:36:22"  (Android en-IN: "Sept", "June", "July"…)
//        "2026-09-16 10:36:22"    (ISO / DATETIME column)
//      The month token is cut to its first 3 letters so "Sept"/"June"/"July"
//      parse with %b. Conversion to epoch uses TIMESTAMPDIFF against
//      1970-01-01 05:30:00, so it does NOT depend on the MySQL server's
//      time_zone setting.
//
// ⚠️ The expression is interpolated into SQL that also uses `?` placeholders,
// and the mysql driver replaces EVERY `?` — even inside quoted regexes. Never
// put a literal `?` in this file's SQL (use {0,1} instead).
//
// Columns are checked once per branch pool (SHOW COLUMNS) and cached, so a branch
// whose table has no `dateTime` (or no `timestamp`) never gets a query that
// names a missing column.
// ─────────────────────────────────────────────────────────────────────────────

const columnCache = new WeakMap(); // pool -> Promise<Set<lowercase column name>>

const queryPool = (pool, sql, params = []) =>
  new Promise((resolve, reject) => {
    pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

const getPhoneLogColumns = (pool) => {
  if (!columnCache.has(pool)) {
    const p = queryPool(pool, "SHOW COLUMNS FROM phonecalllogs")
      .then((rows) => new Set(rows.map((r) => String(r.Field).toLowerCase())))
      .catch((err) => {
        columnCache.delete(pool); // don't cache a failure
        throw err;
      });
    columnCache.set(pool, p);
  }
  return columnCache.get(pool);
};

// "16 Sept 2026 10:36:22" / "2026-09-16 10:36:22" -> DATETIME (IST wall clock)
const DATETIME_PARSE_SQL = (col) => {
  const dt = `TRIM(CAST(${col} AS CHAR))`;
  const day = `SUBSTRING_INDEX(${dt}, ' ', 1)`;
  const mon = `LEFT(SUBSTRING_INDEX(SUBSTRING_INDEX(${dt}, ' ', 2), ' ', -1), 3)`;
  const yearTime = `SUBSTRING_INDEX(${dt}, ' ', -2)`;
  return `(CASE
      WHEN ${dt} REGEXP '^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}'
        THEN STR_TO_DATE(LEFT(${dt}, 19), '%Y-%m-%d %H:%i:%s')
      WHEN ${dt} REGEXP '^[0-9]{1,2} [A-Za-z]{3,9} [0-9]{4} [0-9]{1,2}:[0-9]{2}(:[0-9]{2}){0,1}$'
        THEN STR_TO_DATE(CONCAT(${day}, ' ', ${mon}, ' ', ${yearTime}), '%d %b %Y %H:%i:%s')
      ELSE NULL
    END)`;
};

const IST_EPOCH = "'1970-01-01 05:30:00'";

/**
 * SQL expression giving epoch millis for a phonecalllogs row, or NULL.
 * @param {Set<string>} cols lowercase column names of phonecalllogs
 */
const buildEpochExpr = (cols) => {
  const hasTs = cols.has("timestamp");
  const hasDt = cols.has("datetime");

  const tsValid = "CAST(`timestamp` AS CHAR) REGEXP '^[0-9]{12,13}$'";
  const tsMs = "CAST(`timestamp` AS UNSIGNED)";
  const dtMs = `(TIMESTAMPDIFF(SECOND, ${IST_EPOCH}, ${DATETIME_PARSE_SQL("`dateTime`")}) * 1000)`;

  if (hasTs && hasDt) return `(CASE WHEN ${tsValid} THEN ${tsMs} ELSE ${dtMs} END)`;
  if (hasTs) return `(CASE WHEN ${tsValid} THEN ${tsMs} ELSE NULL END)`;
  if (hasDt) return dtMs;
  return "NULL";
};

/**
 * @param {object} pool      mysql pool from getConnectionByLocation
 * @returns {Promise<string>} SQL expression for epoch millis
 */
const getPhoneLogEpochExpr = async (pool) =>
  buildEpochExpr(await getPhoneLogColumns(pool));

/**
 * The app reads `row.timestamp` as epoch millis. Rewrite it from the computed
 * value so rows from text-date branches display and sort correctly. The
 * original `dateTime` is left untouched.
 */
const normaliseRowTimestamp = (row, epochField = "_epoch_ms") => {
  const ms = row[epochField];
  if (ms !== null && ms !== undefined && Number(ms) > 0) {
    row.timestamp = String(Number(ms));
  }
  delete row[epochField];
  return row;
};

module.exports = {
  getPhoneLogEpochExpr,
  normaliseRowTimestamp,
  buildEpochExpr, // exported for tests
};
