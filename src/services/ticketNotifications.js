// ─────────────────────────────────────────────────────────────────────────────
//  Ticket notifications — who gets emailed when a ticket moves, and the message.
//
//  The requirement: email the person the ticket now sits with, whenever it
//  reaches their level. This module resolves the recipient and builds the
//  message; the actual send goes through services/mailer.js.
//
//  Recipient sources (the backend is MySQL-only and never touches Firestore):
//   • Department Head → the ticket_user roster, by department. There is no
//     assignee lookup any more: PDF §2 made a department one head, assigned
//     off-system, so the head IS the recipient.
//   • Partner / raiser and Cluster Head → NOT in MySQL, so their addresses are
//     carried on the ticket (raised_by_email, cluster_head_email), passed by the
//     app at raise time.
//
//  resolveNotification() is a pure-ish function (its only side effect is reading
//  the roster via the injected query fn), which makes the who-gets-what logic
//  unit-testable without SMTP.
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The app's colour theme (from app/src/ticketing/theme.js), mirrored here so the
// notification email looks like the product rather than a generic system mail.
// Email clients strip <style>/external CSS, so every colour is inlined below.
const THEME = {
  green: "#0b6b4b", // header / brand
  greenDeep: "#073e2d", // header gradient end
  bg: "#f6f8f7", // page backdrop
  card: "#ffffff",
  text: "#1f2a2e",
  muted: "#6d7b80",
  line: "#e4e9e6",
  green2: "#0e8f65",
  badgeBg: "#f0f4f2",
  badgeText: "#3c4d45",
};

// Priority / status pill colours, matching PRIORITY_STYLE and STATUS_STYLE in
// the app so a "Critical"/"Open" pill reads the same in the email as on screen.
const PILL = {
  // priorities
  Critical: { bg: "#ffe8e8", fg: "#d94141" },
  Medium: { bg: "#eaf1ff", fg: "#3478f6" },
  Low: { bg: "#edf7ef", fg: "#0e8f65" },
  // statuses
  Open: { bg: "#fff1df", fg: "#df8a28" },
  // Amber, not red. Being asked to rethink a request is not a failure, and
  // colouring it like one makes every Cluster Head reluctant to use it.
  "Sent Back": { bg: "#fff1df", fg: "#df8a28" },
  Approved: { bg: "#eaf1ff", fg: "#3478f6" },
  "In Progress": { bg: "#eaf1ff", fg: "#3478f6" },
  "Waiting for Vendor": { bg: "#fff1df", fg: "#df8a28" },
  Resolved: { bg: "#edf7ef", fg: "#0e8f65" },
  Closed: { bg: "#f0f4f2", fg: "#3c4d45" },
  Reopened: { bg: "#ffe8e8", fg: "#d94141" },
};

/** An inline-styled coloured pill for a priority or status value. */
function pill(value) {
  const c = PILL[value] || { bg: THEME.badgeBg, fg: THEME.badgeText };
  return (
    `<span style="display:inline-block;padding:2px 10px;border-radius:999px;` +
    `background:${c.bg};color:${c.fg};font-size:12px;font-weight:600;` +
    `line-height:18px;white-space:nowrap">${escapeHtml(value)}</span>`
  );
}

// Human-readable label for each activity action, for the timeline in the email.
// These keys must match ACTION_LOG in ticketingModel.js — that is what gets
// written to ticket_activity.action and passed to notifyForTicket().
const ACTION_LABEL = {
  RAISED: "Raised",
  APPROVED: "Approved",
  SENT_BACK: "Sent back",
  SENT_TO_BRANCH: "Sent to branch to fix",
  FIXED_LOCALLY: "Fixed at the branch",
  REASSIGNED: "Re-assigned — wrong department",
  FORWARDED: "Forwarded",
  PROGRESS: "Progress update",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  REOPENED: "Reopened",
  COMMENT: "Comment",
};

// A short, email-safe timestamp like "12 Jul, 3:45 PM".
function fmtWhen(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return "";
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  let h = dt.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const min = String(dt.getMinutes()).padStart(2, "0");
  return `${dt.getDate()} ${months[dt.getMonth()]}, ${h}:${min} ${ampm}`;
}

/**
 * Build the ticket's progress timeline (most recent first, capped) as inline
 * HTML plus a plain-text version. Reads the append-only ticket_activity trail —
 * the same history the app's detail screen shows — so the recipient sees how the
 * ticket got here, not just the current ask.
 */
