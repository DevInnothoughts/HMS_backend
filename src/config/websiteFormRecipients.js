// src/config/websiteFormRecipients.js
// ─────────────────────────────────────────────────────────────────────────────
// Website lead forms — who gets the mail for each form / location.
//
// Ported 1:1 from three PHP files:
//   career-mail.php      → CAREER_MAIL
//   campaign-mail.php    → CAMPAIGN_ROUTES   (landing-page enquiry form)
//   mailchimp-post.php   → AMP_ROUTES        (AMP pages' enquiry form)
//
// The KEY is the exact `selected_area` value the website form posts.
// Every enquiry mail goes TO the admin inbox (WEBSITE_LEADS_ADMIN_TO, default
// innothoughtsadwords@gmail.com); the people below are CC'd.
//
// A location the form sends that is NOT listed here still gets saved and
// mailed — to the admin inbox only — and is logged, so a new location on the
// website shows up in the logs until it is added here. (The PHP silently sent
// nothing and showed a blank page.)
//
// To change who gets a location's mail, edit this file only.
// ─────────────────────────────────────────────────────────────────────────────

const p = (email, name) => ({ email, name });

// People who appear on many locations
const MAHIMA = p("mahima.hhc@gmail.com", "Mahima HR");
const ROSHAN = p("rosh@innothoughts.com", "Roshan");
const MAYURI = p("mayurishah@healinghandsclinic.co.in", "Cluster Head");
const PANKAJ = p("pankaj@healinghandsclinic.co.in", "Cluster Head");
const DEEPIKA = p("deepikaporwal04@gmail.com", "Cluster Head");
const NIBM = p("healinghandsclinic.sv@gmail.com", "HHC NIBM");
const NEHA = p("neha.hhc@gmail.com", "Dr Neha");
const RECEPTION_HHC = p("reception.hhc@gmail.com", "Reception HHC");
const SNEHAL = p("drsnehaljain@gmail.com", "Dr Snehal Jain");
const UNDRI = p("healinghandsclinicundri@gmail.com", "HHC Undri");
const GURUGRAM = p("Hhc.gurugram@gmail.com", "HHC Gurugram Team");

