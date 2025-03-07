var express = require("express");
var router = express.Router();

const {
  getDashboardValues,
  getOPDReportData,
  getDCData,
  getDoctorDashboardValues,
  getDoctorsDCData,
  getDoctorOPDReportData,
} = require("../models/dashboardModel");

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

router.get("/dischargeCard", async (req, res, next) => {
  console.log(req.query.location);
  console.log(req.query.from);
  console.log(req.query.to);
  try {
    const values = await getDCData(req);
    console.log(values);
    res.status(200).send(values);
  } catch (err) {
    next(err);
  }
});

router.get("/doctorsDischargeCard", async (req, res, next) => {
  console.log(req.query.location);
  console.log(req.query.from);
  console.log(req.query.to);
  try {
    const values = await getDoctorsDCData(req);
    console.log(values);
    res.status(200).send(values);
  } catch (err) {
    next(err);
  }
});

router.get("/OPDReport", async (req, res, next) => {
  // console.log(req.query.location);
  // console.log(req.query.from);
  // console.log(req.query.to);
  try {
    const values = await getOPDReportData(req);
    console.log(values);
    res.status(200).send(values);
  } catch (err) {
    next(err);
  }
});

router.get("/doctorOPDReport", async (req, res, next) => {
  // console.log(req.query.location);
  // console.log(req.query.from);
  // console.log(req.query.to);
  try {
    const values = await getDoctorOPDReportData(req);
    console.log(values);
    res.status(200).send(values);
  } catch (err) {
    next(err);
  }
});

router.get("/doctor", async (req, res, next) => {
  console.log(req.query.location);
  console.log(req.query.from);
  console.log(req.query.to);
  console.log(req.query.mobile);
  try {
    const values = await getDoctorDashboardValues(req);
    console.log(values);
    res.status(200).send(values);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
