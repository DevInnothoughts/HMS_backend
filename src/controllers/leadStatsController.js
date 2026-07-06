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

module.exports = router;
