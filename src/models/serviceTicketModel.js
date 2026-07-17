// serviceTicketModel.js
// ─────────────────────────────────────────────────────────────────────────────
// Service Ticketing — all business logic lives here.
//
// Storage : the master DB `hhc_appointments`, reached the same way every other
//           cross-branch feature reaches it: getConnectionByLocation("lead").
// Tables  : service_ticket, service_ticket_log, service_ticket_recipient
//           (see db/service_ticketing_schema.sql).
//
// Workflow / state machine
//   Partner   raise      →  RAISED
//   Cluster   approve     RAISED               → CLUSTER_APPROVED
//   Cluster   reject      RAISED               → REJECTED            (terminal)
//   HO User   action      CLUSTER_APPROVED     → HO_ACTION_SUBMITTED
//                         REOPENED             → HO_ACTION_SUBMITTED
//   Partner   close       HO_ACTION_SUBMITTED  → CLOSED              (terminal)
//   Partner   reopen      HO_ACTION_SUBMITTED  → REOPENED
//
// Identity model
//   The app has no server-side auth token (same as the existing /approval
//   feature), so each write carries the acting user's identity in the body
//   (actorName / actorMobile / actorEmail / actorRole). We validate that the
//   supplied role is allowed to perform the requested transition from the
//   ticket's current status. SuperAdmin may perform any transition.
//   NOTE: verifying that identity server-side (signed token → allowed role)
//   is the recommended future hardening; this file deliberately mirrors the
//   trust model already used elsewhere in the codebase.
// ─────────────────────────────────────────────────────────────────────────────

const nodemailer = require("nodemailer");
const { getConnectionByLocation } = require("../../databaseUtils");

const MASTER_DB_KEY = "lead"; // → hhc_appointments

// ─── Reference data ──────────────────────────────────────────────────────────

// The 17 fixed categories. `code` is stored/queried; `label` is shown to users
// and printed in e-mails. This is the single source of truth on the backend;
// the app keeps a matching copy in ServiceTicketConstants.js.
const CATEGORIES = [
  { code: "MEDICAL_EQUIPMENT", label: "Medical Equipment" },
  { code: "IT_INFRASTRUCTURE", label: "IT Infrastructure" },
  { code: "SOFTWARE_DIGITAL", label: "Software & Digital Assets" },
  { code: "ELECTRICAL", label: "Electrical Assets" },
  { code: "FURNITURE_FIXTURES", label: "Furniture & Fixtures" },
  { code: "OT_CLINICAL_FURNITURE", label: "OT & Clinical Furniture" },
  { code: "HOUSEKEEPING", label: "Housekeeping Assets" },
  { code: "PANTRY_CAFETERIA", label: "Pantry & Cafeteria" },
  { code: "LINEN_SOFT_FURNISHING", label: "Linen & Soft Furnishings" },
  { code: "BRANDING_SIGNAGE", label: "Branding & Signages" },
  { code: "SAFETY_FIRE", label: "Safety & Fire" },
  { code: "PHARMACY_ASSETS", label: "Pharmacy Assets" },
  { code: "UTILITY_ASSETS", label: "Utility Assets" },
  { code: "OFFICE_EQUIPMENT", label: "Office Equipment" },
  { code: "INTERIOR_ASSETS", label: "Interior Assets" },
  { code: "BIOMEDICAL_ASSET", label: "Biomedical Asset" },
  { code: "MISCELLANEOUS", label: "Miscellaneous (Others)" },
];
const CATEGORY_BY_CODE = Object.fromEntries(CATEGORIES.map((c) => [c.code, c]));

// Status constants
const S = {
  RAISED: "RAISED",
  CLUSTER_APPROVED: "CLUSTER_APPROVED",
  HO_ACTION_SUBMITTED: "HO_ACTION_SUBMITTED",
  REOPENED: "REOPENED",
  CLOSED: "CLOSED",
  REJECTED: "REJECTED",
};

