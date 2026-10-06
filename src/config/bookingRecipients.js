// src/config/bookingRecipients.js
// ─────────────────────────────────────────────────────────────────────────────
// Website "Book Appointment" — who gets the mail for each branch.
//
// Ported 1:1 from book-appointment-mail.php. The KEY is the exact `branch`
// value the website form posts (not the label shown in the dropdown), and
// `label` is what goes in front of the subject:
//
//     "<label> - <Offline|Online> Appointment Details"
//
// Every mail also goes TO the admin inbox (BOOKING_ADMIN_TO, default
// innothoughtsadwords@gmail.com); the people below are CC'd.
//
// A branch the form sends that is NOT listed here still sends — to the admin
// inbox only, with the generic subject — exactly as the PHP did. It is logged,
// so a new branch on the website shows up in the logs until it is added here.
//
// To change who gets a branch's mail, edit this file only.
// ─────────────────────────────────────────────────────────────────────────────

const MAHIMA = { email: "mahima.hhc@gmail.com", name: "Mahima Porwal" };
const ROSHAN = { email: "rosh@innothoughts.com", name: "Roshan" };
const MAYURI = { email: "mayurishah@healinghandsclinic.co.in", name: "Cluster Head" };
const PANKAJ = { email: "pankaj@healinghandsclinic.co.in", name: "Cluster Head" };
const DEEPIKA = { email: "deepikaporwal04@gmail.com", name: "Cluster Head" };
const NIBM = { email: "healinghandsclinic.sv@gmail.com", name: "HHC NIBM" };
const NEHA = { email: "neha.hhc@gmail.com", name: "Dr Neha" };
const RECEPTION_HHC = { email: "reception.hhc@gmail.com", name: "Reception HHC" };

const r = (email, name) => ({ email, name });

