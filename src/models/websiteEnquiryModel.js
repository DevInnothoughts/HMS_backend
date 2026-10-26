// src/models/websiteEnquiryModel.js
// ─────────────────────────────────────────────────────────────────────────────
// Website enquiry forms — Node ports of:
//   campaign-mail.php   → submitCampaignEnquiry()  (landing-page form)
//   contact-mail.php    → submitContactEnquiry()   (contact-page form)
//   appointment-medical-tourism.php
//                       → submitMedicalTourismEnquiry() (medical-tourism form)
//   mailchimp-post.php  → submitAmpEnquiry()       (AMP-page form)
//
// All of them do the same thing:
//   1. Validate the fields
//   2. INSERT into hhc_appointments.appointments
//        (name, email_id, phoneno, selected_area, message, date, pageurl, utmsource)
//   3. Mail the location: TO admin inbox, CC that location's list
//      (src/config/websiteFormRecipients.js)
//
// Deliberate differences from the PHP (bug fixes, none change what the visitor
// sees on a good submission):
//   • INSERT is parameterised and form values are HTML-escaped in the mail (the
//     PHP put raw $_POST into both).
//   • A failed INSERT is logged and the mail still goes, so a DB problem never
//     loses the lead. (The PHP die()'d.)
//   • A location with no recipient list is mailed to the admin inbox and logged.
//     (The PHP saved the row, sent nothing, and showed a blank page.)
//
// Leads Tracker sheet (added Oct 2026):
//   After the INSERT, every form also pushes the lead to the "Web Leads" tab of
//   the Leads Tracker Google Sheet through its Apps Script webhook
//   (src/services/leadSheetWebhook.js). Fire-and-forget: it never delays or
//   changes the reply. visitingFor (contact) and country (medical tourism),
//   which have no DB column, are carried to the sheet too. Needs
//   LEAD_SHEET_WEBHOOK_URL + LEAD_SHEET_WEBHOOK_SECRET in .env.
// ─────────────────────────────────────────────────────────────────────────────

const {
  CAMPAIGN_ROUTES,
  CONTACT_ROUTES,
  MEDICAL_TOURISM_ROUTES,
  AMP_ROUTES,
} = require("../config/websiteFormRecipients");
const {
  EMAIL_RE,
  str,
  esc,
  nowSqlIST,
  insertLead,
  sendLeadMail,
} = require("./websiteFormUtils");
const {
  pushLeadToSheet,
  campaignFor,
  pageTopic,
} = require("../services/leadSheetWebhook");

