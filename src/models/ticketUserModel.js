// ticketUserModel.js
// ─────────────────────────────────────────────────────────────────────────────
// Requirement 9 — "Department head has option to add, edit and delete the users
// belongs to his departments."
//
// Scope rules, enforced on every call:
//   • Only a Department Head may manage users, and only inside their OWN
//     department. The department comes from the caller's own `ticket_user` row,
//     never from the request, so "add a user to Finance" from the Maintenance
//     head is rejected regardless of what the body says.
//   • A head cannot create another head, and cannot delete themselves.
//   • Delete is soft (is_deleted = 1). Tickets carry the assignee's name copied
//     at assign time, so history survives a departure intact.
//   • A user holding live work cannot be deleted — reassign first. Deleting the
//     only person who knows what is happening on a ticket is how tickets get lost.
//
// SuperAdmin gets the same powers across every department, and may create heads.
// That is the only way the first head of a department can exist (or seed via
// sql/hhc_ticketing.sql).
//
// Login lives in Firestore, not here. See docs/IMPLEMENTATION.md →
// "Roster & identity" for how the two stay in step.
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

/** Statuses that mean "this person still owes somebody work". */
const LIVE_STATES = [
  "Assigned",
  "In Progress",
  "Waiting for Vendor",
  "Pending Approval",
];

/**
 * Only Department Heads (in their own department) and SuperAdmin get in here.
 * Returns the department the caller is allowed to touch.
 */
function assertCanManage(actor, requestedDepartment) {
  if (actor.role === ROLES.SUPER_ADMIN) {
    const dept = str(requestedDepartment);
    if (!dept) throw badRequest("Which department?");
    return dept;
  }
  if (actor.role !== ROLES.DEPT_HEAD) {
    throw forbidden("Only a Department Head can manage department users.");
  }
  const dept = str(requestedDepartment);
  if (dept && dept !== actor.department) {
    throw forbidden(
      `You manage ${actor.department}. You cannot change ${dept}.`,
    );
  }
  return actor.department;
}

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

// ─── LIST ────────────────────────────────────────────────────────────────────
/**
 * Everyone in the caller's department, each with their live workload — the
 * number the head actually needs when deciding who to assign the next ticket to.
 */
async function listUsers(req) {
  const src = { ...req.query, ...(req.body || {}) };
  const actor = await loadActor(src);
  const department = assertCanManage(actor, src.department || actor.department);

  const rows = await run(
    `SELECT u.*,
            (SELECT COUNT(*) FROM ticket t
              WHERE t.assignee_mobile = u.mobile
                AND t.is_deleted = 0
                AND t.status IN (?, ?, ?, ?)) AS open_tickets
       FROM ticket_user u
      WHERE u.department = ? AND u.is_deleted = 0
      ORDER BY FIELD(u.ticket_role, 'Department Head', 'Department User'), u.name`,
    [...LIVE_STATES, department],
  );

  return {
    department,
    role: actor.role,
    users: rows.map(mapUser),
  };
}

/**
 * The assignee picker on a ticket: active Department Users in a department.
 * Any Department Head or SuperAdmin can read it (a head assigning work needs
 * this list, and the ticket's own department gates the assign call itself).
 */
async function listAssignees(req) {
  const src = { ...req.query, ...(req.body || {}) };
  const actor = await loadActor(src);

  let department;
  if (actor.role === ROLES.DEPT_HEAD) {
    department = actor.department;
  } else if (actor.role === ROLES.SUPER_ADMIN) {
    department = str(src.department);
    if (!department) throw badRequest("Which department?");
  } else {
    throw forbidden("Only a Department Head can assign tickets.");
  }

  const rows = await run(
    `SELECT u.*,
            (SELECT COUNT(*) FROM ticket t
              WHERE t.assignee_mobile = u.mobile
                AND t.is_deleted = 0
                AND t.status IN (?, ?, ?, ?)) AS open_tickets
       FROM ticket_user u
      WHERE u.department = ? AND u.is_deleted = 0 AND u.is_active = 1
        AND u.ticket_role = 'Department User'
      ORDER BY u.name`,
    [...LIVE_STATES, department],
  );

  return { department, users: rows.map(mapUser) };
}

