const express = require("express");
const router = express.Router();

const { getConvincingInsights } = require("../models/convincingInsightsModel");
const { validateDateRange } = require("../utils/dateRange"); // ← add

router.get("/", async (req, res, next) => {
  try {
    validateDateRange(req); // ← add
    res.status(200).json(await getConvincingInsights(req));
  } catch (err) {
    console.error("Convincing insights error:", err);
    next(err);
  }
});

module.exports = router;