const BOOKING_RECIPIENTS = {
  "Pune - Dhole Patil Road": {
    label: "Dhole Patil Road (Pune)",
    recipients: [
      RECEPTION_HHC,
      r("drsnehaljain@gmail.com", "Dr Snehal Jain"),
      NEHA,
      MAHIMA,
    ],
  },
  "Pune - Tilak Road": {
    label: "Tilak Road (Pune)",
    recipients: [RECEPTION_HHC, NEHA, MAHIMA],
  },
  "Pune - Kothrud": {
    label: "Kothrud (Pune)",
    recipients: [r("hhc.kothrud@gmail.com", "HHC Kothrud"), NIBM, MAHIMA],
  },
  "Pimpri & Chinchwad": {
    label: "Pimpri & Chinchwad",
    recipients: [r("hhc.chinchwad@gmail.com", "Chinchwad HHC"), MAHIMA],
  },
  "Pune - Chakan": {
    label: "Chakan (Pune)",
    recipients: [r("hhcchakan@gmail.com", "HHC Chakan"), ROSHAN, MAYURI, MAHIMA],
  },
  "Pune - Dighi": {
    label: "Dighi (Pune)",
    recipients: [
      r("healinghandsdiggi07@gmail.com", "HHC Dighi"),
      ROSHAN,
      r("atatultambade@gmail.com", "Atul Tambade"),
      MAYURI,
      MAHIMA,
    ],
  },
  "Pune - Undri": {
    label: "Undri(Pune)",
    recipients: [
      NIBM,
      PANKAJ,
      r("healinghandsclinicundri@gmail.com", "HHC Undri"),
      MAHIMA,
    ],
  },
  "Pune - Loni Kalbhor (Hadapsar)": {
    label: "Pune - Loni Kalbhor (Hadapsar)",
    recipients: [
      r("hadapsar@healinghandsclinic.co.in", "HHC Hadapsar"),
      PANKAJ,
      DEEPIKA,
      MAHIMA,
    ],
  },
  "Pune - Katraj": {
    label: "Katraj(Pune)",
    recipients: [
      ROSHAN,
      r("katraj@healinghandsclinic.co.in", "HHC Katraj"),
      DEEPIKA,
      MAHIMA,
    ],
  },
  "Pune - Hinjawadi": {
    label: "Hinjawadi(Pune)",
    recipients: [
      ROSHAN,
      r("hhcdoc2340@gmail.com", "HHC Hinjawadi"),
      r("drvarsharanahhc@gmail.com", "Dr Varsha"),
      MAHIMA,
    ],
  },
  "Pune - Wanowrie": {
    label: "Salunkhe Vihar, Wanowrie(Pune)",
    recipients: [NIBM, PANKAJ, MAHIMA],
  },
  "Pune - Baner": {
    label: "Baner (Pune)",
    recipients: [
      r("hhcbaner@gmail.com", "HHC Baner"),
      NEHA,
      r("yamanjhawar@gmail.com", "Yaman Jhawar"),
      MAYURI,
      MAHIMA,
    ],
  },
  "Navi Mumbai": {
    label: "Navi Mumbai",
    recipients: [
      r("hhcnavimumbai@gmail.com", "HHC Navi Mumbai"),
      r("drnehal@healinghandsclinic.co.in", "Dr Nehal"),
      MAHIMA,
    ],
  },
  "Mumbai - Kemps Corner": {
    label: "Kemps Corner(Mumbai)",
    recipients: [r("reception.hhcmumbai@gmail.com", "HHC Kemps Corner"), MAHIMA],
  },
  // The PHP had an if/else on a page URL here, but both arms were identical
  // (and $url was never set), so it is one list.
  "Thane - Kapurbawdi": {
    label: "Thane",
    recipients: [r("healinghandsclinicthane@gmail.com", "HHC Thane"), MAHIMA],
  },
  "Mumbai - Andheri West": {
    label: "Andheri West",
    recipients: [r("hhc.andheri.fde@gmail.com", "HHC Andheri"), ROSHAN, MAHIMA],
  },
  "Mumbai - Vashi": {
    label: "Vashi",
    recipients: [r("healinghandsclinic18@gmail.com", "HHC Vashi"), MAHIMA],
  },
  Kalyan: {
    label: "Kalyan",
    recipients: [r("kalyan@healinghandsclinic.co.in", "HHC Kalyan"), PANKAJ, MAHIMA],
  },
  Nashik: {
    label: "Nashik",
    recipients: [r("hhcnashik@gmail.com", "HHC Nashik"), PANKAJ, MAHIMA],
  },
  Kolhapur: {
    label: "Kolhapur",
    recipients: [ROSHAN, MAHIMA],
  },
  Latur: {
    label: "Latur",
    recipients: [ROSHAN, r("laturhhc@gmail.com", "HHC Latur"), PANKAJ, MAHIMA],
  },
  Aurangabad: {
    label: "Aurangabad",
    recipients: [
      ROSHAN,
      r("shambajinagar@healinghandsclinic.co.in", "HHC Aurangabad"),
      MAHIMA,
    ],
  },
  Belagavi: {
    label: "Belagavi",
    recipients: [r("sbghealinghandsbgv@gmail.com", "Belagavi Branch"), MAHIMA, ROSHAN],
  },
  Bengaluru: {
    label: "Bengaluru JP Nagar",
    recipients: [
      r("hhc.bengaluru@gmail.com", "HHC Bengaluru"),
      r("priyankajain.hhc@gmail.com", "Priyanka Jain HHC"),
      MAHIMA,
    ],
  },
  "Bengaluru - Indiranagar": {
    label: "Bengaluru Indiranagar",
    recipients: [r("hhcindiranagar@gmail.com", "HHC Indiranagar"), ROSHAN, MAHIMA],
  },
  "Bengaluru - Sahakarnagar": {
    label: "Bengaluru Sahakar Nagar",
    recipients: [r("hhcsahakarnagar@gmail.com", "HHC Sahakarnagar"), ROSHAN, MAHIMA],
  },
  "Bengaluru - HSR Layout": {
    label: "Bengaluru HSR Layout",
    recipients: [
      ROSHAN,
      MAHIMA,
      r("nishantsinghania.hhc@gmail.com", "Nishant"),
      r("hhchsrlayout@gmail.com", "HSR Team"),
    ],
  },
  "Bengaluru - Rajajinagar": {
    label: "Bengaluru Rajajinagar",
    recipients: [ROSHAN, MAHIMA, r("rajajinagar@healinghandsclinic.co.in", "HHC Rajajinagar")],
  },
  "Bengaluru - Whitefield": {
    label: "Bengaluru Whitefield",
    recipients: [ROSHAN, MAHIMA, r("whitefield@healinghandsclinic.co.in", "HHC Whitefield")],
  },
  "Bengaluru - Electronic City": {
    label: "Bengaluru Electronic City",
    recipients: [ROSHAN, MAHIMA, r("ecity@healinghandsclinic.co.in", "HHC Electronic City")],
  },
  "Bengaluru - RR Nagar": {
    label: "Bengaluru RR Nagar",
    recipients: [ROSHAN, MAHIMA, r("rrnagar@healinghandsclinic.co.in", "HHC RR Nagar")],
  },
  "Bengaluru - Kalyan Nagar": {
    label: "Bengaluru Kalyan Nagar",
    recipients: [ROSHAN, MAHIMA, r("kalyannagar@healinghandsclinic.co.in", "HHC Kalyan Nagar")],
  },
  "Bengaluru - Sarjapur": {
    label: "Bengaluru Sarjapura",
    recipients: [ROSHAN, MAHIMA, r("sarjapur@healinghandsclinic.co.in", "HHC Sarjapura")],
  },
  Hyderabad: {
    label: "Hyderabad",
    recipients: [r("hhchyderabad@gmail.com", "HHC Hyderabad"), ROSHAN, MAHIMA, MAYURI],
  },
  Secunderabad: {
    label: "Secunderabad",
    recipients: [r("laxma008@gmail.com", "HHC Secunderabad"), ROSHAN, MAHIMA, MAYURI],
  },
  Ludhiana: {
    label: "Ludhiana",
    recipients: [
      r("healinghandsclinicludhiana@gmail.com", "Ludhiana Team"),
      ROSHAN,
      PANKAJ,
      MAHIMA,
    ],
  },
  // Indore team / Nihit were commented out in the PHP — left out here too.
  Indore: {
    label: "Indore",
    recipients: [ROSHAN, PANKAJ],
  },
  Mysore: {
    label: "Mysore",
    recipients: [r("reception.hhcmysore@gmail.com", "Reception Mysore"), ROSHAN, MAHIMA],
  },
  Surat: {
    label: "Surat",
    recipients: [r("hhcsurat@gmail.com", "HHC Surat"), ROSHAN, DEEPIKA, MAHIMA],
  },
  "Adajan - Pal": {
    label: "Pal",
    recipients: [r("suratpal@healinghandsclinic.co.in", "HHC Pal"), ROSHAN, DEEPIKA, MAHIMA],
  },
  Ahmedabad: {
    label: "Ahmedabad",
    recipients: [r("ahmedabad@healinghandsclinic.co.in", "HHC Ahmedabad"), ROSHAN, MAHIMA],
  },
  Bopal: {
    label: "Bopal",
    recipients: [r("bopal@healinghandsclinic.co.in", "HHC Bopal"), ROSHAN, MAHIMA],
  },
  Raipur: {
    label: "Raipur",
    recipients: [r("raipur@healinghandsclinic.co.in", "HHC Raipur"), ROSHAN, MAHIMA],
  },
  Mohali: {
    label: "Mohali",
    recipients: [r("mohali@healinghandsclinic.co.in", "HHC Mohali"), ROSHAN, MAHIMA],
  },
  Dubai: {
    label: "Dubai",
    recipients: [ROSHAN, PANKAJ, MAHIMA],
  },
  "Gurugram - Sector 49": {
    label: "Gurugram Sector 49",
    recipients: [
      r("HHC.reception49@gmail.com", "HHC Sector 49"),
      r("Hhc.gurugram@gmail.com", "HHC Gurugram Team"),
      MAYURI,
      MAHIMA,
    ],
  },
  "Gurugram - Sector 14": {
    label: "Gurugram Sector 14",
    recipients: [
      r("HHC.reception14@gmail.com", "HHC Sector 14"),
      r("Hhc.gurugram@gmail.com", "HHC Gurugram Team"),
      MAYURI,
      MAHIMA,
    ],
  },
  Jaipur: {
    label: "Jaipur",
    recipients: [ROSHAN, MAHIMA],
  },
  Kalaburagi: {
    label: "Kalaburagi",
    recipients: [ROSHAN, r("healinghands.585@gmail.com", "HHC Kalaburagi"), MAHIMA],
  },
  Lucknow: {
    label: "Lucknow",
    recipients: [ROSHAN, r("Lucknow@healinghandsclinic.co.in", "HHC Lucknow"), DEEPIKA, MAHIMA],
  },
};

module.exports = { BOOKING_RECIPIENTS };