// Canonical workflow roles
const R = {
  PARTNER: "Partner",
  CLUSTER: "Cluster Head",
  HO: "HO User",
  SUPERADMIN: "SuperAdmin",
};

// SLA hours per priority (snapshotted onto the ticket at creation).
const SLA_HOURS = { Critical: 4, High: 24, Medium: 72, Low: 120 };

// Transition table: action → rules.
//   from     : statuses the action is valid from
//   role     : role allowed to perform it (SuperAdmin always allowed too)
//   to       : resulting status
const ACTIONS = {
  CLUSTER_APPROVED: { from: [S.RAISED], role: R.CLUSTER, to: S.CLUSTER_APPROVED },
  CLUSTER_REJECTED: { from: [S.RAISED], role: R.CLUSTER, to: S.REJECTED },
  HO_ACTION_SUBMITTED: {
    from: [S.CLUSTER_APPROVED, S.REOPENED],
    role: R.HO,
    to: S.HO_ACTION_SUBMITTED,
  },
  CLOSED: { from: [S.HO_ACTION_SUBMITTED], role: R.PARTNER, to: S.CLOSED },
  REOPENED: { from: [S.HO_ACTION_SUBMITTED], role: R.PARTNER, to: S.REOPENED },
};

// ─── Small helpers ───────────────────────────────────────────────────────────

const makeRunner =
  (connection) =>
  (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) =>
        err ? reject(err) : resolve(rows),
      ),
    );

function getLead() {
  const { connection } = getConnectionByLocation(MASTER_DB_KEY);
  if (!connection) {
    const err = new Error(`No DB connection for "${MASTER_DB_KEY}"`);
    err.status = 500;
    throw err;
  }
  return connection;
}

const httpErr = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};

// MySQL DATETIME string in IST (server timezone-independent).
function nowDbString(d = new Date()) {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 19).replace("T", " ");
}

// due = now + hours, as a MySQL DATETIME string (IST).
function dueString(hours, from = new Date()) {
  return nowDbString(new Date(from.getTime() + hours * 3600 * 1000));
}

// Normalise whatever the app sends (role + subRole) into a canonical role.
//   SuperAdmin (role) stays SuperAdmin.
//   subRole "Owner" / "Partner"      → Partner   (this app stores partners as "Owner")
//   subRole "Cluster Head"           → Cluster Head
//   subRole "HO User"/"Head Office"  → HO User
function normaliseRole(role, subRole) {
  if (role === R.SUPERADMIN) return R.SUPERADMIN;
  const sr = String(subRole || role || "").trim().toLowerCase();
  if (sr === "owner" || sr === "partner") return R.PARTNER;
  if (sr === "cluster head") return R.CLUSTER;
  if (sr === "ho user" || sr === "head office" || sr === "ho") return R.HO;
  return String(subRole || role || "").trim(); // unknown → pass through
}

// Pull the acting user out of a request body in a tolerant way.
function readActor(body = {}) {
  const role = normaliseRole(body.actorRole, body.actorSubRole);
  return {
    role,
    name: body.actorName || null,
    mobile: body.actorMobile || null,
    email: body.actorEmail || null,
  };
}

// SLA state for a still-open ticket.
function slaState(status, stageDueAt) {
  if (status === S.CLOSED || status === S.REJECTED || !stageDueAt) return "NA";
  const due = new Date(String(stageDueAt).replace(" ", "T")).getTime();
  const now = Date.now();
  if (Number.isNaN(due)) return "NA";
  if (now > due) return "Breached";
  if (due - now <= 6 * 3600 * 1000) return "DueSoon";
  return "OnTrack";
}

// ─── E-mail ──────────────────────────────────────────────────────────────────
// Reuses the same Gmail sender the rest of the app uses
// (info@healinghandsclinic.co.in). Set MAIL_USER / MAIL_PASS in the environment;
// if MAIL_PASS is absent we log a warning and skip sending so the ticket flow is
// never blocked by mail problems.
const MAIL_USER = process.env.MAIL_USER || "info@healinghandsclinic.co.in";
const MAIL_PASS = process.env.MAIL_PASS || "";

