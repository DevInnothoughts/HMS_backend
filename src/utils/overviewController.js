// src/controllers/overviewController.js
// ─────────────────────────────────────────────────────────────────────────────
// Mount in app.js:
//     const overviewController = require("./src/controllers/overviewController");
//     app.use("/hms/overview", overviewController);
//
//   GET /hms/overview/collection?location&from&to
//   GET /hms/overview/section/:id?location&from&to&compare=prev
//
// Sections are registered one at a time in SECTION_MODELS. An id with no model
// yet returns 501 with a readable message rather than a 404 — the section
// exists in the app, its data does not exist yet, and those are different
// problems for whoever is reading the log.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();

const { getCollection } = require("../models/overview/collectionModel");
const { getOpdSection } = require("../models/overview/opdModel");
const { getIpdFeedback } = require("../models/overview/ipdFeedbackModel");
const { getIpdSection } = require("../models/overview/ipdModel");
const { getLabSection } = require("../models/overview/labModel");
const { getPharmacySection } = require("../models/overview/pharmacyModel");
const { getLeadsSection } = require("../models/overview/leadsModel");
const { getReportsSection } = require("../models/overview/reportsModel");
const {
  getBranchSummary,
  getBranchSummaryV2,
} = require("../models/overview/branchSummaryModel");
const { getBranchTrend } = require("../models/overview/branchTrendModel");

// id → model. Add a line per section as each is built.
const SECTION_MODELS = {
  opd: getOpdSection,
  ipd: getIpdSection,
  lab: getLabSection,
  pharmacy: getPharmacySection,
  leads: getLeadsSection,
  reports: getReportsSection,
  performance: getIpdFeedback,
};

function send(res, next, work) {
  work()
    .then((data) => res.status(200).json(data))
    .catch((err) => {
      if (err && err.status) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    });
}

router.get("/collection", (req, res, next) =>
  send(res, next, () =>
    getCollection(req.query.location, req.query.from, req.query.to),
  ),
);

router.get("/section/:id", (req, res, next) => {
  const model = SECTION_MODELS[req.params.id];
  if (!model) {
    return res.status(501).json({
      error: `No data is available for the ${req.params.id} section yet.`,
    });
  }
  return send(res, next, () =>
    model({
      location: req.query.location,
      from: req.query.from,
      to: req.query.to,
      // Anything other than the literal 'prev' means no comparison. Guards
      // against the `status=undefined` class of bug, where a missing client
      // param arrives as the STRING "undefined" and passes a truthy check.
      compare: req.query.compare === "prev" ? "prev" : null,
    }),
  );
});

router.get("/feedback", (req, res, next) =>
  send(res, next, () =>
    getIpdFeedback({
      location: req.query.location,
      from: req.query.from,
      to: req.query.to,
    }),
  ),
);

router.get("/branchSummary", (req, res, next) => {
  const locations = String(req.query.locations || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  getBranchSummary({ from: req.query.from, to: req.query.to, locations })
    .then((d) => res.json(d))
    .catch((err) =>
      err?.status
        ? res.status(err.status).json({ error: err.message })
        : next(err),
    );
});

// GET /hms/overview/branchSummaryV2?from&to&locations=a,b,c
// New patients + revenue per new patient. V1 above stays for older app builds.
router.get("/branchSummaryV2", (req, res, next) => {
  const locations = String(req.query.locations || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  send(res, next, () =>
    getBranchSummaryV2({ from: req.query.from, to: req.query.to, locations }),
  );
});

// GET /hms/overview/branchTrend?location=Baner
// Monthly (12), quarterly (8) and FY (5) buckets for one branch, in one call.
router.get("/branchTrend", (req, res, next) =>
  send(res, next, () =>
    getBranchTrend({ location: String(req.query.location || "").trim() }),
  ),
);

module.exports = router;
