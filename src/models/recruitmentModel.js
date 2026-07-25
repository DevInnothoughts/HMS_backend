// ═══════════════════════════════════════════════════════════════════════════
//  Recruitment — Manpower Requisition (MRF) workflow engine
//
//  The form is HRM-F-2.1-01. The flow, from the requirements:
//
//    Cluster Head submits an MRF          → Submitted
//    HR Dept Head approves + assigns      → Assigned      (with a target date)
//                 or rejects with comment → Rejected      (terminal)
//    HR Dept User updates progress        → In Progress
//    HR Dept User uploads an offer letter → Offer Released   (one per position)
//    HR Dept User records a joining date  → Joined
//    HR Dept Head closes                  → Closed        (terminal)
//
//  NO CANDIDATE IDENTITY IS STORED. Offer letters live in `recruitment_offer`,
//  one row per position filled — so a requisition for three nurses can carry
//  three letters — but a row identifies a POSITION, not a person. No applicant
//  name, phone or email ever enters this database.
//
//  DESIGN — this module deliberately borrows from ticketingModel rather than
//  restating anything:
//    • loadActor      — so a person's role resolves IDENTICALLY in both modules.
//                       Two copies of that logic is exactly how the "button
//                       shows but the server rejects it" class of bug starts.
//    • run / withTransaction / error helpers — same pool, same semantics.
//    • ticket_user    — the HR head and executives are already on that roster
//                       with their emails. No second user table.
//
//  Like tickets, the server is the authority on permissions: every request it
//  returns carries an `actions` array, and the app renders buttons from it.
// ═══════════════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const {
  ROLES,
  loadActor,
  run,
  withTransaction,
  badRequest,
  forbidden,
  notFound,
  str,
  toSqlDateTime,
} = require("./ticketingModel");
const { sendMail } = require("../services/mailer");
const {
  resolveRecruitmentNotification,
} = require("../services/recruitmentNotifications");

const CONFIG = {
  REF_PREFIX: "MRF-",
  REF_BASE: 1000, // MRF-1001, MRF-1002, …

  // Recruitment is an HR process. The column exists so another department could
  // own it later without a migration, but nothing in the app offers a choice.
  HANDLING_DEPARTMENT: "HR",

  // Default window the Department Head gets for closing a position, in days.
  // Only a default — they set the real target when approving.
  DEFAULT_TARGET_DAYS: 30,

  // Signed offer letters land on the server disk, same as ticket attachments.
  // Override per environment; the URL must map to the directory.
  OFFER_DIR:
    process.env.RECRUITMENT_OFFER_DIR ||
    "/var/www/wedoc.in/uploads/recruitment",
  OFFER_BASE_URL:
    process.env.RECRUITMENT_OFFER_BASE_URL ||
    "https://wedoc.in/uploads/recruitment",
  OFFER_MAX_BYTES: 8 * 1024 * 1024, // 8 MB
};

// A POSIX directory configured on a Windows host is almost always a developer
// running the backend locally against production settings. The upload then
// succeeds — onto the developer's C: drive — while the URL points at the Linux
// server, so the link 404s forever with nothing obviously wrong. Say so once,
// loudly, at startup.
if (process.platform === "win32" && CONFIG.OFFER_DIR.startsWith("/")) {
  console.warn(
    "\n" +
      "  ┌─ recruitment: offer letters will NOT be reachable ──────────────────\n" +
      `  │ This process is running on Windows, but RECRUITMENT_OFFER_DIR is a\n` +
      `  │ Linux path: ${CONFIG.OFFER_DIR}\n` +
      `  │ Files will be saved to C:${CONFIG.OFFER_DIR.replace(/\//g, "\\")}\n` +
      `  │ while their URLs point at ${CONFIG.OFFER_BASE_URL} — a different machine.\n` +
      "  │ Either run the backend on the server, or set RECRUITMENT_OFFER_DIR\n" +
      "  │ and RECRUITMENT_OFFER_BASE_URL to a local pair.\n" +
      "  └─────────────────────────────────────────────────────────────────────\n",
  );
}

const STATUS = {
  SUBMITTED: "Submitted",
  REJECTED: "Rejected",
  ASSIGNED: "Assigned",
  IN_PROGRESS: "In Progress",
  OFFER_RELEASED: "Offer Released",
  JOINED: "Joined",
  CLOSED: "Closed",
};

const ALL_STATUSES = Object.values(STATUS);
const DONE_STATES = [STATUS.CLOSED, STATUS.REJECTED];

// action → { from[], to, roles[], label }
const TRANSITIONS = {
  approve: {
    from: [STATUS.SUBMITTED],
    to: STATUS.ASSIGNED,
    roles: [ROLES.DEPT_HEAD, ROLES.SUPER_ADMIN],
    label: "Approve & assign",
  },
  reject: {
    from: [STATUS.SUBMITTED],
    to: STATUS.REJECTED,
    roles: [ROLES.DEPT_HEAD, ROLES.SUPER_ADMIN],
    label: "Reject",
  },
  progress: {
    from: [STATUS.ASSIGNED, STATUS.IN_PROGRESS, STATUS.OFFER_RELEASED],
    to: STATUS.IN_PROGRESS,
    roles: [ROLES.DEPT_USER, ROLES.DEPT_HEAD, ROLES.SUPER_ADMIN],
    label: "Update progress",
  },
  reassign: {
    from: [
      STATUS.ASSIGNED,
      STATUS.IN_PROGRESS,
      STATUS.OFFER_RELEASED,
      STATUS.JOINED,
    ],
    to: null, // status unchanged
    roles: [ROLES.DEPT_HEAD, ROLES.SUPER_ADMIN],
    label: "Reassign",
  },
  retarget: {
    from: [
      STATUS.ASSIGNED,
      STATUS.IN_PROGRESS,
      STATUS.OFFER_RELEASED,
      STATUS.JOINED,
    ],
    to: null,
    roles: [ROLES.DEPT_HEAD, ROLES.SUPER_ADMIN],
    label: "Change target date",
  },
  close: {
    from: [STATUS.IN_PROGRESS, STATUS.OFFER_RELEASED, STATUS.JOINED],
    to: STATUS.CLOSED,
    roles: [ROLES.DEPT_HEAD, ROLES.SUPER_ADMIN],
    label: "Close requisition",
  },
};

const ACTION_LOG = {
  approve: "APPROVED",
  reject: "REJECTED",
  progress: "PROGRESS",
  reassign: "REASSIGNED",
  retarget: "TARGET_CHANGED",
  close: "CLOSED",
};

// ─── Visibility ──────────────────────────────────────────────────────────────
/**
 * The WHERE fragment limiting a list to what this actor may see.
 *
 *   SuperAdmin      everything
 *   ClusterHead     requisitions for THEIR branches (the answer chosen for this
 *                   module — same scoping rule tickets use)
 *   DeptHead        everything their department handles (HR)
 *   DeptUser        only what is assigned to them
 *   Partner/Viewer  nothing — recruitment is not a partner-facing process
 */
