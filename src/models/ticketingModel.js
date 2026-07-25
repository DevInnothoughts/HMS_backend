// ticketingModel.js
// ─────────────────────────────────────────────────────────────────────────────
// HHC ticketing — workflow engine + data access.
//
// Everything lives in the module's own database (serviceTicketing), reached
// through the project's existing factory: getConnectionByLocation("ticketing").
//
// The module is self-contained: no query here joins to anything outside its own
// six ticket_* tables, which is what lets it sit in a separate database at all.
// `branch_name` holds the location string exactly as the app sends it ("Baner",
// "DP Road") rather than a foreign key into hhc_appointments — so the two
// databases never have to be joined.
//
// If the database is ever renamed, there is one line to change: the pool in
// databaseUtils.js. This file only knows the key, not the name.
//
// THE WORKFLOW (requirements 6, 7, 8)
// ───────────────────────────────────
//   Partner raises ─────────────────────────────► Open
//   Cluster Head approves ──────────────────────► Approved      (or Rejected)
//   Dept Head assigns to a Dept User ───────────► Assigned
//     └─ or reverts: wrong department ──────────► Reverted → CH re-routes → Approved
//   Dept User works ────────────────────────────► In Progress / Waiting for Vendor
//   Dept User marks fixed ──────────────────────► Pending Approval
//   Dept Head signs the fix off ────────────────► Resolved      (or sends back → Assigned)
//   Raiser closes ──────────────────────────────► Closed        (or reopens → Reopened)
//
//   Requirement 7 — branches with no Partner: the Cluster Head raises, and the
//   ticket is created directly in `Approved`. The approval step exists so a
//   Cluster Head vets what a Partner reports; when the Cluster Head IS the
//   reporter that step is already satisfied. Everything downstream is identical.
//
// TWO DELIBERATE CHOICES
// ──────────────────────
//   1. The server decides which actions a user may take (`actionsFor`) and
//      returns them on every ticket. The app renders buttons from that list
//      rather than re-deriving the rules, so the two can never disagree.
//   2. A caller's department is read from `ticket_user` by mobile — never from
//      what the request claims. Someone editing a request body cannot move
//      themselves into another department's queue.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../databaseUtils");
const fs = require("fs");
const path = require("path");
const { sendMail } = require("../services/mailer");
const { resolveNotification } = require("../services/ticketNotifications");

// Key for the ticketing database in the shared connection factory.
// databaseUtils.js maps this to createPool("serviceTicketing"). Same convention
// as "lead" → hhc_appointments: a non-location key for a non-location database.
const TICKETING_DB_KEY = "ticketing";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  // Hours from raise to SLA breach. A ticket is "overdue" past this while still
  // actionable. Tune here — due_at is stamped at raise time from these numbers.
  SLA_HOURS: { Critical: 8, High: 24, Medium: 72, Low: 168 },

  TICKET_REF_PREFIX: "HHC-",
  TICKET_REF_BASE: 1000, // HHC-1001, HHC-1002, … (matches the approved mockups)

  // What a Partner sees.
  //   "branch" → everything raised at their branch(es), by anyone. A partner is
  //              accountable for their branch, not just their own paperwork, so
  //              a ticket their branch admin raised is still their problem.
  //   "own"    → only tickets they personally raised. This is what the original
  //              mockup specified; kept as a switch in case you want it back.
  PARTNER_SEES: "branch",

  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 200,

  // The Cluster Head dashboard's "Target: 90% tickets closed within SLA" line.
  // Sent to the app rather than hardcoded there, so the promise and the bar it
  // is measured against can never disagree.
  SLA_TARGET_PCT: 90,

  // ── Attachment storage (wedoc.in Linode server) ──────────────────────────
  // Uploaded files are written to disk on the server and only their public URL
  // is stored in ticket_attachment.storage_path — NOT the bytes. This keeps the
  // database small and backups light.
  //
  // Set these two to match your server. They are the ONLY things that are
  // environment-specific; everything else is derived.
  //
  //   ATTACHMENT_DIR      absolute path to a folder the web server serves and
  //                       the Node process can write to. Create it once:
  //                         mkdir -p /var/www/wedoc.in/uploads/ticketing
  //                         chown <node-user>:<web-group> /var/www/wedoc.in/uploads/ticketing
  //                         chmod 775 /var/www/wedoc.in/uploads/ticketing
  //
  //   ATTACHMENT_BASE_URL the public URL that maps to ATTACHMENT_DIR. A file
  //                       written to ATTACHMENT_DIR/<name> must be reachable at
  //                       ATTACHMENT_BASE_URL/<name> in a browser.
  //
  // Override per-environment with env vars rather than editing code.
  ATTACHMENT_DIR:
    process.env.TICKETING_ATTACHMENT_DIR ||
    "/var/www/wedoc.in/uploads/ticketing",
  ATTACHMENT_BASE_URL:
    process.env.TICKETING_ATTACHMENT_BASE_URL ||
    "https://wedoc.in/uploads/ticketing",

  // Reject anything larger than this after decoding (bytes). The app already
  // caps images ~4MB; this is the server-side backstop.
  ATTACHMENT_MAX_BYTES: 8 * 1024 * 1024,
};

// ─── ROLES ───────────────────────────────────────────────────────────────────
// Same trap as recruitment: a POSIX attachment directory on a Windows host
// means files save to the developer's C: drive while their URLs point at the
// Linux server, so every attachment 404s with nothing obviously wrong.
if (process.platform === "win32" && CONFIG.ATTACHMENT_DIR.startsWith("/")) {
  console.warn(
    `\n  recruitment/ticketing: running on Windows with a Linux attachment directory ` +
      `(${CONFIG.ATTACHMENT_DIR}). Files will be written to this machine, not the web ` +
      `server, so their URLs will 404.\n`,
  );
}

const ROLES = {
  PARTNER: "Partner",
  CLUSTER_HEAD: "ClusterHead",
  DEPT_HEAD: "DepartmentHead",
  DEPT_USER: "DepartmentUser",
  SUPER_ADMIN: "SuperAdmin",
  VIEWER: "Viewer",
};

// ─── STATUSES ────────────────────────────────────────────────────────────────
const STATUS = {
  OPEN: "Open",
  REJECTED: "Rejected",
  APPROVED: "Approved",
  REVERTED: "Reverted",
  ASSIGNED: "Assigned",
  IN_PROGRESS: "In Progress",
  WAITING_VENDOR: "Waiting for Vendor",
  PENDING_APPROVAL: "Pending Approval",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  REOPENED: "Reopened",
};

// ─── The five statuses anyone outside the engine ever sees ───────────────────
//
// The workflow needs finer states than this: "Open" (awaiting the cluster head),
// "Approved" (awaiting the department head) and "Assigned" (awaiting the
// department user) look identical to a reader but decide completely different
// permissions. Collapsing them in the database would leave the server unable to
// say whose turn it is.
//
// So the detailed states stay as the engine, and these five are the vocabulary
// for display and filtering. Every ticket maps to exactly one.
const DISPLAY_STATUS = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  OVERDUE: "Overdue",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};
const DISPLAY_STATUSES = Object.values(DISPLAY_STATUS);

