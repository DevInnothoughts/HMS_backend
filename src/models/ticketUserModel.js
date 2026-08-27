// ticketUserModel.js
// ─────────────────────────────────────────────────────────────────────────────
// The ticketing roster — `ticket_user`.
//
// Two ways a person gets onto it, and they must stay in step:
//
//   1. THE ADMIN PANEL (upsertRosterUser / removeRosterUser).
//      AddUserForm writes the Firestore login, then calls POST /roster, which
//      writes the matching row here. Both are needed for a usable account —
//      Firestore alone leaves a Department Head resolving to department = null
//      with an empty queue forever.
//
//   2. A DEPARTMENT HEAD, in-app (listUsers / addUser / updateUser /
//      deleteUser). A head builds their own team without waiting on an admin.
//      This is the "My Team" screen, restored.
//
// WHY THE SPLIT MATTERS
// ─────────────────────
// A head may only touch their OWN department, and may only create Department
// Users — never another Head. Promoting someone to Head is an org decision, not
// a team-management one, and a head who could mint heads could hand away the
// department. The admin panel keeps that power; see assertHeadScope.
//
// The roster is ALSO read by recruitmentModel.js for the MRF assign-to picker,
// so nothing here may narrow the table's meaning to ticketing alone.
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

// Statuses that mean "this person is mid-job". Used to refuse deleting someone
// who still holds live work. Kept as a literal list rather than imported from
// the model's DEPT_ACTIVE because the meaning is different: this is about a
// PERSON being busy, not about a ticket being actionable.
const LIVE_FOR_ASSIGNEE = [
  "Assigned",
  "In Progress",
  "Waiting for Vendor",
  "Pending Approval",
];

const inClause = (arr) => arr.map(() => "?").join(", ");

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

// ─── GUARDS ──────────────────────────────────────────────────────────────────
/**
 * The actor must be a Department Head acting inside their own department (or a
 * SuperAdmin, who is not bound to one). Returns the department to operate on.
 *
 * `department` is taken from the ACTOR, never from the request body, for
 * everyone except a SuperAdmin. A head who could name the department in the
 * body could add themselves a user in Finance — and the whole point of holding
 * the department in this table rather than in Firestore is that it cannot be
 * edited by whoever is calling.
 */
function assertHeadScope(actor, requestedDepartment) {
  if (actor.role === ROLES.SUPER_ADMIN) {
    const dept = str(requestedDepartment) || actor.department;
    if (!dept) throw badRequest("Which department?");
    return dept;
  }
  if (actor.role !== ROLES.DEPT_HEAD) {
    throw forbidden("Only a Department Head can manage the team.");
  }
  if (!actor.department) {
    throw forbidden(
      "Your login is not attached to a department yet. Ask your administrator.",
    );
  }
  return actor.department;
}

// ─── READ ────────────────────────────────────────────────────────────────────
/**
 * The head's team — everyone in their department, with a live workload count.
 *
 * `open_tickets` is the number that makes this screen worth opening: a head
 * about to assign wants to know who is already buried. Counted with a
 * correlated subquery rather than a JOIN + GROUP BY so people with zero tickets
 * still appear — the person with nothing on is exactly who you are looking for.
 */
async function listUsers(req) {
  const src = { ...req.query, ...(req.body || {}) };
  const actor = await loadActor(src);
  const department = assertHeadScope(actor, src.department);

  const rows = await run(
    `SELECT u.*,
            (SELECT COUNT(*)
               FROM ticket t
              WHERE t.assignee_mobile = u.mobile
                AND t.is_deleted = 0
                AND t.status IN (${inClause(LIVE_FOR_ASSIGNEE)})) AS open_tickets
       FROM ticket_user u
      WHERE u.department = ? AND u.is_deleted = 0
      ORDER BY u.ticket_role ASC, u.name ASC`,
    [...LIVE_FOR_ASSIGNEE, department],
  );

  return { department, users: rows.map(mapUser) };
}

/**
 * Just the people a ticket can be handed to — the picker in the assign sheet.
 *
 * Includes the head themselves. A head who works a ticket personally rather
 * than passing it on should not have to invent a fake user to do it, and the
 * activity trail is more honest for saying they took it.
 */
async function listAssignees(req) {
  const src = { ...req.query, ...(req.body || {}) };
  const actor = await loadActor(src);
  const department = assertHeadScope(actor, src.department);

  const rows = await run(
    `SELECT mobile, name, email, ticket_role
       FROM ticket_user
      WHERE department = ? AND is_active = 1 AND is_deleted = 0
      ORDER BY ticket_role ASC, name ASC`,
    [department],
  );

  return {
    department,
    assignees: rows.map((r) => ({
      mobile: r.mobile,
      name: r.name,
      email: r.email,
      ticketRole: r.ticket_role,
    })),
  };
}

