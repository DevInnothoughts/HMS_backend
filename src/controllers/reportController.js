var express = require("express");
var router = express.Router();

const { getReport, getIPDBillsV2 } = require("../models/reportModel");

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
    console.log("Rating Info generated:", result);
    res.status(200).json(result);
  } catch (err) {
    console.error("Report generation error:", err);
    next(err);
  }
});

module.exports = router;
