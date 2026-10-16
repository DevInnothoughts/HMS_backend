// src/controllers/websiteFormsController.js
// ─────────────────────────────────────────────────────────────────────────────
// Website enquiry-form endpoints — replace two PHP scripts whose SMTP is broken
// (same approach as websiteAppointmentController / book-appointment-mail.php):
//
//   POST https://<backend-host>/hms/websiteForms/campaign  ← campaign-mail.php
//   POST https://<backend-host>/hms/websiteForms/amp       ← mailchimp-post.php
//
// Mounted in app.js:
//   app.use("/hms/websiteForms", websiteFormsController);
//
// Each one: validate → INSERT into hhc_appointments.appointments → mail the
// location (TO admin inbox, CC that location's list from
// src/config/websiteFormRecipients.js). See src/models/websiteEnquiryModel.js.
//
// ── Request fields (unchanged from the PHP) ─────────────────────────────────
//   campaign: yourname, youremail, yourphone, selected_area, yourmessage,
//             subjectText, utmsource            (+ Referer header → pageurl)
//   amp:      name, email, phoneno, selected_area, message, pagesubject
//                                               (+ Referer → pageurl, utm_source)
// Accepted as application/x-www-form-urlencoded, multipart/form-data (multer)
// or JSON.
//
// ── Replies ─────────────────────────────────────────────────────────────────
// campaign is a normal <form method="post"> submission, so — exactly like the
// PHP — it answers with a tiny HTML page that fires the Meta pixel and sends
// the visitor on:
//   success → per location (see `pixel` in the recipients config):
//               PageView pixel 913144286745452 → /thank-you/      or
//               Lead pixel 2199419837014290 + "Thank you…" alert → /thank-you/
//   error   → "Something went wrong..." alert → home page
//
// amp answers JSON with the AMP CORS headers and AMP-Redirect-To
// /amp/thank-you/, or 400 {message} on bad input — as the PHP did.
//
// ── Captcha (campaign) ──────────────────────────────────────────────────────
// campaign-mail.php compared $_POST["captcha"] with $_SESSION["code"], a PHP
// session on the website's domain. This backend can't see that session, so the
// check is replaced by:
//   • a per-IP rate limit (5 submissions / 10 min per form), and
//   • an optional honeypot: add <input type="text" name="hhc_hp" value=""
//     style="display:none" tabindex="-1" autocomplete="off"> to the form. Bots
//     that fill it get the normal thank-you and nothing is saved or mailed.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();

const {
  submitCampaignEnquiry,
  submitAmpEnquiry,
} = require("../models/websiteEnquiryModel");
const { SITE } = require("../models/websiteFormUtils");

const THANK_YOU = `${SITE}/thank-you/`;
const AMP_THANK_YOU = `${SITE}/amp/thank-you/`;

/* ── Body parsing (multer required lazily, as in websiteAppointment) ─────── */

let fieldsOnly = null;
try {
  // eslint-disable-next-line global-require
  const multer = require("multer");
  fieldsOnly = multer({ limits: { fields: 50, fieldSize: 64 * 1024 } }).none();
} catch (e) {
  console.warn(
    "websiteForms: multer not installed — multipart/form-data posts (incl. the AMP form) " +
      "will be refused. Run `npm install multer`.",
  );
}

/** Run multer only for multipart requests; hand errors to onError. */
function multipart(onError) {
  return (req, res, next) => {
    if (!req.is("multipart/form-data")) return next();
    if (!fieldsOnly) return onError(res, new Error("multer not installed"));
    return fieldsOnly(req, res, (err) => (err ? onError(res, err) : next()));
  };
}

const urlencoded = express.urlencoded({ extended: false, limit: "64kb" });

/* ── Abuse protection ────────────────────────────────────────────────────── */

const RATE = { max: 5, windowMs: 10 * 60 * 1000 };
const hits = new Map();

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return fwd || req.ip || "";
}

function rateLimited(form, req) {
  const key = `${form}:${clientIp(req)}`;
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < RATE.windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10000) hits.clear(); // crude memory cap
  return recent.length > RATE.max;
}

const isBot = (body) => !!(body && String(body.hhc_hp || "").trim());

/* ── HTML replies (same scripts the PHP echoed) ──────────────────────────── */

const PIXELS = {
  pageview: { id: "913144286745452", event: "PageView" },
  lead: { id: "2199419837014290", event: "Lead" },
};