let _transporter = null;
function transporter() {
  if (!MAIL_PASS) return null;
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: MAIL_USER, pass: MAIL_PASS },
    });
  }
  return _transporter;
}

// active recipient e-mails for a (branch, role); includes branch_name='ALL' rows.
async function recipientsFor(run, branchName, role) {
  const rows = await run(
    `SELECT email FROM service_ticket_recipient
      WHERE role = ? AND is_active = 1
        AND (branch_name = ? OR branch_name = 'ALL')`,
    [role, branchName],
  );
  return rows.map((r) => r.email).filter(Boolean);
}

// De-dupe + drop empties, case-insensitively.
function uniqEmails(list) {
  const seen = new Set();
  const out = [];
  for (const e of list) {
    if (!e) continue;
    const k = String(e).trim().toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(String(e).trim());
    }
  }
  return out;
}

function actionVerb(action) {
  return (
    {
      RAISED: "raised",
      CLUSTER_APPROVED: "approved by the Cluster Head",
      CLUSTER_REJECTED: "rejected by the Cluster Head",
      HO_ACTION_SUBMITTED: "actioned by the Head Office",
      REOPENED: "reopened by the Partner",
      CLOSED: "verified and closed by the Partner",
    }[action] || action
  );
}

// What the *next* actor must do, given the new status.
function nextInstruction(status) {
  switch (status) {
    case S.RAISED:
      return "Awaiting Cluster Head verification & approval.";
    case S.CLUSTER_APPROVED:
      return "Awaiting Head Office action.";
    case S.REOPENED:
      return "Sent back to Head Office — awaiting a fresh action.";
    case S.HO_ACTION_SUBMITTED:
      return "Awaiting the raising Partner to verify the action and close the ticket.";
    case S.CLOSED:
      return "Ticket is closed. No further action required.";
    case S.REJECTED:
      return "Ticket was rejected. No further action required.";
    default:
      return "";
  }
}

