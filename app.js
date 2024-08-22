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
