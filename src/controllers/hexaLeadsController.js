// hexaLeadController.js
// ─────────────────────────────────────────────────────────────────────────────
// Webhook endpoint Hexa calls when a new lead arrives at their end.
//
// Mount in app.js (snippet at the bottom of this file):
//   app.use("/hms/hexaLead", hexaLeadController);
//
// Public URL to give Hexa:
//   POST https://<your-host>/hms/hexaLead
//
// Like approvalController's POST, this route does NOT call next(err): the global
// error handler replies in plain text, and a webhook sender needs JSON plus a
// deliberate status code, so errors are handled here.
// ─────────────────────────────────────────────────────────────────────────────

var express = require("express");
var router = express.Router();
const crypto = require("crypto");

const { saveHexaLead } = require("../models/hexaLeadsModel");

// Optional shared secret. If HEXA_WEBHOOK_SECRET is set in .env (dotenv is
// already loaded in app.js), every delivery must present it and anything else is
// rejected. If it is NOT set, the route still accepts deliveries but logs a
// warning — so you can bring the integration up before Hexa's auth mechanism is
// pinned down, then tighten it by setting the env var. Set it in production.
const HEXA_SECRET = process.env.HEXA_WEBHOOK_SECRET;

// Constant-time compare, so a wrong token can't be guessed byte-by-byte off
// response timing.
function tokenMatches(received) {
  if (!received) return false;
  const a = Buffer.from(String(received));
  const b = Buffer.from(String(HEXA_SECRET));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function authorized(req) {
  if (!HEXA_SECRET) {
    console.warn(
      "⚠️  Hexa webhook: HEXA_WEBHOOK_SECRET is not set — accepting delivery " +
        "without authentication. Set it before going to production.",
    );
    return true;
  }
  const token =
    req.get("x-hexa-token") ||
    req.get("authorization")?.replace(/^Bearer\s+/i, "");
  return tokenMatches(token);
}

// The webhook itself.
router.post("/", async (req, res) => {
  if (!authorized(req)) {
    console.warn(
      "Hexa webhook: rejected delivery with missing/invalid token from",
      req.ip,
    );
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  try {
    const result = await saveHexaLead(req.body);

    return res.status(200).json({
      success: true,
      message: result.inserted
        ? "Lead saved"
        : "Lead already received; record updated",
      leadId: result.id,
    });
  } catch (err) {
    // Log the payload next to the error — when the field mapping is wrong, this
    // line is what tells you which field Hexa actually sent.
    console.error(
      "Hexa webhook error:",
      err.message,
      "| payload:",
      JSON.stringify(req.body),
    );

    // Status code drives Hexa's retry behaviour:
    //   4xx -> payload is unusable; retrying re-sends the same bad data.
    //   5xx -> our side failed (DB down, etc); a retry may succeed, so we want
    //          Hexa to make it rather than drop the lead.
    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      error: err.message || "Failed to save Hexa lead",
    });
  }
});

// Reachability check for Hexa's dashboard and for you post-deploy. Writes nothing.
router.get("/health", (req, res) => {
  res.status(200).json({ success: true, service: "hexa-webhook" });
});

module.exports = router;

// ─────────────────────────────────────────────────────────────────────────────
// Wiring — add alongside the other controllers in app.js:
//
//   const hexaLeadController = require("./src/controllers/hexaLeadController");
//   ...
//   app.use("/hms/hexaLead", hexaLeadController);
//
// And (recommended) in .env:
//   HEXA_WEBHOOK_SECRET=<a long random string, shared with Hexa>
// ─────────────────────────────────────────────────────────────────────────────
