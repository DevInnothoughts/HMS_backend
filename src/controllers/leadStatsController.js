var express = require("express");
var router = express.Router();
const {
  getWebLeadsCount,
  getChatbotLeadsCount,
  getLocationStats,
  getAllLocationsStats,
} = require("../models/leadsStatsModel");

// GET /leadsStats/web?location=DP+Road&from=2026-04-01&to=2026-04-25
router.get("/web", async (req, res, next) => {
  try {
    const { location, from, to } = req.query;
    const stats = await getWebLeadsCount(location, from, to);
    res.status(200).json({ success: true, data: stats });
  } catch (err) {
    next(err);
  }
});

// GET /leadsStats/bot?location=DP+Road&from=2026-04-01&to=2026-04-25
router.get("/bot", async (req, res, next) => {
  try {
    const { location, from, to } = req.query;
    const stats = await getChatbotLeadsCount(location, from, to);
    res.status(200).json({ success: true, data: stats });
  } catch (err) {
    next(err);
  }
});

// GET /leadsStats/location?location=DP+Road&from=2026-04-01&to=2026-04-25
router.get("/location", async (req, res, next) => {
  try {
    const { location, from, to } = req.query;
    const stats = await getLocationStats(location, from, to);
    res.status(200).json({ success: true, data: stats });
  } catch (err) {
    next(err);
  }
});

// GET /leadsStats/all?from=2026-04-01&to=2026-04-25
router.get("/all", async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const stats = await getAllLocationsStats(from, to);
    res.status(200).json({ success: true, data: stats });
  } catch (err) {
    next(err);
  }
});

// ─── V2 — Ad Agency screen ────────────────────────────────────────────────────
// Additive: v1 above stays as-is for LeadStatsReportScreen and older builds.
const {
  getAgencyStatsV2,
  getBranchLeads,
  getBranchLeadTrend,
} = require("../models/adAgencyLeadsModel");

// 400s carry a readable message; anything else goes to the error handler.
const fail = (res, next, err) =>
  err.status && err.status < 500
    ? res.status(err.status).json({ success: false, error: err.message })
    : next(err);

// GET /leadsStats/v2/all?from=2026-10-01&to=2026-10-23&locations=DP Road,Baner
// Per branch UNIQUE leads (one per phone): web, chatbot, webcall, ivr, combined.
// Each bucket also carries entries, duplicates and notBooked.
router.get("/v2/all", async (req, res, next) => {
  try {
    const { from, to, locations } = req.query;
    const data = await getAgencyStatsV2({ from, to, locations });
    res.status(200).json({ success: true, data });
  } catch (err) {
    fail(res, next, err);
  }
});

// GET /leadsStats/v2/leads?location=DP Road&from=2026-10-01&to=2026-10-23
// Branch unique-lead list (all sources). Phones masked server-side (98XXXXXX45).
router.get("/v2/leads", async (req, res, next) => {
  try {
    const { location, from, to } = req.query;
    const data = await getBranchLeads({ location, from, to });
    res.status(200).json({ success: true, data });
  } catch (err) {
    fail(res, next, err);
  }
});

// GET /leadsStats/v2/trend?location=DP Road
// Unique leads per month and per FY, last three financial years, by source.
router.get("/v2/trend", async (req, res, next) => {
  try {
    const data = await getBranchLeadTrend({ location: req.query.location });
    res.status(200).json({ success: true, data });
  } catch (err) {
    fail(res, next, err);
  }
});

// ─── Meta leads — Lead Stats Report's "Meta leads" tab ───────────────────────
// Bot leads whose lead_source is "mumbai_chatbot" (metaLeadsModel.js). The
// same rows are excluded from every Google figure.
const { getMetaStats, getMetaLeads } = require("../models/metaLeadsModel");

// GET /leadsStats/meta/stats?from=2026-10-01&to=2026-10-29&locations=Andheri,Thane
router.get("/meta/stats", async (req, res, next) => {
  try {
    const { from, to, locations } = req.query;
    const data = await getMetaStats({ from, to, locations });
    res.status(200).json({ success: true, data });
  } catch (err) {
    fail(res, next, err);
  }
});

// GET /leadsStats/meta/leads?location=Andheri&from=2026-10-01&to=2026-10-29
// One branch's Meta leads. Phones masked server-side (98XXXXXX45).
router.get("/meta/leads", async (req, res, next) => {
  try {
    const { location, from, to } = req.query;
    const data = await getMetaLeads({ location, from, to });
    res.status(200).json({ success: true, data });
  } catch (err) {
    fail(res, next, err);
  }
});

module.exports = router;
