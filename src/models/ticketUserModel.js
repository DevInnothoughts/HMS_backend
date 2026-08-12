// ticketUserModel.js
// ─────────────────────────────────────────────────────────────────────────────
// The ticketing roster — `ticket_user`.
//
// PDF §2 removed in-app user management: a department is one head, tickets are
// assigned off-system, and there is no team to build. What remains is
// ONBOARDING, driven from the admin panel:
//
//   AddUserForm writes the Firestore login, then calls POST /roster, which
//   writes the matching ticket_user row. Both are needed for a usable account —
//   Firestore alone leaves a Department Head resolving to department = null,
//   with an empty queue forever.
//
// The roster is also read by recruitmentModel.js for the MRF assign-to picker.
// Recruitment DOES still assign work to Department Users; only ticketing
// stopped. That is why this table and these two functions survive.
// ─────────────────────────────────────────────────────────────────────────────

const {
  ROLES,
  loadActor,
  run,
  badRequest,
  forbidden,
  notFound,
  str,
} = require("./ticketingModel");

const TICKET_ROLES = ["Department Head", "Department User"];

// Indian mobile numbers, matching the 10-digit field the login screen uses.
const MOBILE_RE = /^[0-9]{10}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function mapUser(r) {
  return {
    ticketUserId: r.ticket_user_id,
    mobile: r.mobile,
    name: r.name,
    email: r.email,
    ticketRole: r.ticket_role,
    department: r.department,
    isActive: !!r.is_active,
    openTickets: Number(r.open_tickets) || 0,
    createdAt: r.created_at,
  };
}

// ─── ADMIN ONBOARDING ────────────────────────────────────────────────────────
/**
 * Upsert a roster row from the admin user-creation panel (AddUserForm).
 *
 * WHY THIS EXISTS
 * ───────────────
 * The department a Department Head or Department User belongs to lives in
 * `ticket_user`, not Firestore — the server reads it from here on every request
 * so nobody can move themselves between departments by editing a request body.
 *
 * AddUserForm creates the Firestore login (it already writes that collection),
 * but Firestore alone leaves the person with no roster row, so:
 *   • a Department Head would resolve to department = null and their queue would
 *     be empty forever;
 *   • a Department User could never be assigned a ticket.
 *
 * So when the admin panel creates a user whose subRole is Department Head or
 * Department User, it also calls this, which writes the matching roster row.
 * The two writes are what make a usable ticketing user — same dual-write the
 * in-app "My Team" screen (DeptUsers.js) already does, just driven from the
 * admin panel instead of from a head.
 *
 * TRUST
 * ─────
 * This is the admin user-management screen — its operator is the person who
 * assigns every role in the system, so it is treated as SuperAdmin-equivalent
 * here (it can create Heads, which an in-app head cannot). It is guarded the
 * same way the rest of /hms/ticketing is: see docs/DECISIONS.md, "Security —
 * the actor is client-supplied". When that is tightened app-wide, this rides
 * along with it.
 *
 * Idempotent: called again for the same mobile, it updates in place and revives
 * a soft-deleted row, so re-saving a user in the admin panel never errors.
 */
async function upsertRosterUser(req) {
  const body = req.body || {};

  const mobile = str(body.mobile);
  const name = str(body.name);
  const email = str(body.email);
  const department = str(body.department);
  const ticketRole = str(body.ticketRole);

  if (!/^[0-9]{10}$/.test(mobile)) {
    throw badRequest("Enter a 10-digit mobile number.");
  }
  if (!name) throw badRequest("Enter the user's name.");
  if (ticketRole !== "Department Head" && ticketRole !== "Department User") {
    throw badRequest("ticketRole must be Department Head or Department User.");
  }
  if (!department) {
    throw badRequest("Pick the department this person belongs to.");
  }

  const known = await run(
    `SELECT name FROM ticket_department WHERE name = ? AND is_active = 1`,
    [department],
  );
  if (!known.length) {
    throw badRequest(`"${department}" is not a department.`);
  }

  // One department, one head. A second head for a department that already has an
  // active one is almost always a mistake (wrong department picked), and two
  // heads make "who signs off fixes" ambiguous. Updating the SAME mobile is
  // fine; a DIFFERENT mobile as a second head is refused.
  if (ticketRole === "Department Head") {
    const existingHead = await run(
      `SELECT mobile, name FROM ticket_user
        WHERE department = ? AND ticket_role = 'Department Head'
          AND is_deleted = 0 AND mobile <> ?
        LIMIT 1`,
      [department, mobile],
    );
    if (existingHead.length) {
      throw badRequest(
        `${department} already has a head (${existingHead[0].name}). ` +
          `Remove them first, or add this person as a Department User.`,
      );
    }
  }

  const existing = await run(
    `SELECT ticket_user_id FROM ticket_user WHERE mobile = ? LIMIT 1`,
    [mobile],
  );

  if (existing.length) {
    await run(
      `UPDATE ticket_user
          SET name = ?, email = ?, ticket_role = ?, department = ?,
              is_active = 1, is_deleted = 0
        WHERE ticket_user_id = ?`,
      [name, email || null, ticketRole, department, existing[0].ticket_user_id],
    );
    return {
      success: true,
      ticketUserId: existing[0].ticket_user_id,
      updated: true,
      message: `${name} set as ${ticketRole} for ${department}.`,
    };
  }

  const res = await run(
    `INSERT INTO ticket_user (mobile, name, email, ticket_role, department, created_by_mobile)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      mobile,
      name,
      email || null,
      ticketRole,
      department,
      str(body.actorMobile) || null,
    ],
  );

  return {
    success: true,
    ticketUserId: res.insertId,
    message: `${name} added as ${ticketRole} for ${department}.`,
  };
}

/**
 * Remove a roster row by mobile — the counterpart for when the admin panel
 * deletes a user or changes their subRole away from a ticketing role. Soft
 * delete, so ticket history keeps the name. No-op if there is no row, so it is
 * always safe to call.
 */
async function removeRosterUser(req) {
  const src = { ...req.query, ...(req.body || {}) };
  const mobile = str(src.mobile);
  if (!/^[0-9]{10}$/.test(mobile))
    throw badRequest("A valid mobile is required.");

  const rows = await run(
    `SELECT ticket_user_id, name, department, ticket_role FROM ticket_user
      WHERE mobile = ? AND is_deleted = 0 LIMIT 1`,
    [mobile],
  );
  if (!rows.length) {
    return { success: true, message: "No roster row to remove.", noop: true };
  }

  // Refuse to strip someone mid-ticket, same guard as the in-app delete.
  const [live] = await run(
    `SELECT COUNT(*) AS n FROM ticket
      WHERE assignee_mobile = ? AND is_deleted = 0
        AND status IN ('Assigned', 'In Progress', 'Waiting for Vendor', 'Pending Approval')`,
    [mobile],
  );
  if (Number(live?.n) > 0) {
    throw badRequest(
      `${rows[0].name} still has ${live.n} ticket(s) in progress. Reassign those first.`,
    );
  }

  await run(
    `UPDATE ticket_user SET is_deleted = 1, is_active = 0 WHERE ticket_user_id = ?`,
    [rows[0].ticket_user_id],
  );
  return {
    success: true,
    message: `${rows[0].name} removed from ${rows[0].department}.`,
  };
}

module.exports = {
  upsertRosterUser,
  removeRosterUser,
};
