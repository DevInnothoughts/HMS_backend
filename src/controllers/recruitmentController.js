// ═══════════════════════════════════════════════════════════════════════════
//  Recruitment routes — mounted at /hms/recruitment
//
//  Mirrors the ticketing controller: thin, no business logic. Everything about
//  who may do what lives in recruitmentModel.js, so the rules can't drift
//  between the transport layer and the engine.
// ═══════════════════════════════════════════════════════════════════════════

const express = require("express");
const router = express.Router();
const M = require("../models/recruitmentModel");

// Every handler funnels through this so an error becomes a clean JSON response
// with the right status, rather than an unhandled rejection.
const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    if (status >= 500) console.error("recruitment:", e);
    res.status(status).json({
      success: false,
      message: (e && e.message) || "Something went wrong.",
    });
  }
};

// Pickers and lookups
router.get("/meta", handle(M.getMeta));

// Diagnostics: where offer letters are written, and whether that works.
// Hit this from the server itself when a stored letter 404s — it answers the
// only two questions that matter, without guesswork.
router.get("/storage-check", handle(M.storageCheck));
router.get("/dashboard", handle(M.getDashboard));

// The department's people, for the "assign to" picker. Declared before
// /requests/:id so "users" is never swallowed as an id.
router.get("/users", handle(M.listDepartmentUsers));
router.post("/users", handle(M.listDepartmentUsers));

// Requisitions
router.get("/requests", handle(M.listRequests));
router.post("/requests", handle(M.createRequest)); // Cluster Head submits the MRF
router.get("/requests/:id", handle(M.getRequest));

// Workflow transitions
router.post(
  "/requests/:id/approve",
  handle((req) => M.transitionRequest(req, "approve")),
);
router.post(
  "/requests/:id/reject",
  handle((req) => M.transitionRequest(req, "reject")),
);
router.post(
  "/requests/:id/progress",
  handle((req) => M.transitionRequest(req, "progress")),
);
router.post(
  "/requests/:id/reassign",
  handle((req) => M.transitionRequest(req, "reassign")),
);
router.post(
  "/requests/:id/retarget",
  handle((req) => M.transitionRequest(req, "retarget")),
);
router.post(
  "/requests/:id/close",
  handle((req) => M.transitionRequest(req, "close")),
);

// Offer letters (requirement 6) — one per position filled, so a requisition for
// several positions can carry several letters. No candidate identity is stored.
router.post("/requests/:id/offers", handle(M.addOffer));
router.post("/requests/:id/offers/:offerId", handle(M.updateOffer)); // joining date / remove
// An offer was declined, or the position is being re-offered. The old letter is
// kept in the history and the position frees up against the requisition's cap.
router.post("/requests/:id/offers/:offerId/replace", handle(M.replaceOffer));

module.exports = router;
