// ═══════════════════════════════════════════════════════════════════════════
//  Recruitment notifications — who gets emailed as a requisition moves.
//
//  Requirement 8: email each person when the requisition reaches their stage,
//  and when the Department Head closes it, tell the Cluster Head who raised it.
//
//  Recipient sources mirror the ticketing module:
//   • Department Head / Department User → the `ticket_user` roster (they are
//     already onboarded there with their email).
//   • Cluster Head (the raiser) → `raised_by_email` on the requisition, passed
//     by the app at submit time, because Cluster Heads live in Firestore and
//     this database never joins it.
// ═══════════════════════════════════════════════════════════════════════════

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ok = (e) =>
  typeof e === "string" && EMAIL_RE.test(e.trim()) ? e.trim() : null;

// Same palette as the ticket emails, so both look like one product.
const THEME = {
  green: "#0b6b4b",
  bg: "#f6f8f7",
  card: "#ffffff",
  text: "#1f2a2e",
  muted: "#6d7b80",
  line: "#e4e9e6",
  green2: "#0e8f65",
  badgeBg: "#f0f4f2",
  badgeText: "#3c4d45",
};

const PILL = {
  Submitted: { bg: "#fff1df", fg: "#df8a28" },
  Rejected: { bg: "#ffe8e8", fg: "#d94141" },
  Assigned: { bg: "#eaf1ff", fg: "#3478f6" },
  "In Progress": { bg: "#eaf1ff", fg: "#3478f6" },
  "Offer Released": { bg: "#edf7ef", fg: "#0e8f65" },
  Joined: { bg: "#edf7ef", fg: "#0e8f65" },
  Closed: { bg: "#f0f4f2", fg: "#3c4d45" },
};

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pill(value) {
  const c = PILL[value] || { bg: THEME.badgeBg, fg: THEME.badgeText };
  return (
    `<span style="display:inline-block;padding:2px 10px;border-radius:999px;` +
    `background:${c.bg};color:${c.fg};font-size:12px;font-weight:600;` +
    `line-height:18px;white-space:nowrap">${escapeHtml(value)}</span>`
  );
}

function fmtDate(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return String(d);
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
  return `${dt.getDate()} ${months[dt.getMonth()]} ${dt.getFullYear()}`;
}

/** The HR Department Head's email, from the roster. */
async function deptHeadEmail(run, department) {
  if (!department) return null;
  const rows = await run(
    `SELECT email FROM ticket_user
      WHERE department = ? AND ticket_role = 'Department Head'
        AND is_active = 1 AND is_deleted = 0 AND email IS NOT NULL
      LIMIT 1`,
    [department],
  );
  return rows.length ? ok(rows[0].email) : null;
}

/** A roster member's email by mobile (used for the assignee). */
async function rosterEmail(run, mobile) {
  if (!mobile) return null;
  const rows = await run(
    `SELECT email FROM ticket_user
      WHERE mobile = ? AND is_active = 1 AND is_deleted = 0 AND email IS NOT NULL
      LIMIT 1`,
    [mobile],
  );
  return rows.length ? ok(rows[0].email) : null;
}

