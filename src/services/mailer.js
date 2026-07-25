// ─────────────────────────────────────────────────────────────────────────────
//  Mailer — SMTP transport for ticket notification emails.
//
//  Sends via nodemailer over SMTP. Everything is configured with env vars so no
//  credentials live in code:
//
//    TICKETING_SMTP_HOST     SMTP server host        e.g. smtp.gmail.com
//    TICKETING_SMTP_PORT     port (default 587)
//    TICKETING_SMTP_SECURE   "true" for port 465 (implicit TLS), else false
//    TICKETING_SMTP_USER     login user
//    TICKETING_SMTP_PASS     login password / app password
//    TICKETING_SMTP_FROM     From: address    e.g. "One HHC <tickets@wedoc.in>"
//
//  Two deliberate safety properties:
//   1. If SMTP isn't configured (no host), or nodemailer isn't installed, the
//      mailer runs in LOG-ONLY mode: it logs what it would have sent and
//      resolves successfully. The feature is inert but never crashes, so the app
//      works before credentials are wired and tests run without the dependency.
//   2. sendMail NEVER throws into the caller. A failed email must not break a
//      ticket transition. Failures are caught and logged; the ticket action has
//      already been committed by the time we get here.
// ─────────────────────────────────────────────────────────────────────────────

// nodemailer is required lazily and defensively: if the package isn't installed
// yet (e.g. before `npm install nodemailer`), we fall back to log-only mode
// instead of crashing the whole model on require.
let nodemailer = null;
try {
  // eslint-disable-next-line global-require
  nodemailer = require("nodemailer");
} catch (e) {
  nodemailer = null;
}

const SMTP = {
  host: process.env.TICKETING_SMTP_HOST || "",
  port: parseInt(process.env.TICKETING_SMTP_PORT, 10) || 587,
  secure:
    String(process.env.TICKETING_SMTP_SECURE || "").toLowerCase() === "true",
  user: process.env.TICKETING_SMTP_USER || "",
  pass: process.env.TICKETING_SMTP_PASS || "",
};

// A configured mailer needs at least a host. Without it we log instead of send.
const isConfigured = () => !!(nodemailer && SMTP.host);

// Build the transport once and reuse it.
let _transport = null;
function transport() {
  if (!isConfigured()) return null;
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host: SMTP.host,
    port: SMTP.port,
    secure: SMTP.secure,
    auth: SMTP.user ? { user: SMTP.user, pass: SMTP.pass } : undefined,
  });
  return _transport;
}

/**
 * Send one email. Resolves to { sent, reason } and never rejects.
 *
 *   sent === true   the message was handed to SMTP
 *   sent === false  log-only mode or a failure (reason explains which)
 *
 * @param {{to:string|string[], subject:string, text?:string, html?:string}} msg
 */
async function sendMail(msg) {
  const to = Array.isArray(msg.to) ? msg.to.filter(Boolean).join(", ") : msg.to;

  if (!to) return { sent: false, reason: "no recipient" };

  if (!isConfigured()) {
    // Log-only: make it obvious in logs what would have gone out.
    console.log(
      `ticketing/mailer (log-only, SMTP not configured): would email "${to}" — ${msg.subject}`,
    );
    return { sent: false, reason: "not configured" };
  }

  try {
    await transport().sendMail({
      from: `"One HHC" <${process.env.TICKETING_SMTP_USER}>`,
      to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    return { sent: true };
  } catch (e) {
    // Never let an email failure bubble into a ticket transition.
    console.error(`ticketing/mailer: send failed to "${to}":`, e && e.message);
    return { sent: false, reason: e && e.message };
  }
}

module.exports = { sendMail, isConfigured };
