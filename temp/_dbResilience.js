/**
 * temp/_dbResilience.js  —  helper for the TEMPORARY report runners
 * ---------------------------------------------------------------------------
 * Every branch database lives on ONE MySQL host, and dbconfig's pools use the
 * mysql driver's default 10 s connect timeout. The report models fire a query
 * per branch all at once, so on a busy server some connections never finish
 * their handshake ("Handshake inactivity timeout"). The models then drop that
 * branch for the WHOLE window — and still write the workbook — so the Excel
 * comes out with missing or zero data and no obvious error.
 *
 * harden(locations) fixes that for a runner WITHOUT touching dbconfig.js or
 * any model, by patching only the pools those branches use, in this process:
 *
 *   • connect timeout 10 s → 30 s
 *   • at most MAX_CONCURRENT pool.query calls in flight across ALL branches
 *     (the rest queue) — env REPORT_DB_CONCURRENCY, default 4
 *   • pool.query / pool.getConnection retried up to 3× on transient network
 *     errors (handshake timeout, reset, too many connections…), with backoff.
 *     Only safe because the reports issue SELECTs only.
 *
 * preflight(location) runs SELECT 1 first and throws a clear message if the
 * host can't be reached at all, instead of a page of timeouts.
 * ---------------------------------------------------------------------------
 */

const { getConnectionByLocation } = require("../databaseUtils");

const CONNECT_TIMEOUT_MS = 30000;
const MAX_CONCURRENT = Math.max(1, Number(process.env.REPORT_DB_CONCURRENCY) || 4);
const RETRIES = 3;

const TRANSIENT = new Set([
  "PROTOCOL_SEQUENCE_TIMEOUT", // Handshake inactivity timeout
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "PROTOCOL_CONNECTION_LOST",
  "ER_CON_COUNT_ERROR", // Too many connections
]);
const isTransient = (e) =>
  !!e &&
  (TRANSIENT.has(e.code) ||
    /handshake|timeout|too many connections/i.test(e.message || ""));

// ── one semaphore shared by every patched pool ─────────────────────────────
let active = 0;
const waiting = [];
const acquire = () =>
  new Promise((resolve) => {
    if (active < MAX_CONCURRENT) {
      active++;
      resolve();
    } else waiting.push(resolve);
  });
const release = () => {
  const next = waiting.shift();
  if (next) next();
  else active--;
};

let retriesUsed = 0;
const patched = new Set();

function patchPool(pool, label) {
  if (!pool || patched.has(pool)) return;
  patched.add(pool);

  const cc = pool.config && pool.config.connectionConfig;
  if (cc) cc.connectTimeout = CONNECT_TIMEOUT_MS;

  const origQuery = pool.query.bind(pool);
  pool.query = function (sql, values, cb) {
    if (typeof values === "function") {
      cb = values;
      values = undefined;
    }
    const attempt = (n) => {
      acquire().then(() => {
        origQuery(sql, values, (err, rows, fields) => {
          release();
          if (err && isTransient(err) && n < RETRIES) {
            retriesUsed++;
            const wait = 2000 * n;
            console.warn(`  ↻ ${label}: ${err.message} — retry ${n}/${RETRIES - 1} in ${wait / 1000}s`);
            return setTimeout(() => attempt(n + 1), wait);
          }
          if (cb) cb(err, rows, fields);
        });
      });
    };
    attempt(1);
  };

  const origGet = pool.getConnection.bind(pool);
  pool.getConnection = function (cb) {
    const attempt = (n) =>
      origGet((err, conn) => {
        if (err && isTransient(err) && n < RETRIES) {
          retriesUsed++;
          const wait = 2000 * n;
          console.warn(`  ↻ ${label}: ${err.message} — retry ${n}/${RETRIES - 1} in ${wait / 1000}s`);
          return setTimeout(() => attempt(n + 1), wait);
        }
        cb(err, conn);
      });
    attempt(1);
  };
}

/** Patch the pools behind these branch names. Unknown names are reported. */
function harden(locations) {
  const unknown = [];
  for (const loc of locations) {
    const { connection } = getConnectionByLocation(loc) || {};
    if (!connection) unknown.push(loc);
    else patchPool(connection, loc);
  }
  return { unknown, maxConcurrent: MAX_CONCURRENT };
}

/** SELECT 1 against one branch; throws a readable error if unreachable. */
function preflight(location) {
  const { connection } = getConnectionByLocation(location) || {};
  if (!connection) return Promise.reject(new Error(`Unknown branch: ${location}`));
  return new Promise((resolve, reject) =>
    connection.query("SELECT 1", [], (err) => {
      if (!err) return resolve();
      reject(
        new Error(
          `Cannot reach the branch database host (${err.code || "error"}: ${err.message}). ` +
            "Check this machine can reach the MySQL server (network / VPN / IP whitelist), " +
            "or run the script on the backend server itself.",
        ),
      );
    }),
  );
}

module.exports = { harden, preflight, getRetriesUsed: () => retriesUsed };
