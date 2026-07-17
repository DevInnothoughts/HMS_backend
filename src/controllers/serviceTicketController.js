// serviceTicketController.js
// ─────────────────────────────────────────────────────────────────────────────
// Routes for the Service Ticketing feature. Mounted in app.js as:
//     app.use("/hms/serviceTicket", serviceTicketController);
//
//   POST /hms/serviceTicket/create      raise a request              (Partner)
//   POST /hms/serviceTicket/action      approve / reject / action /
//                                        close / reopen               (stage role)
//   POST /hms/serviceTicket/list        role-aware ticket list        (any)
//   GET  /hms/serviceTicket/detail      one ticket + timeline + TAT   (any)
//   POST /hms/serviceTicket/stats       dashboard aggregates          (any)
//   GET  /hms/serviceTicket/categories  the 17 categories             (any)
//   GET  /hms/serviceTicket/recipients  list notification routing     (admin)
//   POST /hms/serviceTicket/recipients  add a notification recipient  (admin)
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();

const {
  CATEGORIES,
  createTicket,
  actOnTicket,
  listTickets,
  getTicketDetail,
  getTicketStats,
  listRecipients,
  addRecipient,
} = require("../models/serviceTicketModel");

router.get("/categories", (req, res) => {
  res.status(200).json({ categories: CATEGORIES });
});

router.post("/create", async (req, res, next) => {
  try {
    res.status(201).json(await createTicket(req));
  } catch (err) {
    next(err);
  }
});

router.post("/action", async (req, res, next) => {
  try {
    res.status(200).json(await actOnTicket(req));
  } catch (err) {
    next(err);
  }
});

router.post("/list", async (req, res, next) => {
  try {
    res.status(200).json(await listTickets(req));
  } catch (err) {
    next(err);
  }
});

router.get("/detail", async (req, res, next) => {
  try {
    res.status(200).json(await getTicketDetail(req));
  } catch (err) {
    next(err);
  }
});

router.post("/stats", async (req, res, next) => {
  try {
    res.status(200).json(await getTicketStats(req));
  } catch (err) {
    next(err);
  }
});

router.get("/recipients", async (req, res, next) => {
  try {
    res.status(200).json(await listRecipients(req));
  } catch (err) {
    next(err);
  }
});

router.post("/recipients", async (req, res, next) => {
  try {
    res.status(200).json(await addRecipient(req));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