// Which underlying states feed each bucket. Overdue is not in here because it
// is derived from the due date, not stored, and takes precedence over both
// "Open" and "In progress" — a late ticket's most useful fact is that it's late.
const DISPLAY_GROUPS = {
  [DISPLAY_STATUS.OPEN]: [
    "Open",
    "Approved",
    "Assigned",
    "Reverted",
    "Reopened",
  ],
  [DISPLAY_STATUS.IN_PROGRESS]: [
    "In Progress",
    "Waiting for Vendor",
    "Pending Approval",
  ],
  [DISPLAY_STATUS.RESOLVED]: ["Resolved"],
  [DISPLAY_STATUS.CLOSED]: ["Closed", "Rejected"],
};

/**
 * The one status a person sees for a ticket.
 *
 * Order matters: finished states win over lateness (a resolved ticket delivered
 * late is resolved, not overdue), and lateness wins over whatever stage the work
 * had reached.
 */
function displayStatusOf(status, overdue) {
  if (DISPLAY_GROUPS[DISPLAY_STATUS.CLOSED].includes(status))
    return DISPLAY_STATUS.CLOSED;
  if (DISPLAY_GROUPS[DISPLAY_STATUS.RESOLVED].includes(status))
    return DISPLAY_STATUS.RESOLVED;
  if (overdue) return DISPLAY_STATUS.OVERDUE;
  if (DISPLAY_GROUPS[DISPLAY_STATUS.IN_PROGRESS].includes(status)) {
    return DISPLAY_STATUS.IN_PROGRESS;
  }
  return DISPLAY_STATUS.OPEN;
}

const ALL_STATUSES = Object.values(STATUS);
const PRIORITIES = ["Critical", "High", "Medium", "Low"];

// Terminal-ish buckets. `Rejected` is deliberately in neither: it never became
// work, so counting it as "open" would nag people forever and counting it as
// "closed" would flatter the closure rate. It is excluded from the denominator.
const DONE_STATES = [STATUS.CLOSED, STATUS.RESOLVED];
const NOT_OPEN_STATES = [STATUS.CLOSED, STATUS.RESOLVED, STATUS.REJECTED];

// Statuses a Department Head may see in their queue: anything past CH approval.
const DEPT_VISIBLE_STATES = ALL_STATUSES.filter(
  (s) => s !== STATUS.OPEN && s !== STATUS.REJECTED,
);

// ─── STATE MACHINE ───────────────────────────────────────────────────────────
// One row per action. `from` is the set of statuses the action is legal in,
// `roles` who may fire it, `raiserOrBranchPartner` restricts it to whoever
// raised the ticket or a Partner accountable for that branch, `assigneeOnly` to
// the person it currently sits with.
const TRANSITIONS = {
  approve: {
    from: [STATUS.OPEN],
    to: STATUS.APPROVED,
    roles: [ROLES.CLUSTER_HEAD, ROLES.SUPER_ADMIN],
    label: "Approve",
  },
  reject: {
    from: [STATUS.OPEN],
    to: STATUS.REJECTED,
    roles: [ROLES.CLUSTER_HEAD, ROLES.SUPER_ADMIN],
    label: "Reject",
    remarkRequired: true,
  },
  // Requirement 8 — Dept Head bounced it back as wrong department, Cluster Head
  // sends it to the right one.
  route: {
    from: [STATUS.REVERTED],
    to: STATUS.APPROVED,
    roles: [ROLES.CLUSTER_HEAD, ROLES.SUPER_ADMIN],
    label: "Re-route",
  },
  assign: {
    from: [STATUS.APPROVED, STATUS.REOPENED],
    to: STATUS.ASSIGNED,
    roles: [ROLES.DEPT_HEAD],
    label: "Assign",
  },
  revert: {
    from: [STATUS.APPROVED],
    to: STATUS.REVERTED,
    roles: [ROLES.DEPT_HEAD],
    label: "Wrong department",
    remarkRequired: true,
  },
  progress: {
    from: [STATUS.ASSIGNED, STATUS.IN_PROGRESS, STATUS.WAITING_VENDOR],
    to: null, // caller picks: In Progress | Waiting for Vendor
    toOneOf: [STATUS.IN_PROGRESS, STATUS.WAITING_VENDOR],
    roles: [ROLES.DEPT_USER, ROLES.DEPT_HEAD],
    label: "Update progress",
    assigneeOnly: true,
  },
  fix: {
    from: [STATUS.ASSIGNED, STATUS.IN_PROGRESS, STATUS.WAITING_VENDOR],
    to: STATUS.PENDING_APPROVAL,
    roles: [ROLES.DEPT_USER, ROLES.DEPT_HEAD],
    label: "Mark fixed",
    assigneeOnly: true,
  },
  deptApprove: {
    from: [STATUS.PENDING_APPROVAL],
    to: STATUS.RESOLVED,
    roles: [ROLES.DEPT_HEAD],
    label: "Approve fix",
  },
  sendBack: {
    from: [STATUS.PENDING_APPROVAL],
    to: STATUS.ASSIGNED,
    roles: [ROLES.DEPT_HEAD],
    label: "Send back",
    remarkRequired: true,
  },
  close: {
    from: [STATUS.RESOLVED, STATUS.REJECTED],
    to: STATUS.CLOSED,
    roles: [ROLES.PARTNER, ROLES.CLUSTER_HEAD],
    raiserOrBranchPartner: true,
    label: "Close ticket",
  },
  reopen: {
    from: [STATUS.RESOLVED],
    to: STATUS.REOPENED,
    roles: [ROLES.PARTNER, ROLES.CLUSTER_HEAD],
    raiserOrBranchPartner: true,
    label: "Reopen",
    remarkRequired: true,
  },
  comment: {
    from: ALL_STATUSES,
    to: null, // status unchanged
    roles: "*",
    label: "Comment",
    remarkRequired: true,
  },
};

// Which activity row an action writes.
const ACTION_LOG = {
  approve: "APPROVED",
  reject: "REJECTED",
  route: "ROUTED",
  assign: "ASSIGNED",
  revert: "REVERTED",
  progress: "PROGRESS",
  fix: "FIXED",
  deptApprove: "DEPT_APPROVED",
  sendBack: "SENT_BACK",
  close: "CLOSED",
  reopen: "REOPENED",
  comment: "COMMENT",
};

// ─── ERRORS ──────────────────────────────────────────────────────────────────
const httpError = (status, message) => {
  const e = new Error(message);
  e.status = status;
  return e;
};
const badRequest = (m) => httpError(400, m);
const forbidden = (m) => httpError(403, m);
const notFound = (m) => httpError(404, m);

// ─── DB PLUMBING ─────────────────────────────────────────────────────────────
const makeRunner =
  (connection) =>
  (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) =>
        err ? reject(err) : resolve(rows),
      ),
    );

function ticketingPool() {
  const { connection } = getConnectionByLocation(TICKETING_DB_KEY);
  if (!connection) {
    // Almost always means databaseUtils.js has no `case "ticketing"` yet.
    throw httpError(
      503,
      "Ticketing is unavailable: the serviceTicketing database is not reachable.",
    );
  }
  return connection;
}

const run = (sql, params) => makeRunner(ticketingPool())(sql, params);

/**
 * Run `fn(query)` inside a transaction. Rolls back on any throw.
 * Used wherever a ticket row and its activity row must land together.
 */