// action → who is now responsible, and the one-line reason they're being told.
const RULES = {
  // Cluster Head submitted → the HR Department Head must review it.
  SUBMITTED: {
    who: (r, run) => deptHeadEmail(run, r.handling_department),
    line: (r) =>
      `A new manpower requisition for ${r.position} at ${r.unit || r.location || "your group"} ` +
      `needs your review.`,
  },
  // Approved and assigned → the HR executive who now owns it.
  APPROVED: {
    who: (r, run) => rosterEmail(run, r.assignee_mobile),
    line: (r) =>
      `A requisition for ${r.position} has been assigned to you` +
      (r.target_close_date
        ? `, to close by ${fmtDate(r.target_close_date)}.`
        : "."),
  },
  // Rejected → back to the Cluster Head who raised it, with the comment.
  REJECTED: {
    who: (r) => ok(r.raised_by_email),
    line: (r) => `Your requisition for ${r.position} was not approved.`,
  },
  // Reassigned → the new owner.
  REASSIGNED: {
    who: (r, run) => rosterEmail(run, r.assignee_mobile),
    line: (r) => `A requisition for ${r.position} has been reassigned to you.`,
  },
  // The head changed the deadline → tell the person working it.
  TARGET_CHANGED: {
    who: (r, run) => rosterEmail(run, r.assignee_mobile),
    line: (r) =>
      `The target date for ${r.position} is now ${fmtDate(r.target_close_date)}.`,
  },
  // Progress update → the Department Head keeps oversight.
  PROGRESS: {
    who: (r, run) => deptHeadEmail(run, r.handling_department),
    line: (r) => `Progress was recorded on the ${r.position} requisition.`,
  },
  // An offer went out → the Department Head, who signs the position off.
  OFFER_RELEASED: {
    who: (r, run) => deptHeadEmail(run, r.handling_department),
    line: (r) => `An offer letter has been issued for ${r.position}.`,
  },
  // A candidate joined → the Department Head, who can now close it.
  JOINED: {
    who: (r, run) => deptHeadEmail(run, r.handling_department),
    line: (r) =>
      `${r.positions_filled} of ${r.number_of_positions} position(s) for ${r.position} ` +
      `${Number(r.positions_filled) >= Number(r.number_of_positions) ? "are now filled — you can close this requisition." : "have been filled."}`,
  },
  OFFER_REPLACED: {
    who: (r, run) => deptHeadEmail(run, r.handling_department),
    line: (r) =>
      `An offer letter for ${r.position} has been replaced and re-issued.`,
  },
  OFFER_UPDATED: {
    who: (r, run) => deptHeadEmail(run, r.handling_department),
    line: (r) =>
      `An offer letter on the ${r.position} requisition was updated.`,
  },
  // Requirement 8, second half: on close, tell the Cluster Head who raised it.
  CLOSED: {
    who: (r) => ok(r.raised_by_email),
    line: (r) =>
      `Your requisition for ${r.position} at ${r.unit || r.location || "your group"} has been ` +
      `closed by ${r.closed_by_name || "the HR department"}.`,
  },
};

/**
 * Build the recruitment notification for an action, or null if nobody should be
 * emailed (no rule, or no valid address).
 */
