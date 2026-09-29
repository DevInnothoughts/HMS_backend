var express = require("express");
var app = express();
const cors = require("cors");
const cron = require("node-cron");
const dotenv = require("dotenv");
dotenv.config();
const ipdCollectionController = require("./src/controllers/ipdCollectionController");
const opdCollectionController = require("./src/controllers/opdCollectionController");
const appointmentController = require("./src/controllers/appointmentController");
const patientController = require("./src/controllers/patientController");
const dailyOPDController = require("./src/controllers/DailyOPDController");
const commonController = require("./src/controllers/commonController");
const dashboardController = require("./src/controllers/dashboardController");
const depositController = require("./src/controllers/depositController");
const IVRController = require("./src/controllers/ivrCallController");
const HelplineController = require("./src/controllers/helplineCallController");
const ConvincingScoreController = require("./src/controllers/convincingScoreController");
const CallingListController = require("./src/controllers/callingListController");
const leadManagementController = require("./src/controllers/leadManagementController");
const gpReferralController = require("./src/controllers/gpReferralController");
const approvalController = require("./src/controllers/approvalController");
const performanceController = require("./src/controllers/performanceController");
const openAIController = require("./src/controllers/openAIController");
const pharmacyController = require("./src/controllers/evitalPharmacyCollectionController");
const reportController = require("./src/controllers/reportController");
const leadsStatsController = require("./src/controllers/leadStatsController");
const targetComparisonController = require("./src/controllers/targetComparisonController");
const doctorPerformanceController = require("./src/controllers/doctorPerformanceController");
const serviceTicketController = require("./src/controllers/serviceTicketController");
const convincingInsightsController = require("./src/controllers/convincingInsightsController");
const targetComparisonNewController = require("./src/controllers/targetComparisonNewController");
const ticketingController = require("./src/controllers/ticketingController");
const recruitmentController = require("./src/controllers/recruitmentController");
const hexaLeadController = require("./src/controllers/hexaLeadsController");
const { sendApprovalReminders } = require("./src/models/ticketingModel");
const { isReminderWindow } = require("./src/services/businessHours");
const practoLeadController = require("./src/controllers/practoLeadController");
const overViewController = require("./src/controllers/overviewController");

const {
  syncAppointments,
  syncBotAppointments,
} = require("./src/models/leadManagementModel");

const { syncCallAppointments } = require("./src/models/callLeadsModel");
const {
  getTomorrowsAppointment,
  sendScheduledWhatsAppMsg,
} = require("./src/models/patientModel");
const {
  generateAndSendReport,
  generateDSRRangeExcel,
} = require("./src/models/reportMailModel");
const {
  generateReport,
  generatePatientHistoryReport,
} = require("./src/models/consolidatedDataModel");
const {
  generateAllBranchFeedbackExcel,
} = require("./temp/tmp_generateFeedbackReport");
const {
  generateSurgeryPendingExcel,
} = require("./temp/tmp_generateSurgeryPendingReport");

const locations = [
  //"DP Road",
  "Andheri",
  "Baner",
  "Belgavi",
  "Chakan",
  "Chinchwad",
  "Dighi",
  "Gurgaon Sector 14",
  "Gurgaon Sector 49",
  "Hinjewadi",
  "HSR",
  "Hyderabad",
  "Indiranagar",
  "JP Nagar",
  "Kalaburagi",
  "Latur",
  "Ludhiana",
  "Lucknow",
  "Mysore",
  "Nashik",
  "Navi Mumbai",
  "Salunke Vihar",
  "Sahakar Nagar",
  "Secunderabad",
  "Surat",
  "Thane",
  "Undri",
  "Vashi",
  "Rajaji Nagar",
  "Sarjapura",
  "Katraj",
  "Ahmedabad",
  "Mohali",
  "Aurangabad",
  "Whitefield",
  "Hadapsar",
  "Kalyan",
  "Bopal",
  "Electronic City",
  "RR Nagar",
  "Adajan",
  "Raipur",
];

app.use(express.json());
app.use(cors());

