// src/services/leadSheetWebhook.js
// ─────────────────────────────────────────────────────────────────────────────
//  Pushes website leads into the "Leads Tracker" Google Sheet through the
//  sheet's own Apps Script webhook (LeadSync / doPost).
//
//  The script — not this code — writes the row on "Web Leads", assigns the
//  WEB-xxxxxx Lead ID and copies the lead to "Master Leads". We never touch the
//  sheet directly, so the tracker's IDs, formulas and Master sync stay intact.
//
//  Config (.env — no credentials in code):
//    LEAD_SHEET_WEBHOOK_URL     the Apps Script web-app /exec URL
//    LEAD_SHEET_WEBHOOK_SECRET  the SECRET constant at the top of the script
//  If either is missing the push is skipped with one warning; forms keep
//  working exactly as before.
//
//  Safety properties (same spirit as services/mailer.js and whatsapp.js):
//   1. pushLeadToSheet() is fire-and-forget and NEVER throws, so a slow or
//      failing Google call can't delay the visitor's reply or lose the lead
//      (it is already in hhc_appointments by the time we get here).
//   2. Retries are safe: every lead saved in the DB is sent with
//      ext_ref = "appt:<appointments.id>", and the script fills blanks on the
//      existing row instead of adding a duplicate when it sees the same ext_ref.
//
//  PAYLOAD KEYS — how the script reads them
//  ────────────────────────────────────────
//   Column keys:  source, name, phone, city, message, campaign
//   The script treats some other keys as column aliases and DROPS them when the
//   main key is filled: received, full_name, mobile, phone_number, contact,
//   number, location, branch, area, condition, problem, query, campaign_name,
//   ad_name, adset_name, form_name, page, page_url, utm_campaign.
//   → Never use those names for extra info. Every other key ends up in the
//     "Extra Data (JSON)" column, which is why the page URL is sent as
//     `pageurl`, not `page_url`.
//   Keys are lower-cased by the script and nested objects are flattened, so
//   keep the payload flat and lower_snake_case.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");

// The script waits up to 30 s for its lock and then syncs Master, so allow
// a generous timeout. Retries back off; ext_ref makes them duplicate-safe.
const TIMEOUT_MS = 60000;
const RETRY_DELAYS_MS = [5000, 30000];

const cfg = () => ({
  url: String(process.env.LEAD_SHEET_WEBHOOK_URL || "").trim(),
  secret: String(process.env.LEAD_SHEET_WEBHOOK_SECRET || "").trim(),
});

const isConfigured = () => {
  const { url, secret } = cfg();
  return !!url && !!secret;
};

const str = (v) => (v == null ? "" : String(v)).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let warnedMissing = false;

/** Drop empty values and stringify the rest (the script expects strings). */
function cleanPayload(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const s = str(v);
    if (s) out[k] = s;
  }
  return out;
}

/**
 * "utm_source / utm_campaign" for the Campaign column.
 * Uses the posted utm source first, then the page URL's query string,
 * then `fallback` (e.g. "Website – Contact form").
 */
function campaignFor(utmSource, pageUrl, fallback = "Website") {
  let src = str(utmSource);
  let camp = "";
  try {
    const q = new URL(str(pageUrl)).searchParams;
    src = src || str(q.get("utm_source"));
    camp = str(q.get("utm_campaign"));
  } catch (e) {
    /* not a full URL — ignore */
  }
  return [src, camp].filter(Boolean).join(" / ") || fallback;
}

/**
 * "Page: circumcision treatment" from the page URL's last path segment.
 * Added to the message so the script's condition matcher (which looks for
 * words like "piles", "fissure", "circumcision" in the message) can fill the
 * Condition column on Master for forms that have no free-text message.
 */
function pageTopic(pageUrl) {
  try {
    const parts = new URL(str(pageUrl)).pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "";
    const topic = decodeURIComponent(last)
      .replace(/\.(php|html?)$/i, "")
      .replace(/[-_]+/g, " ")
      .trim();
    return topic ? `Page: ${topic}` : "";
  } catch (e) {
    return "";
  }
}

async function postOnce(url, payload) {
  // Apps Script answers a POST with a 302 to googleusercontent.com; axios
  // follows it (as a GET) and we get the script's JSON reply.
  const res = await axios.post(url, payload, {
    timeout: TIMEOUT_MS,
    maxRedirects: 5,
    headers: { "Content-Type": "application/json" },
    validateStatus: (s) => s >= 200 && s < 300,
  });

  let data = res.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch (e) {
      // Usually a Google sign-in page: the deployment isn't "Anyone" access.
      const err = new Error(
        "reply was not JSON — check the web-app deployment has 'Who has access: Anyone'",
      );
      err.fatal = true;
      throw err;
    }
  }

  // The script reports its own errors with HTTP 200 + { ok:false, error }.
  if (!data || data.ok !== true) {
    const reason = (data && data.error) || "no ok:true in reply";
    const err = new Error(reason);
    err.fatal = /unauthori[sz]ed|unknown source/i.test(reason); // retrying won't help
    throw err;
  }
  return data;
}

/**
 * Sends one lead, with retries. Never throws.
 * @returns {Promise<{sent:boolean, leadId?:string, updated?:boolean, reason?:string}>}
 */
async function sendLeadToSheet(tag, lead) {
  if (!isConfigured()) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(
        "leadSheet: LEAD_SHEET_WEBHOOK_URL / LEAD_SHEET_WEBHOOK_SECRET not set in .env — " +
          "website leads are NOT being sent to the Leads Tracker sheet",
      );
    }
    return { sent: false, reason: "not configured" };
  }

  const { url, secret } = cfg();
  const payload = cleanPayload({
    ...lead,
    source: lead.source || "web",
    secret,
  });

  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      const data = await postOnce(url, payload);
      return { sent: true, leadId: data.lead_id, updated: !!data.updated };
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
      // A retry without ext_ref could create a second row, so only retry
      // timeouts/network errors when the lead carries an ext_ref.
      if (!payload.ext_ref && e.code === "ECONNABORTED") break;
    }
  }

  console.error(`${tag}: sheet push failed —`, lastErr && lastErr.message, {
    name: payload.name,
    phone: payload.phone,
    ext_ref: payload.ext_ref,
  });
  return { sent: false, reason: lastErr ? lastErr.message : "failed" };
}

/** Fire-and-forget wrapper used by the form models. */
function pushLeadToSheet(tag, lead) {
  sendLeadToSheet(tag, lead).catch((e) =>
    console.error(`${tag}: sheet push crashed —`, e && e.message),
  );
}

module.exports = {
  pushLeadToSheet,
  sendLeadToSheet, // awaitable version, for scripts/backfills
  campaignFor,
  pageTopic,
  isConfigured,
};
