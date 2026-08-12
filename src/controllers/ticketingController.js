// ticketingController.js
// ─────────────────────────────────────────────────────────────────────────────
// Mounted in app.js as:  app.use("/hms/ticketing", ticketingController);
//
// Same shape as the other controllers here: a thin router that calls the model
// and hands errors to next(). The one addition is `send`, which honours the
// err.status the models set (400 / 403 / 404) instead of letting everything
// fall through as a 500 — the app shows these messages to the user, so a
// "pick a department" has to arrive as a 400, not a server error.
//
// Endpoints
// ─────────
//   GET    /meta                     departments, issue types, priorities, statuses
//   GET    /tickets                  role-scoped list  (+ filters)
//   GET    /tickets/:id              one ticket + activity trail + attachments
//   POST   /tickets                  raise            (Partner | Branch Admin | SuperAdmin)
//   GET    /dashboard                role-scoped counters
//
//   POST   /tickets/:id/approve      Cluster Head  → Approved
//                                     (sets department, priority, resolution time)
//   POST   /tickets/:id/reconsider   Cluster Head  → Sent Back
//   POST   /tickets/:id/progress     Dept Head     → In Progress | Waiting for Vendor
//   POST   /tickets/:id/reassign     Dept Head     → Approved, new department (wrong one)
//   POST   /tickets/:id/forward      Dept Head     → Approved, new department (work done)
//   POST   /tickets/:id/resolve      Dept Head     → Resolved
//   POST   /tickets/:id/close        Dept Head     → Closed
//   POST   /tickets/:id/reopen       Raiser        → Reopened
//   POST   /tickets/:id/comment      anyone with access
//
//   POST   /roster                   Admin panel: upsert a Head/User roster row
//                                     (pairs with AddUserForm's Firestore write)
//   DELETE /roster                   Admin panel: remove a roster row by mobile
//
// Every call identifies the caller with actorMobile / actorName / actorRole /
// actorSubRole (+ branch, branches) — query string on GET, body on POST/PUT.
// ─────────────────────────────────────────────────────────────────────────────

var express = require("express");
var router = express.Router();

const {
  getMeta,
  listTickets,
  getTicket,
  createTicket,
  transitionTicket,
  getDashboard,
} = require("../models/ticketingModel");

const {
  listUsers,
  listAssignees,
  addUser,
  updateUser,
  deleteUser,
  upsertRosterUser,
  removeRosterUser,
} = require("../models/ticketUserModel");

/**
 * Run a model call and reply. Model errors carry an intentional status and a
 * message written for the person on the other end, so pass both straight
 * through; anything without a status is a genuine fault and goes to next().
 */
const send = (handler) => async (req, res, next) => {
  try {
    const result = await handler(req);
    res.status(200).send(result);
  } catch (err) {
    if (err && err.status && err.status < 500) {
      return res.status(err.status).send({
        success: false,
        error: err.message,
      });
    }
    next(err);
  }
};

/** A status change. `action` is the key in the model's TRANSITIONS table. */
const transition = (action) => send((req) => transitionTicket(req, action));

// ─── roster onboarding from the admin panel ──────────────────────────────────
// The in-app /users CRUD is gone with PDF §2 — a head has no team to manage.
// These two remain because they are how a Department Head gets a roster row at
// all, and without one they resolve to department = null and see nothing.
router.post("/roster", send(upsertRosterUser));
router.delete("/roster", send(removeRosterUser));

// ─── tickets ─────────────────────────────────────────────────────────────────
router.get("/meta", send(getMeta));
router.get("/dashboard", send(getDashboard));
router.get("/tickets", send(listTickets));
router.post("/tickets", send(createTicket));
router.get("/tickets/:id", send(getTicket));

// ─── workflow ────────────────────────────────────────────────────────────────
router.post("/tickets/:id/approve", transition("approve"));
router.post("/tickets/:id/reconsider", transition("reconsider"));
// Local fix (Operations) — the Cluster Head hands it to the branch instead of a
// department, and signs off the branch's own fix.
router.post("/tickets/:id/send-to-branch", transition("sendToBranch"));
router.post("/tickets/:id/fixed-locally", transition("fixedLocally"));
router.post("/tickets/:id/resolve-local", transition("resolveLocal"));
router.post("/tickets/:id/close-local", transition("closeLocal"));
router.post("/tickets/:id/progress", transition("progress"));
router.post("/tickets/:id/reassign", transition("reassign"));
router.post("/tickets/:id/forward", transition("forward"));
router.post("/tickets/:id/resolve", transition("resolve"));
router.post("/tickets/:id/close", transition("close"));
router.post("/tickets/:id/reopen", transition("reopen"));
router.post("/tickets/:id/comment", transition("comment"));

module.exports = router;