// ─── WRITE (in-app, by a Department Head) ────────────────────────────────────
/**
 * Add someone to the head's own department.
 *
 * DEPARTMENT USERS ONLY. A head cannot create another Head — see the file
 * header. SuperAdmin can, through the admin panel's upsertRosterUser.
 *
 * NOTE ON THE FIRESTORE HALF
 * ──────────────────────────
 * This writes the roster row. It does NOT create the Firestore login, because
 * the server never touches Firestore. The app's DeptUsers screen writes the
 * Firestore user doc and then calls this — the same dual write AddUserForm
 * does. A roster row without a login is a person who cannot sign in; a login
 * without a roster row is a person with no department. Both halves or neither.
 */
async function addUser(req) {
  const body = req.body || {};
  const actor = await loadActor(body);
  const department = assertHeadScope(actor, body.department);

  const mobile = str(body.mobile);
  const name = str(body.name);
  const email = str(body.email);

  if (!MOBILE_RE.test(mobile))
    throw badRequest("Enter a 10-digit mobile number.");
  if (!name) throw badRequest("Enter the person's name.");
  if (email && !EMAIL_RE.test(email))
    throw badRequest("That email is not valid.");

  // A head adds users, full stop. Anything else is rejected loudly rather than
  // quietly downgraded — silently turning a requested Head into a User would
  // leave the caller believing something that is not true.
  const ticketRole = str(body.ticketRole) || "Department User";
  if (ticketRole !== "Department User" && actor.role !== ROLES.SUPER_ADMIN) {
    throw forbidden(
      "You can add Department Users. Making someone a Department Head is done " +
        "from the admin user screen.",
    );
  }
  if (!TICKET_ROLES.includes(ticketRole)) {
    throw badRequest("ticketRole must be Department Head or Department User.");
  }

  // Already on the roster somewhere?
  const existing = await run(
    `SELECT ticket_user_id, name, department, ticket_role, is_deleted
       FROM ticket_user WHERE mobile = ? LIMIT 1`,
    [mobile],
  );

  if (existing.length) {
    const e = existing[0];
    // In ANOTHER department and live: refuse. Moving someone between
    // departments reassigns their queue and is not a thing one head should be
    // able to do to another head's team behind their back.
    if (!e.is_deleted && e.department !== department) {
      throw badRequest(
        `${e.name} is already in ${e.department}. An administrator can move them.`,
      );
    }
    // Same department, or previously removed: revive in place. This is what
    // makes re-adding someone who left and came back work rather than error.
    await run(
      `UPDATE ticket_user
          SET name = ?, email = ?, ticket_role = ?, department = ?,
              is_active = 1, is_deleted = 0
        WHERE ticket_user_id = ?`,
      [name, email || null, ticketRole, department, e.ticket_user_id],
    );
    return {
      success: true,
      ticketUserId: e.ticket_user_id,
      updated: true,
      message: `${name} is back on the ${department} team.`,
    };
  }

  const res = await run(
    `INSERT INTO ticket_user
       (mobile, name, email, ticket_role, department, created_by_mobile)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [mobile, name, email || null, ticketRole, department, actor.mobile],
  );

  return {
    success: true,
    ticketUserId: res.insertId,
    message: `${name} added to ${department}.`,
  };
}

/**
 * Edit a team member's name, email, or active flag.
 *
 * Deliberately cannot change `department` or `ticket_role`: both are the org
 * decisions this screen does not own. Sending them is ignored rather than
 * refused, because the app never offers the fields.
 */
async function updateUser(req) {
  const body = req.body || {};
  const actor = await loadActor(body);
  const department = assertHeadScope(actor, body.department);

  const mobile = str(req.params.mobile || body.mobile);
  if (!MOBILE_RE.test(mobile)) throw badRequest("A valid mobile is required.");

  const rows = await run(
    `SELECT ticket_user_id, name, department FROM ticket_user
      WHERE mobile = ? AND is_deleted = 0 LIMIT 1`,
    [mobile],
  );
  if (!rows.length) throw notFound("That person is not on the roster.");
  if (rows[0].department !== department && actor.role !== ROLES.SUPER_ADMIN) {
    throw forbidden(`${rows[0].name} is not in your department.`);
  }

  const name = str(body.name) || rows[0].name;
  const email = str(body.email);
  if (email && !EMAIL_RE.test(email))
    throw badRequest("That email is not valid.");

  // Absent means "leave it alone", not "set false" — a PATCH-shaped update sent
  // without the flag must not silently deactivate someone.
  const isActive = body.isActive === undefined ? null : body.isActive ? 1 : 0;

  const sets = ["name = ?", "email = ?"];
  const params = [name, email || null];
  if (isActive !== null) {
    sets.push("is_active = ?");
    params.push(isActive);
  }
  params.push(rows[0].ticket_user_id);

  await run(
    `UPDATE ticket_user SET ${sets.join(", ")} WHERE ticket_user_id = ?`,
    params,
  );
  return { success: true, message: `${name} updated.` };
}

/**
 * Remove someone from the team. Soft delete, so the activity trail keeps their
 * name on tickets they worked.
 *
 * Refuses while they still hold live tickets. Deleting them would leave those
 * tickets assigned to a person who can no longer sign in — invisible work,
 * which is the failure mode this whole feature exists to prevent. The head has
 * to reassign first, which is the correct order anyway.
 */
async function deleteUser(req) {
  const src = { ...req.query, ...(req.body || {}) };
  const actor = await loadActor(src);
  const department = assertHeadScope(actor, src.department);

  const mobile = str(req.params.mobile || src.mobile);
  if (!MOBILE_RE.test(mobile)) throw badRequest("A valid mobile is required.");

  const rows = await run(
    `SELECT ticket_user_id, name, department, ticket_role FROM ticket_user
      WHERE mobile = ? AND is_deleted = 0 LIMIT 1`,
    [mobile],
  );
  if (!rows.length) throw notFound("That person is not on the roster.");
  if (rows[0].department !== department && actor.role !== ROLES.SUPER_ADMIN) {
    throw forbidden(`${rows[0].name} is not in your department.`);
  }
  // A head removing themselves would leave the department with no head and a
  // queue nobody can see.
  if (mobile === actor.mobile) {
    throw badRequest("You cannot remove yourself from your own department.");
  }

  const live = await run(
    `SELECT COUNT(*) AS n FROM ticket
      WHERE assignee_mobile = ? AND is_deleted = 0
        AND status IN (${inClause(LIVE_FOR_ASSIGNEE)})`,
    [mobile, ...LIVE_FOR_ASSIGNEE],
  );
  if (Number(live[0] && live[0].n) > 0) {
    throw badRequest(
      `${rows[0].name} still has ${live[0].n} ticket(s) in hand. ` +
        `Reassign those first, then remove them.`,
    );
  }

  await run(
    `UPDATE ticket_user SET is_deleted = 1, is_active = 0 WHERE ticket_user_id = ?`,
    [rows[0].ticket_user_id],
  );
  return {
    success: true,
    message: `${rows[0].name} removed from ${department}.`,
  };
}

// ─── ADMIN ONBOARDING ────────────────────────────────────────────────────────
/**
 * Upsert a roster row from the admin user-creation panel (AddUserForm).
 *
 * The department a Department Head or Department User belongs to lives in
 * `ticket_user`, not Firestore — the server reads it from here on every request
 * so nobody can move themselves between departments by editing a request body.
 *
 * AddUserForm creates the Firestore login, but Firestore alone leaves the
 * person with no roster row, so a Head resolves to department = null with an
 * empty queue, and a User can never be assigned anything.
 *
 * TRUST
 * ─────
 * This is the admin user-management screen — its operator assigns every role in
 * the system, so it is treated as SuperAdmin-equivalent here (it can create
 * Heads, which an in-app head cannot). Guarded the same way the rest of
 * /hms/ticketing is: see docs/DECISIONS.md, "Security — the actor is
 * client-supplied". When that is tightened app-wide, this rides along.
 *
 * Idempotent: called again for the same mobile it updates in place and revives
 * a soft-deleted row, so re-saving a user in the admin panel never errors.
 */
async function upsertRosterUser(req) {
  const body = req.body || {};

  const mobile = str(body.mobile);
  const name = str(body.name);
  const email = str(body.email);
  const department = str(body.department);
  const ticketRole = str(body.ticketRole);

  if (!MOBILE_RE.test(mobile)) {
    throw badRequest("Enter a 10-digit mobile number.");
  }
  if (!name) throw badRequest("Enter the user's name.");
  if (!TICKET_ROLES.includes(ticketRole)) {
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

  // One department, one head. A second head for a department that already has
  // an active one is almost always a mistake (wrong department picked), and two
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
  if (!MOBILE_RE.test(mobile)) throw badRequest("A valid mobile is required.");

  const rows = await run(
    `SELECT ticket_user_id, name, department, ticket_role FROM ticket_user
      WHERE mobile = ? AND is_deleted = 0 LIMIT 1`,
    [mobile],
  );
  if (!rows.length) {
    return { success: true, message: "No roster row to remove.", noop: true };
  }

  // Refuse to strip someone mid-ticket, same guard as the in-app delete.
  const live = await run(
    `SELECT COUNT(*) AS n FROM ticket
      WHERE assignee_mobile = ? AND is_deleted = 0
        AND status IN (${inClause(LIVE_FOR_ASSIGNEE)})`,
    [mobile, ...LIVE_FOR_ASSIGNEE],
  );
  if (Number(live[0] && live[0].n) > 0) {
    throw badRequest(
      `${rows[0].name} still has ${live[0].n} ticket(s) in progress. Reassign those first.`,
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
  listUsers,
  listAssignees,
  addUser,
  updateUser,
  deleteUser,
  upsertRosterUser,
  removeRosterUser,
};