function ticketEmailHtml(t, action, remark) {
  const cat = t.category_label || t.category_code;
  const rows = [
    ["Ticket", t.ticket_no],
    ["Branch", t.branch_name],
    ["Category", cat],
    ["Priority", t.priority],
    ["Subject", t.title],
    ["Current status", t.status],
    ["Raised by", t.raised_by_name || t.raised_by_mobile || "—"],
  ];
  const tableRows = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#6B6A68">${k}</td>` +
        `<td style="padding:4px 0;color:#18181A"><b>${v ?? "—"}</b></td></tr>`,
    )
    .join("");
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px">
    <h2 style="color:#3B6D11;margin:0 0 4px">Service Ticket ${actionVerb(action)}</h2>
    <p style="color:#6B6A68;margin:0 0 16px">${nextInstruction(t.status)}</p>
    <table style="border-collapse:collapse;font-size:14px">${tableRows}</table>
    ${
      remark
        ? `<p style="margin:16px 0 0;font-size:14px"><b>Remark:</b> ${remark}</p>`
        : ""
    }
    ${
      t.description
        ? `<p style="margin:12px 0 0;font-size:14px"><b>Description:</b> ${t.description}</p>`
        : ""
    }
    <p style="margin:20px 0 0;color:#A09F9C;font-size:12px">
      Healing Hands Clinic — Service Ticketing (automated notification)
    </p>
  </div>`;
}

// Fire-and-(mostly)-forget. Never throws into the request path.
async function sendTicketMail(ticket, action, remark, to, cc) {
  const tx = transporter();
  const toList = uniqEmails(to);
  const ccList = uniqEmails(cc).filter(
    (e) => !toList.map((x) => x.toLowerCase()).includes(e.toLowerCase()),
  );
  if (!tx || toList.length === 0) {
    if (!tx) console.warn("[serviceTicket] MAIL_PASS not set — e-mail skipped.");
    else console.warn(`[serviceTicket] no recipients for ${ticket.ticket_no}.`);
    return;
  }
  try {
    await tx.sendMail({
      from: MAIL_USER,
      to: toList,
      cc: ccList.length ? ccList : undefined,
      subject: `[${ticket.ticket_no}] Service Ticket ${actionVerb(action)} — ${
        ticket.branch_name
      } / ${ticket.category_label || ticket.category_code}`,
      html: ticketEmailHtml(ticket, action, remark),
    });
  } catch (e) {
    console.error(`[serviceTicket] mail failed for ${ticket.ticket_no}:`, e.message);
  }
}

// Decide recipients for a transition and send.
async function notifyStage(run, ticket, action, remark) {
  const raiser = ticket.raised_by_email;
  const cluster = ticket.cluster_action_by_email;
  const ho = ticket.ho_action_by_email;

  let to = [];
  let cc = [];

  switch (ticket.status) {
    case S.RAISED: // just created → Cluster Head
      to = await recipientsFor(run, ticket.branch_name, R.CLUSTER);
      cc = [raiser];
      break;
    case S.CLUSTER_APPROVED: // → HO User
    case S.REOPENED: // → HO User (fresh action needed)
      to = await recipientsFor(run, ticket.branch_name, R.HO);
      cc = [raiser, cluster];
      break;
    case S.HO_ACTION_SUBMITTED: // → raising Partner
      to = [raiser];
      cc = [cluster];
      break;
    case S.REJECTED: // → raising Partner
      to = [raiser];
      cc = [cluster];
      break;
    case S.CLOSED: // informational to everyone involved
      to = [raiser];
      cc = [cluster, ho];
      break;
    default:
      to = [raiser];
  }
  await sendTicketMail(ticket, action, remark, to, cc);
}

// ─── Row → API shape ─────────────────────────────────────────────────────────
function shapeTicket(t) {
  return {
    id: t.id,
    ticketNo: t.ticket_no,
    branch: t.branch_name,
    categoryCode: t.category_code,
    categoryLabel: t.category_label,
    title: t.title,
    description: t.description,
    priority: t.priority,
    status: t.status,
    slaHours: t.sla_hours,
    stageDueAt: t.stage_due_at,
    slaState: slaState(t.status, t.stage_due_at),
    raisedBy: {
      name: t.raised_by_name,
      mobile: t.raised_by_mobile,
      email: t.raised_by_email,
    },
    clusterAction: t.cluster_action_at
      ? {
          name: t.cluster_action_by_name,
          mobile: t.cluster_action_by_mobile,
          at: t.cluster_action_at,
          remark: t.cluster_remark,
        }
      : null,
    hoAction: t.ho_action_at
      ? {
          name: t.ho_action_by_name,
          mobile: t.ho_action_by_mobile,
          at: t.ho_action_at,
          remark: t.ho_action_remark,
        }
      : null,
    closure: t.closed_at
      ? {
          name: t.closed_by_name,
          mobile: t.closed_by_mobile,
          at: t.closed_at,
          remark: t.closure_remark,
        }
      : null,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

// ─── CREATE ──────────────────────────────────────────────────────────────────
async function createTicket(req) {
  const b = req.body || {};
  const run = makeRunner(getLead());

  const branch = String(b.branch || "").trim();
  const categoryCode = String(b.categoryCode || "").trim();
  const title = String(b.title || "").trim();
  const description = b.description ? String(b.description).trim() : null;
  const priority = SLA_HOURS[b.priority] ? b.priority : "Medium";
  const actor = readActor(b);

  if (!branch) throw httpErr("`branch` is required");
  const cat = CATEGORY_BY_CODE[categoryCode];
  if (!cat) throw httpErr(`Invalid categoryCode: ${categoryCode}`);
  if (!title) throw httpErr("`title` is required");

  // Only a Partner (or SuperAdmin acting as one) may raise a request.
  if (actor.role !== R.PARTNER && actor.role !== R.SUPERADMIN) {
    throw httpErr("Only a Partner can raise a service request.", 403);
  }

  const slaHours = SLA_HOURS[priority];
  const createdAt = nowDbString();
  const stageDue = dueString(slaHours); // due for the RAISED→cluster stage

  const result = await run(
    `INSERT INTO service_ticket
       (branch_name, category_code, category_label, title, description,
        priority, status, sla_hours, stage_due_at,
        raised_by_name, raised_by_mobile, raised_by_email, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      branch,
      cat.code,
      cat.label,
      title,
      description,
      priority,
      S.RAISED,
      slaHours,
      stageDue,
      actor.name,
      actor.mobile,
      actor.email,
      createdAt,
    ],
  );

  const id = result.insertId;
  const ticketNo = `ST-${new Date().getFullYear()}-${String(id).padStart(6, "0")}`;
  await run(`UPDATE service_ticket SET ticket_no = ? WHERE id = ?`, [ticketNo, id]);

  // First log row (creation). No previous event → no duration/breach.
  await run(
    `INSERT INTO service_ticket_log
       (ticket_id, ticket_no, action, from_status, to_status,
        actor_role, actor_name, actor_mobile, actor_email, remark,
        stage_due_at, sla_breached, duration_seconds, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      ticketNo,
      "RAISED",
      null,
      S.RAISED,
      actor.role,
      actor.name,
      actor.mobile,
      actor.email,
      description,
      stageDue,
      0,
      null,
      createdAt,
    ],
  );

  const [row] = await run(`SELECT * FROM service_ticket WHERE id = ?`, [id]);
  await notifyStage(run, row, "RAISED", description);

  return { success: true, ticketNo, ticket: shapeTicket(row) };
}

// ─── ACT (single entry point for all stage transitions) ──────────────────────
async function actOnTicket(req) {
  const b = req.body || {};
  const run = makeRunner(getLead());

  const ticketId = Number(b.ticketId);
  const action = String(b.action || "").trim(); // CLUSTER_APPROVED / CLUSTER_REJECTED / HO_ACTION_SUBMITTED / CLOSED / REOPENED
  const remark = b.remark ? String(b.remark).trim() : null;
  const actor = readActor(b);

  if (!ticketId) throw httpErr("`ticketId` is required");
  const rule = ACTIONS[action];
  if (!rule) throw httpErr(`Unknown action: ${action}`);

  // HO action and Partner reopen/close usually want an explanatory remark.
  if (
    (action === "HO_ACTION_SUBMITTED" ||
      action === "CLUSTER_REJECTED" ||
      action === "REOPENED") &&
    !remark
  ) {
    throw httpErr(`A remark is required for action "${action}".`);
  }

  const [ticket] = await run(`SELECT * FROM service_ticket WHERE id = ?`, [ticketId]);
  if (!ticket) throw httpErr("Ticket not found", 404);

  // Role gate (SuperAdmin bypasses).
  if (actor.role !== R.SUPERADMIN && actor.role !== rule.role) {
    throw httpErr(
      `Action "${action}" requires role "${rule.role}" (got "${actor.role}").`,
      403,
    );
  }
  // Status gate.
  if (!rule.from.includes(ticket.status)) {
    throw httpErr(
      `Ticket ${ticket.ticket_no} is "${ticket.status}"; "${action}" is not allowed from that state.`,
      409,
    );
  }

  const now = new Date();
  const nowStr = nowDbString(now);
  const newStatus = rule.to;

  // The stage that is COMPLETING now had its due at ticket.stage_due_at.
  const completedDue = ticket.stage_due_at;
  const breached =
    completedDue && now.getTime() > new Date(String(completedDue).replace(" ", "T")).getTime()
      ? 1
      : 0;

  // Duration of the completed stage = now - last log row time.
  const [last] = await run(
    `SELECT created_at FROM service_ticket_log
      WHERE ticket_id = ? ORDER BY id DESC LIMIT 1`,
    [ticketId],
  );
  let durationSeconds = null;
  if (last && last.created_at) {
    const prev = new Date(String(last.created_at).replace(" ", "T")).getTime();
    durationSeconds = Math.max(0, Math.round((now.getTime() - prev) / 1000));
  }

  // Next stage's SLA deadline (null for terminal states).
  const terminal = newStatus === S.CLOSED || newStatus === S.REJECTED;
  const nextDue = terminal ? null : dueString(ticket.sla_hours, now);

  // Build the stage-specific column updates.
  const sets = ["status = ?", "stage_due_at = ?", "updated_at = ?"];
  const vals = [newStatus, nextDue, nowStr];

  if (action === "CLUSTER_APPROVED" || action === "CLUSTER_REJECTED") {
    sets.push(
      "cluster_action_by_name = ?",
      "cluster_action_by_mobile = ?",
      "cluster_action_by_email = ?",
      "cluster_action_at = ?",
      "cluster_remark = ?",
    );
    vals.push(actor.name, actor.mobile, actor.email, nowStr, remark);
  } else if (action === "HO_ACTION_SUBMITTED") {
    sets.push(
      "ho_action_by_name = ?",
      "ho_action_by_mobile = ?",
      "ho_action_by_email = ?",
      "ho_action_at = ?",
      "ho_action_remark = ?",
    );
    vals.push(actor.name, actor.mobile, actor.email, nowStr, remark);
  } else if (action === "CLOSED") {
    sets.push(
      "closed_by_name = ?",
      "closed_by_mobile = ?",
      "closed_by_email = ?",
      "closed_at = ?",
      "closure_remark = ?",
    );
    vals.push(actor.name, actor.mobile, actor.email, nowStr, remark);
  } else if (action === "REOPENED") {
    // keep the prior HO action visible; just note the reopen in the log/remark
  }

  vals.push(ticketId);
  await run(`UPDATE service_ticket SET ${sets.join(", ")} WHERE id = ?`, vals);

  await run(
    `INSERT INTO service_ticket_log
       (ticket_id, ticket_no, action, from_status, to_status,
        actor_role, actor_name, actor_mobile, actor_email, remark,
        stage_due_at, sla_breached, duration_seconds, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      ticketId,
      ticket.ticket_no,
      action,
      ticket.status,
      newStatus,
      actor.role,
      actor.name,
      actor.mobile,
      actor.email,
      remark,
      completedDue,
      breached,
      durationSeconds,
      nowStr,
    ],
  );

  const [row] = await run(`SELECT * FROM service_ticket WHERE id = ?`, [ticketId]);
  await notifyStage(run, row, action, remark);

  return { success: true, ticketNo: row.ticket_no, ticket: shapeTicket(row) };
}