function withTransaction(fn) {
  const pool = ticketingPool();
  return new Promise((resolve, reject) => {
    pool.getConnection((err, tempCon) => {
      if (err) return reject(err);

      const q = (sql, params = []) =>
        new Promise((res, rej) =>
          tempCon.query(sql, params, (e, r) => (e ? rej(e) : res(r))),
        );

      tempCon.beginTransaction(async (txErr) => {
        if (txErr) {
          tempCon.release();
          return reject(txErr);
        }
        try {
          const out = await fn(q);
          tempCon.commit((cErr) => {
            if (cErr) {
              return tempCon.rollback(() => {
                tempCon.release();
                reject(cErr);
              });
            }
            tempCon.release();
            resolve(out);
          });
        } catch (e) {
          tempCon.rollback(() => {
            tempCon.release();
            reject(e);
          });
        }
      });
    });
  });
}

// ─── SMALL HELPERS ───────────────────────────────────────────────────────────
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());

const placeholders = (arr) => arr.map(() => "?").join(", ");

function parseList(v) {
  if (Array.isArray(v)) return v.map((s) => str(s)).filter(Boolean);
  if (typeof v === "string")
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

function slaDueDate(priority, from = new Date()) {
  const hours = CONFIG.SLA_HOURS[priority] ?? CONFIG.SLA_HOURS.Medium;
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

// A short, safe file extension for a mime type — used to name the saved file.
const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
};

/**
 * Save an attachment to the server's disk and return its public URL.
 *
 * The app sends the file as a base64 data URL (`data:image/png;base64,…`). We
 * decode it, write the bytes to CONFIG.ATTACHMENT_DIR under a unique name, and
 * return CONFIG.ATTACHMENT_BASE_URL + "/" + name — that URL is what goes in
 * ticket_attachment.storage_path. The bytes never touch the database.
 *
 * Returns { storagePath, fileName } on success. Returns null if there's nothing
 * to store or the write fails — the caller then falls back to keeping the base64
 * in data_url, so a storage misconfiguration degrades instead of losing the file.
 *
 * @param {{dataUrl?:string, fileName?:string, mimeType?:string}} attachment
 * @param {number|string} ticketId  used to namespace the filename
 */
function saveAttachmentToDisk(attachment, ticketId) {
  try {
    const dataUrl = attachment && attachment.dataUrl;
    if (!dataUrl || typeof dataUrl !== "string") return null;

    // Split "data:<mime>;base64,<payload>".
    const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
    if (!match) return null;
    const mimeFromUrl = match[1];
    const base64 = match[2];

    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length) return null;
    if (buffer.length > CONFIG.ATTACHMENT_MAX_BYTES) {
      throw badRequest("Attachment is too large.");
    }

    // Pick an extension from the mime type, falling back to the original file's.
    const mime =
      str(attachment.mimeType) || mimeFromUrl || "application/octet-stream";
    const extFromName = path
      .extname(str(attachment.fileName))
      .replace(".", "")
      .toLowerCase();
    const ext = MIME_EXT[mime] || extFromName || "bin";

    // Unique, non-guessable, filesystem-safe name: ticket id + time + random.
    const unique = `${ticketId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fileName = `ticket-${unique}.${ext}`;

    // Ensure the folder exists, then write the bytes.
    fs.mkdirSync(CONFIG.ATTACHMENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(CONFIG.ATTACHMENT_DIR, fileName), buffer);

    const base = CONFIG.ATTACHMENT_BASE_URL.replace(/\/+$/, "");
    return { storagePath: `${base}/${fileName}`, fileName };
  } catch (e) {
    // A bad-request (too large) should surface; anything else (disk, perms) is
    // logged and we fall back to the data_url path so the file isn't lost.
    if (e && e.status === 400) throw e;
    console.error(
      "ticketing: could not save attachment to disk:",
      e && e.message,
    );
    return null;
  }
}

// MySQL DATETIME in the server's local time, matching how the rest of the
// codebase writes dates.
function toSqlDateTime(d) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// ─── ACTOR ───────────────────────────────────────────────────────────────────
/**
 * Work out who is calling, and what they're allowed to be.
 *
 * The roster (`ticket_user`) wins: if this mobile is a Department Head or
 * Department User, that is what they are and their department comes from the
 * table — not from the request. Partners / Cluster Heads / SuperAdmin aren't on
 * the roster, so those come from the app's own role + subRole (the same trust
 * model the existing /hms/approval endpoint uses).
 *
 * Accepts either query params (GET) or a body (POST).
 */
async function loadActor(source = {}) {
  const mobile = str(source.actorMobile || source.mobile);
  if (!mobile) throw badRequest("actorMobile is required.");

  const claimedName = str(source.actorName || source.name);
  const appRole = str(source.actorRole || source.role);
  const appSubRole = str(source.actorSubRole || source.subRole);

  const branch = str(source.branch || source.location);
  const branches = parseList(source.branches || source.locationArray);
  if (branch && !branches.includes(branch)) branches.push(branch);

  const rows = await run(
    `SELECT name, ticket_role, department, is_active
       FROM ticket_user
      WHERE mobile = ? AND is_deleted = 0
      LIMIT 1`,
    [mobile],
  );

  if (rows.length) {
    const r = rows[0];
    if (!r.is_active) {
      throw forbidden("This ticketing login has been deactivated.");
    }
    return {
      mobile,
      name: r.name || claimedName || mobile,
      role:
        r.ticket_role === "Department Head" ? ROLES.DEPT_HEAD : ROLES.DEPT_USER,
      department: r.department,
      branch,
      branches,
    };
  }

  // Not on the roster — fall back to the app's role/subRole.
  let role = ROLES.VIEWER;
  if (appRole === "SuperAdmin") role = ROLES.SUPER_ADMIN;
  else if (appSubRole === "Owner" || appSubRole === "Partner")
    role = ROLES.PARTNER;
  else if (appSubRole === "Cluster Head") role = ROLES.CLUSTER_HEAD;
  else if (appSubRole === "Department Head" || appSubRole === "Department User")
    throw forbidden(
      "You are not on the ticketing roster yet. Ask your Department Head to add you.",
    );

  return {
    mobile,
    name: claimedName || mobile,
    role,
    department: null,
    branch,
    branches,
  };
}

// ─── VISIBILITY ──────────────────────────────────────────────────────────────
/**
 * The WHERE fragment that limits a list to what this actor may see.
 *   SuperAdmin     → everything
 *   Partner        → everything raised at their branch (see CONFIG.PARTNER_SEES)
 *   Cluster Head   → every ticket from the branches in their cluster
 *   Dept Head      → their department's queue, once past Cluster Head approval
 *   Dept User      → only what is assigned to them
 */
function visibilityScope(actor) {
  switch (actor.role) {
    case ROLES.SUPER_ADMIN:
      return { sql: "1 = 1", params: [] };

    case ROLES.PARTNER:
      // Branch-wide, plus anything they raised themselves — so a partner who
      // moves branches doesn't lose sight of tickets they filed at the old one.
      // Falls back to own-only if we have no branch context, which is the safe
      // direction to fail: too little rather than someone else's data.
      if (CONFIG.PARTNER_SEES === "branch" && actor.branches.length) {
        return {
          sql: `(t.branch_name IN (${placeholders(actor.branches)}) OR t.raised_by_mobile = ?)`,
          params: [...actor.branches, actor.mobile],
        };
      }
      return { sql: "t.raised_by_mobile = ?", params: [actor.mobile] };

    case ROLES.CLUSTER_HEAD:
      if (!actor.branches.length) {
        return { sql: "t.raised_by_mobile = ?", params: [actor.mobile] };
      }
      return {
        sql: `(t.branch_name IN (${placeholders(actor.branches)}) OR t.raised_by_mobile = ?)`,
        params: [...actor.branches, actor.mobile],
      };

    case ROLES.DEPT_HEAD:
      if (!actor.department) return { sql: "1 = 0", params: [] };
      return {
        sql: `(t.department = ? AND t.status IN (${placeholders(DEPT_VISIBLE_STATES)}))`,
        params: [actor.department, ...DEPT_VISIBLE_STATES],
      };

    case ROLES.DEPT_USER:
      return { sql: "t.assignee_mobile = ?", params: [actor.mobile] };

    default:
      return { sql: "1 = 0", params: [] };
  }
}

// ─── PERMISSIONS ─────────────────────────────────────────────────────────────
/**
 * Can `actor` fire `action` on `ticket`? Returns null when allowed, otherwise a
 * sentence explaining why not — which becomes the API's 403 body, so the
 * message is written for the person reading it.
 */
function denyReason(action, ticket, actor) {
  const t = TRANSITIONS[action];
  if (!t) return `Unknown action "${action}".`;

  if (t.roles !== "*" && !t.roles.includes(actor.role)) {
    return `A ${actor.role} cannot ${t.label.toLowerCase()} a ticket.`;
  }
  if (Array.isArray(t.from) && !t.from.includes(ticket.status)) {
    return `This ticket is ${ticket.status} — ${t.label.toLowerCase()} does not apply.`;
  }

  // ── Scope guards first ───────────────────────────────────────────────────
  // "This isn't your branch" is a more useful thing to be told than "you're not
  // allowed", so the specific reason has to be reached before the general one.

  // A partner acts on their own branch only. This used to be implied by
  // raiser-only closing; now that a partner can act on tickets they didn't
  // raise, it has to be said out loud.
  if (
    actor.role === ROLES.PARTNER &&
    actor.branches.length &&
    !actor.branches.includes(ticket.branch_name) &&
    ticket.raised_by_mobile !== actor.mobile
  ) {
    return `${ticket.branch_name} is not your branch.`;
  }
  if (
    actor.role === ROLES.CLUSTER_HEAD &&
    actor.branches.length &&
    !actor.branches.includes(ticket.branch_name) &&
    ticket.raised_by_mobile !== actor.mobile
  ) {
    return `${ticket.branch_name} is not in your cluster.`;
  }
  if (
    (actor.role === ROLES.DEPT_HEAD || actor.role === ROLES.DEPT_USER) &&
    actor.department &&
    ticket.department !== actor.department
  ) {
    return `This ticket sits with ${ticket.department}, not ${actor.department}.`;
  }
  if (
    t.assigneeOnly &&
    actor.role === ROLES.DEPT_USER &&
    ticket.assignee_mobile !== actor.mobile
  ) {
    return "This ticket is assigned to someone else.";
  }

  // ── Then ownership ───────────────────────────────────────────────────────
  // Requirement 6 ends "branch partner will close the ticket" — the branch's
  // partner, not necessarily the individual who typed it in. So the raiser can
  // always close, and so can a Partner accountable for that branch. For a
  // partner-less branch (requirement 7) there is no branch partner, and the
  // Cluster Head who raised it closes it as the raiser.
  if (t.raiserOrBranchPartner) {
    const isRaiser = ticket.raised_by_mobile === actor.mobile;
    const isBranchPartner =
      actor.role === ROLES.PARTNER &&
      CONFIG.PARTNER_SEES === "branch" &&
      actor.branches.includes(ticket.branch_name);
    if (!isRaiser && !isBranchPartner) {
      return "Only the partner for this branch, or whoever raised it, can do that.";
    }
  }

  return null;
}

/** Every action this actor may currently fire — the app renders buttons from this. */
function actionsFor(ticket, actor) {
  return Object.keys(TRANSITIONS).filter(
    (a) => a !== "comment" && !denyReason(a, ticket, actor),
  );
}

// ─── ROW MAPPING ─────────────────────────────────────────────────────────────
// Keys deliberately mirror the ticket objects in the approved mockup
// (id / center / department / priority / issueType / description / status /
//  owner / age / overdue / raisedBy) so the screens read the same shape.
function mapTicket(r, actor) {
  const base = {
    ticketId: r.ticket_id,
    id: r.ticket_ref,
    center: r.branch_name,
    branch: r.branch_name,
    department: r.department,
    issueType: r.issue_type,
    priority: r.priority,
    description: r.description,
    // The detailed workflow state. The app shows `displayStatus` instead — see
    // DISPLAY_STATUS — but this stays available for the timeline and debugging.
    status: r.status,
    owner: r.assignee_name || r.owner_label || `${r.department} Team`,
    age: Number(r.age_days) || 0,
    overdue: !!Number(r.is_overdue),
    // The one of five words a person actually sees.
    displayStatus: displayStatusOf(r.status, !!Number(r.is_overdue)),
    raisedBy: r.raised_by_name,
    raisedByMobile: r.raised_by_mobile,
    raisedByRole: r.raised_by_role,
    raisedAt: r.raised_at,
    dueAt: r.due_at,
    assigneeMobile: r.assignee_mobile,
    assigneeName: r.assignee_name,
    approvedByName: r.approved_by_name,
    approvedAt: r.approved_at,
    fixedAt: r.fixed_at,
    deptApprovedByName: r.dept_approved_by_name,
    deptApprovedAt: r.dept_approved_at,
    closedByName: r.closed_by_name,
    closedAt: r.closed_at,
    reopenCount: r.reopen_count,
    revertCount: r.revert_count,
  };
  if (actor) {
    base.actions = actionsFor(
      {
        status: r.status,
        raised_by_mobile: r.raised_by_mobile,
        assignee_mobile: r.assignee_mobile,
        department: r.department,
        branch_name: r.branch_name,
      },
      actor,
    );
  }
  return base;
}

const TICKET_SELECT = `
  SELECT t.*,
         d.owner_label,
         TIMESTAMPDIFF(DAY, t.raised_at, NOW()) AS age_days,
         (t.status NOT IN ('Closed', 'Rejected') AND t.due_at < NOW()) AS is_overdue
    FROM ticket t
    LEFT JOIN ticket_department d ON d.name = t.department
`;

// ─── META ────────────────────────────────────────────────────────────────────
/** Departments, their issue types, and the enum values the forms need. */
async function getMeta() {
  const [departments, issueTypes] = await Promise.all([
    run(
      `SELECT name, owner_label FROM ticket_department
        WHERE is_active = 1 ORDER BY sort_order, name`,
    ),
    run(
      `SELECT department, name FROM ticket_issue_type
        WHERE is_active = 1 ORDER BY department, sort_order, name`,
    ),
  ]);

  // { "Maintenance": ["AC not working", …] } — same shape as issueMap in the mockup.
  const issueMap = {};
  for (const d of departments) issueMap[d.name] = [];
  for (const it of issueTypes) {
    if (!issueMap[it.department]) issueMap[it.department] = [];
    issueMap[it.department].push(it.name);
  }

  return {
    departments: departments.map((d) => d.name),
    departmentOwners: Object.fromEntries(
      departments.map((d) => [d.name, d.owner_label]),
    ),
    issueMap,
    priorities: PRIORITIES,
    // The five a person may filter by. ALL_STATUSES stays internal to the
    // engine — see DISPLAY_STATUS for why they are not the same list.
    statuses: DISPLAY_STATUSES,
  };
}

// ─── LIST ────────────────────────────────────────────────────────────────────
/**
 * Role-scoped ticket list.
 * Filters: status, priority, department, branch, q (free text), overdue, mine.
 * `status=Open` means "not finished", matching the dashboard tile — not the
 * literal Open enum. Pass `statusExact` for the enum value.
 */
async function listTickets(req) {
  const src = { ...req.query, ...(req.body || {}) };
  const actor = await loadActor(src);
  const scope = visibilityScope(actor);

  const where = [`t.is_deleted = 0`, scope.sql];
  const params = [...scope.params];

  const status = str(src.status);
  const statusExact = str(src.statusExact);
  const priority = str(src.priority);
  const department = str(src.department);
  // The branch FILTER must come only from an explicit filter field — never from
  // the actor's own branch/location. Those share the request object, and for a
  // Department Head the actor's `location` is their DEPARTMENT ("Operations"),
  // not a clinic. Reading `src.branch` here filtered branch_name = "Operations",
  // which matches nothing — so the dashboard counted 3 while the list showed 0.
  // `filterBranch` is sent only when the user picks a branch in the FilterBar.
  const branch = str(src.filterBranch);
  const q = str(src.q);

  if (statusExact && ALL_STATUSES.includes(statusExact)) {
    where.push("t.status = ?");
    params.push(statusExact);
  } else if (status && status !== "All") {
    // Filtering speaks the five-word vocabulary the app shows, translated here
    // into the underlying states. The buckets are mutually exclusive and match
    // displayStatusOf() exactly — a ticket the list calls "In progress" must
    // never read "Overdue" on its own card.
    const LATE =
      "t.status NOT IN ('Closed','Rejected','Resolved') AND t.due_at < NOW()";
    const NOT_LATE = `NOT (${LATE})`;
    const G = DISPLAY_GROUPS;

    if (status === DISPLAY_STATUS.OVERDUE) {
      where.push(LATE);
    } else if (status === DISPLAY_STATUS.CLOSED) {
      where.push(`t.status IN (${placeholders(G[DISPLAY_STATUS.CLOSED])})`);
      params.push(...G[DISPLAY_STATUS.CLOSED]);
    } else if (status === DISPLAY_STATUS.RESOLVED) {
      where.push(`t.status IN (${placeholders(G[DISPLAY_STATUS.RESOLVED])})`);
      params.push(...G[DISPLAY_STATUS.RESOLVED]);
    } else if (status === DISPLAY_STATUS.IN_PROGRESS) {
      where.push(
        `t.status IN (${placeholders(G[DISPLAY_STATUS.IN_PROGRESS])}) AND ${NOT_LATE}`,
      );
      params.push(...G[DISPLAY_STATUS.IN_PROGRESS]);
    } else if (status === DISPLAY_STATUS.OPEN) {
      where.push(
        `t.status IN (${placeholders(G[DISPLAY_STATUS.OPEN])}) AND ${NOT_LATE}`,
      );
      params.push(...G[DISPLAY_STATUS.OPEN]);
    } else if (ALL_STATUSES.includes(status)) {
      // Still honoured, so dashboard tiles that name a precise workflow state
      // (e.g. "Pending Approval" for a head's sign-off queue) keep working.
      where.push("t.status = ?");
      params.push(status);
    }
  }

  if (priority && PRIORITIES.includes(priority)) {
    where.push("t.priority = ?");
    params.push(priority);
  }
  if (department) {
    where.push("t.department = ?");
    params.push(department);
  }
  if (branch) {
    where.push("t.branch_name = ?");
    params.push(branch);
  }
  if (String(src.overdue) === "true") {
    where.push(`t.status NOT IN ('Closed', 'Rejected') AND t.due_at < NOW()`);
  }
  if (String(src.mine) === "true") {
    where.push("t.raised_by_mobile = ?");
    params.push(actor.mobile);
  }
  if (q) {
    where.push(
      `(t.ticket_ref LIKE ? OR t.issue_type LIKE ? OR t.description LIKE ? OR t.branch_name LIKE ?)`,
    );
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  const limit = Math.min(
    Math.max(parseInt(src.limit, 10) || CONFIG.DEFAULT_PAGE_SIZE, 1),
    CONFIG.MAX_PAGE_SIZE,
  );
  const offset = Math.max(parseInt(src.offset, 10) || 0, 0);

  const sql = `${TICKET_SELECT}
    WHERE ${where.join(" AND ")}
    ORDER BY
      FIELD(t.priority, 'Critical', 'High', 'Medium', 'Low'),
      t.raised_at DESC
    LIMIT ? OFFSET ?`;

  const rows = await run(sql, [...params, limit, offset]);

  const countRows = await run(
    `SELECT COUNT(*) AS total FROM ticket t WHERE ${where.join(" AND ")}`,
    params,
  );

  return {
    role: actor.role,
    department: actor.department,
    total: countRows[0]?.total ?? 0,
    limit,
    offset,
    tickets: rows.map((r) => mapTicket(r, actor)),
  };
}

// ─── DETAIL ──────────────────────────────────────────────────────────────────
async function getTicket(req) {
  const src = { ...req.query, ...(req.body || {}) };
  const actor = await loadActor(src);
  const key = str(req.params.id || src.ticketId);
  if (!key) throw badRequest("Ticket id is required.");

  const rows = await run(
    `${TICKET_SELECT} WHERE t.is_deleted = 0 AND (t.ticket_id = ? OR t.ticket_ref = ?) LIMIT 1`,
    [Number(key) || 0, key],
  );
  if (!rows.length) throw notFound("Ticket not found.");

  const t = rows[0];
  const scope = visibilityScope(actor);
  const visible = await run(
    `SELECT 1 FROM ticket t WHERE t.ticket_id = ? AND ${scope.sql} LIMIT 1`,
    [t.ticket_id, ...scope.params],
  );
  if (!visible.length && actor.role !== ROLES.SUPER_ADMIN) {
    throw forbidden("You do not have access to this ticket.");
  }

  const [activity, attachments] = await Promise.all([
    run(
      `SELECT action, from_status, to_status, actor_name, actor_role, remark, created_at
         FROM ticket_activity WHERE ticket_id = ? ORDER BY activity_id ASC`,
      [t.ticket_id],
    ),
    run(
      // data_url is included here (detail view, one ticket) so the app can show
      // the image. It is deliberately NOT in the list query — a base64 image on
      // every row would bloat list responses.
      `SELECT attachment_id, file_name, mime_type, file_size, storage_path, data_url, created_at
         FROM ticket_attachment WHERE ticket_id = ? ORDER BY attachment_id ASC`,
      [t.ticket_id],
    ),
  ]);

  return {
    ...mapTicket(t, actor),
    activity: activity.map((a) => ({
      action: a.action,
      fromStatus: a.from_status,
      toStatus: a.to_status,
      actorName: a.actor_name,
      actorRole: a.actor_role,
      remark: a.remark,
      at: a.created_at,
    })),
    // Normalize to camelCase and hand the app a ready-to-render `src`: the
    // Prefer the on-disk URL (storage_path) now that files live on the server;
    // fall back to a legacy base64 data_url for any rows saved before that. The
    // app renders whichever `src` it gets.
    attachments: attachments.map((a) => ({
      id: a.attachment_id,
      fileName: a.file_name,
      mimeType: a.mime_type,
      fileSize: a.file_size,
      storagePath: a.storage_path,
      src: a.storage_path || a.data_url || null,
      isImage: !!(a.mime_type && a.mime_type.startsWith("image/")),
      at: a.created_at,
    })),
  };
}

// ─── NOTIFICATIONS ───────────────────────────────────────────────────────────
/**
 * Email whoever the ticket now sits with, for the action that just happened.
 *
 * Fire-and-forget by design: this is called AFTER the transaction commits, is
 * never awaited by the request, and never throws. A ticket action must not be
 * delayed or failed by SMTP. `ticketId` is re-read fresh so the email reflects
 * the committed row (ref, status, assignee, emails).
 */
function notifyForTicket(ticketId, action) {
  // Detach from the request: resolve recipient, then send, swallowing everything.
  (async () => {
    try {
      const rows = await run(
        `SELECT * FROM ticket WHERE ticket_id = ? LIMIT 1`,
        [ticketId],
      );
      if (!rows.length) return;
      const note = await resolveNotification(rows[0], action, run);
      if (!note) return; // nobody to notify, or no valid address
      await sendMail(note); // mailer never throws; log-only until SMTP is set
    } catch (e) {
      console.error(
        "ticketing: notification failed (ticket action already saved):",
        e && e.message,
      );
    }
  })();
}

// ─── CREATE ──────────────────────────────────────────────────────────────────
/**
 * Raise a ticket. Partners and Cluster Heads only.
 * A Cluster Head's own ticket lands in `Approved` — see requirement 7 above.
 */
async function createTicket(req) {
  const body = req.body || {};
  const actor = await loadActor(body);

  // Who may raise: a Partner (for their branch), a Cluster Head (for a branch
  // in their cluster, requirement 7), or a SuperAdmin (for any branch — they
  // oversee everything). A Department Head/User cannot raise; they receive and
  // work tickets.
  if (
    actor.role !== ROLES.PARTNER &&
    actor.role !== ROLES.CLUSTER_HEAD &&
    actor.role !== ROLES.SUPER_ADMIN
  ) {
    throw forbidden(
      "Only a Partner, Cluster Head, or SuperAdmin can raise a ticket.",
    );
  }

  const branch = str(body.center || body.branch || body.location);
  const department = str(body.department);
  const issueType = str(body.issueType);
  const priority = str(body.priority) || "Medium";
  const description = str(body.description);

  if (!branch) throw badRequest("Select the center this issue belongs to.");
  if (!department) throw badRequest("Select a department.");
  if (!issueType) throw badRequest("Select an issue type.");
  if (!PRIORITIES.includes(priority))
    throw badRequest(`Priority must be one of: ${PRIORITIES.join(", ")}.`);
  if (!description) throw badRequest("Describe the issue before submitting.");

  const known = await run(
    `SELECT name FROM ticket_department WHERE name = ? AND is_active = 1`,
    [department],
  );
  if (!known.length) throw badRequest(`"${department}" is not a department.`);

  // A Cluster Head may only raise for a branch in their own cluster.
  if (
    actor.role === ROLES.CLUSTER_HEAD &&
    actor.branches.length &&
    !actor.branches.includes(branch)
  ) {
    throw forbidden(`${branch} is not in your cluster.`);
  }

  const now = new Date();
  const raisedAt = toSqlDateTime(now);
  const dueAt = toSqlDateTime(slaDueDate(priority, now));
  // A ticket raised by its own approver skips the approval step — there is no
  // one above them to vet it. That's a Cluster Head (requirement 7) and a
  // SuperAdmin. A Partner's ticket still starts at Open, awaiting approval.
  const selfApproved =
    actor.role === ROLES.CLUSTER_HEAD || actor.role === ROLES.SUPER_ADMIN;
  const status = selfApproved ? STATUS.APPROVED : STATUS.OPEN;

  const attachment = body.attachment || null;

  return withTransaction(async (q) => {
    const res = await q(
      `INSERT INTO ticket
         (branch_name, department, issue_type, priority, description, status,
          raised_by_mobile, raised_by_name, raised_by_role, raised_at,
          raised_by_email, cluster_head_email,
          approved_by_mobile, approved_by_name, approved_at, due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        branch,
        department,
        issueType,
        priority,
        description,
        status,
        actor.mobile,
        actor.name,
        actor.role === ROLES.PARTNER ? "Partner" : "ClusterHead",
        raisedAt,
        // Emails for the non-roster people, passed by the app. The raiser is
        // whoever raises now; cluster_head_email is who approves this branch
        // (meaningful only when a Partner raises — a CH raising self-approves).
        str(body.raisedByEmail) || null,
        str(body.clusterHeadEmail) || null,
        selfApproved ? actor.mobile : null,
        selfApproved ? actor.name : null,
        selfApproved ? raisedAt : null,
        dueAt,
      ],
    );

    const ticketId = res.insertId;
    const ref = `${CONFIG.TICKET_REF_PREFIX}${CONFIG.TICKET_REF_BASE + ticketId}`;
    await q(`UPDATE ticket SET ticket_ref = ? WHERE ticket_id = ?`, [
      ref,
      ticketId,
    ]);

    await q(
      `INSERT INTO ticket_activity
         (ticket_id, action, from_status, to_status, actor_mobile, actor_name, actor_role, remark, created_at)
       VALUES (?, 'RAISED', NULL, ?, ?, ?, ?, ?, ?)`,
      [
        ticketId,
        status,
        actor.mobile,
        actor.name,
        actor.role,
        description.slice(0, 500),
        raisedAt,
      ],
    );

    if (selfApproved) {
      await q(
        `INSERT INTO ticket_activity
           (ticket_id, action, from_status, to_status, actor_mobile, actor_name, actor_role, remark, created_at)
         VALUES (?, 'APPROVED', ?, ?, ?, ?, ?, ?, ?)`,
        [
          ticketId,
          STATUS.OPEN,
          STATUS.APPROVED,
          actor.mobile,
          actor.name,
          actor.role,
          "Auto-approved: raised by the Cluster Head (branch has no Partner).",
          raisedAt,
        ],
      );
    }

    if (attachment && (attachment.dataUrl || attachment.storagePath)) {
      // Write the file to the server's disk and keep only its URL. If the disk
      // write fails (misconfigured folder/permissions), fall back to storing the
      // base64 in data_url so the attachment is never silently lost.
      let storagePath = str(attachment.storagePath) || null;
      let dataUrl = attachment.dataUrl || null;
      if (!storagePath && dataUrl) {
        const saved = saveAttachmentToDisk(attachment, ticketId);
        if (saved) {
          storagePath = saved.storagePath;
          dataUrl = null; // bytes now live on disk, not in the DB
        }
      }

      await q(
        `INSERT INTO ticket_attachment
           (ticket_id, file_name, mime_type, file_size, storage_path, data_url, uploaded_by_mobile, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ticketId,
          str(attachment.fileName) || "photo.jpg",
          str(attachment.mimeType) || null,
          Number(attachment.fileSize) || null,
          storagePath,
          dataUrl,
          actor.mobile,
          raisedAt,
        ],
      );
    }

    return {
      success: true,
      ticketId,
      id: ref,
      status,
      message: selfApproved
        ? `Ticket ${ref} raised and approved. It is with the ${department} head now.`
        : `Ticket ${ref} raised. Your Cluster Head will review it.`,
    };
  }).then((result) => {
    // Notify after commit, off the request path. A self-approved ticket (CH or
    // SuperAdmin raised) skips approval and lands with the Department Head — an
    // "APPROVED" notification; otherwise it waits on the Cluster Head — a
    // "RAISED" notification.
    notifyForTicket(result.ticketId, selfApproved ? "APPROVED" : "RAISED");
    return result;
  });
}

// ─── TRANSITION ──────────────────────────────────────────────────────────────
/**
 * The one door every status change goes through. Loads the ticket, checks the
 * transition is legal for this actor, applies the action's side effects, and
 * writes the activity row — all in one transaction.
 */
async function transitionTicket(req, action) {
  const body = req.body || {};
  const actor = await loadActor(body);
  const key = str(req.params.id || body.ticketId);
  if (!key) throw badRequest("Ticket id is required.");

  const spec = TRANSITIONS[action];
  if (!spec) throw badRequest(`Unknown action "${action}".`);

  const remark = str(body.remark || body.comment);
  if (spec.remarkRequired && !remark) {
    throw badRequest(`Add a short reason to ${spec.label.toLowerCase()}.`);
  }

  return withTransaction(async (q) => {
    const rows = await q(
      `SELECT * FROM ticket
        WHERE is_deleted = 0 AND (ticket_id = ? OR ticket_ref = ?)
        LIMIT 1 FOR UPDATE`,
      [Number(key) || 0, key],
    );
    if (!rows.length) throw notFound("Ticket not found.");
    const ticket = rows[0];

    const deny = denyReason(action, ticket, actor);
    if (deny) throw forbidden(deny);

    const now = new Date();
    const nowSql = toSqlDateTime(now);
    const sets = [];
    const params = [];
    // Set when an approval also corrects the department, so the activity row
    // records the move rather than only "approved".
    //
    // Declared HERE, per transition. Assigning without declaring would create an
    // implicit global that survives between requests — one ticket's department
    // move would then appear in the next ticket's audit trail.
    let deptMoved = "";
    const push = (frag, ...vals) => {
      sets.push(frag);
      params.push(...vals);
    };

    // Work out the destination status.
    let toStatus = spec.to;
    if (action === "progress") {
      toStatus = str(body.toStatus);
      if (!spec.toOneOf.includes(toStatus)) {
        throw badRequest(
          `Progress must be one of: ${spec.toOneOf.join(", ")}.`,
        );
      }
    }

    // ── per-action side effects ──────────────────────────────────────────────
    switch (action) {
      case "approve": {
        // The Cluster Head may correct the department while approving — the last
        // cheap moment to fix a partner's wrong pick, before it reaches a
        // department head who would otherwise have to revert it.
        const dept = str(body.department);
        if (dept && dept !== ticket.department) {
          const ok = await q(
            `SELECT name FROM ticket_department WHERE name = ? AND is_active = 1`,
            [dept],
          );
          if (!ok.length) throw badRequest(`"${dept}" is not a department.`);
          push("department = ?", dept);
          // Record the move. A ticket quietly changing hands with nothing in the
          // trail is the kind of thing nobody can explain a month later.
          deptMoved = `Moved from ${ticket.department} to ${dept}`;
        }
        push("approved_by_mobile = ?", actor.mobile);
        push("approved_by_name = ?", actor.name);
        push("approved_at = ?", nowSql);
        break;
      }

      case "route": {
        // Requirement 8 — send a reverted ticket to the right department.
        const dept = str(body.department);
        if (!dept)
          throw badRequest("Pick the department this should have gone to.");
        const ok = await q(
          `SELECT name FROM ticket_department WHERE name = ? AND is_active = 1`,
          [dept],
        );
        if (!ok.length) throw badRequest(`"${dept}" is not a department.`);
        if (dept === ticket.department) {
          throw badRequest(
            `It was already with ${dept} — pick a different department.`,
          );
        }
        push("department = ?", dept);
        push("approved_by_mobile = ?", actor.mobile);
        push("approved_by_name = ?", actor.name);
        push("approved_at = ?", nowSql);
        // A re-route starts the clock again for the new department.
        push("assignee_mobile = NULL");
        push("assignee_name = NULL");
        break;
      }

      case "assign": {
        const assignee = str(body.assigneeMobile);
        if (!assignee) throw badRequest("Pick someone to assign this to.");
        const who = await q(
          `SELECT name, department, ticket_role FROM ticket_user
            WHERE mobile = ? AND is_deleted = 0 AND is_active = 1 LIMIT 1`,
          [assignee],
        );
        if (!who.length)
          throw badRequest("That user is not on the ticketing roster.");
        if (who[0].department !== ticket.department) {
          throw badRequest(
            `${who[0].name} is in ${who[0].department}, not ${ticket.department}.`,
          );
        }
        push("assignee_mobile = ?", assignee);
        push("assignee_name = ?", who[0].name);
        push("assigned_by_mobile = ?", actor.mobile);
        push("assigned_by_name = ?", actor.name);
        push("assigned_at = ?", nowSql);
        push("fixed_at = NULL");
        break;
      }

      case "revert":
        push("revert_count = revert_count + 1");
        push("assignee_mobile = NULL");
        push("assignee_name = NULL");
        break;

      case "fix":
        push("fixed_at = ?", nowSql);
        break;

      case "deptApprove":
        push("dept_approved_by_mobile = ?", actor.mobile);
        push("dept_approved_by_name = ?", actor.name);
        push("dept_approved_at = ?", nowSql);
        break;

      case "sendBack":
        push("fixed_at = NULL");
        break;

      case "close":
        push("closed_by_mobile = ?", actor.mobile);
        push("closed_by_name = ?", actor.name);
        push("closed_at = ?", nowSql);
        break;

      case "reopen":
        push("reopen_count = reopen_count + 1");
        push("dept_approved_by_mobile = NULL");
        push("dept_approved_by_name = NULL");
        push("dept_approved_at = NULL");
        push("fixed_at = NULL");
        // A reopened ticket gets a fresh SLA clock.
        push("due_at = ?", toSqlDateTime(slaDueDate(ticket.priority, now)));
        break;

      default:
        break;
    }

    if (toStatus) push("status = ?", toStatus);

    if (sets.length) {
      await q(`UPDATE ticket SET ${sets.join(", ")} WHERE ticket_id = ?`, [
        ...params,
        ticket.ticket_id,
      ]);
    }

    await q(
      `INSERT INTO ticket_activity
         (ticket_id, action, from_status, to_status, actor_mobile, actor_name, actor_role, remark, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ticket.ticket_id,
        ACTION_LOG[action] || action.toUpperCase(),
        ticket.status,
        toStatus || ticket.status,
        actor.mobile,
        actor.name,
        actor.role,
        // A department correction is prepended, so the trail reads
        // "Moved from Maintenance to IT / HMS" even when no reason was typed.
        deptMoved
          ? remark
            ? `${deptMoved}. ${remark}`
            : deptMoved
          : remark || null,
        nowSql,
      ],
    );

    return {
      success: true,
      ticketId: ticket.ticket_id,
      id: ticket.ticket_ref,
      fromStatus: ticket.status,
      status: toStatus || ticket.status,
      message: `${ticket.ticket_ref} is now ${toStatus || ticket.status}.`,
    };
  }).then((result) => {
    // Notify whoever the ticket now sits with, after commit and off the request
    // path. The action name here is the same logged in ticket_activity
    // (ACTION_LOG[action]); the notification resolver maps it to a recipient.
    notifyForTicket(
      result.ticketId,
      ACTION_LOG[action] || action.toUpperCase(),
    );
    return result;
  });
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
/**
 * Role-scoped counters for the dashboard.
 *
 * `closurePct` excludes Rejected tickets from the denominator: they were never
 * work, so they should neither drag the number down nor pad it.
 */