function visibilityScope(actor) {
  switch (actor.role) {
    case ROLES.SUPER_ADMIN:
      return { sql: "1=1", params: [] };

    case ROLES.CLUSTER_HEAD: {
      // Scoped by UNIT (the clinic), not by location — location is the city on
      // the form, and several units share one.
      const branches = (actor.branches || []).filter(Boolean);
      if (!branches.length) {
        // No branches configured — fall back to what they raised, so a
        // misconfigured login leaks nothing.
        return { sql: "r.raised_by_mobile = ?", params: [actor.mobile] };
      }
      return {
        sql: `r.unit IN (${branches.map(() => "?").join(",")})`,
        params: branches,
      };
    }

    case ROLES.DEPT_HEAD:
      return {
        sql: "r.handling_department = ?",
        params: [actor.department || CONFIG.HANDLING_DEPARTMENT],
      };

    case ROLES.DEPT_USER:
      return { sql: "r.assignee_mobile = ?", params: [actor.mobile] };

    default:
      return { sql: "1=0", params: [] };
  }
}

/** Which buttons this actor gets on this requisition. */
function actionsFor(row, actor) {
  const out = [];
  if (!row || row.is_deleted) return out;

  const isHandlingDept =
    (actor.department || "") ===
    (row.handling_department || CONFIG.HANDLING_DEPARTMENT);

  const anyoneJoined = Number(row.positions_filled || 0) > 0;

  for (const [action, spec] of Object.entries(TRANSITIONS)) {
    if (!spec.from.includes(row.status)) continue;
    if (!spec.roles.includes(actor.role)) continue;

    // Once someone has a joining date the deadline has served its purpose, so
    // moving it would only rewrite history. Filling the last position closes
    // the requisition outright, which removes every action with it.
    if (action === "retarget" && anyoneJoined) continue;

    // A department head or user only acts on their own department's work.
    if (
      (actor.role === ROLES.DEPT_HEAD || actor.role === ROLES.DEPT_USER) &&
      !isHandlingDept
    ) {
      continue;
    }
    // A department user only acts on what is assigned to them.
    if (actor.role === ROLES.DEPT_USER && row.assignee_mobile !== actor.mobile)
      continue;

    out.push(action);
  }

  // Offer letters can be added or updated while the requisition is live —
  // one per position, so a 3-position requisition can carry 3 letters.
  const liveForOffers = [
    STATUS.ASSIGNED,
    STATUS.IN_PROGRESS,
    STATUS.OFFER_RELEASED,
    STATUS.JOINED,
  ];
  const canManageOffers =
    liveForOffers.includes(row.status) &&
    ((actor.role === ROLES.DEPT_USER && row.assignee_mobile === actor.mobile) ||
      (actor.role === ROLES.DEPT_HEAD && isHandlingDept) ||
      actor.role === ROLES.SUPER_ADMIN);
  if (canManageOffers) out.push("addOffer");

  return out;
}

// ─── Row → API shape ─────────────────────────────────────────────────────────
function daysBetween(a, b) {
  return Math.floor((a - b) / 86400000);
}

function mapRequest(r, actor) {
  const today = new Date();
  const target = r.target_close_date ? new Date(r.target_close_date) : null;
  const overdue =
    !DONE_STATES.includes(r.status) && target ? target < today : false;

  return {
    requestId: r.request_id,
    id: r.request_ref,

    // The MRF
    position: r.position,
    numberOfPositions: r.number_of_positions,
    unit: r.unit,
    forDepartment: r.for_department,
    location: r.location,
    employmentType: r.employment_type,
    minQualification: r.min_qualification,
    minExperience: r.min_experience,
    industryPreference: r.industry_preference,
    requisitionDate: r.requisition_date,
    reportingTo: r.reporting_to,
    salaryRange: r.salary_range,
    reasonForRecruitment: r.reason_for_recruitment,
    skillSets: r.skill_sets,
    jobProfile: r.job_profile,
    currentHandler: r.current_handler,

    // Workflow
    status: r.status,
    handlingDepartment: r.handling_department,
    progressStage: r.progress_stage,
    raisedBy: r.raised_by_name,
    raisedByMobile: r.raised_by_mobile,
    raisedAt: r.raised_at,
    reviewedBy: r.reviewed_by_name,
    reviewedAt: r.reviewed_at,
    reviewRemark: r.review_remark,
    assigneeName: r.assignee_name,
    assigneeMobile: r.assignee_mobile,
    targetCloseDate: r.target_close_date,

    // Offers are held in their own table, one per position filled. These are
    // the running totals, so a list row needs no join.
    offerReleased: !!r.offer_released,
    positionsFilled: Number(r.positions_filled || 0),
    positionsRemaining: Math.max(
      Number(r.number_of_positions || 1) - Number(r.positions_filled || 0),
      0,
    ),

    closeOutcome: r.close_outcome,
    closedBy: r.closed_by_name,
    closedAt: r.closed_at,
    closeRemark: r.close_remark,

    // Derived
    overdue,
    age: daysBetween(today, new Date(r.raised_at)),
    daysLeft:
      target && !DONE_STATES.includes(r.status)
        ? daysBetween(target, today)
        : null,

    actions: actor ? actionsFor(r, actor) : [],
  };
}

// ─── Offer letter storage ────────────────────────────────────────────────────
const MIME_EXT = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
};

/**
 * Decode a base64 data URL and write it to the offer-letter directory, returning
 * the public URL. Returns null if there is nothing to store or the write fails —
 * a failed upload must never lose the action that carried it.
 */
function saveOfferLetter(requestId, file) {
  // No file is a normal case, not a fault: recording a joining date on an
  // existing letter sends no attachment. The callers that DO require one
  // validate for themselves, so saying anything here would only cry wolf.
  if (!file || !file.dataUrl) return null;
  try {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(file.dataUrl);
    const mime = m ? m[1] : file.mimeType || "application/octet-stream";
    const b64 = m ? m[2] : file.dataUrl;
    const bytes = Buffer.from(b64, "base64");
    if (!bytes.length) {
      console.warn(
        "recruitment: the offer letter decoded to zero bytes — not stored.",
      );
      return null;
    }
    if (bytes.length > CONFIG.OFFER_MAX_BYTES) {
      throw badRequest(
        "The offer letter is too large. Please keep it under 8 MB.",
      );
    }

    fs.mkdirSync(CONFIG.OFFER_DIR, { recursive: true });
    const ext = MIME_EXT[mime] || path.extname(file.fileName || "") || ".bin";
    const safe = `offer-${requestId}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}${ext}`;
    const fullPath = path.join(CONFIG.OFFER_DIR, safe);
    fs.writeFileSync(fullPath, bytes);

    // Verify rather than assume. A write can appear to succeed and leave
    // nothing readable behind — a full disk, a bind mount, a path that isn't
    // where you think it is. Returning a URL for a file that isn't there is
    // the worst outcome: the database records a link that 404s forever, with
    // nothing in the logs to say why.
    if (!fs.existsSync(fullPath)) {
      console.error(
        `recruitment: wrote the offer letter but it is not on disk afterwards: ${fullPath}`,
      );
      return null;
    }

    const onDisk = fs.statSync(fullPath).size;
    const url = `${CONFIG.OFFER_BASE_URL}/${safe}`;
    // Logged at info level on every upload, because the single most common
    // failure here is the directory and the public URL pointing at different
    // places — each valid on its own, so nothing complains.
    console.log(
      `recruitment: offer letter stored\n` +
        `  file : ${fullPath} (${onDisk} bytes)\n` +
        `  url  : ${url}\n` +
        `  NOTE : the web server must map ${CONFIG.OFFER_BASE_URL}/<name> to ${CONFIG.OFFER_DIR}/<name>`,
    );
    return url;
  } catch (e) {
    if (e && e.status === 400) throw e; // size limit is a real user error
    console.error(
      `recruitment: OFFER LETTER NOT SAVED. Tried to write into ${CONFIG.OFFER_DIR} — ` +
        `${e && e.code ? e.code + ": " : ""}${e && e.message}`,
    );
    return null;
  }
}

