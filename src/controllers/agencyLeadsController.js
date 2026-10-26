// src/controllers/agencyLeadsController.js
// ─────────────────────────────────────────────────────────────────────────────
// Ad Agency login — Google leads only, no IVR (agencyGoogleLeadsModel.js).
// Mounted at /hms/agencyLeads in app.js. The internal Lead Stats screen keeps
// using /hms/leadsStats/v2/* (leadStatsController.js), unchanged.
//
//   GET /hms/agencyLeads/stats?from&to&locations=a,b   campaign / term stats
//   GET /hms/agencyLeads/leads?location&from&to       branch lead list (masked)
//   GET /hms/agencyLeads/trend?location               MoM / YoY, last 3 FYs
// ─────────────────────────────────────────────────────────────────────────────

var express = require("express");
var router = express.Router();
const {
  getAgencyGoogleStats,
  getAgencyGoogleLeads,
  getAgencyGoogleTrend,
} = require("../models/agencyGoogleLeadsModel");

// 400s carry a readable message; anything else goes to the error handler.
const fail = (res, next, err) =>
  err.status && err.status < 500
    ? res.status(err.status).json({ success: false, error: err.message })
    : next(err);

router.get("/stats", async (req, res, next) => {
  try {
    const { from, to, locations } = req.query;
    const data = await getAgencyGoogleStats({ from, to, locations });
    res.status(200).json({ success: true, data });
  } catch (err) {
    fail(res, next, err);
  }
});

router.get("/leads", async (req, res, next) => {
  try {
    const { location, from, to } = req.query;
    const data = await getAgencyGoogleLeads({ location, from, to });
    res.status(200).json({ success: true, data });
  } catch (err) {
    fail(res, next, err);
  }
});

router.get("/trend", async (req, res, next) => {
  try {
    const data = await getAgencyGoogleTrend({ location: req.query.location });
    res.status(200).json({ success: true, data });
  } catch (err) {
    fail(res, next, err);
  }
});

module.exports = router;
