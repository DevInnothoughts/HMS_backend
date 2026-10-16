// src/models/careerLeadModel.js
// ─────────────────────────────────────────────────────────────────────────────
// Website "Career" form — Node port of career-mail.php.
//
// Same steps, same order:
//   1. Require fname, lname, phone_no, address, city, zipcode, email_id
//   2. Optional resume — PDF / DOC / DOCX only
//   3. INSERT into hhc_appointments.careerlead (same columns as the PHP)
//   4. Mail HR: TO CAREER_MAIL.to, CC the HR list, resume attached
//
// ── Resumes are NOT stored on the server ────────────────────────────────────
// The resume is held in memory only for this request (multer memoryStorage in
// the controller) and sent as a mail attachment. Nothing is written to disk.
// The `filename` column gets the applicant's original file name (e.g.
// "Asha_CV.pdf") so the row still shows that a resume came with the mail;
// the file itself lives only in the HR mailbox. (The PHP stored a public URL
// to a copy on the website server.)
//
// Deliberate differences from the PHP (bug fixes):
//   • The INSERT is parameterised (the PHP put raw $_POST into the SQL) and
//     form values are HTML-escaped in the mail.
//   • A failed INSERT is logged and the mail still goes, so HR never loses an
//     applicant to a DB hiccup. (The PHP die()'d with the MySQL error.)
//   • Max resume size 10 MB (the PHP had only the server's upload limit).
//   • An incomplete form no longer fires the Meta "Lead" pixel (the PHP did).
// ─────────────────────────────────────────────────────────────────────────────

const path = require("path");

const { CAREER_MAIL } = require("../config/websiteFormRecipients");
const {
  str,
  esc,
  nowSqlIST,
  insertLead,
  sendLeadMail,
} = require("./websiteFormUtils");

const CONFIG = {
  ALLOWED_EXT: ["pdf", "doc", "docx"],
  MAX_BYTES: 10 * 1024 * 1024, // enforced by multer in the controller
};

const INSERT_SQL = `
  INSERT INTO careerlead
    (fname, lname, email_id, phone_no, address, city, zipcode, date,
     companyname, feedback, filename)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function mailHtml(f) {
  let msg = "";
  msg += `First Name : ${esc(f.fname)}<br>`;
  msg += `Last Name : ${esc(f.lname)}<br>`;
  msg += `Contact No. : ${esc(f.phone)}<br>`;
  msg += `Address : ${esc(f.address)}<br>`;
  msg += `City : ${esc(f.city)}<br>`;
  msg += `Zip Code : ${esc(f.zipcode)}<br>`;
  msg += `Email ID : ${esc(f.email)}<br>`;
  msg += `Current Company : ${esc(f.company)}<br>`;
  msg += `Feedback Message : ${esc(f.feedback)}<br>`;
  return msg;
}

/**
 * @param {object} body   posted form fields
 * @param {object} [file] multer file (memory storage) for the `file` field
 * @returns {Promise<{status:'success'|'missing'|'badType'}>}  never rejects
 */
async function submitCareerLead(body = {}, file = null) {
  const f = {
    fname: str(body.fname),
    lname: str(body.lname),
    phone: str(body.phone_no),
    address: str(body.address),
    city: str(body.city),
    zipcode: str(body.zipcode),
    email: str(body.email_id),
    company: str(body.current_cmp),
    feedback: str(body.feedback),
    fileName: "",
  };

  // 1 — required
  if (
    !f.fname ||
    !f.lname ||
    !f.phone ||
    !f.address ||
    !f.city ||
    !f.zipcode ||
    !f.email
  ) {
    return { status: "missing" };
  }

  // 2 — resume (optional): validate, attach from memory, never saved
  let attachments;
  if (file && file.buffer && file.buffer.length) {
    const original = path.basename(str(file.originalname)) || "resume";
    const ext = path.extname(original).replace(".", "").toLowerCase();
    if (!CONFIG.ALLOWED_EXT.includes(ext)) return { status: "badType" };
    f.fileName = original;
    attachments = [
      {
        filename: original,
        content: file.buffer,
        ...(file.mimetype ? { contentType: file.mimetype } : {}),
      },
    ];
  }

  // 3 — insert (logged on failure; HR mail still goes)
  try {
    await insertLead(INSERT_SQL, [
      f.fname,
      f.lname,
      f.email,
      f.phone,
      f.address,
      f.city,
      f.zipcode,
      nowSqlIST(),
      f.company,
      f.feedback,
      f.fileName,
    ]);
  } catch (e) {
    console.error("careerLead: insert failed —", e.message, {
      name: `${f.fname} ${f.lname}`,
      phone: f.phone,
    });
  }

  // 4 — HR mail with the resume attached. Like the PHP, the applicant sees
  // success either way; a failure is logged.
  await sendLeadMail({
    tag: "careerLead",
    to: CAREER_MAIL.to,
    cc: CAREER_MAIL.recipients,
    subject: CAREER_MAIL.subject,
    html: mailHtml(f),
    attachments,
  });

  // The PHP's applicant acknowledgement mail was commented out — not sent here
  // either.
  return { status: "success" };
}

module.exports = { submitCareerLead, CONFIG };