/**
 * Report where offer letters are being written and whether that actually works.
 *
 * Exists because the two halves of this — the directory the bytes go to and the
 * URL written into the database — are separate settings that must agree, and
 * nothing else notices when they don't. This proves the writable half from the
 * server itself, so the question stops being guesswork.
 */
async function storageCheck() {
  const out = {
    offerDir: CONFIG.OFFER_DIR,
    offerBaseUrl: CONFIG.OFFER_BASE_URL,
    envDirSet: !!process.env.RECRUITMENT_OFFER_DIR,
    envUrlSet: !!process.env.RECRUITMENT_OFFER_BASE_URL,
    processUser:
      typeof process.getuid === "function"
        ? `uid ${process.getuid()}`
        : "unknown",
    cwd: process.cwd(),
    platform: process.platform,
    hostname: require("os").hostname(),
  };

  // The failure that looks like nothing: a Linux path on a Windows host. The
  // write succeeds locally, the URL points at the server, and the two never meet.
  if (process.platform === "win32" && CONFIG.OFFER_DIR.startsWith("/")) {
    out.platformMismatch = true;
    out.warning =
      "This backend is running on Windows with a Linux offer directory. Files are " +
      "being saved onto this machine's C: drive, not onto the web server, so every " +
      "stored URL will 404. Run the backend on the server, or set both " +
      "RECRUITMENT_OFFER_DIR and RECRUITMENT_OFFER_BASE_URL to a matching local pair.";
  }

  try {
    fs.mkdirSync(CONFIG.OFFER_DIR, { recursive: true });
    out.dirExists = true;
    const st = fs.statSync(CONFIG.OFFER_DIR);
    out.dirMode = "0" + (st.mode & 0o777).toString(8);

    // Actually write, don't just check permissions — that is the only proof.
    const probe = path.join(CONFIG.OFFER_DIR, `.probe-${Date.now()}`);
    fs.writeFileSync(probe, "probe");
    out.writable = fs.existsSync(probe);
    fs.unlinkSync(probe);

    const files = fs
      .readdirSync(CONFIG.OFFER_DIR)
      .filter((f) => !f.startsWith("."))
      .slice(-10);
    out.fileCount = fs
      .readdirSync(CONFIG.OFFER_DIR)
      .filter((f) => !f.startsWith(".")).length;
    out.recentFiles = files;
  } catch (e) {
    out.writable = false;
    out.error = `${e.code || ""} ${e.message}`.trim();
  }

  // What the database thinks it stored, to compare against what is on disk.
  try {
    const rows = await run(
      `SELECT offer_letter_path FROM recruitment_offer
        WHERE offer_letter_path IS NOT NULL AND is_deleted = 0
        ORDER BY offer_id DESC LIMIT 5`,
    );
    out.recentUrlsInDb = rows.map((r) => r.offer_letter_path);
    out.mismatch = out.recentUrlsInDb.some(
      (u) => !String(u).startsWith(CONFIG.OFFER_BASE_URL),
    );
  } catch (e) {
    out.recentUrlsInDb = [];
  }

  return out;
}

// ─── Notifications ───────────────────────────────────────────────────────────
/**
 * Email whoever the requisition now sits with. Fire-and-forget after commit:
 * never awaited, never throws. Requirement 8.
 */
function notify(requestId, action) {
  (async () => {
    try {
      const rows = await run(
        `SELECT * FROM recruitment_request WHERE request_id = ?`,
        [requestId],
      );
      if (!rows.length) return;
      const note = await resolveRecruitmentNotification(rows[0], action, run);
      if (note) await sendMail(note);
    } catch (e) {
      console.error(
        "recruitment: notification failed (action already saved):",
        e && e.message,
      );
    }
  })();
}