// Branch inboxes (used by both the campaign and AMP lists)
const B = {
  kothrud: p("hhc.kothrud@gmail.com", "HHC Kothrud"),
  chinchwad: p("hhc.chinchwad@gmail.com", "Chinchwad HHC"),
  chakan: p("hhcchakan@gmail.com", "HHC Chakan"),
  dighi: p("healinghandsdiggi07@gmail.com", "HHC Dighi"),
  atul: p("atatultambade@gmail.com", "Atul Tambade"),
  katraj: p("katraj@healinghandsclinic.co.in", "HHC Katraj"),
  hinjawadi: p("hhcdoc2340@gmail.com", "HHC Hinjawadi"),
  varsha: p("drvarsharanahhc@gmail.com", "Dr Varsha"),
  hadapsar: p("hadapsar@healinghandsclinic.co.in", "HHC Hadapsar"),
  baner: p("hhcbaner@gmail.com", "HHC Baner"),
  yaman: p("yamanjhawar@gmail.com", "Yaman Jhawar"),
  naviMumbai: p("hhcnavimumbai@gmail.com", "HHC Navi Mumbai"),
  nehal: p("drnehal@healinghandsclinic.co.in", "Dr Nehal"),
  kemps: p("reception.hhcmumbai@gmail.com", "HHC Kemps Corner"),
  thane: p("healinghandsclinicthane@gmail.com", "HHC Thane"),
  andheri: p("hhc.andheri.fde@gmail.com", "HHC Andheri"),
  vashi: p("healinghandsclinic18@gmail.com", "HHC Vashi"),
  kalyan: p("kalyan@healinghandsclinic.co.in", "HHC Kalyan"),
  nashik: p("hhcnashik@gmail.com", "HHC Nashik"),
  latur: p("laturhhc@gmail.com", "HHC Latur"),
  aurangabad: p("shambajinagar@healinghandsclinic.co.in", "HHC Aurangabad"),
  belagavi: p("sbghealinghandsbgv@gmail.com", "Belagavi Branch"),
  jpNagar: p("hhc.bengaluru@gmail.com", "HHC Bengaluru"),
  priyanka: p("priyankajain.hhc@gmail.com", "Priyanka Jain HHC"),
  indiranagar: p("hhcindiranagar@gmail.com", "HHC Indiranagar"),
  sahakarnagar: p("hhcsahakarnagar@gmail.com", "HHC Sahakarnagar"),
  nishant: p("nishantsinghania.hhc@gmail.com", "Nishant"),
  hsr: p("hhchsrlayout@gmail.com", "HSR Team"),
  rajajinagar: p("rajajinagar@healinghandsclinic.co.in", "HHC Rajajinagar"),
  whitefield: p("whitefield@healinghandsclinic.co.in", "HHC Whitefield"),
  ecity: p("ecity@healinghandsclinic.co.in", "HHC Electronic City"),
  rrNagar: p("rrnagar@healinghandsclinic.co.in", "HHC RR Nagar"),
  kalyanNagar: p("kalyannagar@healinghandsclinic.co.in", "HHC Kalyan Nagar"),
  sarjapur: p("sarjapur@healinghandsclinic.co.in", "HHC Sarjapura"),
  hyderabad: p("hhchyderabad@gmail.com", "HHC Hyderabad"),
  secunderabad: p("laxma008@gmail.com", "HHC Secunderabad"),
  ludhiana: p("healinghandsclinicludhiana@gmail.com", "Ludhiana Team"),
  mysore: p("reception.hhcmysore@gmail.com", "Reception Mysore"),
  surat: p("hhcsurat@gmail.com", "HHC Surat"),
  pal: p("suratpal@healinghandsclinic.co.in", "HHC Pal"),
  mohali: p("mohali@healinghandsclinic.co.in", "HHC Mohali"),
  ahmedabad: p("ahmedabad@healinghandsclinic.co.in", "HHC Ahmedabad"),
  bopal: p("bopal@healinghandsclinic.co.in", "HHC Bopal"),
  raipur: p("raipur@healinghandsclinic.co.in", "HHC Raipur"),
  gurugram49: p("HHC.reception49@gmail.com", "HHC Sector 49"),
  gurugram14: p("HHC.reception14@gmail.com", "HHC Sector 14"),
  kalaburagi: p("healinghands.585@gmail.com", "HHC Kalaburagi"),
  lucknow: p("Lucknow@healinghandsclinic.co.in", "HHC Lucknow"),
};

/* ── career-mail.php ─────────────────────────────────────────────────────── */
// NOTE: in the PHP the live TO is ajitinnothought@gmail.com (the
// info@healinghandsclinic.co.in line is commented out). Kept as-is; set
// CAREER_MAIL_TO in .env to change it without a code change.
const CAREER_MAIL = {
  to: process.env.CAREER_MAIL_TO || "ajitinnothought@gmail.com",
  subject: "Career",
  recipients: [
    p("drsnehaljain@gmail.com", "Dr Snehal"),
    p("hrhhc@healinghandsclinic.co.in", "HR Department"),
    p("sagarshekhar@healinghandsclinic.co.in", "HR Sagar Department"),
  ],
};

/* ── campaign-mail.php ───────────────────────────────────────────────────── */
// subject      → prefix; the form's `subjectText` is appended (exactly as the
//                PHP did, including the prefixes that have no trailing space)
// fixedSubject → used as-is, subjectText NOT appended (Belagavi only)
// pixel        → which thank-you response the PHP sent:
//                "pageview" = pixel 913144286745452 PageView, straight redirect
//                "lead"     = pixel 2199419837014290 Lead + "Thank you" alert
const PV = "pageview";
const LEAD = "lead";