// ─── LIST ────────────────────────────────────────────────────────────────────
// Body: { locations[], status?, category?, actorMobile?, actorRole? }
// Returns tickets for the given branches (newest first), each annotated with
// slaState, raisedByMe and actionableByMe so the app can build role queues.
async function listTickets(req) {
  const b = req.body || {};
  const run = makeRunner(getLead());

  const locations = Array.isArray(b.locations) ? b.locations.filter(Boolean) : [];
  if (locations.length === 0) throw httpErr("`locations` must be a non-empty array");

  const role = normaliseRole(b.actorRole, b.actorSubRole);
  const mobile = b.actorMobile || null;

  const where = [`branch_name IN (${locations.map(() => "?").join(",")})`];
  const params = [...locations];
  if (b.status) {
    where.push("status = ?");
    params.push(b.status);
  }
  if (b.category) {
    where.push("category_code = ?");
    params.push(b.category);
  }

  const rows = await run(
    `SELECT * FROM service_ticket
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT 500`,
    params,
  );

  const actionableFrom = {
    [R.CLUSTER]: [S.RAISED],
    [R.HO]: [S.CLUSTER_APPROVED, S.REOPENED],
    [R.PARTNER]: [S.HO_ACTION_SUBMITTED],
  };

  const tickets = rows.map((t) => {
    const shaped = shapeTicket(t);
    const raisedByMe = !!mobile && t.raised_by_mobile === mobile;
    let actionableByMe = false;
    if (role === R.SUPERADMIN) {
      actionableByMe = ![S.CLOSED, S.REJECTED].includes(t.status);
    } else if (actionableFrom[role]) {
      actionableByMe = actionableFrom[role].includes(t.status);
      // a Partner only acts on tickets they raised
      if (role === R.PARTNER) actionableByMe = actionableByMe && raisedByMe;
    }
    return { ...shaped, raisedByMe, actionableByMe };
  });

  // Lightweight status tally for header chips.
  const counts = tickets.reduce((a, t) => {
    a[t.status] = (a[t.status] || 0) + 1;
    return a;
  }, {});

  return { total: tickets.length, counts, tickets };
}