// ─── Activity ────────────────────────────────────────────────────────────────
function logActivity(
  q,
  requestId,
  action,
  fromStatus,
  toStatus,
  actor,
  remark,
) {
  return q(
    `INSERT INTO recruitment_activity
       (request_id, action, from_status, to_status, actor_mobile, actor_name, actor_role, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      requestId,
      action,
      fromStatus,
      toStatus,
      actor.mobile,
      actor.name,
      actor.role,
      remark || null,
    ],
  );
}

// ─── Meta ────────────────────────────────────────────────────────────────────
async function getMeta() {
  // The static lists first. They come from this file's own enums and need no
  // database, so they must not be able to fail — an empty Status or Type
  // dropdown is indistinguishable, to the person using it, from a broken app.
  const meta = {
    statuses: ALL_STATUSES,
    employmentTypes: ["Payroll", "Contract"],
    progressStages: [
      "Sourcing",
      "Screening",
      "Interviewing",
      "Selection",
      "Offer",
      "Joining",
    ],
    handlingDepartment: CONFIG.HANDLING_DEPARTMENT,
    departments: [],
  };

  // Departments come from `recruitment_department`, NOT `ticket_department`.
  // The MRF's Department is where the ROLE sits (Nursing, Diagnostics); the
  // ticketing list is who FIXES issues (Maintenance, Purchase). Offering the
  // latter here would let someone raise a requisition to hire a "Purchase" nurse.
  //
  // Wrapped because the table is created by recruitment.sql: if that has not
  // been run yet, this one query fails. It used to take the whole response with
  // it and leave EVERY dropdown empty, which pointed at the frontend rather than
  // at the missing migration. Now only the department list is affected, and the
  // log says exactly what to do.
  try {
    const depts = await run(
      `SELECT name FROM recruitment_department
        WHERE is_active = 1 ORDER BY sort_order, name`,
    );
    meta.departments = depts.map((d) => d.name);
  } catch (e) {
    console.error(
      "recruitment: could not read recruitment_department — run backend/sql/recruitment.sql. " +
        `(${e && e.message})`,
    );
    meta.departmentsUnavailable = true;
  }

  return meta;
}

// ─── List ────────────────────────────────────────────────────────────────────
async function listRequests(req) {
  const src = { ...req.query, ...(req.body || {}) };
  const actor = await loadActor(src);
  const scope = visibilityScope(actor);

  const where = ["r.is_deleted = 0", scope.sql];
  const params = [...scope.params];

  const status = str(src.status);
  const statusExact = str(src.statusExact);
  // Overdue is its own ADDITIVE flag, not a status. It has to compose: someone
  // filtering to "Assigned" and tapping "Overdue" means late Assigned ones, and
  // folding it into the status chain would silently drop one of the two.
  const overdue = str(src.overdue) === "1" || str(src.overdue) === "true";
  // The unit filter comes ONLY from a dedicated key, never from the actor's own
  // context — the same collision that made ticket lists come back empty.
  const filterUnit = str(src.filterUnit || src.filterLocation);
  const forDepartment = str(src.department);
  const employmentType = str(src.employmentType);
  const mine = str(src.mine) === "1" || str(src.mine) === "true";
  const q = str(src.q);

  if (statusExact && ALL_STATUSES.includes(statusExact)) {
    where.push("r.status = ?");
    params.push(statusExact);
  } else if (status === "Open") {
    where.push(`r.status NOT IN (${DONE_STATES.map(() => "?").join(",")})`);
    params.push(...DONE_STATES);
  } else if (status === "Overdue") {
    // Kept so the dashboard's Overdue tile keeps working as it did.
    where.push(
      `r.status NOT IN (${DONE_STATES.map(() => "?").join(",")}) AND r.target_close_date < CURDATE()`,
    );
    params.push(...DONE_STATES);
  } else if (status && ALL_STATUSES.includes(status)) {
    where.push("r.status = ?");
    params.push(status);
  }

  // Applied on top of whatever status filter is in play, so the two compose.
  if (overdue) {
    where.push(
      `r.status NOT IN (${DONE_STATES.map(() => "?").join(",")}) AND r.target_close_date < CURDATE()`,
    );
    params.push(...DONE_STATES);
  }

  if (filterUnit) {
    where.push("r.unit = ?");
    params.push(filterUnit);
  }
  if (forDepartment) {
    where.push("r.for_department = ?");
    params.push(forDepartment);
  }
  if (employmentType === "Payroll" || employmentType === "Contract") {
    where.push("r.employment_type = ?");
    params.push(employmentType);
  }
  if (mine) {
    where.push("r.raised_by_mobile = ?");
    params.push(actor.mobile);
  }
  if (q) {
    where.push(
      "(r.position LIKE ? OR r.request_ref LIKE ? OR r.for_department LIKE ?)",
    );
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const limit = Math.min(Math.max(parseInt(src.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(src.offset, 10) || 0, 0);

  const rows = await run(
    `SELECT r.* FROM recruitment_request r
      WHERE ${where.join(" AND ")}
      ORDER BY (r.status = 'Submitted') DESC, r.raised_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const countRows = await run(
    `SELECT COUNT(*) AS total FROM recruitment_request r WHERE ${where.join(" AND ")}`,
    params,
  );

  return {
    role: actor.role,
    department: actor.department,
    total: countRows[0]?.total ?? 0,
    limit,
    offset,
    requests: rows.map((r) => mapRequest(r, actor)),
  };
}

// ─── Detail ──────────────────────────────────────────────────────────────────
async function getRequest(req) {
  const src = { ...req.query, ...(req.body || {}) };
  const actor = await loadActor(src);
  const key = str(req.params.id || src.requestId);
  if (!key) throw badRequest("A requisition id is required.");

  const rows = await run(
    `SELECT * FROM recruitment_request
      WHERE (request_ref = ? OR request_id = ?) AND is_deleted = 0 LIMIT 1`,
    [key, /^\d+$/.test(key) ? key : 0],
  );
  if (!rows.length) throw notFound("That requisition no longer exists.");
  const r = rows[0];

  // Same scope as the list, applied to this one row.
  const scope = visibilityScope(actor);
  const allowed = await run(
    `SELECT 1 FROM recruitment_request r WHERE r.request_id = ? AND ${scope.sql} LIMIT 1`,
    [r.request_id, ...scope.params],
  );
  if (!allowed.length)
    throw forbidden("You do not have access to this requisition.");

  const [activity, offers] = await Promise.all([
    run(
      `SELECT action, from_status, to_status, actor_name, actor_role, remark, created_at
         FROM recruitment_activity WHERE request_id = ? ORDER BY activity_id ASC`,
      [r.request_id],
    ),
    run(
      `SELECT * FROM recruitment_offer
        WHERE request_id = ? AND is_deleted = 0 ORDER BY offer_id ASC`,
      [r.request_id],
    ),
  ]);

  return {
    ...mapRequest(r, actor),
    activity: activity.map((a) => ({
      action: a.action,
      fromStatus: a.from_status,
      toStatus: a.to_status,
      actorName: a.actor_name,
      actorRole: a.actor_role,
      remark: a.remark,
      at: a.created_at,
    })),
    offers: offers.map((o) => ({
      offerId: o.offer_id,
      label: o.label,
      offerDate: o.offer_date,
      offerLetterUrl: o.offer_letter_path || null,
      fileName: o.file_name,
      joiningDate: o.joining_date,
      status: o.status,
      replacedByOfferId: o.replaced_by_offer_id,
      remark: o.remark,
      addedBy: o.added_by_name,
      at: o.created_at,
    })),
  };
}

// ─── Create (the MRF) ────────────────────────────────────────────────────────
async function createRequest(req) {
  const body = req.body || {};
  const actor = await loadActor(body);

  if (actor.role !== ROLES.CLUSTER_HEAD && actor.role !== ROLES.SUPER_ADMIN) {
    throw forbidden("Only a Cluster Head can raise a manpower requisition.");
  }

  const position = str(body.position);
  // The unit is the clinic and is required — it is what scopes visibility.
  // The location is the city and is optional free text.
  const unit = str(body.unit || body.center || body.branch);
  const location = str(body.location);
  const forDepartment = str(body.forDepartment || body.department);
  if (!position) throw badRequest("Position is required.");
  if (!unit) throw badRequest("Unit is required.");
  if (!forDepartment) throw badRequest("Department is required.");

  const count = Math.max(parseInt(body.numberOfPositions, 10) || 1, 1);
  const employmentType =
    str(body.employmentType) === "Contract" ? "Contract" : "Payroll";
  const requisitionDate =
    str(body.requisitionDate) || new Date().toISOString().slice(0, 10);
  const raisedAt = toSqlDateTime(new Date());

  return withTransaction(async (q) => {
    const res = await q(
      `INSERT INTO recruitment_request
         (request_ref, position, number_of_positions, unit, for_department, location,
          employment_type, min_qualification, min_experience, industry_preference,
          requisition_date, reporting_to, salary_range, reason_for_recruitment,
          skill_sets, job_profile, current_handler,
          status, handling_department, raised_by_mobile, raised_by_name, raised_by_email, raised_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        "PENDING", // replaced below once we know the id
        position,
        count,
        unit,
        forDepartment,
        location || null,
        employmentType,
        str(body.minQualification) || null,
        str(body.minExperience) || null,
        str(body.industryPreference) || null,
        requisitionDate,
        str(body.reportingTo) || null,
        str(body.salaryRange) || null,
        str(body.reasonForRecruitment) || null,
        str(body.skillSets) || null,
        str(body.jobProfile) || null,
        str(body.currentHandler) || null,
        STATUS.SUBMITTED,
        CONFIG.HANDLING_DEPARTMENT,
        actor.mobile,
        actor.name,
        str(body.raisedByEmail) || null,
        raisedAt,
      ],
    );

    const requestId = res.insertId;
    const ref = `${CONFIG.REF_PREFIX}${CONFIG.REF_BASE + requestId}`;
    await q(
      `UPDATE recruitment_request SET request_ref = ? WHERE request_id = ?`,
      [ref, requestId],
    );

    await logActivity(
      q,
      requestId,
      "SUBMITTED",
      null,
      STATUS.SUBMITTED,
      actor,
      null,
    );

    return {
      success: true,
      requestId,
      id: ref,
      status: STATUS.SUBMITTED,
      message: `Requisition ${ref} submitted to the ${CONFIG.HANDLING_DEPARTMENT} department.`,
    };
  }).then((result) => {
    notify(result.requestId, "SUBMITTED");
    return result;
  });
}

// ─── Transitions ─────────────────────────────────────────────────────────────
async function transitionRequest(req, action) {
  const body = req.body || {};
  const actor = await loadActor(body);
  const key = str(req.params.id || body.requestId);
  if (!key) throw badRequest("A requisition id is required.");

  const spec = TRANSITIONS[action];
  if (!spec) throw badRequest("That action does not exist.");

  return withTransaction(async (q) => {
    const rows = await q(
      `SELECT * FROM recruitment_request
        WHERE (request_ref = ? OR request_id = ?) AND is_deleted = 0 LIMIT 1 FOR UPDATE`,
      [key, /^\d+$/.test(key) ? key : 0],
    );
    if (!rows.length) throw notFound("That requisition no longer exists.");
    const r = rows[0];

    if (!actionsFor(r, actor).includes(action)) {
      throw forbidden(
        `You cannot ${spec.label.toLowerCase()} a requisition that is ${r.status}.`,
      );
    }

    const now = toSqlDateTime(new Date());
    const sets = [];
    const params = [];
    let toStatus = spec.to;

    if (action === "approve") {
      const assigneeMobile = str(body.assigneeMobile);
      if (!assigneeMobile)
        throw badRequest("Choose who will work on this requisition.");
      const who = await q(
        `SELECT name FROM ticket_user
          WHERE mobile = ? AND department = ? AND is_active = 1 AND is_deleted = 0 LIMIT 1`,
        [assigneeMobile, r.handling_department],
      );
      if (!who.length) {
        throw badRequest("That person is not in this department.");
      }
      // Requirement 4 — the head sets how long there is to close the position.
      const days = Math.max(
        parseInt(body.targetDays, 10) || CONFIG.DEFAULT_TARGET_DAYS,
        1,
      );
      const explicit = str(body.targetCloseDate);
      sets.push(
        "status = ?",
        "reviewed_by_mobile = ?",
        "reviewed_by_name = ?",
        "reviewed_at = ?",
        "review_remark = ?",
        "assignee_mobile = ?",
        "assignee_name = ?",
        explicit
          ? "target_close_date = ?"
          : "target_close_date = DATE_ADD(CURDATE(), INTERVAL ? DAY)",
      );
      params.push(
        STATUS.ASSIGNED,
        actor.mobile,
        actor.name,
        now,
        str(body.remark) || null,
        assigneeMobile,
        who[0].name,
        explicit || days,
      );
    } else if (action === "reject") {
      const remark = str(body.remark);
      if (!remark) throw badRequest("Add a comment explaining the rejection.");
      sets.push(
        "status = ?",
        "reviewed_by_mobile = ?",
        "reviewed_by_name = ?",
        "reviewed_at = ?",
        "review_remark = ?",
      );
      params.push(STATUS.REJECTED, actor.mobile, actor.name, now, remark);
    } else if (action === "progress") {
      const remark = str(body.remark);
      if (!remark) throw badRequest("Describe the progress before saving.");
      sets.push("status = ?", "progress_stage = ?");
      params.push(
        STATUS.IN_PROGRESS,
        str(body.progressStage) || r.progress_stage || null,
      );
    } else if (action === "reassign") {
      const assigneeMobile = str(body.assigneeMobile);
      if (!assigneeMobile) throw badRequest("Choose who to reassign this to.");
      const who = await q(
        `SELECT name FROM ticket_user
          WHERE mobile = ? AND department = ? AND is_active = 1 AND is_deleted = 0 LIMIT 1`,
        [assigneeMobile, r.handling_department],
      );
      if (!who.length)
        throw badRequest("That person is not in this department.");
      sets.push("assignee_mobile = ?", "assignee_name = ?");
      params.push(assigneeMobile, who[0].name);
      toStatus = null;
    } else if (action === "retarget") {
      const explicit = str(body.targetCloseDate);
      const days = parseInt(body.targetDays, 10);
      if (!explicit && !days) throw badRequest("Give a new target date.");
      sets.push(
        explicit
          ? "target_close_date = ?"
          : "target_close_date = DATE_ADD(CURDATE(), INTERVAL ? DAY)",
      );
      params.push(explicit || days);
      toStatus = null;
    } else if (action === "close") {
      // Record WHAT closing meant. Derived from the offers actually on file,
      // because that is the evidence — but a head who is closing an unfilled
      // requisition must say so explicitly, rather than leaving a position that
      // looks abandoned. This is what stops the dashboard reporting "0 of 1
      // filled" for a role that was, in fact, filled: if nothing is recorded,
      // the close asks for it instead of quietly accepting the gap.
      const filled = Number(r.positions_filled || 0);
      const wanted = Number(r.number_of_positions || 1);
      let outcome = str(body.outcome);

      if (!outcome) {
        if (filled >= wanted) outcome = "Filled";
        else if (filled > 0) outcome = "Partially Filled";
        else {
          throw badRequest(
            "No joining date has been recorded for this requisition, so it cannot be " +
              "closed as filled. Record the offer letter and joining date first, or " +
              "close it as 'Not Filled' with a reason.",
          );
        }
      }
      if (!["Filled", "Partially Filled", "Not Filled"].includes(outcome)) {
        throw badRequest(
          "Choose what closing this means: Filled, Partially Filled, or Not Filled.",
        );
      }
      // Claiming "Filled" with nothing on record would put the dashboard and
      // the paperwork permanently at odds.
      if (outcome !== "Not Filled" && filled === 0) {
        throw badRequest(
          "This requisition has no joining date on record, so it cannot be closed as filled. " +
            "Add the offer letter and joining date first.",
        );
      }
      if (outcome === "Not Filled" && !str(body.remark)) {
        throw badRequest(
          "Add a short reason for closing this without filling it.",
        );
      }

      sets.push(
        "status = ?",
        "close_outcome = ?",
        "closed_by_mobile = ?",
        "closed_by_name = ?",
        "closed_at = ?",
        "close_remark = ?",
      );
      params.push(
        STATUS.CLOSED,
        outcome,
        actor.mobile,
        actor.name,
        now,
        str(body.remark) || null,
      );
    }

    await q(
      `UPDATE recruitment_request SET ${sets.join(", ")} WHERE request_id = ?`,
      [...params, r.request_id],
    );

    await logActivity(
      q,
      r.request_id,
      ACTION_LOG[action] || action.toUpperCase(),
      r.status,
      toStatus,
      actor,
      str(body.remark) || null,
    );

    return {
      success: true,
      requestId: r.request_id,
      id: r.request_ref,
      fromStatus: r.status,
      status: toStatus || r.status,
      message: `${r.request_ref} is now ${toStatus || r.status}.`,
    };
  }).then((result) => {
    notify(result.requestId, ACTION_LOG[action] || action.toUpperCase());
    return result;
  });
}

// ─── Offer letters (requirement 6) ───────────────────────────────────────────
/**
 * Recompute the request's running totals from its offers, and move the status
 * along. Kept in one place so the two can never disagree.
 *
 * The status follows the offers but never moves backwards and never disturbs a
 * requisition that is already Closed or Rejected.
 */
async function syncOfferTotals(q, requestId, currentStatus, actor) {
  // A replaced letter is kept for the audit trail but is not a live offer, so
  // it counts toward neither the totals nor the position cap.
  const rows = await q(
    `SELECT COUNT(*) AS total,
            SUM(joining_date IS NOT NULL) AS joined
       FROM recruitment_offer
      WHERE request_id = ? AND is_deleted = 0 AND status <> 'Replaced'`,
    [requestId],
  );
  const total = Number(rows[0]?.total || 0);
  const joined = Number(rows[0]?.joined || 0);

  // How many were asked for, so we know when the requisition is complete.
  const want = await q(
    `SELECT number_of_positions FROM recruitment_request WHERE request_id = ?`,
    [requestId],
  );
  const wanted = Number(want[0]?.number_of_positions || 1);

  let status = currentStatus;
  let autoClosed = false;
  if (!DONE_STATES.includes(currentStatus)) {
    if (joined >= wanted) {
      // Every position has someone joining, so there is nothing left to decide.
      // Closing it here rather than waiting for a button means the requisition
      // can never sit finished-but-open, and it is why the Close action is not
      // offered once the last joining date goes in — there would be nothing for
      // it to do.
      status = STATUS.CLOSED;
      autoClosed = true;
    } else if (joined > 0) status = STATUS.JOINED;
    else if (total > 0) status = STATUS.OFFER_RELEASED;
  }

  if (autoClosed) {
    await q(
      `UPDATE recruitment_request
          SET offer_released = ?, positions_filled = ?, status = ?,
              close_outcome = 'Filled',
              closed_by_mobile = ?, closed_by_name = ?, closed_at = ?,
              close_remark = COALESCE(close_remark, ?)
        WHERE request_id = ?`,
      [
        total > 0 ? 1 : 0,
        joined,
        status,
        actor ? actor.mobile : null,
        actor ? actor.name : "System",
        toSqlDateTime(new Date()),
        `All ${wanted} position(s) filled.`,
        requestId,
      ],
    );
  } else {
    await q(
      `UPDATE recruitment_request
          SET offer_released = ?, positions_filled = ?, status = ?
        WHERE request_id = ?`,
      [total > 0 ? 1 : 0, joined, status, requestId],
    );
  }

  return { total, joined, wanted, status, autoClosed };
}

/** Load the requisition for an offer operation, checking permission. */
async function loadForOffer(q, key, actor) {
  const rows = await q(
    `SELECT * FROM recruitment_request
      WHERE (request_ref = ? OR request_id = ?) AND is_deleted = 0 LIMIT 1 FOR UPDATE`,
    [key, /^\d+$/.test(key) ? key : 0],
  );
  if (!rows.length) throw notFound("That requisition no longer exists.");
  const r = rows[0];
  if (!actionsFor(r, actor).includes("addOffer")) {
    throw forbidden("You cannot record offer letters on this requisition.");
  }
  return r;
}

/**
 * Add an offer letter — one per position filled, so this can be called several
 * times on the same requisition. No candidate identity is captured: the row is
 * the letter, its date, and (later) the joining date.
 */
async function addOffer(req) {
  const body = req.body || {};
  const actor = await loadActor(body);
  const key = str(req.params.id || body.requestId);
  if (!key) throw badRequest("A requisition id is required.");

  const offerDate =
    str(body.offerDate) || new Date().toISOString().slice(0, 10);
  const joiningDate = str(body.joiningDate) || null;
  if (!body.offerLetter && !str(body.offerDate)) {
    throw badRequest(
      "Attach the offer letter, or give the date it was issued.",
    );
  }

  return withTransaction(async (q) => {
    const r = await loadForOffer(q, key, actor);

    // Guard against filling more positions than were requested.
    const live = await q(
      `SELECT COUNT(*) AS n FROM recruitment_offer
        WHERE request_id = ? AND is_deleted = 0 AND status <> 'Replaced'`,
      [r.request_id],
    );
    if (Number(live[0].n) >= Number(r.number_of_positions)) {
      throw badRequest(
        `This requisition is for ${r.number_of_positions} position(s) and already has that many live offer letters. ` +
          `If an offer was declined, replace that letter instead of adding another.`,
      );
    }

    const letterUrl = saveOfferLetter(r.request_id, body.offerLetter);
    await q(
      `INSERT INTO recruitment_offer
         (request_id, label, offer_date, offer_letter_path, file_name, joining_date,
          remark, added_by_mobile, added_by_name)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        r.request_id,
        str(body.label) || null,
        offerDate,
        letterUrl,
        (body.offerLetter && str(body.offerLetter.fileName)) || null,
        joiningDate,
        str(body.remark) || null,
        actor.mobile,
        actor.name,
      ],
    );

    const totals = await syncOfferTotals(q, r.request_id, r.status, actor);
    await logActivity(
      q,
      r.request_id,
      joiningDate ? "JOINED" : "OFFER_RELEASED",
      r.status,
      totals.status !== r.status ? totals.status : null,
      actor,
      `${totals.total} of ${r.number_of_positions} position(s) — offer dated ${offerDate}` +
        (joiningDate ? `, joining ${joiningDate}` : ""),
    );

    return {
      success: true,
      requestId: r.request_id,
      id: r.request_ref,
      status: totals.status,
      offersTotal: totals.total,
      positionsFilled: totals.joined,
      action: joiningDate ? "JOINED" : "OFFER_RELEASED",
      autoClosed: totals.autoClosed,
      message: totals.autoClosed
        ? `Offer letter recorded with a joining date. All ${r.number_of_positions} ` +
          `position(s) are filled, so ${r.request_ref} has been closed.`
        : `Offer letter recorded (${totals.total} of ${r.number_of_positions}).`,
    };
  }).then((result) => {
    // If filling the last position closed the requisition, the event that
    // matters is the CLOSE — that is what requirement 8 says the Cluster Head
    // must hear about. Sending "you can close this" for something already
    // closed would be both wrong and a missed obligation.
    notify(result.requestId, result.autoClosed ? "CLOSED" : result.action);
    return result;
  });
}

