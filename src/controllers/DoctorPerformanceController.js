var express = require("express");
var router = express.Router();

const { getDoctorPerformance } = require("../models/doctorPerformanceModel");

// GET /hms/doctorPerformance?location=<branch>&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/", async (req, res, next) => {
  try {
    const { location, from, to } = req.query;
    if (!location)
      return res.status(400).json({ error: "location is required" });
    if (!from || !to)
      return res
        .status(400)
        .json({ error: "from and to are required (YYYY-MM-DD)" });

    const result = await getDoctorPerformance(req);
    res.status(200).json(result);
  } catch (err) {
    console.error("Doctor performance error:", err);
    next(err);
  }
});

module.exports = router;
