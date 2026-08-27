var express = require("express");
var router = express.Router();
const {
  getConvincingScore,
  getConvincingScoreV1,
  getConvincingScoreV2,
  getConvincingScoreV3,
} = require("../models/convincingScoreModel");
const { validateDateRange } = require("../utils/dateRange"); // ← add
const {
  getConvincingComparison,
} = require("../models/convincingComparisonModel"); // ← add

router.get("/", async (req, res, next) => {
  try {
    validateDateRange(req); // ← add
    const result = await getConvincingScore(req);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

router.get("/v1", async (req, res, next) => {
  try {
    validateDateRange(req); // ← add
    const result = await getConvincingScoreV2(req);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

router.get("/v3", async (req, res, next) => {
  try {
    const { from, to, days } = validateDateRange(req); // ← add
    console.log(
      `ConvincingScore/v3 ${req.query.location} ${from}→${to} (${days}d)`,
    );
    const result = await getConvincingScoreV3(req);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

router.get("/comparison", async (req, res, next) => {
  try {
    // yoy on a 366-day range would scan two years — cap it harder here
    const { from, to } = validateDateRange(req, { maxDays: 372 });
    const result = await getConvincingComparison(req);
    console.log(
      `ConvincingScore/comparison ${req.query.location} ` +
        `${from}→${to} mode=${result.mode} periods=${result.series.length}`,
    );
    res.status(200).json(result);
  } catch (err) {
    console.error("Convincing comparison error:", err);
    next(err);
  }
});

module.exports = router;