async function buildTimeline(ticketId, run) {
  let rows = [];
  try {
    rows = await run(
      `SELECT action, actor_name, actor_role, remark, to_status, created_at
         FROM ticket_activity
        WHERE ticket_id = ?
        ORDER BY activity_id DESC
        LIMIT 8`,
      [ticketId],
    );
  } catch (e) {
    return { html: "", text: "" }; // history is a bonus — never block the email
  }
  if (!rows.length) return { html: "", text: "" };

  // The remark is kept RAW here and the " — " separator added at render time.
  // It used to be prefixed here and un-prefixed with .slice(3) below, which
  // silently depended on that separator staying exactly three characters long.
  // An approve remark now reads "Priority changed from Critical to Medium.
  // Resolution time: 48 hours" — the text you least want quietly truncated.
  const items = rows.map((r) => {
    const label = ACTION_LABEL[r.action] || r.action;
    const when = fmtWhen(r.created_at);
    const by = r.actor_name ? ` by ${r.actor_name}` : "";
    const remark = r.remark || "";
    return { label, when, by, remark };
  });

  const htmlRows = items
    .map(
      (it, i) =>
        `<tr>` +
        `<td style="padding:0 12px 0 0;vertical-align:top;width:8px">` +
        `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;` +
        `background:${i === 0 ? THEME.green : THEME.line};margin-top:5px"></span></td>` +
        `<td style="padding:0 0 12px;vertical-align:top">` +
        `<div style="font-size:13px;color:${THEME.text};font-weight:600">${escapeHtml(it.label)}` +
        `<span style="font-weight:400;color:${THEME.muted}">${escapeHtml(it.by)}</span></div>` +
        (it.remark
          ? `<div style="font-size:12px;color:${THEME.muted};margin-top:1px">${escapeHtml(it.remark)}</div>`
          : "") +
        `<div style="font-size:11px;color:${THEME.muted};margin-top:1px">${escapeHtml(it.when)}</div>` +
        `</td></tr>`,
    )
    .join("");

  const html =
    `<div style="margin-top:20px">` +
    `<div style="font-size:12px;font-weight:700;color:${THEME.muted};text-transform:uppercase;` +
    `letter-spacing:.4px;margin-bottom:10px">History</div>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%">${htmlRows}</table>` +
    `</div>`;

  const text =
    `\nHistory:\n` +
    items
      .map(
        (it) =>
          `  • ${it.label}${it.by}${it.remark ? ` — ${it.remark}` : ""}` +
          `${it.when ? ` (${it.when})` : ""}`,
      )
      .join("\n");

  return { html, text };
}

const ok = (e) =>
  typeof e === "string" && EMAIL_RE.test(e.trim()) ? e.trim() : null;

/**
 * The active Department Head's email for a department.
 */
async function deptHeadEmail(run, department) {
  if (!department) return null;
  const rows = await run(
    `SELECT email FROM ticket_user
      WHERE department = ? AND ticket_role = 'Department Head'
        AND is_active = 1 AND is_deleted = 0 AND email IS NOT NULL
      ORDER BY ticket_user_id DESC
      LIMIT 1`,
    [department],
  );
  return rows.length ? ok(rows[0].email) : null;
}

// What each action means for notification: who is now responsible, and the line
// that tells them why they're getting the mail. `who` returns an email, or an
// array of them, or null when we can't resolve one — then no mail is sent.
// `line` is the one-sentence call to action.
//
// Actions with no new owner (progress updates, comments) return null and send
// nothing.
const RULES = {
  RAISED: {
    who: (t) => ok(t.cluster_head_email),
    line: (t) => `A new ticket for ${t.branch_name} needs your approval.`,
  },
  // Approved → the department head works it themselves (PDF §2). The raiser is
  // copied because this is where they learn the priority and the resolution
  // time their Cluster Head committed to.
  APPROVED: {
    who: async (t, run) => [
      await deptHeadEmail(run, t.department),
      ok(t.raised_by_email),
    ],
    line: (t) => `A ticket has been approved for ${t.department}.`,
  },
  SENT_BACK: {
    who: (t) => ok(t.raised_by_email),
    line: () => `Your ticket has been sent back to be reconsidered.`,
  },
  // The branch is being asked to do the work themselves.
  SENT_TO_BRANCH: {
    who: (t) => ok(t.raised_by_email),
    line: (t) =>
      `Your ticket is for ${t.branch_name} to fix locally — please action it.`,
  },
  // Back to the Cluster Head to sign off.
  FIXED_LOCALLY: {
    who: (t) => ok(t.cluster_head_email),
    line: (t) =>
      `${t.branch_name} has fixed a ticket — please review and resolve it.`,
  },
  // PDF §5 — the ticket moved to the right department. The head there picks it
  // up; the raiser is told it moved and why.
  REASSIGNED: {
    who: async (t, run) => [
      await deptHeadEmail(run, t.department),
      ok(t.raised_by_email),
    ],
    line: (t) =>
      `A ticket has been re-assigned to ${t.department} as the correct department.`,
  },
  // PDF §5 — the previous department finished their part.
  FORWARDED: {
    who: async (t, run) => [
      await deptHeadEmail(run, t.department),
      ok(t.raised_by_email),
    ],
    line: (t) => `A ticket has been forwarded to ${t.department} to continue.`,
  },
  RESOLVED: {
    who: (t) => ok(t.raised_by_email),
    line: () => `Your ticket has been resolved.`,
  },
  // The department head closes without the branch's say-so now (PDF §2), so the
  // branch has to be told rather than doing it themselves.
  CLOSED: {
    who: (t) => ok(t.raised_by_email),
    line: () => `Your ticket has been closed.`,
  },
  REOPENED: {
    who: (t, run) => deptHeadEmail(run, t.department),
    line: () =>
      `A resolved ticket has been reopened and is back with your department.`,
  },
};