const CAMPAIGN_ROUTES = {
  "Pune - Dhole Patil Road": {
    subject: "Dhole Patil Road (Pune) - ",
    pixel: PV,
    recipients: [RECEPTION_HHC, SNEHAL, NEHA],
  },
  // The PHP routes plain "Pune" to the Gastric Balloon team (its block appeared
  // twice; the second copy was unreachable).
  Pune: {
    subject: "Gastric Balloon - ",
    pixel: PV,
    recipients: [ROSHAN, MAHIMA, UNDRI],
  },
  "Pune - Tilak Road": {
    subject: "Tilak Road (Pune) - ",
    pixel: PV,
    recipients: [RECEPTION_HHC, NEHA],
  },
  "Pune - Kothrud": {
    subject: "Kothrud (Pune) - ",
    pixel: PV,
    recipients: [B.kothrud, NIBM],
  },
  "Pimpri & Chinchwad": {
    subject: "Pimpri & Chinchwad - ",
    pixel: PV,
    recipients: [B.chinchwad, MAHIMA],
  },
  "Pune - Chakan": {
    subject: "Chakan (Pune) - ",
    pixel: PV,
    recipients: [B.chakan, ROSHAN, MAYURI],
  },
  "Pune - Dighi": {
    subject: "Dighi (Pune) - ",
    pixel: PV,
    recipients: [B.dighi, ROSHAN, B.atul, MAYURI],
  },
  "Pune - Katraj": {
    subject: "Katraj(Pune) - ",
    pixel: LEAD,
    recipients: [ROSHAN, B.katraj, DEEPIKA],
  },
  "Pune - Hinjawadi": {
    subject: "Hinjawadi(Pune) - ",
    pixel: LEAD,
    recipients: [ROSHAN, B.hinjawadi, B.varsha],
  },
  "Pune - Undri": {
    subject: "Undri(Pune) - ",
    pixel: LEAD,
    recipients: [NIBM, PANKAJ, UNDRI],
  },
  "Pune - Loni Kalbhor (Hadapsar)": {
    subject: "Pune - Loni Kalbhor (Hadapsar) - ",
    pixel: LEAD,
    recipients: [B.hadapsar, PANKAJ, DEEPIKA],
  },
  "Pune - Wanowrie": {
    subject: "Salunkhe Vihar, Wanowrie(Pune) - ",
    pixel: PV,
    recipients: [NIBM, PANKAJ],
  },
  "Pune - Baner": {
    subject: "Baner (Pune) - ",
    pixel: PV,
    recipients: [B.baner, NEHA, B.yaman, MAYURI],
  },
  "Navi Mumbai": {
    subject: "Navi Mumbai - ",
    pixel: PV,
    recipients: [B.naviMumbai, B.nehal, MAHIMA],
  },
  "Mumbai - Kemps Corner": {
    subject: "Kemps Corner(Mumbai) - ",
    pixel: PV,
    recipients: [B.kemps, MAHIMA],
  },
  "Thane - Kapurbawdi": {
    subject: "Thane - ",
    pixel: PV,
    recipients: [B.thane, MAHIMA],
  },
  "Mumbai - Andheri West": {
    subject: "Andheri West - ",
    pixel: PV,
    recipients: [B.andheri, ROSHAN, MAHIMA],
  },
  "Mumbai - Vashi": {
    subject: "Vashi - ",
    pixel: PV,
    recipients: [B.vashi, MAHIMA],
  },
  Kalyan: { subject: "Kalyan - ", pixel: PV, recipients: [B.kalyan, PANKAJ] },
  Nashik: { subject: "Nashik - ", pixel: PV, recipients: [B.nashik, PANKAJ] },
  Kolhapur: { subject: "Kolhapur - ", pixel: PV, recipients: [ROSHAN, MAHIMA] },
  Latur: {
    subject: "Latur - ",
    pixel: PV,
    recipients: [ROSHAN, B.latur, PANKAJ],
  },
  Aurangabad: {
    subject: "Aurangabad - ",
    pixel: PV,
    recipients: [ROSHAN, B.aurangabad, MAHIMA],
  },
  Belagavi: {
    fixedSubject: "Belagavi - Online Appointment",
    pixel: LEAD,
    recipients: [B.belagavi, MAHIMA, ROSHAN],
  },
  Bengaluru: {
    subject: "Bengaluru - JP Nagar ",
    pixel: PV,
    recipients: [B.jpNagar, B.priyanka, MAHIMA],
  },
  "Bengaluru - Indiranagar": {
    subject: "Bengaluru - Indiranagar ",
    pixel: PV,
    recipients: [B.indiranagar, ROSHAN, MAHIMA],
  },
  "Bengaluru - Sahakarnagar": {
    subject: "Bengaluru - Sahakar Nagar ",
    pixel: PV,
    recipients: [B.sahakarnagar, ROSHAN, MAHIMA],
  },
  "Bengaluru - HSR Layout": {
    subject: "Bengaluru - HSR Layout ",
    pixel: PV,
    recipients: [ROSHAN, MAHIMA, B.nishant, B.hsr],
  },
  "Bengaluru - Rajajinagar": {
    subject: "Bengaluru - Rajajinagar",
    pixel: LEAD,
    recipients: [ROSHAN, MAHIMA, B.rajajinagar],
  },
  "Bengaluru - Whitefield": {
    subject: "Bengaluru - Whitefield",
    pixel: LEAD,
    recipients: [ROSHAN, MAHIMA, B.whitefield],
  },
  "Bengaluru - Electronic City": {
    subject: "Bengaluru - Electronic City",
    pixel: LEAD,
    recipients: [ROSHAN, MAHIMA, B.ecity],
  },
  "Bengaluru - RR Nagar": {
    subject: "Bengaluru - RR Nagar",
    pixel: LEAD,
    recipients: [ROSHAN, MAHIMA, B.rrNagar],
  },
  "Bengaluru - Kalyan Nagar": {
    subject: "Bengaluru - Kalyan Nagar",
    pixel: LEAD,
    recipients: [ROSHAN, MAHIMA, B.kalyanNagar],
  },
  "Bengaluru - Sarjapur": {
    subject: "Bengaluru - Sarjapura",
    pixel: LEAD,
    recipients: [ROSHAN, MAHIMA, B.sarjapur],
  },
  Hyderabad: {
    subject: "Hyderabad - ",
    pixel: PV,
    recipients: [B.hyderabad, ROSHAN, MAHIMA, MAYURI],
  },
  Secunderabad: {
    subject: "Secunderabad - ",
    pixel: PV,
    recipients: [B.secunderabad, ROSHAN, MAHIMA, MAYURI],
  },
  Ludhiana: {
    subject: "Ludhiana - ",
    pixel: PV,
    recipients: [B.ludhiana, ROSHAN, PANKAJ],
  },
  Indore: { subject: "Indore - ", pixel: PV, recipients: [ROSHAN, PANKAJ] },
  Mysore: {
    subject: "Mysore - ",
    pixel: PV,
    recipients: [B.mysore, ROSHAN, MAHIMA],
  },
  Surat: {
    subject: "Surat - ",
    pixel: PV,
    recipients: [B.surat, ROSHAN, DEEPIKA],
  },
  "Adajan - Pal": {
    subject: "Pal - ",
    pixel: PV,
    recipients: [B.pal, ROSHAN, DEEPIKA],
  },
  Mohali: { subject: "Mohali - ", pixel: PV, recipients: [B.mohali, ROSHAN] },
  Ahmedabad: {
    subject: "Ahmedabad - ",
    pixel: PV,
    recipients: [B.ahmedabad, ROSHAN, MAHIMA],
  },
  Bopal: { subject: "Bopal - ", pixel: PV, recipients: [B.bopal, ROSHAN] },
  Raipur: {
    subject: "Raipur - ",
    pixel: PV,
    recipients: [B.raipur, ROSHAN, MAHIMA],
  },
  "Gurugram - Sector 49": {
    subject: "Gurugram Sector 49 - ",
    pixel: LEAD,
    recipients: [B.gurugram49, GURUGRAM, MAYURI],
  },
  "Gurugram - Sector 14": {
    subject: "Gurugram Sector 14 - ",
    pixel: LEAD,
    recipients: [B.gurugram14, GURUGRAM, MAYURI],
  },
  Jaipur: { subject: "Jaipur - ", pixel: PV, recipients: [ROSHAN, MAHIMA] },
  Kalaburagi: {
    subject: "Kalaburagi - ",
    pixel: PV,
    recipients: [ROSHAN, B.kalaburagi, MAHIMA],
  },
  Lucknow: {
    subject: "Lucknow - ",
    pixel: PV,
    recipients: [ROSHAN, B.lucknow, DEEPIKA],
  },
  Dubai: { subject: "Dubai - ", pixel: PV, recipients: [ROSHAN, PANKAJ] },
};

