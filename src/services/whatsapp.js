// whatsapp.js
// ─────────────────────────────────────────────────────────────────────────────
//  WhatsApp transport — WATI template messages.
//
//  The same provider patientModel.js already uses for appointment confirmations,
//  pulled out into a service so the token stops being copy-pasted into models.
//
//  Config (env, so no credentials live in code):
//    WATI_BASE_URL        e.g. https://live-server-115992.wati.io
//    WATI_TOKEN           the bearer token from the WATI dashboard
//    WATI_BROADCAST_NAME  optional label WATI groups sends under
//
//  Two safety properties, deliberately the same as services/mailer.js:
//
//   1. If WATI_TOKEN is not set the service runs in LOG-ONLY mode: it logs what
//      it would have sent and resolves successfully. The feature is inert but
//      never crashes, so the reminder sweep can be deployed before credentials
//      are wired.
//   2. send() NEVER throws. A failed message must not take down the cron sweep
//      and leave the rest of the queue unreminded.
//
//  TEMPLATES ARE PRE-APPROVED, NOT FREE TEXT
//  ─────────────────────────────────────────
//  WhatsApp only permits business-initiated messages from a template Meta has
//  approved. `ticket_approval_reminder` has to exist in your WATI dashboard with
//  the same variable names this file sends, or the API accepts the call and
//  silently delivers nothing. See TICKETING_CHANGES.md for the body text.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");

const WATI = {
  base: (process.env.WATI_BASE_URL || "https://live-server-115992.wati.io")
    .trim()
    .replace(/\/+$/, ""),
  token: (process.env.WATI_TOKEN || "").trim(),
  broadcast: process.env.WATI_BROADCAST_NAME || "ticketing",
};

const isConfigured = () => !!WATI.token;

/**
 * An Indian mobile in the form WATI wants: country code, digits only.
 *
 * The roster and Firestore both hold plain 10-digit numbers, but people paste
 * "+91 98765 43210" and "098765 43210" into admin forms often enough that
 * normalising here is cheaper than chasing one bad row later.
 *
 * Returns null for anything that cannot be made into a plausible number, which
 * the caller treats as "no recipient" rather than sending to a mangled address.
 */
function normalizeMobile(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.length > 10 && d.startsWith("0")) d = d.replace(/^0+/, "");
  if (d.length === 10) return `91${d}`;
  if (d.length === 11 && d.startsWith("0")) return `91${d.slice(1)}`;
  if (d.length === 12 && d.startsWith("91")) return d;
  return null; // not a shape we recognise — better to skip than to guess
}

/**
 * Send one approved template message. Resolves to { sent, reason } and never
 * rejects.
 *
 * @param {object}   msg
 * @param {string}   msg.mobile         recipient, any common Indian format
 * @param {string}   msg.templateName   the approved WATI template name
 * @param {Array<{name:string,value:string}>} [msg.parameters]
 * @param {string}   [msg.broadcastName]
 */
async function sendTemplate({
  mobile,
  templateName,
  parameters = [],
  broadcastName,
} = {}) {
  const to = normalizeMobile(mobile);
  if (!to) return { sent: false, reason: "no recipient" };
  if (!templateName) return { sent: false, reason: "no template" };

  if (!isConfigured()) {
    // Log-only: make it obvious in the logs what would have gone out, and to
    // whom, so the feature can be verified before the token exists.
    console.log(
      `whatsapp (log-only, WATI_TOKEN not set): would send "${templateName}" ` +
        `to ${to} — ${parameters.map((p) => `${p.name}=${p.value}`).join(", ")}`,
    );
    return { sent: false, reason: "not configured" };
  }

  try {
    const res = await axios.post(
      `${WATI.base}/api/v1/sendTemplateMessage?whatsappNumber=${to}`,
      {
        broadcast_name: broadcastName || WATI.broadcast,
        template_name: templateName,
        parameters: parameters.map((p) => ({
          name: String(p.name),
          value: p.value === null || p.value === undefined ? "" : String(p.value),
        })),
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${WATI.token}`,
        },
        timeout: 15000,
      },
    );

    // WATI answers 200 with { result: false, info: "..." } when the template is
    // missing or the number is not on WhatsApp. Treating a 200 as success would
    // mark a ticket reminded that nobody was reminded about, so read the body.
    const body = res && res.data;
    if (body && body.result === false) {
      console.error(
        `whatsapp: WATI refused "${templateName}" to ${to}:`,
        body.info || body.message || JSON.stringify(body),
      );
      return { sent: false, reason: body.info || "rejected by WATI" };
    }
    return { sent: true };
  } catch (e) {
    const detail =
      (e.response && JSON.stringify(e.response.data)) || (e && e.message);
    console.error(`whatsapp: send failed to ${to}:`, detail);
    return { sent: false, reason: detail };
  }
}

module.exports = { sendTemplate, normalizeMobile, isConfigured };
