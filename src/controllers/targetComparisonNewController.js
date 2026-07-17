// targetComparisonController.js
// ─────────────────────────────────────────────────────────────────────────────
// Same two routes and request bodies as before, plus `role`/`subRole` so the
// server can gate Optimistic targets to SuperAdmin. The client sends the
// logged-in user's role (from redux); the server decides what to include —
// optimistic numbers are never returned to non-superadmins.
//
//   POST /hms/targetComparison/branches
//   POST /hms/targetComparison/detail
//
// Body adds: { role?, subRole? }
// ─────────────────────────────────────────────────────────────────────────────

var express = require("express");
var router = express.Router();

const {
  getComparisonBranchList,
  getComparisonDetail,
} = require("../models/targetComparisonNewModel");

// Branches excluded from Target Comparison regardless of what the client sends.
const EXCLUDED_BRANCHES = ["DP Road"];
const filterLocations = (locations) =>
  Array.isArray(locations)
    ? locations.filter((loc) => !EXCLUDED_BRANCHES.includes(loc))
    : locations;

router.post("/branches", async (req, res, next) => {
  try {
    const {
      locations,
      from,
      to,
      fromLastYear,
      toLastYear,
      mode,
      period,
      role,
      subRole,
    } = req.body || {};
    if (!from || !to) {
      return res
        .status(400)
        .json({ error: "`from` and `to` (YYYY-MM-DD) are required" });
    }

    const result = await getComparisonBranchList({
      locations: filterLocations(locations),
      from,
      to,
      fromLastYear,
      toLastYear,
      mode,
      period,
      role,
      subRole,
    });
    res.status(200).json(result);
  } catch (err) {
    console.error("Target comparison branch list error:", err);
    next(err);
  }
});

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
      role,
      subRole,
    } = req.body || {};
    if (!from || !to) {
      return res
        .status(400)
        .json({ error: "`from` and `to` (YYYY-MM-DD) are required" });
    }
    const result = await getComparisonDetail({
      branch: branch || "all",
      locations: filterLocations(locations),
      from,
      to,
      fromLastYear,
      toLastYear,
      mode,
      period,
      role,
      subRole,
    });
    res.status(200).json(result);
  } catch (err) {
    console.error("Target comparison detail error:", err);
    next(err);
  }
});

module.exports = router;
