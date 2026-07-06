var express = require("express");
var router = express.Router();

const {
  getReport,
  getIPDBillsV2,
  getConditionwiseReport,
} = require("../models/reportModel");
const {
  generateSummaryReport,
  generateDSRForDate,
  getDSRData,
} = require("../models/reportMailModel");
const {
  generateIPDDueEmail,
  getIPDDueData,
} = require("../models/consolidatedDataModel");

router.post("/", async (req, res, next) => {
  try {
    const result = await getReport(req);
    console.log("Report generated:", result);
    res.status(200).json(result);
  } catch (err) {
    console.error("Report generation error:", err);
    next(err);
  }
});

router.get("/ratingInfo", async (req, res, next) => {
  try {
    const result = await getIPDBillsV2(req);
    // console.log("Rating Info generated:", result);
    res.status(200).json(result);
  } catch (err) {
    console.error("Report generation error:", err);
    next(err);
  }
});

router.get("/conditionwiseReport", async (req, res, next) => {
  try {
    const result = await getConditionwiseReport(req);
    console.log("Report generated:", result);
    res.status(200).json(result);
  } catch (err) {
    console.error("Report generation error:", err);
    next(err);
  }
});

router.get("/summaryReport", async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to)
      return res
        .status(400)
        .json({ error: "from and to query params required (YYYY-MM-DD)" });
    const data = await generateSummaryReport(from, to);
    res.json(data);
  } catch (err) {
    console.error("Summary report error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Daily Sales Report: generate a branch-wise collections workbook for the
// selected date and email it. Body: { date: "YYYY-MM-DD", locations: [...] }.
// The locations list scopes which branches the requester is allowed to pull.
router.post("/dsr", async (req, res) => {
  try {
    const { date, locations } = req.body;
    if (!date)
      return res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
    if (!Array.isArray(locations) || locations.length === 0)
      return res.status(400).json({ error: "locations array is required" });

    const result = await generateDSRForDate(date, locations);
    res.status(200).json(result);
  } catch (err) {
    console.error("DSR error:", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DSR data only (for in-app download): returns the branch-wise rows as JSON.
// The app builds the Excel on-device. Body: { date, locations: [...] }.
router.post("/dsr/data", async (req, res) => {
  try {
    const { date, locations } = req.body;
    if (!date)
      return res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
    if (!Array.isArray(locations) || locations.length === 0)
      return res.status(400).json({ error: "locations array is required" });

    const result = await getDSRData(date, locations);
    res.status(200).json(result);
  } catch (err) {
    console.error("DSR data error:", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// IPD Due (outstanding) report — emails the workbook.
// Body: { from, to, locations: [...] }.
router.post("/ipd-due", async (req, res) => {
  try {
    const { from, to, locations, status } = req.body;
    if (!from || !to)
      return res
        .status(400)
        .json({ error: "from and to are required (YYYY-MM-DD)" });
    if (!Array.isArray(locations) || locations.length === 0)
      return res.status(400).json({ error: "locations array is required" });

    const result = await generateIPDDueEmail(from, to, locations, status);
    res.status(200).json(result);
  } catch (err) {
    console.error("IPD Due error:", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// IPD Due data only (for in-app download): returns detail + summary rows.
// Body: { from, to, locations: [...] }.
router.post("/ipd-due/data", async (req, res) => {
  try {
    const { from, to, locations, status } = req.body;
    if (!from || !to)
      return res
        .status(400)
        .json({ error: "from and to are required (YYYY-MM-DD)" });
    if (!Array.isArray(locations) || locations.length === 0)
      return res.status(400).json({ error: "locations array is required" });

    const result = await getIPDDueData(from, to, locations, status);
    res.status(200).json(result);
  } catch (err) {
    console.error("IPD Due data error:", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