/**
 * Resolve the notification for a transition, or null if nobody should be mailed.
 *
 * @param {object} ticket  the ticket row (snake_case columns)
 * @param {string} action  the action string (RAISED, APPROVED, …)
 * @param {(sql:string, params:any[]) => Promise<any[]>} run  roster query fn
 * @returns {Promise<null | {to:string, subject:string, text:string, html:string}>}
 */
async function resolveNotification(ticket, action, run) {
  const rule = RULES[action];
  if (!rule) return null;

  // A rule may name one recipient or several. De-duplicated because a
  // self-approved ticket resolves the same person twice — the raiser is also
  // the approver — and nobody should get the same mail in duplicate.
  const resolved = await rule.who(ticket, run);
  const list = (Array.isArray(resolved) ? resolved : [resolved]).filter(
    Boolean,
  );
  const to = [...new Set(list)].join(", ");
  if (!to) return null; // no resolvable/valid address → send nothing

  const ref = ticket.ticket_ref || `#${ticket.ticket_id}`;
  const line = rule.line(ticket);
  const subject = `[${ref}] ${line}`;

  // The ticket's progress so far, so the recipient sees the journey — not just
  // the current ask. A bonus section; if it can't be built the email still sends.
  const timeline = await buildTimeline(ticket.ticket_id, run);

  const facts = [
    ["Ticket", ref],
    ["Location", ticket.branch_name],
    ["Department", ticket.department],
    ["Issue", ticket.issue_type],
    ["Priority", ticket.priority],
    ["Status", ticket.status],
  ];
  // Only once a Cluster Head has approved and set one (PDF §4). Before that
  // there is no deadline to quote, and inventing one would be a promise nobody
  // has made.
  if (ticket.sla_hours) {
    facts.push(["Resolution time", `${ticket.sla_hours} hours`]);
  }

  const text =
    `${line}\n\n` +
    facts.map(([k, v]) => `${k}: ${v}`).join("\n") +
    (ticket.description ? `\n\nDetails: ${ticket.description}` : "") +
    timeline.text +
    `\n\n— Healing Hands Clinic ticketing`;

  // Rows: priority and status render as coloured pills; the rest as plain text.
  const rowHtml = facts
    .map(([k, v]) => {
      const val =
        k === "Priority" || k === "Status"
          ? pill(v)
          : `<b style="color:${THEME.text}">${escapeHtml(v)}</b>`;
      return (
        `<tr>` +
        `<td style="padding:7px 16px 7px 0;color:${THEME.muted};font-size:13px;white-space:nowrap;vertical-align:top">${k}</td>` +
        `<td style="padding:7px 0;font-size:13px;vertical-align:top">${val}</td>` +
        `</tr>`
      );
    })
    .join("");

  // Email layout is table-based with fully inlined styles — email clients strip
  // <style> blocks, flexbox, and external CSS. Structure: tinted page → white
  // card → green brand header → message line → facts table → optional details →
  // footer. Colours come from the app theme so the mail looks like the product.
  const html =
    `<div style="margin:0;padding:24px 12px;background:${THEME.bg};` +
    `font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto">` +
    `<tr><td style="background:${THEME.card};border:1px solid ${THEME.line};border-radius:14px;overflow:hidden">` +
    // Brand header
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">` +
    `<tr><td style="background:${THEME.green};padding:18px 24px">` +
    `<span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:.2px">Healing Hands Clinic</span>` +
    `<span style="color:#bfe3d3;font-size:13px;font-weight:600;margin-left:8px">Ticketing</span>` +
    `</td></tr></table>` +
    // Body
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:24px">` +
    `<p style="margin:0 0 4px;font-size:15px;font-weight:600;color:${THEME.text}">${escapeHtml(line)}</p>` +
    `<p style="margin:0 0 18px;font-size:13px;color:${THEME.muted}">Ticket ${escapeHtml(ref)}</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="border-top:1px solid ${THEME.line};width:100%">` +
    rowHtml +
    `</table>` +
    (ticket.description
      ? `<div style="margin-top:18px;padding:14px 16px;background:${THEME.bg};` +
        `border-left:3px solid ${THEME.green2};border-radius:8px;font-size:13px;` +
        `color:${THEME.text};line-height:1.5">${escapeHtml(ticket.description)}</div>`
      : "") +
    timeline.html +
    `</td></tr></table>` +
    // Footer
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">` +
    `<tr><td style="padding:14px 24px;border-top:1px solid ${THEME.line};` +
    `color:${THEME.muted};font-size:11px">` +
    `This is an automated message from Healing Hands Clinic ticketing. Please do not reply.` +
    `</td></tr></table>` +
    `</td></tr></table></div>`;

  return { to, subject, text, html };
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = { resolveNotification, EMAIL_RE };
