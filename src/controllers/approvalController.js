var express = require("express");
var router = express.Router();

const { getDashboardValues } = require("../models/dashboardModel");
const {
  getCallAndWebData,
  addApprovalDetails,
  getApprovalDetails,
  getIPDReportData,
} = require("../models/approvalModel");

router.get("/", async (req, res, next) => {
  console.log(req.query.location);
  console.log(req.query.from);
  console.log(req.query.to);
  try {
    const values = await getDashboardValues(req);
    console.log(values);
    res.status(200).send(values);
  } catch (err) {
    next(err);
  }
});

router.get("/callAndWeb", async (req, res, next) => {
  console.log(req.query.location);
  console.log(req.query.from);
  console.log(req.query.to);
  try {
    const values = await getCallAndWebData(req);
    console.log(values);
    res.status(200).send(values);
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res) => {
  try {
    const result = await addApprovalDetails(req.body);

    res.status(200).json({
      success: true,
      message: result.message || "Approval record processed successfully",
    });
  } catch (err) {
    console.error("Approval details error:", err);

    res.status(err.status || 500).json({
      success: false,
      error: err.message || "Failed to process approval record",
    });
  }
});

router.get("/approvalStatus", async (req, res, next) => {
  try {
    const values = await getApprovalDetails(req.query.location);
    console.log(values);
    res.status(200).send(values);
  } catch (err) {
    next(err);
  }
});

router.get("/ipdReport", async (req, res, next) => {
  try {
    const values = await getIPDReportData(req);
    console.log(values);
    res.status(200).send(values);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
