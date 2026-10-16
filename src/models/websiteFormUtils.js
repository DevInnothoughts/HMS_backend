// src/models/websiteFormUtils.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers for the website enquiry forms (campaign, AMP) — the Node
// ports of campaign-mail.php and mailchimp-post.php.
//
// Mail goes through the shared ticketing mailer (src/services/mailer.js), so it
// uses the same TICKETING_SMTP_* settings in .env — nothing new to configure.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../databaseUtils");
const { sendMail, isConfigured } = require("../services/mailer");

const FROM_NAME = "Healing Hands Clinic";
const REPLY_TO = "info@healinghandsclinic.co.in"; // the PHP's AddReplyTo
const ADMIN_TO =
  process.env.WEBSITE_LEADS_ADMIN_TO || "innothoughtsadwords@gmail.com";

const SITE = "https://www.healinghandsclinic.co.in";

const str = (v) => (v == null ? "" : String(v)).trim();

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Same loose check as PHP FILTER_VALIDATE_EMAIL for practical purposes.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const pad2 = (n) => String(n).padStart(2, "0");

// PHP date("Y-m-d H:i:s") with date_default_timezone_set("Asia/Kolkata").
function nowSqlIST() {
  const t = new Date(Date.now() + 5.5 * 3600 * 1000);
  return (
    `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())} ` +
    `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}:${pad2(t.getUTCSeconds())}`
  );
}

// "Name <email>" list, de-duplicated case-insensitively and excluding `skip`.
function addressList(list = [], skip = []) {
  const seen = new Set(skip.map((e) => String(e).toLowerCase()));
  const out = [];
  for (const { email, name } of list) {
    const k = String(email || "").toLowerCase();
    if (!email || seen.has(k)) continue;
    seen.add(k);
    out.push(name ? { name, address: email } : email);
  }
  return out;
}

/** Parameterised insert into hhc_appointments (the "lead" connection). */
function insertLead(sql, params) {
  const { connection } = getConnectionByLocation("lead"); // hhc_appointments
  if (!connection)
    return Promise.reject(new Error("No connection for hhc_appointments"));
  return new Promise((resolve, reject) =>
    connection.query(sql, params, (err, res) =>
      err ? reject(err) : resolve(res),
    ),
  );
}

/**
 * Send one lead mail. Never throws; resolves { sent, reason }.
 * Logs loudly when SMTP isn't configured, so a silent outage is visible.
 */
async function sendLeadMail({ tag, to = ADMIN_TO, cc = [], subject, html }) {
  if (!isConfigured()) {
    console.error(`${tag}: TICKETING_SMTP_* not set in .env — mail not sent`);
    return { sent: false, reason: "SMTP is not configured" };
  }
  const res = await sendMail({
    fromName: FROM_NAME,
    replyTo: REPLY_TO,
    to,
    cc: addressList(cc, [to]),
    subject,
    html,
  });
  if (!res.sent) console.error(`${tag}: mail failed —`, res.reason);
  return res;
}

module.exports = {
  ADMIN_TO,
  SITE,
  EMAIL_RE,
  str,
  esc,
  nowSqlIST,
  addressList,
  insertLead,
  sendLeadMail,
};
