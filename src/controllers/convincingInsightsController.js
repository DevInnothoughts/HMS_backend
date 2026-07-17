// convincingInsightsController.js
// ─────────────────────────────────────────────────────────────────────────────
// Mount in app.js (one line, alongside the other controllers):
//     const convincingInsightsController = require("./src/controllers/convincingInsightsController");
//     app.use("/hms/convincingInsights", convincingInsightsController);
//
//   GET /hms/convincingInsights?location=<branch>&from=YYYY-MM-DD&to=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();

const { getConvincingInsights } = require("../models/convincingInsightsModel");

router.get("/", async (req, res, next) => {
  try {
    res.status(200).json(await getConvincingInsights(req));
  } catch (err) {
    console.error("Convincing insights error:", err);
    next(err);
  }
});

module.exports = router;