function pixelHtml(kind) {
  const px = PIXELS[kind];
  if (!px) return "";
  return (
    "<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?" +
    "n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;" +
    "n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;" +
    "s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script'," +
    `'https://connect.facebook.net/en_US/fbevents.js');fbq('init','${px.id}');fbq('track','${px.event}');</script>` +
    `<noscript><img height="1" width="1" src="https://www.facebook.com/tr?id=${px.id}&ev=PageView&noscript=1"/></noscript>`
  );
}

function replyPage(res, { pixel, alert, redirect }) {
  const alertJs = alert ? `alert(${JSON.stringify(alert)});` : "";
  res
    .status(200)
    .type("html")
    .send(
      '<!doctype html><html><head><meta charset="utf-8"><title>Healing Hands Clinic</title></head><body>' +
        pixelHtml(pixel) +
        `<script>${alertJs}window.open(${JSON.stringify(redirect)},'_self');</script>` +
        `<noscript><a href="${redirect}">Continue</a></noscript>` +
        "</body></html>",
    );
}

/* ── campaign-mail.php ───────────────────────────────────────────────────── */

const campaignError = (res) =>
  replyPage(res, { alert: "Something went wrong...", redirect: SITE });

router.post(
  "/campaign",
  urlencoded,
  multipart((res) => campaignError(res)),
  async (req, res) => {
    try {
      if (isBot(req.body)) return replyPage(res, { redirect: THANK_YOU });
      if (rateLimited("campaign", req)) return campaignError(res);

      const result = await submitCampaignEnquiry(req.body || {}, {
        referer: req.get("referer"),
        query: req.query,
      });
      if (result.status !== "success") return campaignError(res);

      return result.pixel === "lead"
        ? replyPage(res, {
            pixel: "lead",
            alert:
              "Thank you. Your request for a consultation at Healing Hands Clinic has been received by us",
            redirect: THANK_YOU,
          })
        : replyPage(res, { pixel: "pageview", redirect: THANK_YOU });
    } catch (e) {
      console.error("campaignEnquiry: unexpected error —", e);
      return campaignError(res);
    }
  },
);

/* ── mailchimp-post.php (AMP) ────────────────────────────────────────────── */

// The page's own origin. AMP sends it as ?__amp_source_origin=… and expects it
// echoed back in AMP-Access-Control-Allow-Source-Origin.
const AMP_SOURCE_ORIGIN = process.env.AMP_SOURCE_ORIGIN || SITE;

// Origins allowed to call: the site itself and the AMP caches serving it.
function ampOriginAllowed(origin) {
  if (!origin) return false;
  if (
    origin === AMP_SOURCE_ORIGIN ||
    origin === "https://healinghandsclinic.co.in"
  )
    return true;
  return /^https:\/\/[a-z0-9-]+\.(cdn\.ampproject\.org|amp\.cloudflare\.com|bing-amp\.com)$/i.test(
    origin,
  );
}

// Overrides the global cors() "*" — AMP sends credentials, so the exact origin
// must be echoed.
function ampCors(req, res) {
  const origin = req.get("origin");
  if (ampOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("AMP-Access-Control-Allow-Source-Origin", AMP_SOURCE_ORIGIN);
  res.setHeader(
    "Access-Control-Expose-Headers",
    "AMP-Redirect-To, AMP-Access-Control-Allow-Source-Origin",
  );
}

const ampError = (
  res,
  message = "Error! Something went wrong, please try again",
) => res.status(400).json({ message });

router.post(
  "/amp",
  (req, res, next) => {
    ampCors(req, res);
    const src = req.query.__amp_source_origin;
    if (src && src !== AMP_SOURCE_ORIGIN)
      return ampError(res, "Invalid source origin");
    return next();
  },
  urlencoded,
  multipart((res) => ampError(res)),
  async (req, res) => {
    try {
      if (rateLimited("amp", req))
        return ampError(res, "Too many submissions. Please try again later.");
      if (isBot(req.body)) {
        res.setHeader("AMP-Redirect-To", AMP_THANK_YOU);
        return res.status(200).json({});
      }

      const result = await submitAmpEnquiry(req.body || {}, {
        referer: req.get("referer"),
      });
      if (result.status !== "success") return ampError(res);

      res.setHeader("AMP-Redirect-To", AMP_THANK_YOU);
      return res.status(200).json({ name: result.name, email: result.email });
    } catch (e) {
      console.error("ampEnquiry: unexpected error —", e);
      return ampError(res);
    }
  },
);

module.exports = router;