// Routes
app.use("/hms/IPDCollection", ipdCollectionController);
app.use("/hms/OPDCollection", opdCollectionController);
app.use("/hms/Appointment", appointmentController);
app.use("/hms/Patient", patientController);
app.use("/hms/DailyOPD", dailyOPDController);
app.use("/hms/Common", commonController);
app.use("/hms/Dashboard", dashboardController);
app.use("/hms/Deposit", depositController);
app.use("/hms/IVRCall", IVRController);
app.use("/hms/HelplineCall", HelplineController);
app.use("/hms/ConvincingScore", ConvincingScoreController);
app.use("/hms/callingList", CallingListController);
app.use("/hms/leadManagement", leadManagementController);
app.use("/hms/approval", approvalController);
app.use("/hms/performance", performanceController);
app.use("/hms/gpReferral", gpReferralController);
app.use("/hms/aiAssistant", openAIController);
app.use("/hms/pharmacyCollection", pharmacyController);
app.use("/hms/report", reportController);
app.use("/hms/leadsStats", leadsStatsController);
app.use("/hms/targetComparison", targetComparisonController);
app.use("/hms/doctorPerformance", doctorPerformanceController);
app.use("/hms/serviceTicket", serviceTicketController);
app.use("/hms/convincingInsights", convincingInsightsController);
app.use("/hms/targetComparisonNew", targetComparisonNewController);
app.use("/hms/ticketing", ticketingController);
app.use("/hms/recruitment", recruitmentController);
app.use("/hms/hexaLead", hexaLeadController);
app.use("/hms/practoLead", practoLeadController);
app.use("/hms/overview", overViewController);

// Error handling middleware
app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? "Internal server error" : err.message,
  });
});

// Schedule every 3 hours (at minute 0 of hour 0, 3, 6, 9, 12, 15, 18, 21)
// cron.schedule("*/6 * * * *", () => {
//   locations.forEach(async (location) => {
//     //console.log(`🔁 Running sync for location: ${location}`);
//     // syncAppointments(location);
//     // syncBotAppointments(location);
//  //syncCallAppointments(location);
//   });
// });

// schedule: 30 20 * * * -> 8:30 PM every day. timezone Asia/Kolkata
cron.schedule(
  "30 20 * * *",
  async () => {
    await Promise.all(
      locations.map(async (loc) => {
        const appointments = await getTomorrowsAppointment(loc);

        console.log(
          `Location ${loc} has ${appointments.length} appointments for tomorrow.`,
        );

        for (const appt of appointments) {
          await sendScheduledWhatsAppMsg(
            `91${appt.patient_phone}`,
            new Date(appt.appointment_timestamp).toLocaleDateString("en-CA", {
              timeZone: "Asia/Kolkata",
            }),
            appt.appointment_time,
            loc, // Use the correct location here
            appt.FDE_Name,
          );
        }
      }),
    );
  },
  {
    timezone: "Asia/Kolkata",
  },
);

// Schedule at 12:30 AM every day
// cron.schedule(
//   "*/1 * * * *",
//   //"30 0 * * *",
//   async () => {
//     try {
//       console.log("Generating and sending yesterday's collections report...");
//       //await generateAndSendReport("shubham.khatod17594@gmail.com"); // replace with actual email
//       //await generateReport("2026-03-01", "2026-03-31"); // For testing, use a wide date range to get all data. Replace with actual date range in production.
//       //generateDSRRangeExcel("2026-05-01", "2026-05-31", locations);
//       // const history = await generatePatientHistoryReport(
//       //   "2026-01-01",
//       //   "2026-06-30",
//       //   ["Andheri", "Thane", "Navi Mumbai", "Vashi"],
//       // );
//       generateAllBranchFeedbackExcel({
//         from: "2026-08-15",
//         to: "2026-09-28",
//         locations,
//       })
//         .then((r) => console.log("Feedback workbook:", r.filePath))
//         .catch((e) => console.error("Feedback workbook failed:", e.message));
//       //console.log("Report generated successfully:", history);
//       // generateSurgeryPendingExcel({
//       //   from: "2026-06-01",
//       //   to: "2026-08-31",
//       //   locations: ["Thane", "Andheri", "Navi Mumbai", "Vashi"],
//       // })
//       //   .then((r) => console.log("Pending surgery workbook:", r.filePath))
//       //   .catch((e) => console.error("Pending surgery failed:", e.message));
//     } catch (err) {
//       console.error("Error in sending report:", err);
//     }
//   },
//   {
//     timezone: "Asia/Kolkata", // Ensure correct timezone
//   },
// );

// ── Cluster Head approval reminders ──────────────────────────────────────────
// Every ten minutes: any ticket still at `Open` past its 3-working-hour
// approval deadline gets one WhatsApp to the Cluster Head. The window guard is
// belt and braces — a deadline computed in working hours always lands inside
// them, so this only matters if the server was down and a backlog built up
// overnight, which must not then flush onto someone's phone at 3 a.m.
// cron.schedule(
//   "*/10 * * * *",
//   async () => {
//     if (!isReminderWindow()) return;
//     try {
//       const r = await sendApprovalReminders();
//       if (r.due) {
//         console.log(
//           `ticketing: ${r.due} ticket(s) past approval deadline — ` +
//             `${r.sent} reminder(s) sent, ${r.skipped} with no mobile on file.`,
//         );
//       }
//     } catch (e) {
//       console.error(
//         "ticketing: approval reminder sweep failed:",
//         e && e.message,
//       );
//     }
//   },
//   { timezone: "Asia/Kolkata" },
// );

// Start the server
const PORT = process.env.PORT || 5100;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