/**
 * Update one offer letter — normally to record the joining date once the person
 * starts. Also handles removing a letter that was added by mistake.
 */
async function updateOffer(req) {
  const body = req.body || {};
  const actor = await loadActor(body);
  const key = str(req.params.id || body.requestId);
  const offerId = parseInt(req.params.offerId || body.offerId, 10);
  if (!key || !offerId)
    throw badRequest("A requisition and offer are required.");

  return withTransaction(async (q) => {
    const r = await loadForOffer(q, key, actor);
    const existing = await q(
      `SELECT * FROM recruitment_offer
        WHERE offer_id = ? AND request_id = ? AND is_deleted = 0 LIMIT 1`,
      [offerId, r.request_id],
    );
    if (!existing.length) throw notFound("That offer letter no longer exists.");

    if (body.remove) {
      await q(
        `UPDATE recruitment_offer SET is_deleted = 1 WHERE offer_id = ?`,
        [offerId],
      );
      const totals = await syncOfferTotals(q, r.request_id, r.status, actor);
      await logActivity(
        q,
        r.request_id,
        "OFFER_REMOVED",
        r.status,
        null,
        actor,
        "Offer letter removed",
      );
      return {
        success: true,
        requestId: r.request_id,
        id: r.request_ref,
        status: totals.status,
        action: "OFFER_REMOVED",
        message: "Offer letter removed.",
      };
    }

    const joiningDate = str(body.joiningDate) || null;
    const letterUrl = saveOfferLetter(r.request_id, body.offerLetter);
    await q(
      `UPDATE recruitment_offer
          SET status = CASE WHEN ? IS NOT NULL THEN 'Joined' ELSE status END,
              joining_date = COALESCE(?, joining_date),
              offer_date   = COALESCE(?, offer_date),
              label        = COALESCE(?, label),
              remark       = COALESCE(?, remark),
              offer_letter_path = COALESCE(?, offer_letter_path),
              file_name    = COALESCE(?, file_name)
        WHERE offer_id = ?`,
      [
        joiningDate,
        joiningDate,
        str(body.offerDate) || null,
        str(body.label) || null,
        str(body.remark) || null,
        letterUrl,
        (body.offerLetter && str(body.offerLetter.fileName)) || null,
        offerId,
      ],
    );

    const totals = await syncOfferTotals(q, r.request_id, r.status, actor);
    const action = joiningDate ? "JOINED" : "OFFER_UPDATED";
    await logActivity(
      q,
      r.request_id,
      action,
      r.status,
      totals.status !== r.status ? totals.status : null,
      actor,
      joiningDate
        ? `Joining ${joiningDate} — ${totals.joined} of ${r.number_of_positions} filled`
        : "Offer letter updated",
    );

    return {
      success: true,
      requestId: r.request_id,
      id: r.request_ref,
      status: totals.status,
      positionsFilled: totals.joined,
      action,
      autoClosed: totals.autoClosed,
      message: joiningDate
        ? totals.autoClosed
          ? `Joining recorded. All ${r.number_of_positions} position(s) are filled, ` +
            `so ${r.request_ref} has been closed.`
          : `Joining recorded (${totals.joined} of ${r.number_of_positions} filled).`
        : "Offer letter updated.",
    };
  }).then((result) => {
    notify(result.requestId, result.action);
    return result;
  });
}

