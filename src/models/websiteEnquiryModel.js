// src/models/websiteEnquiryModel.js
// ─────────────────────────────────────────────────────────────────────────────
// Website enquiry forms — Node ports of:
//   campaign-mail.php   → submitCampaignEnquiry()  (landing-page form)
//   mailchimp-post.php  → submitAmpEnquiry()       (AMP-page form)
//
// Both do the same thing:
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
// ─────────────────────────────────────────────────────────────────────────────

const { CAMPAIGN_ROUTES, AMP_ROUTES } = require("../config/websiteFormRecipients");
const {
  EMAIL_RE,
  str,
  esc,
  nowSqlIST,
  insertLead,
  sendLeadMail,
} = require("./websiteFormUtils");

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
  msg += `Message. : ${esc(f.message)}<br>`;
  msg += `Page Url: ${esc(f.pageurl)}<br>`;
  msg += `Lead Source : ${esc(f.utmsource)}<br>`;
  return msg;
}

async function saveRow(tag, f) {
  try {
    await insertLead(INSERT_SQL, [
      f.name, f.email, f.phone, f.area, f.message, nowSqlIST(), f.pageurl, f.utmsource,
    ]);
  } catch (e) {
    console.error(`${tag}: insert failed —`, e.message, {
      name: f.name,
      phone: f.phone,
      area: f.area,
    });
  }
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
    pageurl: str(meta.referer),
  };
  f.mailArea = f.area;

  if (!f.name || !EMAIL_RE.test(f.email) || !f.phone || !f.area || !f.message) {
    return { status: "error" };
  }

  await saveRow("campaignEnquiry", f);

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
    pageurl: str(meta.referer),
  };
  f.utmsource = utmFromUrl(f.pageurl);

  if (!f.name || !f.phone || !f.email || !f.area || !f.message) {
    return { status: "error" };
  }

  // As in the PHP: the raw value is saved; the mail says "Not mentioned".
  f.mailArea = f.area === "Select Location" ? "Not mentioned" : f.area;

  await saveRow("ampEnquiry", f);

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

module.exports = { submitCampaignEnquiry, submitAmpEnquiry, utmFromUrl };
