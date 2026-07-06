var express = require("express");
var router = express.Router();

const {
  getComparisonBranchList,
  getComparisonDetail,
} = require("../models/targetComparisonModel");

// ─────────────────────────────────────────────────────────────────────────────
// POST /hms/targetComparison/branches
//
// Lightweight per-branch Total Revenue list for TargetComparisonScreen.
// Switched to POST because `locations` is an array (40+ entries).
//
// Body:
//   {
//     locations:     ["Baner", "Andheri", ...],   // branches to include
//     from:          "2025-04-01",                 // this-year range start (YYYY-MM-DD)
//     to:            "2026-03-31",                 // this-year range end
//     fromLastYear?: "2024-04-01",                 // optional; defaults to `from` - 1yr
//     toLastYear?:   "2025-03-31",                 // optional; defaults to `to`   - 1yr
//     mode?:         "yearly",                     // optional; for meta.periodLabel only
//     period?:       0                             // optional; for meta.periodLabel only
//   }
//
// Response:
//   {
//     meta: { mode, periodIndex, periodLabel, range },
//     branches: [{ id, name, thisYear, lastYear, yoy, ach, target }]
//   }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/branches", async (req, res, next) => {
  try {
    const { locations, from, to, fromLastYear, toLastYear, mode, period } =
      req.body || {};
    if (!from || !to) {
      return res
        .status(400)
        .json({ error: "`from` and `to` (YYYY-MM-DD) are required" });
    }
    const result = await getComparisonBranchList({
      locations,
      from,
      to,
      fromLastYear,
      toLastYear,
      mode,
      period,
    });
    res.status(200).json(result);
  } catch (err) {
    console.error("Target comparison branch list error:", err);
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /hms/targetComparison/detail
//
// Full parameter-level comparison for one branch, or consolidated across
// `locations` when branch === "all". Used by BranchTargetDetailScreen and by
// the overview screen's top cards + revenue chart (called with branch "all").
//
// Body:
//   {
//     branch:        "Baner" | "all",             // default "all"
//     locations:     ["Baner", "Andheri", ...],   // required only when branch="all"
//     from, to,                                    // this-year range (required)
//     fromLastYear?, toLastYear?,                  // optional last-year range
//     mode?, period?                               // optional; meta label only
//   }
//
// Response:
//   {
//     meta: { branchId, branchName, mode, periodIndex, periodLabel, range, warnings },
//     params: [{ key, label, short, type, targetPct, lastYear, thisYear, target, yoy, ach }]
//   }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/detail", async (req, res, next) => {
  try {
    const {
      branch,
      locations,
      from,
      to,
      fromLastYear,
      toLastYear,
      mode,
      period,
    } = req.body || {};
    if (!from || !to) {
      return res
        .status(400)
        .json({ error: "`from` and `to` (YYYY-MM-DD) are required" });
    }
    const result = await getComparisonDetail({
      branch: branch || "all",
      locations,
      from,
      to,
      fromLastYear,
      toLastYear,
      mode,
      period,
    });
    res.status(200).json(result);
  } catch (err) {
    console.error("Target comparison detail error:", err);
    next(err);
  }
});

module.exports = router;
