// src/models/websiteAppointmentModel.js
// ─────────────────────────────────────────────────────────────────────────────
// Website "Book Appointment" form — Node port of book-appointment-mail.php.
//
// Same steps, same order of outcomes, same JSON replies:
//   1. Validate apptDate (d/m/Y, a real calendar date)
//   2. Require fname + phone                  → 'Missing required fields'
//   3. INSERT into hhc_appointments.appointments (same columns as the PHP)
//   4. Mail the branch: TO admin inbox, CC the branch list
//                                             → 'Mailer Error: …' on failure
//   5. Confirmation mail to the patient (best effort, never fails the request)
//                                             → 'Mail sent successfully'
//
// Deliberate differences from the PHP (all bug fixes, none change a reply):
//   • fname/phone are checked BEFORE the insert, so an empty submission no
//     longer writes a blank row. (The PHP inserted first, then checked.)
//   • An invalid date replies with JSON instead of the PHP's plain-text die().
//   • A failed DB insert is logged instead of silently ignored. As in the PHP,
//     the mail still goes out, so a DB problem never loses the lead.
//   • Form values are HTML-escaped in both mails and the insert is
//     parameterised (the PHP put raw input into the mail HTML).
//   • Recipients are de-duplicated, and the patient mail is skipped when the
//     form had no email address.
//
// Mail goes through the shared ticketing mailer (src/services/mailer.js), so it
// uses the same TICKETING_SMTP_* settings in .env — nothing new to configure.
// ─────────────────────────────────────────────────────────────────────────────

const { getConnectionByLocation } = require("../../databaseUtils");
const { BOOKING_RECIPIENTS } = require("../config/bookingRecipients");

const { sendMail, isConfigured } = require("../services/mailer");

const FROM_NAME = "Healing Hands Clinic";
const ADMIN_TO = "innothoughtsadwords@gmail.com"; // same main receiver as the PHP

/* ── Helpers ──────────────────────────────────────────────────────────────── */

const str = (v) => (v == null ? "" : String(v)).trim();

// PHP ucfirst: upper-cases the first character only.
const ucfirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * PHP: DateTime::createFromFormat('d/m/Y', …) with warning/error checks.
 * Accepts d/m/Y (1- or 2-digit day/month), rejects non-dates like 31/02/2026.
 * Returns 'YYYY-MM-DD' or null.
 */
function parseApptDate(input) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str(input));
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