// ─── CREATE ──────────────────────────────────────────────────────────────────
async function addUser(req) {
  const body = req.body || {};
  const actor = await loadActor(body);
  const department = assertCanManage(
    actor,
    body.department || actor.department,
  );

  const mobile = str(body.mobile);
  const name = str(body.name);
  const email = str(body.email);
  const ticketRole = str(body.ticketRole) || "Department User";

  if (!MOBILE_RE.test(mobile)) {
    throw badRequest("Enter a 10-digit mobile number.");
  }
  if (!name) throw badRequest("Enter the user's name.");
  if (email && !EMAIL_RE.test(email))
    throw badRequest("That email looks wrong.");
  if (!TICKET_ROLES.includes(ticketRole)) {
    throw badRequest(`Role must be one of: ${TICKET_ROLES.join(", ")}.`);
  }
  if (ticketRole === "Department Head" && actor.role !== ROLES.SUPER_ADMIN) {
    throw forbidden("Only a SuperAdmin can appoint a Department Head.");
  }

  const existing = await run(
    `SELECT ticket_user_id, department, is_deleted FROM ticket_user WHERE mobile = ? LIMIT 1`,
    [mobile],
  );

  if (existing.length) {
    const e = existing[0];
    if (!e.is_deleted) {
      throw badRequest(
        e.department === department
          ? `${mobile} is already in ${department}.`
          : `${mobile} is already on the roster, in ${e.department}.`,
      );
    }
    // Previously removed — bring them back rather than leaving a dead row.
    await run(
      `UPDATE ticket_user
          SET name = ?, email = ?, ticket_role = ?, department = ?,
              is_active = 1, is_deleted = 0, created_by_mobile = ?
        WHERE ticket_user_id = ?`,
      [
        name,
        email || null,
        ticketRole,
        department,
        actor.mobile,
        e.ticket_user_id,
      ],
    );
    return {
      success: true,
      ticketUserId: e.ticket_user_id,
      restored: true,
      message: `${name} is back in ${department}.`,
    };
  }

  const res = await run(
    `INSERT INTO ticket_user (mobile, name, email, ticket_role, department, created_by_mobile)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [mobile, name, email || null, ticketRole, department, actor.mobile],
  );

  return {
    success: true,
    ticketUserId: res.insertId,
    message: `${name} added to ${department}.`,
  };
}

// ─── UPDATE ──────────────────────────────────────────────────────────────────
async function updateUser(req) {
  const body = req.body || {};
  const actor = await loadActor(body);
  const id = Number(req.params.id || body.ticketUserId);
  if (!id) throw badRequest("Which user?");

  const rows = await run(
    `SELECT * FROM ticket_user WHERE ticket_user_id = ? AND is_deleted = 0 LIMIT 1`,
    [id],
  );
  if (!rows.length) throw notFound("That user is not on the roster.");
  const target = rows[0];

  assertCanManage(actor, target.department);

  const sets = [];
  const params = [];

  if (body.name !== undefined) {
    const name = str(body.name);
    if (!name) throw badRequest("Enter the user's name.");
    sets.push("name = ?");
    params.push(name);
  }
  if (body.email !== undefined) {
    const email = str(body.email);
    if (email && !EMAIL_RE.test(email))
      throw badRequest("That email looks wrong.");
    sets.push("email = ?");
    params.push(email || null);
  }
  if (body.isActive !== undefined) {
    const active = body.isActive === true || String(body.isActive) === "true";
    if (
      !active &&
      target.ticket_role === "Department Head" &&
      actor.role !== ROLES.SUPER_ADMIN
    ) {
      throw forbidden("Only a SuperAdmin can deactivate a Department Head.");
    }
    sets.push("is_active = ?");
    params.push(active ? 1 : 0);
  }
  // Moving someone between departments is a SuperAdmin call: a head cannot push
  // one of their people into a department they don't run.
  if (
    body.department !== undefined &&
    str(body.department) !== target.department
  ) {
    if (actor.role !== ROLES.SUPER_ADMIN) {
      throw forbidden(
        "Only a SuperAdmin can move a user to another department.",
      );
    }
    const dept = str(body.department);
    const ok = await run(
      `SELECT name FROM ticket_department WHERE name = ? AND is_active = 1`,
      [dept],
    );
    if (!ok.length) throw badRequest(`"${dept}" is not a department.`);
    sets.push("department = ?");
    params.push(dept);
  }
  if (
    body.ticketRole !== undefined &&
    str(body.ticketRole) !== target.ticket_role
  ) {
    if (actor.role !== ROLES.SUPER_ADMIN) {
      throw forbidden("Only a SuperAdmin can change a user's role.");
    }
    const tr = str(body.ticketRole);
    if (!TICKET_ROLES.includes(tr)) {
      throw badRequest(`Role must be one of: ${TICKET_ROLES.join(", ")}.`);
    }
    sets.push("ticket_role = ?");
    params.push(tr);
  }

  if (!sets.length) throw badRequest("Nothing to change.");

  await run(
    `UPDATE ticket_user SET ${sets.join(", ")} WHERE ticket_user_id = ?`,
    [...params, id],
  );

  return { success: true, ticketUserId: id, message: "Changes saved." };
}

// ─── DELETE ──────────────────────────────────────────────────────────────────
/**
 * Soft delete. Refuses while the person still holds live tickets — the head
 * reassigns those first. `force=true` is available to SuperAdmin only, and even
 * then the tickets are left assigned to the departed name so nothing silently
 * vanishes from a queue.
 */
async function deleteUser(req) {
  const src = { ...req.query, ...(req.body || {}) };
  const actor = await loadActor(src);
  const id = Number(req.params.id || src.ticketUserId);
  if (!id) throw badRequest("Which user?");

  const rows = await run(
    `SELECT * FROM ticket_user WHERE ticket_user_id = ? AND is_deleted = 0 LIMIT 1`,
    [id],
  );
  if (!rows.length) throw notFound("That user is not on the roster.");
  const target = rows[0];

  assertCanManage(actor, target.department);

  if (target.mobile === actor.mobile) {
    throw badRequest("You cannot remove yourself.");
  }
  if (
    target.ticket_role === "Department Head" &&
    actor.role !== ROLES.SUPER_ADMIN
  ) {
    throw forbidden("Only a SuperAdmin can remove a Department Head.");
  }

  const [live] = await run(
    `SELECT COUNT(*) AS n FROM ticket
      WHERE assignee_mobile = ? AND is_deleted = 0 AND status IN (?, ?, ?, ?)`,
    [target.mobile, ...LIVE_STATES],
  );
  const open = Number(live?.n) || 0;
  const force =
    String(src.force) === "true" && actor.role === ROLES.SUPER_ADMIN;

  if (open > 0 && !force) {
    throw badRequest(
      `${target.name} still has ${open} ticket${open === 1 ? "" : "s"} in progress. ` +
        `Reassign ${open === 1 ? "it" : "them"} first, then remove ${target.name}.`,
    );
  }

  await run(
    `UPDATE ticket_user SET is_deleted = 1, is_active = 0 WHERE ticket_user_id = ?`,
    [id],
  );

  return {
    success: true,
    ticketUserId: id,
    message: `${target.name} removed from ${target.department}.`,
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
    `SELECT ticket_user_id, name, department FROM ticket_user
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
  listUsers,
  listAssignees,
  addUser,
  updateUser,
  deleteUser,
  upsertRosterUser,
  removeRosterUser,
};