/**
 * Replace an offer letter — the offer was declined, or the position is being
 * re-offered to someone else. The original row is marked 'Replaced' (kept, so
 * the history of what was issued stays intact) and a fresh letter takes its
 * place, which frees the position back up against the requisition's cap.
 *
 * This exists so a declined offer never leaves a requisition stuck at its
 * position limit with no way forward.
 */
async function replaceOffer(req) {
  const body = req.body || {};
  const actor = await loadActor(body);
  const key = str(req.params.id || body.requestId);
  const offerId = parseInt(req.params.offerId || body.offerId, 10);
  if (!key || !offerId)
    throw badRequest("A requisition and offer are required.");

  return withTransaction(async (q) => {
    const r = await loadForOffer(q, key, actor);
    const existing = await q(
      `SELECT * FROM recruitment_offer
        WHERE offer_id = ? AND request_id = ? AND is_deleted = 0 LIMIT 1`,
      [offerId, r.request_id],
    );
    if (!existing.length) throw notFound("That offer letter no longer exists.");
    if (existing[0].status === "Replaced") {
      throw badRequest("That letter has already been replaced.");
    }
    if (existing[0].status === "Joined") {
      throw badRequest(
        "That position has already been filled. Remove the joining date first if it was recorded in error.",
      );
    }

    const offerDate =
      str(body.offerDate) || new Date().toISOString().slice(0, 10);
    const letterUrl = saveOfferLetter(r.request_id, body.offerLetter);

    // The replacement carries the original's label unless a new one is given,
    // so "Position 2" stays "Position 2" through a re-offer.
    const res = await q(
      `INSERT INTO recruitment_offer
         (request_id, label, offer_date, offer_letter_path, file_name, joining_date,
          status, remark, added_by_mobile, added_by_name)
       VALUES (?,?,?,?,?,?, 'Issued', ?,?,?)`,
      [
        r.request_id,
        str(body.label) || existing[0].label,
        offerDate,
        letterUrl,
        (body.offerLetter && str(body.offerLetter.fileName)) || null,
        str(body.joiningDate) || null,
        str(body.remark) || null,
        actor.mobile,
        actor.name,
      ],
    );

    await q(
      `UPDATE recruitment_offer
          SET status = 'Replaced', replaced_by_offer_id = ?
        WHERE offer_id = ?`,
      [res.insertId, offerId],
    );

    const totals = await syncOfferTotals(q, r.request_id, r.status, actor);
    await logActivity(
      q,
      r.request_id,
      "OFFER_REPLACED",
      r.status,
      totals.status !== r.status ? totals.status : null,
      actor,
      `${existing[0].label || "A position"} re-offered` +
        (str(body.reason) ? ` — ${str(body.reason)}` : ""),
    );

    return {
      success: true,
      requestId: r.request_id,
      id: r.request_ref,
      status: totals.status,
      offerId: res.insertId,
      replacedOfferId: offerId,
      action: "OFFER_REPLACED",
      message:
        "Offer letter replaced. The previous one is kept in the history.",
    };
  }).then((result) => {
    notify(result.requestId, result.autoClosed ? "CLOSED" : result.action);
    return result;
  });
}