// PHP date('H:i:s') with date_default_timezone_set("Asia/Kolkata").
function nowTimeIST() {
  const t = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}:${pad2(t.getUTCSeconds())}`;
}

/* ── DB ───────────────────────────────────────────────────────────────────── */

const INSERT_SQL = `
  INSERT INTO appointments
    (name, email_id, phoneno, source, date, appt_slot, pageurl, appt_type,
     selected_area, payment_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
`;

function insertAppointment(f) {
  const { connection } = getConnectionByLocation("lead"); // hhc_appointments
  if (!connection)
    return Promise.reject(new Error("No connection for hhc_appointments"));
  return new Promise((resolve, reject) =>
    connection.query(
      INSERT_SQL,
      [
        f.fname,
        f.email,
        f.phone,
        f.source,
        f.apptDate,
        f.selectedSlot,
        f.previousUrl,
        f.apptType,
        f.branch,
        f.paymentData,
      ],
      (err, res) => (err ? reject(err) : resolve(res)),
    ),
  );
}

/* ── Mail bodies (same text as the PHP) ──────────────────────────────────── */

function adminHtml(f) {
  let msg = "<h3>New Appointment Details</h3>";
  msg += `<strong>Name:</strong> ${esc(f.fname)}<br>`;
  msg += `<strong>Email:</strong> ${esc(f.email)}<br>`;
  msg += `<strong>Contact No.:</strong> ${esc(f.phone)}<br>`;
  msg += `<strong>Type:</strong> ${esc(ucfirst(f.apptType))} Consultation<br>`;
  msg += `<strong>Date:</strong> ${esc(f.apptDate)}<br>`;
  msg += `<strong>Time Slot:</strong> ${esc(f.selectedSlot)}<br>`;
  msg += `<strong>Branch:</strong> ${esc(f.branch)}<br>`;
  msg += `<strong>Source:</strong> ${esc(f.source)}<br>`;
  if (f.apptType === "online") {
    msg += `<strong>Amount Paid:</strong> ₹${esc(f.amount)}<br>`;
    msg += `<strong>Payment ID:</strong> ${esc(f.paymentId)}<br>`;
    msg += "<strong>Payment Status:</strong> Successful<br>";
  }
  msg += `<strong>Page Url:</strong> ${esc(f.previousUrl)}<br>`;
  return msg;
}

function patientHtml(f) {
  return `
        <p>Dear ${esc(f.fname)},</p>
        <p>Thank you for booking your appointment with Healing Hands Clinic ${esc(f.branch)}.</p>
        <p>We have received your request for an appointment on <strong>${esc(f.apptDate)}</strong> in <strong>${esc(f.selectedSlot)}</strong>. Our team will contact you shortly to confirm your appointment slot and share further details.</p>
        <p>At Healing Hands Clinic, we are committed to providing advanced, compassionate, and patient-focused care with a team of experienced specialists across multiple centers in India.</p>
        <p>For any immediate assistance, please feel free to reply to this email or contact us on <strong>8888988882</strong>.</p>
        <br>
        <p>Regards,<br>Team Healing Hands Clinic</p>`;
}

/** Subject + CC list for a branch. Unknown branch → admin only, generic subject. */
function routeFor(branch, apptType) {
  const type = ucfirst(apptType);
  const entry = BOOKING_RECIPIENTS[branch];
  if (!entry) {
    return {
      known: false,
      subject: `New Appointment Request - ${type}`,
      cc: [],
    };
  }
  return {
    known: true,
    subject: `${entry.label} - ${type} Appointment Details`,
    cc: entry.recipients,
  };
}

// "Name <email>" list, de-duplicated case-insensitively and excluding `skip`.
function addressList(list, skip = []) {
  const seen = new Set(skip.map((e) => e.toLowerCase()));
  const out = [];
  for (const { email, name } of list) {
    const k = String(email).toLowerCase();
    if (!email || seen.has(k)) continue;
    seen.add(k);
    out.push(name ? { name, address: email } : email);
  }
  return out;
}

/* ── Main ─────────────────────────────────────────────────────────────────── */

/**
 * @param {object} body  the posted form fields
 * @returns {Promise<{status:'success'|'error', message:string}>}  never rejects
 */
async function bookWebsiteAppointment(body = {}) {
  const f = {
    fname: str(body.fname),
    email: str(body.email),
    phone: str(body.phone),
    source: str(body.source),
    selectedSlot: str(body.selectedSlot),
    apptType: str(body.apptType),
    branch: str(body.branch),
    paymentId: str(body.paymentId),
    amount: str(body.amount) || "0.00",
    previousUrl: str(body.previousUrl),
  };

  // 1 — date
  const day = parseApptDate(body.apptDate);
  if (!day) return { status: "error", message: "Invalid appointment date" };
  f.apptDate = `${day} ${nowTimeIST()}`;

  // 2 — required
  if (!f.fname || !f.phone) {
    return { status: "error", message: "Missing required fields" };
  }

  f.paymentData =
    f.apptType === "online"
      ? JSON.stringify({
          payment_id: f.paymentId,
          amount: f.amount,
          status: "Captured",
          method: "Razorpay",
        })
      : "";

  // 3 — insert (logged on failure; the mail still goes, as in the PHP)
  try {
    await insertAppointment(f);
  } catch (e) {
    console.error("websiteAppointment: insert failed —", e.message, {
      name: f.fname,
      phone: f.phone,
      branch: f.branch,
    });
  }

  // 4 — branch mail (TO admin, CC the branch list)
  if (!isConfigured()) {
    console.error(
      "websiteAppointment: TICKETING_SMTP_* not set in .env — mail not sent",
    );
    return { status: "error", message: "Mailer Error: SMTP is not configured" };
  }

  const route = routeFor(f.branch, f.apptType);
  if (!route.known) {
    console.warn(
      `websiteAppointment: branch "${f.branch}" has no recipient list — sent to admin only. ` +
        "Add it to src/config/bookingRecipients.js.",
    );
  }

  // sendMail never throws; it resolves { sent, reason }.
  const adminMail = await sendMail({
    fromName: FROM_NAME,
    to: ADMIN_TO,
    cc: addressList(route.cc, [ADMIN_TO]),
    subject: route.subject,
    html: adminHtml(f),
  });
  if (!adminMail.sent) {
    return {
      status: "error",
      message: `Mailer Error: ${adminMail.reason || "send failed"}`,
    };
  }

  // 5 — patient confirmation (best effort, like the PHP's unchecked Send()).
  // Not awaited: the reply shouldn't wait on a second SMTP round trip, and
  // sendMail logs its own failures.
  if (f.email) {
    sendMail({
      fromName: FROM_NAME,
      to: f.email,
      subject: "Appointment Confirmation at Healing Hands Clinic",
      html: patientHtml(f),
    });
  }

  return { status: "success", message: "Mail sent successfully" };
}

module.exports = {
  bookWebsiteAppointment,
  // exported for testing
  parseApptDate,
  routeFor,
  addressList,
};
