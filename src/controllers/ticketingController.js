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
//   POST   /tickets                  raise            (Partner | Cluster Head)
//   GET    /dashboard                role-scoped counters
//
//   POST   /tickets/:id/approve      Cluster Head  → Approved
//   POST   /tickets/:id/reject       Cluster Head  → Rejected
//   POST   /tickets/:id/route        Cluster Head  → Approved (re-route a revert)
//   POST   /tickets/:id/assign       Dept Head     → Assigned
//   POST   /tickets/:id/revert       Dept Head     → Reverted  (wrong department)
//   POST   /tickets/:id/progress     Dept User     → In Progress | Waiting for Vendor
//   POST   /tickets/:id/fix          Dept User     → Pending Approval
//   POST   /tickets/:id/dept-approve Dept Head     → Resolved
//   POST   /tickets/:id/send-back    Dept Head     → Assigned
//   POST   /tickets/:id/close        Raiser        → Closed
//   POST   /tickets/:id/reopen       Raiser        → Reopened
//   POST   /tickets/:id/comment      anyone with access
//
//   GET    /users                    Dept Head: their department roster
//   GET    /users/assignees          Dept Head: who a ticket can go to
//   POST   /users                    Dept Head: add
//   PUT    /users/:id                Dept Head: edit
//   DELETE /users/:id                Dept Head: remove (soft)
//
//   POST   /roster                   Admin panel: upsert a Head/User roster row
//                                     (pairs with AddUserForm's Firestore write)
//   DELETE /roster                   Admin panel: remove a roster row by mobile
//
// Every call identifies the caller with actorMobile / actorName / actorRole /
// actorSubRole (+ branch, branches) — query string on GET, body on POST/PUT.
// This mirrors how /hms/approval already passes `user` and `subRole`.
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

// ─── reference data ──────────────────────────────────────────────────────────
router.get("/meta", send(getMeta));

// ─── dashboard ───────────────────────────────────────────────────────────────
router.get("/dashboard", send(getDashboard));

// ─── roster (requirement 9) ──────────────────────────────────────────────────
// Declared before /tickets/:id so "users" is never read as a ticket id.
router.get("/users/assignees", send(listAssignees));
router.get("/users", send(listUsers));
router.post("/users", send(addUser));
router.put("/users/:id", send(updateUser));
router.delete("/users/:id", send(deleteUser));

// ─── roster onboarding from the admin panel ──────────────────────────────────
// AddUserForm writes the Firestore login and calls these to write the matching
// ticket_user row — the two together make a usable Head or Department User.
router.post("/roster", send(upsertRosterUser));
router.delete("/roster", send(removeRosterUser));

// ─── tickets ─────────────────────────────────────────────────────────────────
router.get("/tickets", send(listTickets));
router.post("/tickets", send(createTicket));
router.get("/tickets/:id", send(getTicket));

// ─── workflow ────────────────────────────────────────────────────────────────
router.post("/tickets/:id/approve", transition("approve"));
router.post("/tickets/:id/reject", transition("reject"));
router.post("/tickets/:id/route", transition("route"));
router.post("/tickets/:id/assign", transition("assign"));
router.post("/tickets/:id/revert", transition("revert"));
router.post("/tickets/:id/progress", transition("progress"));
router.post("/tickets/:id/fix", transition("fix"));
router.post("/tickets/:id/dept-approve", transition("deptApprove"));
router.post("/tickets/:id/send-back", transition("sendBack"));
router.post("/tickets/:id/close", transition("close"));
router.post("/tickets/:id/reopen", transition("reopen"));
router.post("/tickets/:id/comment", transition("comment"));

module.exports = router;