async function resolveRecruitmentNotification(request, action, run) {
  const rule = RULES[action];
  if (!rule) return null;

  const to = await rule.who(request, run);
  if (!to) return null;

  const ref = request.request_ref || `#${request.request_id}`;
  const line = rule.line(request);
  const subject = `[${ref}] ${line}`;

  const facts = [
    ["Requisition", ref],
    ["Position", request.position],
    ["Positions", String(request.number_of_positions || 1)],
    ["Department", request.for_department],
    ["Unit", request.unit],
    ["Type", request.employment_type],
    ["Status", request.status],
  ];
  if (request.target_close_date) {
    facts.push(["Target close", fmtDate(request.target_close_date)]);
  }
  if (request.location) facts.push(["Location", request.location]);
  if (request.assignee_name) facts.push(["With", request.assignee_name]);
  // Offers are counted, not named — there is no candidate identity to show.
  if (Number(request.positions_filled) > 0) {
    facts.push([
      "Filled",
      `${request.positions_filled} of ${request.number_of_positions}`,
    ]);
  }

  // The letters issued so far — dates only, never a person's name.
  let offerBlock = { html: "", text: "" };
  try {
    const offers = await run(
      `SELECT label, offer_date, joining_date, status FROM recruitment_offer
        WHERE request_id = ? AND is_deleted = 0 ORDER BY offer_id ASC LIMIT 10`,
      [request.request_id],
    );
    if (offers.length) {
      const rows = offers
        .map(
          (o, i) =>
            `<tr><td style="padding:5px 14px 5px 0;font-size:13px;color:${THEME.text}">` +
            `${escapeHtml(o.label || `Position ${i + 1}`)}</td>` +
            `<td style="padding:5px 14px 5px 0;font-size:12px;color:${THEME.muted}">` +
            `Offered ${escapeHtml(fmtDate(o.offer_date))}</td>` +
            `<td style="padding:5px 0;font-size:12px;color:${THEME.muted}">` +
            `${o.status === "Replaced" ? "Replaced" : o.joining_date ? "Joins " + escapeHtml(fmtDate(o.joining_date)) : "Awaiting joining"}</td></tr>`,
        )
        .join("");
      offerBlock.html =
        `<div style="margin-top:20px">` +
        `<div style="font-size:12px;font-weight:700;color:${THEME.muted};` +
        `text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px">Offer letters</div>` +
        `<table role="presentation" cellpadding="0" cellspacing="0">${rows}</table></div>`;
      offerBlock.text =
        "\nOffer letters:\n" +
        offers
          .map(
            (o, i) =>
              `  • ${o.label || `Position ${i + 1}`} — offered ${fmtDate(o.offer_date)}` +
              (o.status === "Replaced"
                ? " (replaced)"
                : o.joining_date
                  ? `, joins ${fmtDate(o.joining_date)}`
                  : ", awaiting joining"),
          )
          .join("\n");
    }
  } catch (e) {
    /* the offer list is a bonus — never block the email */
  }

  const text =
    `${line}\n\n` +
    facts.map(([k, v]) => `${k}: ${v}`).join("\n") +
    (request.review_remark ? `\n\nComment: ${request.review_remark}` : "") +
    (request.close_remark ? `\n\nClosing note: ${request.close_remark}` : "") +
    offerBlock.text +
    `\n\n— Healing Hands Clinic recruitment`;

  const rowHtml = facts
    .map(([k, v]) => {
      const val =
        k === "Status"
          ? pill(v)
          : `<b style="color:${THEME.text}">${escapeHtml(v)}</b>`;
      return (
        `<tr><td style="padding:7px 16px 7px 0;color:${THEME.muted};font-size:13px;` +
        `white-space:nowrap;vertical-align:top">${k}</td>` +
        `<td style="padding:7px 0;font-size:13px;vertical-align:top">${val}</td></tr>`
      );
    })
    .join("");

  const note = request.close_remark || request.review_remark;

  const html =
    `<div style="margin:0;padding:24px 12px;background:${THEME.bg};` +
    `font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto">` +
    `<tr><td style="background:${THEME.card};border:1px solid ${THEME.line};border-radius:14px;overflow:hidden">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>` +
    `<td style="background:${THEME.green};padding:18px 24px">` +
    `<span style="color:#ffffff;font-size:16px;font-weight:700">Healing Hands Clinic</span>` +
    `<span style="color:#bfe3d3;font-size:13px;font-weight:600;margin-left:8px">Recruitment</span>` +
    `</td></tr></table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:24px">` +
    `<p style="margin:0 0 4px;font-size:15px;font-weight:600;color:${THEME.text}">${escapeHtml(line)}</p>` +
    `<p style="margin:0 0 18px;font-size:13px;color:${THEME.muted}">Requisition ${escapeHtml(ref)}</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="border-top:1px solid ${THEME.line};width:100%">` +
    rowHtml +
    `</table>` +
    (note
      ? `<div style="margin-top:18px;padding:14px 16px;background:${THEME.bg};` +
        `border-left:3px solid ${THEME.green2};border-radius:8px;font-size:13px;` +
        `color:${THEME.text};line-height:1.5">${escapeHtml(note)}</div>`
      : "") +
    offerBlock.html +
    `</td></tr></table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>` +
    `<td style="padding:14px 24px;border-top:1px solid ${THEME.line};color:${THEME.muted};font-size:11px">` +
    `This is an automated message from Healing Hands Clinic recruitment. Please do not reply.` +
    `</td></tr></table>` +
    `</td></tr></table></div>`;

  return { to, subject, text, html };
}

module.exports = { resolveRecruitmentNotification };
