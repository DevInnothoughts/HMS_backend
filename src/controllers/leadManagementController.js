var express = require("express");
var router = express.Router();
const {
  getLeads,
  getChatBotLeads,
  getDatewiseLeads,
  getDatewiseBotLeads,
} = require("../models/leadManagementModel");
const {
  getCallLeads,
  updateStatusCall,
  getUnmappedCallLocations,
} = require("../models/callLeadsModel");

const { getPartnerLeads } = require("../models/partnerLeadsModel");

router.get("/", async (req, res, next) => {
  try {
    const leads = await getLeads(req.query.location);
    res.status(200).send(leads);
  } catch (err) {
    next(err);
  }
});

router.get("/bot", async (req, res, next) => {
  try {
    const leads = await getChatBotLeads(req.query.location);
    res.status(200).send(leads);
  } catch (err) {
    next(err);
  }
});

router.get("/datewise", async (req, res, next) => {
  try {
    const leads = await getDatewiseLeads(
      req.query.location,
      req.query.from,
      req.query.to,
    );
    res.status(200).send(leads);
  } catch (err) {
    next(err);
  }
});

router.get("/datewiseBot", async (req, res, next) => {
  try {
    const leads = await getDatewiseBotLeads(
      req.query.location,
      req.query.from,
      req.query.to,
    );
    res.status(200).send(leads);
  } catch (err) {
    next(err);
  }
});

router.get("/partnerLeads", async (req, res, next) => {
  try {
    const { location, from, to, source } = req.query;
    if (!location || !from || !to) {
      return res
        .status(400)
        .json({ error: "location, from and to are required" });
    }
    res.status(200).json(await getPartnerLeads(location, from, to, source));
  } catch (err) {
    next(err);
  }
});

/* ── Web call leads ──────────────────────────────────────────────────────────
 * Call-back requests from the "request a call" widget on the website, stored in
 * call_leads (hhc_appointments).
 *
 * ⚠️ REQUIRES call_leads_migration.sql — `status` and `note` do not exist on
 * call_leads by default. Without them the SELECT fails outright, which shows as
 * an empty screen rather than an obvious error.
 * ─────────────────────────────────────────────────────────────────────────── */

// GET /hms/leadManagement/call?location=Thane&from=2026-09-01&to=2026-09-26
// from/to optional — without them, the 100 most recent leads.
router.get("/call", async (req, res, next) => {
  try {
    const { location, from, to } = req.query;
    if (!location) {
      return res.status(400).send({ error: "location is required" });
    }
    // Guard against the literal string "undefined" from a missing client param.
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
    const range = isDate(from) && isDate(to) ? { from, to } : {};
    res.status(200).send(await getCallLeads(location, range));
  } catch (err) {
    // Logged by name so a missing column or table is identifiable in the log
    // rather than surfacing only as an empty list on the device.
    console.error("callLeads list:", err.message);
    next(err);
  }
});

// POST /hms/leadManagement/updateStatus/call?id=123   { status, note }
router.post("/updateStatus/call", async (req, res, next) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).send({ error: "id is required" });

    const { status } = req.body || {};
    if (!status) return res.status(400).send({ error: "status is required" });

    // `?? null`, not `|| null`: an empty-string note is a deliberate clear.
    const note = req.body?.note ?? null;

    res.status(200).send(await updateStatusCall(id, status, note));
  } catch (err) {
    console.error("callLeads updateStatus:", err.message);
    next(err);
  }
});

/**
 * Diagnostic — call_location values that no branch can see.
 * Every row returned is a real lead nobody will ever be shown, because its
 * location neither contains a branch name nor has an alias in the model.
 *
 * GET /hms/leadManagement/call/unmapped?branches=Andheri,Thane,Baner
 */
router.get("/call/unmapped", async (req, res, next) => {
  try {
    const branches = String(req.query.branches || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    res.status(200).send(await getUnmappedCallLocations(branches));
  } catch (err) {
    console.error("callLeads unmapped:", err.message);
    next(err);
  }
});

module.exports = router;