/* ── mailchimp-post.php (AMP form) ───────────────────────────────────────── */
// subject          → full subject line
// pageSubjectLabel → when set and the form posts `pagesubject`, the subject
//                    becomes "<label> - <pagesubject> AMP Enquiry" (Hyderabad,
//                    Surat — as in the PHP)
// The AMP lists are NOT identical to the campaign lists (e.g. Katraj and Loni
// Kalbhor have no Cluster Head here) — kept exactly as the PHP had them.
const AMP_ROUTES = {
  "Pune - DP Road": {
    subject: "Dhole Patil Road (Pune) - AMP Enquiry",
    recipients: [RECEPTION_HHC, SNEHAL, NEHA],
  },
  "Pune - Tilak Road": {
    subject: "Tilak Road (Pune) - AMP Enquiry",
    recipients: [RECEPTION_HHC, NEHA],
  },
  "Pune - Kothrud": {
    subject: "Kothrud (Pune) - AMP Enquiry",
    recipients: [B.kothrud, NIBM],
  },
  "Pimpri & Chinchwad": {
    subject: "Pimpri & Chinchwad - AMP Enquiry",
    recipients: [B.chinchwad, MAHIMA],
  },
  "Pune - Chakan": {
    subject: "Chakan (Pune) - AMP Enquiry",
    recipients: [B.chakan, ROSHAN, MAYURI],
  },
  "Pune - Dighi": {
    subject: "Dighi (Pune) - AMP Enquiry",
    recipients: [B.dighi, ROSHAN, B.atul, MAYURI],
  },
  "Pune - Undri": {
    subject: "Undri(Pune) - AMP Enquiry",
    recipients: [NIBM, PANKAJ, UNDRI],
  },
  "Pune - Loni Kalbhor (Hadapsar)": {
    subject: "Pune - Loni Kalbhor (Hadapsar) - AMP Enquiry",
    recipients: [B.hadapsar, PANKAJ],
  },
  "Pune - Hinjawadi": {
    subject: "Hinjawadi(Pune) - AMP Enquiry",
    recipients: [ROSHAN, B.hinjawadi, B.varsha],
  },
  "Pune - Katraj": {
    subject: "Katraj(Pune) - AMP Enquiry",
    recipients: [ROSHAN, B.katraj],
  },
  "Pune - Wanowrie": {
    subject: "Salunkhe Vihar, Wanowrie(Pune) - AMP Enquiry",
    recipients: [NIBM, PANKAJ],
  },
  "Pune - Baner": {
    subject: "Baner (Pune) - AMP Enquiry",
    recipients: [B.baner, NEHA, B.yaman, MAYURI],
  },
  "Navi Mumbai": {
    subject: "Navi Mumbai - AMP Enquiry",
    recipients: [B.naviMumbai, B.nehal, MAHIMA],
  },
  "Mumbai - Kemps Corner": {
    subject: "Kemps Corner(Mumbai) - AMP Enquiry",
    recipients: [B.kemps, MAHIMA],
  },
  "Thane - Kapurbawdi": {
    subject: "Thane - AMP Enquiry",
    recipients: [B.thane, MAHIMA],
  },
  "Mumbai - Andheri West": {
    subject: "Andheri West - AMP Enquiry",
    recipients: [B.andheri, ROSHAN, MAHIMA],
  },
  "Mumbai - Vashi": {
    subject: "Vashi - AMP Enquiry",
    recipients: [B.vashi, MAHIMA],
  },
  Kalyan: { subject: "Kalyan - AMP Enquiry", recipients: [B.kalyan, PANKAJ] },
  Nashik: { subject: "Nashik - AMP Enquiry", recipients: [B.nashik, PANKAJ] },
  Kolhapur: { subject: "Kolhapur - AMP Enquiry", recipients: [ROSHAN, MAHIMA] },
  Latur: {
    subject: "Latur - AMP Enquiry",
    recipients: [ROSHAN, B.latur, PANKAJ],
  },
  Aurangabad: {
    subject: "Aurangabad - AMP Enquiry",
    recipients: [ROSHAN, B.aurangabad, MAHIMA],
  },
  Belagavi: {
    subject: "Belagavi - AMP Enquiry",
    recipients: [B.belagavi, MAHIMA, ROSHAN],
  },
  Bengaluru: {
    subject: "Bengaluru JP Nagar - AMP Enquiry",
    recipients: [B.jpNagar, B.priyanka, MAHIMA],
  },
  "Bengaluru - Indiranagar": {
    subject: "Bengaluru - Indiranagar AMP Enquiry",
    recipients: [B.indiranagar, ROSHAN, MAHIMA],
  },
  "Bengaluru - Sahakarnagar": {
    subject: "Bengaluru - Sahakar Nagar AMP Enquiry",
    recipients: [B.sahakarnagar, ROSHAN, MAHIMA],
  },
  "Bengaluru - HSR Layout": {
    subject: "Bengaluru - HSR Layout AMP Enquiry",
    recipients: [ROSHAN, MAHIMA, B.nishant, B.hsr],
  },
  "Bengaluru - Rajajinagar": {
    subject: "Bengaluru - Rajajinagar AMP Enquiry",
    recipients: [ROSHAN, MAHIMA, B.rajajinagar],
  },
  "Bengaluru - Whitefield": {
    subject: "Bengaluru - Whitefield AMP Enquiry",
    recipients: [ROSHAN, MAHIMA, B.whitefield],
  },
  "Bengaluru - Electronic City": {
    subject: "Bengaluru - Electronic City AMP Enquiry",
    recipients: [ROSHAN, MAHIMA, B.ecity],
  },
  "Bengaluru - RR Nagar": {
    subject: "Bengaluru - RR Nagar AMP Enquiry",
    recipients: [ROSHAN, MAHIMA, B.rrNagar],
  },
  "Bengaluru - Kalyan Nagar": {
    subject: "Bengaluru - Kalyan Nagar AMP Enquiry",
    recipients: [ROSHAN, MAHIMA, B.kalyanNagar],
  },
  "Bengaluru - Sarjapur": {
    subject: "Bengaluru - Sarjapura AMP Enquiry",
    recipients: [ROSHAN, MAHIMA, B.sarjapur],
  },
  Hyderabad: {
    subject: "Hyderabad - AMP Enquiry",
    pageSubjectLabel: "Hyderabad",
    recipients: [B.hyderabad, ROSHAN, MAHIMA, MAYURI],
  },
  Secunderabad: {
    subject: "Secunderabad - AMP Enquiry",
    recipients: [B.secunderabad, ROSHAN, MAHIMA, MAYURI],
  },
  Ludhiana: {
    subject: "Ludhiana - AMP Enquiry",
    recipients: [B.ludhiana, ROSHAN, PANKAJ],
  },
  Indore: { subject: "Indore - AMP Enquiry", recipients: [ROSHAN, PANKAJ] },
  Mysore: {
    subject: "Mysore - AMP Enquiry",
    recipients: [B.mysore, ROSHAN, MAHIMA],
  },
  Surat: {
    subject: "Surat - AMP Enquiry",
    pageSubjectLabel: "Surat",
    recipients: [B.surat, ROSHAN, DEEPIKA],
  },
  // PHP subject was "Pal - Sector 49 - AMP Enquiry" (copy-paste from Gurugram).
  "Adajan - Pal": {
    subject: "Pal - AMP Enquiry",
    recipients: [B.pal, ROSHAN, DEEPIKA],
  },
  "Gurugram - Sector 49": {
    subject: "Gurugram - Sector 49 - AMP Enquiry",
    recipients: [B.gurugram49, GURUGRAM, MAYURI],
  },
  "Gurugram - Sector 14": {
    subject: "Gurugram - Sector 14 - AMP Enquiry",
    recipients: [B.gurugram14, GURUGRAM, MAYURI],
  },
  Jaipur: { subject: "Jaipur - AMP Enquiry", recipients: [ROSHAN, MAHIMA] },
  Kalaburagi: {
    subject: "Kalaburagi - AMP Enquiry",
    recipients: [ROSHAN, B.kalaburagi, MAHIMA],
  },
  Lucknow: {
    subject: "Lucknow - AMP Enquiry",
    recipients: [ROSHAN, B.lucknow, DEEPIKA],
  },
  Mohali: { subject: "Mohali - AMP Enquiry", recipients: [ROSHAN, B.mohali] },
  Ahmedabad: {
    subject: "Ahmedabad - AMP Enquiry",
    recipients: [ROSHAN, B.ahmedabad, MAHIMA],
  },
  Bopal: { subject: "Bopal - AMP Enquiry", recipients: [ROSHAN, B.bopal] },
  Raipur: {
    subject: "Raipur - AMP Enquiry",
    recipients: [B.raipur, ROSHAN, MAHIMA],
  },
  Dubai: { subject: "Dubai - AMP Enquiry", recipients: [ROSHAN, PANKAJ] },
};

module.exports = { CAREER_MAIL, CAMPAIGN_ROUTES, AMP_ROUTES };