// ─── DETAIL (+ timeline + TAT) ───────────────────────────────────────────────
// Query: ?ticketId= or ?ticketNo=
async function getTicketDetail(req) {
  const run = makeRunner(getLead());
  const { ticketId, ticketNo } = req.query || {};
  if (!ticketId && !ticketNo) throw httpErr("`ticketId` or `ticketNo` is required");

  const [ticket] = ticketId
    ? await run(`SELECT * FROM service_ticket WHERE id = ?`, [Number(ticketId)])
    : await run(`SELECT * FROM service_ticket WHERE ticket_no = ?`, [ticketNo]);
  if (!ticket) throw httpErr("Ticket not found", 404);

  const logs = await run(
    `SELECT action, from_status, to_status, actor_role, actor_name, actor_mobile,
            remark, stage_due_at, sla_breached, duration_seconds, created_at
       FROM service_ticket_log
      WHERE ticket_id = ?
      ORDER BY id ASC`,
    [ticket.id],
  );

  // Turn-around-time summary.
  const totalStageSeconds = logs.reduce(
    (a, l) => a + (Number(l.duration_seconds) || 0),
    0,
  );
  const breaches = logs.filter((l) => l.sla_breached).length;
  const start = new Date(String(ticket.created_at).replace(" ", "T")).getTime();
  const endRef =
    ticket.status === S.CLOSED && ticket.closed_at
      ? new Date(String(ticket.closed_at).replace(" ", "T")).getTime()
      : Date.now();
  const overallSeconds = Math.max(0, Math.round((endRef - start) / 1000));

  return {
    ticket: shapeTicket(ticket),
    timeline: logs.map((l) => ({
      action: l.action,
      fromStatus: l.from_status,
      toStatus: l.to_status,
      by: { role: l.actor_role, name: l.actor_name, mobile: l.actor_mobile },
      remark: l.remark,
      stageDueAt: l.stage_due_at,
      slaBreached: !!l.sla_breached,
      durationSeconds: l.duration_seconds,
      at: l.created_at,
    })),
    tat: {
      overallSeconds,
      overallHours: Math.round((overallSeconds / 3600) * 10) / 10,
      sumOfStageSeconds: totalStageSeconds,
      slaBreaches: breaches,
      isClosed: ticket.status === S.CLOSED,
    },
  };
}