// ─── Dashboard (requirement 7) ───────────────────────────────────────────────
async function getDashboard(req) {
  const src = { ...req.query, ...(req.body || {}) };
  const actor = await loadActor(src);
  const scope = visibilityScope(actor);
  const where = `r.is_deleted = 0 AND ${scope.sql}`;
  const p = scope.params;

  const [totals, byStatus, byUnit, byDept, pipeline, joiners] =
    await Promise.all([
      run(
        `SELECT
         COUNT(*) AS total,
         SUM(r.status NOT IN ('Closed','Rejected')) AS open,
         SUM(r.status = 'Submitted') AS toReview,
         SUM(r.status NOT IN ('Closed','Rejected') AND r.target_close_date < CURDATE()) AS overdue,
         SUM(r.status = 'Closed') AS closed,
         -- Positions we actually set out to fill. A rejected requisition was
         -- never approved, and one closed as 'Not Filled' was withdrawn — so
         -- counting either against the fill rate says we failed to hire someone
         -- we never intended to hire. That is what made a closed, cancelled
         -- position read as "0 of 1 filled".
         SUM(
           CASE WHEN r.status = 'Rejected'
                  OR (r.status = 'Closed' AND r.close_outcome = 'Not Filled')
                THEN 0 ELSE r.number_of_positions END
         ) AS positions,
         -- Shown separately rather than hidden, so withdrawn demand stays visible.
         SUM(
           CASE WHEN r.status = 'Rejected'
                  OR (r.status = 'Closed' AND r.close_outcome = 'Not Filled')
                THEN r.number_of_positions ELSE 0 END
         ) AS positionsWithdrawn,
         SUM(r.positions_filled) AS filled
       FROM recruitment_request r WHERE ${where}`,
        p,
      ),
      run(
        `SELECT r.status, COUNT(*) AS n FROM recruitment_request r
        WHERE ${where} GROUP BY r.status`,
        p,
      ),
      run(
        `SELECT r.unit, COUNT(*) AS open,
              SUM(r.target_close_date < CURDATE()) AS overdue,
              SUM(r.number_of_positions) AS positions,
         SUM(r.positions_filled) AS filled
         FROM recruitment_request r
        WHERE ${where} AND r.status NOT IN ('Closed','Rejected')
        GROUP BY r.unit ORDER BY open DESC`,
        p,
      ),
      run(
        `SELECT r.for_department AS department, COUNT(*) AS open,
              SUM(r.target_close_date < CURDATE()) AS overdue,
              SUM(r.number_of_positions) AS positions,
         SUM(r.positions_filled) AS filled
         FROM recruitment_request r
        WHERE ${where} AND r.status NOT IN ('Closed','Rejected')
        GROUP BY r.for_department ORDER BY open DESC`,
        p,
      ),
      run(
        // Where each open requisition has got to.
        //
        // The STATUS wins wherever it knows better, and the hand-entered
        // progress_stage only fills the middle. Reading the stage alone went
        // stale: an offer could be out while the stage still said "Screening",
        // because nothing updates it when a letter is recorded. It also lumped a
        // requisition awaiting approval together with one HR simply hadn't
        // started — two very different situations.
        `SELECT CASE
                WHEN r.status = 'Submitted'      THEN 'Awaiting approval'
                WHEN r.status = 'Joined'         THEN 'Joined'
                WHEN r.status = 'Offer Released' THEN 'Offer released'
                WHEN r.progress_stage IS NOT NULL AND r.progress_stage <> ''
                                                 THEN r.progress_stage
                WHEN r.status = 'Assigned'       THEN 'Not started'
                ELSE 'In progress'
              END AS stage,
              COUNT(*) AS n
         FROM recruitment_request r
        WHERE ${where} AND r.status NOT IN ('Closed','Rejected')
        GROUP BY stage`,
        p,
      ),
      // Requirement 6 on the dashboard: positions with someone joining soon.
      // Read from the request — there is no candidate table by design.
      run(
        `SELECT r.request_ref, r.position, r.unit, r.location, r.for_department, o.joining_date
         FROM recruitment_offer o
         JOIN recruitment_request r ON r.request_id = o.request_id
        WHERE ${where} AND o.is_deleted = 0
          AND o.joining_date IS NOT NULL AND o.joining_date >= CURDATE()
        ORDER BY o.joining_date ASC LIMIT 10`,
        p,
      ),
    ]);

  const t = totals[0] || {};
  const statusMap = {};
  byStatus.forEach((s) => {
    statusMap[s.status] = Number(s.n);
  });

  return {
    role: actor.role,
    department: actor.department,
    total: Number(t.total || 0),
    open: Number(t.open || 0),
    toReview: Number(t.toReview || 0),
    overdue: Number(t.overdue || 0),
    closed: Number(t.closed || 0),
    positions: Number(t.positions || 0),
    positionsFilled: Number(t.filled || 0),
    positionsWithdrawn: Number(t.positionsWithdrawn || 0),
    byStatus: statusMap,
    byUnit: byUnit.map((x) => ({
      unit: x.unit,
      open: Number(x.open),
      overdue: Number(x.overdue || 0),
      positions: Number(x.positions || 0),
    })),
    byDepartment: byDept.map((x) => ({
      department: x.department,
      open: Number(x.open),
      overdue: Number(x.overdue || 0),
      positions: Number(x.positions || 0),
    })),
    // Ordered along the hiring journey, not by count — a pipeline read out of
    // sequence is harder to make sense of than no pipeline at all.
    pipeline: (() => {
      const ORDER = [
        "Awaiting approval",
        "Not started",
        "Sourcing",
        "Screening",
        "Interviewing",
        "Selection",
        "In progress",
        "Offer",
        "Offer released",
        "Joining",
        "Joined",
      ];
      return pipeline
        .map((x) => ({ stage: x.stage, n: Number(x.n) }))
        .sort((a, b) => {
          const ia = ORDER.indexOf(a.stage);
          const ib = ORDER.indexOf(b.stage);
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        });
    })(),
    upcomingJoiners: joiners.map((j) => ({
      requestRef: j.request_ref,
      position: j.position,
      unit: j.unit,
      location: j.location,
      department: j.for_department,
      joiningDate: j.joining_date,
    })),
  };
}

/** The department's people, for the "assign to" picker. */
async function listDepartmentUsers(req) {
  const src = { ...req.query, ...(req.body || {}) };
  const actor = await loadActor(src);
  if (actor.role !== ROLES.DEPT_HEAD && actor.role !== ROLES.SUPER_ADMIN) {
    throw forbidden("Only a Department Head can see the department's people.");
  }
  const dept = actor.department || CONFIG.HANDLING_DEPARTMENT;
  const rows = await run(
    `SELECT mobile, name, email, ticket_role FROM ticket_user
      WHERE department = ? AND is_active = 1 AND is_deleted = 0
      ORDER BY ticket_role, name`,
    [dept],
  );
  return { department: dept, users: rows };
}

module.exports = {
  CONFIG,
  STATUS,
  ALL_STATUSES,
  TRANSITIONS,
  ACTION_LOG,
  visibilityScope,
  actionsFor,
  getMeta,
  listRequests,
  getRequest,
  createRequest,
  transitionRequest,
  addOffer,
  updateOffer,
  replaceOffer,
  getDashboard,
  listDepartmentUsers,
  storageCheck,
};
