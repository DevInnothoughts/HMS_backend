// src/controllers/websiteAppointmentController.js
// ─────────────────────────────────────────────────────────────────────────────
// Website "Book Appointment" form endpoint — replaces book-appointment-mail.php
// while its SMTP is broken.
//
//   POST https://<backend-host>/hms/websiteAppointment/book
//
// Mounted in app.js:
//   app.use("/hms/websiteAppointment", websiteAppointmentController);
//
// ── Request ─────────────────────────────────────────────────────────────────
// The same fields the PHP read from $_POST:
//   fname, email, phone, source, apptDate (dd/mm/yyyy), selectedSlot,
//   apptType ('online' | 'offline' …), branch, paymentId, amount, previousUrl
//
// Accepted as any of the three ways a website form posts:
//   application/x-www-form-urlencoded   (jQuery $.ajax / $(form).serialize())
//   multipart/form-data                 (new FormData(form)) — needs `multer`
//   application/json                    (fetch with JSON.stringify)
//
// ── Response ────────────────────────────────────────────────────────────────
// Always HTTP 200 with the PHP's JSON, so the page's existing success/error
// handling keeps working unchanged:
//   { "status": "success", "message": "Mail sent successfully" }
//   { "status": "error",   "message": "Missing required fields" }
//   { "status": "error",   "message": "Invalid appointment date" }
//   { "status": "error",   "message": "Mailer Error: …" }
//   { "status": "error",   "message": "Invalid request method" }
//
// ── Mail ────────────────────────────────────────────────────────────────────
// Sent through the shared ticketing mailer (src/services/mailer.js), using the
// same TICKETING_SMTP_* settings already in .env — nothing new to configure.
// From: "Healing Hands Clinic" <TICKETING_SMTP_USER>
//
// Like practoLeadController, errors are answered here rather than passed to
// next(err): the global handler replies in plain text, and the page expects
// JSON.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();

const { bookWebsiteAppointment } = require("../models/websiteAppointmentModel");

// multipart/form-data needs multer (`npm install multer`). Required lazily so a
// missing package can never stop the rest of the backend from starting.
let multipartFields = null;
try {
  // eslint-disable-next-line global-require
  const multer = require("multer");
  multipartFields = multer({
    limits: { fields: 50, fieldSize: 64 * 1024 },
  }).none();
} catch (e) {
  console.warn(
    "websiteAppointment: multer not installed — multipart/form-data posts will be refused. " +
      "Run `npm install multer` if the website sends FormData.",
  );
}

function parseMultipart(req, res, next) {
  if (!req.is("multipart/form-data")) return next();
  if (!multipartFields) {
    return res.status(200).json({
      status: "error",
      message: "Server cannot read multipart/form-data (multer not installed)",
    });
  }
  return multipartFields(req, res, (err) => {
    if (err) {
      return res
        .status(200)
        .json({ status: "error", message: `Bad form data: ${err.message}` });
    }
    return next();
  });
}

// express.json() is already global in app.js; add url-encoded for this route.
router.post(
  "/book",
  express.urlencoded({ extended: false, limit: "64kb" }),
  parseMultipart,
  async (req, res) => {
    try {
      const result = await bookWebsiteAppointment(req.body || {});
      return res.status(200).json(result);
    } catch (e) {
      // bookWebsiteAppointment doesn't throw; this is a last-resort guard.
      console.error("websiteAppointment: unexpected error —", e);
      return res
        .status(200)
        .json({ status: "error", message: "Something went wrong" });
    }
  },
);

// Anything other than POST — same reply as the PHP.
router.all("/book", (req, res) =>
  res.status(200).json({ status: "error", message: "Invalid request method" }),
);

module.exports = router;