// ─── STATS (dashboard) ───────────────────────────────────────────────────────
// Body: { locations[], from?, to? }  (from/to filter on created_at, YYYY-MM-DD)
async function getTicketStats(req) {
  const b = req.body || {};
  const run = makeRunner(getLead());
  const locations = Array.isArray(b.locations) ? b.locations.filter(Boolean) : [];
  if (locations.length === 0) throw httpErr("`locations` must be a non-empty array");

  const where = [`branch_name IN (${locations.map(() => "?").join(",")})`];
  const params = [...locations];
  if (b.from) {
    where.push("created_at >= ?");
    params.push(`${b.from} 00:00:00`);
  }
  if (b.to) {
    where.push("created_at <= ?");
    params.push(`${b.to} 23:59:59`);
  }
  const clause = where.join(" AND ");

  const byStatus = await run(
    `SELECT status, COUNT(*) AS n FROM service_ticket WHERE ${clause} GROUP BY status`,
    params,
  );
  const byCategory = await run(
    `SELECT category_label AS label, COUNT(*) AS n
       FROM service_ticket WHERE ${clause}
      GROUP BY category_label ORDER BY n DESC`,
    params,
  );
  const byPriority = await run(
    `SELECT priority, COUNT(*) AS n FROM service_ticket WHERE ${clause} GROUP BY priority`,
    params,
  );

  // Avg overall TAT (hours) for CLOSED tickets in range.
  const [tat] = await run(
    `SELECT
        COUNT(*) AS closed,
        AVG(TIMESTAMPDIFF(SECOND, created_at, closed_at)) AS avg_seconds
       FROM service_ticket
      WHERE ${clause} AND status = 'CLOSED' AND closed_at IS NOT NULL`,
    params,
  );

  // SLA breaches across all logged transitions for these tickets in range.
  const [breach] = await run(
    `SELECT
        COALESCE(SUM(l.sla_breached),0) AS breached_stages,
        COUNT(*)                        AS total_stages
       FROM service_ticket_log l
       JOIN service_ticket t ON t.id = l.ticket_id
      WHERE ${clause.replace(/branch_name/g, "t.branch_name").replace(/created_at/g, "t.created_at")}`,
    params,
  );

  const avgSeconds = Number(tat?.avg_seconds) || 0;
  return {
    byStatus: byStatus.reduce((a, r) => ((a[r.status] = r.n), a), {}),
    byPriority: byPriority.reduce((a, r) => ((a[r.priority] = r.n), a), {}),
    byCategory,
    tat: {
      closedTickets: Number(tat?.closed) || 0,
      avgHours: Math.round((avgSeconds / 3600) * 10) / 10,
    },
    sla: {
      breachedStages: Number(breach?.breached_stages) || 0,
      totalStages: Number(breach?.total_stages) || 0,
      breachRatePct:
        Number(breach?.total_stages) > 0
          ? Math.round(
              (Number(breach.breached_stages) / Number(breach.total_stages)) * 1000,
            ) / 10
          : 0,
    },
  };
}