const INSERT_SQL = `
  INSERT INTO appointments
    (name, email_id, phoneno, selected_area, message, date, pageurl, utmsource)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

function mailHtml(f) {
  let msg = "";
  msg += `Name : ${esc(f.name)}<br>`;
  msg += `Email ID: ${esc(f.email)}<br>`;
  msg += `Contact No. : ${esc(f.phone)}<br>`;
  msg += `For Location. : ${esc(f.mailArea)}<br>`;
  if (f.visitingFor !== undefined) {
    msg += `Visiting For. : ${esc(f.visitingFor)}<br>`; // contact form only
  }
  if (f.country !== undefined) {
    msg += `Country : ${esc(f.country)}<br>`; // medical tourism form only
  }
  msg += `Message. : ${esc(f.message)}<br>`;
  msg += `Page Url: ${esc(f.pageurl)}<br>`;
  msg += `Lead Source : ${esc(f.utmsource)}<br>`;
  return msg;
}

/** Inserts the row; resolves appointments.id, or null if the insert failed. */
async function saveRow(tag, f) {
  try {
    const res = await insertLead(INSERT_SQL, [
      f.name,
      f.email,
      f.phone,
      f.area,
      f.message,
      nowSqlIST(),
      f.pageurl,
      f.utmsource,
    ]);
    return (res && res.insertId) || null;
  } catch (e) {
    console.error(`${tag}: insert failed —`, e.message, {
      name: f.name,
      phone: f.phone,
      area: f.area,
    });
    return null;
  }
}

/**
 * Push one enquiry to the Leads Tracker sheet ("Web Leads" tab).
 * Fire-and-forget; sent even when the insert failed so the lead isn't lost.
 * Key names avoid the script's alias list (see leadSheetWebhook.js).
 *
 * @param {string} tag        log tag, e.g. "campaignEnquiry"
 * @param {string} form       form id for Extra Data, e.g. "campaign"
 * @param {string} formLabel  campaign fallback, e.g. "Website – Campaign form"
 * @param {object} f          normalised form fields
 * @param {number|null} apptId  appointments.id from saveRow()
 */
function pushToSheet(tag, form, formLabel, f, apptId) {
  const parts = [];
  if (f.visitingFor) parts.push(`Visiting for: ${f.visitingFor}`);
  if (f.message) parts.push(f.message);
  if (f.country) parts.push(`Country: ${f.country}`);
  const topic = pageTopic(f.pageurl);
  if (topic) parts.push(topic);

  pushLeadToSheet(tag, {
    source: "web",
    name: f.name,
    phone: f.phone,
    // "Select Location" means none was chosen — leave the column for the caller
    city: f.area === "Select Location" ? "" : f.area,
    message: parts.join(" | "),
    campaign: campaignFor(f.utmsource, f.pageurl, formLabel),
    // ── Extra Data (JSON)
    form,
    appointment_id: apptId || "",
    ext_ref: apptId ? `appt:${apptId}` : "",
    email: f.email,
    pageurl: f.pageurl,
    utmsource: f.utmsource,
    visiting_for: f.visitingFor,
    country: f.country,
    page_subject: f.pageSubject,
  });
}

// utm_source from the page URL's query string (mailchimp-post.php did this).
function utmFromUrl(url) {
  try {
    return new URL(url).searchParams.get("utm_source") || "";
  } catch (e) {
    return "";
  }
}

/* ── campaign-mail.php ───────────────────────────────────────────────────── */

/**
 * @param {object} body  posted fields: yourname, youremail, yourphone,
 *                       selected_area, yourmessage, subjectText, utmsource
 * @param {{referer?:string, query?:object}} meta
 * @returns {Promise<{status:'success'|'error', pixel?:'pageview'|'lead'}>}
 *          never rejects
 */
async function submitCampaignEnquiry(body = {}, meta = {}) {
  const query = meta.query || {};
  const f = {
    name: str(body.yourname),
    email: str(body.youremail),
    phone: str(body.yourphone),
    area: str(body.selected_area),
    message: str(body.yourmessage),
    subjectText: str(body.subjectText),
    // PHP $_REQUEST['utmsource'] — POST body or query string
    utmsource: str(body.utmsource || query.utmsource),
    pageurl: str(body.currenturl),
  };
  f.mailArea = f.area;

  if (!f.name || !EMAIL_RE.test(f.email) || !f.phone || !f.area || !f.message) {
    return { status: "error" };
  }

  const apptId = await saveRow("campaignEnquiry", f);
  pushToSheet(
    "campaignEnquiry",
    "campaign",
    "Website – Campaign form",
    f,
    apptId,
  );

  const route = CAMPAIGN_ROUTES[f.area];
  if (!route) {
    console.warn(
      `campaignEnquiry: location "${f.area}" has no recipient list — sent to admin only. ` +
        "Add it to src/config/websiteFormRecipients.js.",
    );
  }
  const subject = route
    ? route.fixedSubject || `${route.subject}${f.subjectText}`
    : `${f.area} - ${f.subjectText}`;

  // PHP never checked the send result; the visitor gets the thank-you either way.
  await sendLeadMail({
    tag: "campaignEnquiry",
    cc: route ? route.recipients : [],
    subject,
    html: mailHtml(f),
  });

  return { status: "success", pixel: route ? route.pixel : "pageview" };
}

/* ── contact-mail.php ────────────────────────────────────────────────────── */

/**
 * Same as campaign-mail.php, with c-prefixed field names and one extra
 * required field (cvisitingfor), which goes in the mail only — the
 * appointments table has no column for it, exactly as in the PHP.
 *
 * @param {object} body  posted fields: cyourname, cyouremail, cyourphone,
 *                       cselected_area, cvisitingfor, cyourmessage,
 *                       subjectText, cutmsource, currenturl
 * @param {{referer?:string, query?:object}} meta
 * @returns {Promise<{status:'success'|'error', pixel?:'pageview'|'lead'}>}
 *          never rejects
 */
async function submitContactEnquiry(body = {}, meta = {}) {
  const query = meta.query || {};
  const f = {
    name: str(body.cyourname),
    email: str(body.cyouremail),
    phone: str(body.cyourphone),
    area: str(body.cselected_area),
    visitingFor: str(body.cvisitingfor),
    message: str(body.cyourmessage),
    subjectText: str(body.subjectText),
    // PHP $_REQUEST['cutmsource'] — POST body or query string
    utmsource: str(body.cutmsource || query.cutmsource),
    // Page URL: posted `currenturl` (as on the campaign form), else Referer
    pageurl: str(body.currenturl || meta.referer),
  };
  f.mailArea = f.area;

  if (
    !f.name ||
    !EMAIL_RE.test(f.email) ||
    !f.phone ||
    !f.area ||
    !f.visitingFor ||
    !f.message
  ) {
    return { status: "error" };
  }

  const apptId = await saveRow("contactEnquiry", f);
  pushToSheet("contactEnquiry", "contact", "Website – Contact form", f, apptId);

  const route = CONTACT_ROUTES[f.area];
  if (!route) {
    console.warn(
      `contactEnquiry: location "${f.area}" has no recipient list — sent to admin only. ` +
        "Add it to CONTACT_ROUTES in src/config/websiteFormRecipients.js.",
    );
  }
  const subject = route
    ? route.fixedSubject || `${route.subject}${f.subjectText}`
    : `${f.area} - ${f.subjectText}`;

  await sendLeadMail({
    tag: "contactEnquiry",
    cc: route ? route.recipients : [],
    subject,
    html: mailHtml(f),
  });

  return { status: "success", pixel: route ? route.pixel : "pageview" };
}

/* ── appointment-medical-tourism.php ─────────────────────────────────────── */

/**
 * Medical-tourism page form. Fields: fullname, Email, mobile, country,
 * selected_branch, message, utmsource (+ currenturl / Referer → pageurl).
 *
 * Same steps as the PHP: all fields required → INSERT into appointments
 * (selected_branch goes in selected_area) → mail the location with
 * "<label> - Medical Tourism Appointment". "Select Location" is saved as-is
 * and shown as "Not mentioned" in the mail, as in the PHP.
 *
 * Small additions to the PHP mail: the Country line (the PHP required the
 * field but never saved or mailed it, so it was lost) and Lead Source.
 * There is no DB column for country, as before.
 *
 * @returns {Promise<{status:'success'|'error', pixel?:'lead'}>} never rejects
 */
async function submitMedicalTourismEnquiry(body = {}, meta = {}) {
  const query = meta.query || {};
  const f = {
    name: str(body.fullname),
    email: str(body.Email),
    phone: str(body.mobile),
    country: str(body.country),
    area: str(body.selected_branch),
    message: str(body.message),
    // PHP $_REQUEST['utmsource'] — POST body or query string
    utmsource: str(body.utmsource || query.utmsource),
    pageurl: str(body.currenturl || meta.referer),
  };

  // The PHP only checked that each field was filled in (no email format check).
  if (!f.name || !f.email || !f.phone || !f.country || !f.area || !f.message) {
    return { status: "error" };
  }

  f.mailArea = f.area === "Select Location" ? "Not mentioned" : f.area;

  const apptId = await saveRow("medicalTourismEnquiry", f);
  pushToSheet(
    "medicalTourismEnquiry",
    "medical_tourism",
    "Website – Medical Tourism form",
    f,
    apptId,
  );

  const route = MEDICAL_TOURISM_ROUTES[f.area];
  if (!route) {
    console.warn(
      `medicalTourismEnquiry: location "${f.area}" has no recipient list — sent to admin only. ` +
        "Add it to MEDICAL_TOURISM_LABELS in src/config/websiteFormRecipients.js.",
    );
  }

  await sendLeadMail({
    tag: "medicalTourismEnquiry",
    cc: route ? route.recipients : [],
    subject: route
      ? route.subject
      : `${f.mailArea} - Medical Tourism Appointment`,
    html: mailHtml(f),
  });

  return { status: "success", pixel: "lead" };
}

/* ── mailchimp-post.php (AMP) ────────────────────────────────────────────── */

/**
 * @param {object} body  posted fields: name, email, phoneno, selected_area,
 *                       message, pagesubject
 * @param {{referer?:string}} meta
 * @returns {Promise<{status:'success'|'error', name?:string, email?:string}>}
 *          never rejects
 */
async function submitAmpEnquiry(body = {}, meta = {}) {
  const f = {
    name: str(body.name),
    email: str(body.email),
    phone: str(body.phoneno),
    area: str(body.selected_area),
    message: str(body.message),
    pageSubject: str(body.pagesubject),
    pageurl: str(body.currenturl),
  };
  f.utmsource = utmFromUrl(f.pageurl);

  if (!f.name || !f.phone || !f.email || !f.area || !f.message) {
    return { status: "error" };
  }

  // As in the PHP: the raw value is saved; the mail says "Not mentioned".
  f.mailArea = f.area === "Select Location" ? "Not mentioned" : f.area;

  const apptId = await saveRow("ampEnquiry", f);
  pushToSheet("ampEnquiry", "amp", "Website – AMP form", f, apptId);

  const route = AMP_ROUTES[f.area];
  if (!route) {
    console.warn(
      `ampEnquiry: location "${f.area}" has no recipient list — sent to admin only. ` +
        "Add it to src/config/websiteFormRecipients.js.",
    );
  }
  let subject = `${f.mailArea} - AMP Enquiry`;
  if (route) {
    subject =
      route.pageSubjectLabel && f.pageSubject
        ? `${route.pageSubjectLabel} - ${f.pageSubject} AMP Enquiry`
        : route.subject;
  }

  await sendLeadMail({
    tag: "ampEnquiry",
    cc: route ? route.recipients : [],
    subject,
    html: mailHtml(f),
  });

  return { status: "success", name: f.name, email: f.email };
}

module.exports = {
  submitCampaignEnquiry,
  submitContactEnquiry,
  submitMedicalTourismEnquiry,
  submitAmpEnquiry,
  utmFromUrl,
};
