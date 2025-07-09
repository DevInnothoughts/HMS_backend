var express = require("express");
var app = express();
const cors = require("cors");
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
const approvalController = require("./src/controllers/approvalController");

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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).send(err.message || "Something went wrong!");
});

// Start the server
const PORT = process.env.PORT || 5100;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