async function getDashboard(req) {
  const src = { ...req.query, ...(req.body || {}) };
  const actor = await loadActor(src);
  const scope = visibilityScope(actor);
  const where = `t.is_deleted = 0 AND ${scope.sql}`;

  const [totals] = await run(
    `SELECT
       COUNT(*) AS total,
       SUM(t.status NOT IN (${placeholders(NOT_OPEN_STATES)})) AS openCount,
       SUM(t.status NOT IN (${placeholders(NOT_OPEN_STATES)}) AND t.priority = 'Critical') AS criticalCount,
       SUM(t.status NOT IN ('Closed', 'Rejected') AND t.due_at < NOW()) AS overdueCount,
       SUM(t.status IN (${placeholders(DONE_STATES)})) AS closedCount,
       SUM(t.status = 'Rejected') AS rejectedCount,
       SUM(t.status NOT IN ('Closed', 'Rejected') AND t.raised_at < DATE_SUB(NOW(), INTERVAL 1 MONTH)) AS open1m,
       SUM(t.status NOT IN ('Closed', 'Rejected') AND t.raised_at < DATE_SUB(NOW(), INTERVAL 3 MONTH)) AS open3m,
       SUM(t.status NOT IN ('Closed', 'Rejected') AND t.raised_at < DATE_SUB(NOW(), INTERVAL 6 MONTH)) AS open6m
     FROM ticket t
     WHERE ${where}`,
    // param order follows the placeholders above: openCount, criticalCount,
    // closedCount, then the scope clause.
    [...NOT_OPEN_STATES, ...NOT_OPEN_STATES, ...DONE_STATES, ...scope.params],
  );

  const byStatusRows = await run(
    `SELECT t.status, COUNT(*) AS n FROM ticket t WHERE ${where} GROUP BY t.status`,
    scope.params,
  );
  const byDeptRows = await run(
    `SELECT t.department,
            COUNT(*) AS total,
            SUM(t.status NOT IN (${placeholders(NOT_OPEN_STATES)})) AS openCount,
            SUM(t.status NOT IN ('Closed', 'Rejected') AND t.due_at < NOW()) AS overdueCount
       FROM ticket t WHERE ${where}
      GROUP BY t.department ORDER BY openCount DESC`,
    [...NOT_OPEN_STATES, ...scope.params],
  );
  const byBranchRows = await run(
    `SELECT t.branch_name,
            COUNT(*) AS total,
            SUM(t.status NOT IN (${placeholders(NOT_OPEN_STATES)})) AS openCount,
            SUM(t.status NOT IN ('Closed', 'Rejected') AND t.due_at < NOW()) AS overdueCount
       FROM ticket t WHERE ${where}
      GROUP BY t.branch_name ORDER BY openCount DESC`,
    [...NOT_OPEN_STATES, ...scope.params],
  );

  const num = (v) => Number(v) || 0;
  const total = num(totals?.total);
  const closed = num(totals?.closedCount);
  const rejected = num(totals?.rejectedCount);
  const denominator = total - rejected;
  const closurePct =
    denominator > 0 ? Math.round((closed / denominator) * 100) : 0;

  // ── SLA ──────────────────────────────────────────────────────────────────
  // Two numbers, because they answer different questions.
  //
  // `slaCompliance` is the Cluster Head dashboard's "SLA Performance" bar:
  // the share of tickets that have NOT breached their deadline. A ticket
  // breaches by running past due while still open, OR by finishing after its
  // due date.
  //
  // That second clause matters. The mockup computes (total - overdue) / total,
  // and clears `overdue` when a ticket closes — so closing a ticket six weeks
  // late RAISES the score, and a cluster head could hit 100% by closing every
  // breach. Its own label ("Target: 90% tickets closed within SLA") describes
  // the honest metric; the formula didn't. This counts a late close as the
  // breach it is, so the number can only be moved by being on time.
  //
  // `slaScore` is the narrower one kept for the management view: of the
  // tickets that actually finished, how many beat the clock.
  const [sla] = await run(
    `SELECT
       SUM(t.status IN (${placeholders(DONE_STATES)})) AS finished,
       SUM(t.status IN (${placeholders(DONE_STATES)})
           AND COALESCE(t.dept_approved_at, t.closed_at) <= t.due_at) AS onTime,
       SUM(
         (t.status NOT IN ('Closed', 'Rejected') AND t.due_at < NOW())
         OR (t.status IN (${placeholders(DONE_STATES)})
             AND COALESCE(t.dept_approved_at, t.closed_at) > t.due_at)
       ) AS breached,
       SUM(t.status <> 'Rejected') AS accountable
     FROM ticket t WHERE ${where}`,
    [...DONE_STATES, ...DONE_STATES, ...DONE_STATES, ...scope.params],
  );
  const finished = num(sla?.finished);
  const slaScore =
    finished > 0 ? Math.round((num(sla?.onTime) / finished) * 100) : 100;

  // Rejected tickets never became work, so they are out of the denominator —
  // same reasoning as closurePct.
  const accountable = num(sla?.accountable);
  const breached = num(sla?.breached);
  const slaCompliance =
    accountable > 0
      ? Math.round(((accountable - breached) / accountable) * 100)
      : 100;

  return {
    role: actor.role,
    department: actor.department,
    branches: actor.branches,
    open: num(totals?.openCount),
    critical: num(totals?.criticalCount),
    overdue: num(totals?.overdueCount),
    closedResolved: closed,
    rejected,
    total,
    closurePct,
    slaScore,
    slaCompliance,
    slaBreached: breached,
    slaTarget: CONFIG.SLA_TARGET_PCT,
    aging: {
      month1: num(totals?.open1m),
      month3: num(totals?.open3m),
      month6: num(totals?.open6m),
    },
    byStatus: Object.fromEntries(byStatusRows.map((r) => [r.status, num(r.n)])),
    byDepartment: byDeptRows.map((r) => ({
      department: r.department,
      total: num(r.total),
      open: num(r.openCount),
      overdue: num(r.overdueCount),
    })),
    byBranch: byBranchRows.map((r) => ({
      branch: r.branch_name,
      total: num(r.total),
      open: num(r.openCount),
      overdue: num(r.overdueCount),
    })),
  };
}

module.exports = {
  CONFIG,
  ROLES,
  STATUS,
  ALL_STATUSES,
  DISPLAY_STATUS,
  DISPLAY_STATUSES,
  DISPLAY_GROUPS,
  displayStatusOf,
  PRIORITIES,
  TRANSITIONS,
  loadActor,
  getMeta,
  listTickets,
  getTicket,
  createTicket,
  transitionTicket,
  getDashboard,
  // shared with ticketUserModel.js
  run,
  withTransaction,
  httpError,
  badRequest,
  forbidden,
  notFound,
  str,
  toSqlDateTime,
};