// ─── RECIPIENTS (routing table admin — optional convenience) ─────────────────
async function listRecipients(req) {
  const run = makeRunner(getLead());
  const branch = req.query?.branch;
  const rows = branch
    ? await run(
        `SELECT * FROM service_ticket_recipient
          WHERE branch_name = ? OR branch_name = 'ALL' ORDER BY role, name`,
        [branch],
      )
    : await run(`SELECT * FROM service_ticket_recipient ORDER BY branch_name, role`);
  return { recipients: rows };
}

async function addRecipient(req) {
  const run = makeRunner(getLead());
  const b = req.body || {};
  const branch = String(b.branch || "").trim();
  const role = String(b.role || "").trim();
  const email = String(b.email || "").trim();
  if (!branch || !role || !email) throw httpErr("`branch`, `role`, `email` are required");
  if (![R.CLUSTER, R.HO, R.PARTNER].includes(role))
    throw httpErr(`role must be one of: ${R.CLUSTER}, ${R.HO}, ${R.PARTNER}`);
  await run(
    `INSERT INTO service_ticket_recipient (branch_name, role, name, email, mobile)
       VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), mobile = VALUES(mobile), is_active = 1`,
    [branch, role, b.name || null, email, b.mobile || null],
  );
  return { success: true };
}

module.exports = {
  CATEGORIES,
  createTicket,
  actOnTicket,
  listTickets,
  getTicketDetail,
  getTicketStats,
  listRecipients,
  addRecipient,
};
