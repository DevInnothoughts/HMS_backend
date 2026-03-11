var express = require("express");
const {
  getDatewiseReferredPatients,
  getTopDoctors,
  getAllDoctorsStatistics,
} = require("../models/gpReferralModel");
var router = express.Router();

router.get("/referredPatients", async (req, res, next) => {
  try {
    const leads = await getDatewiseReferredPatients(
      req.query.location,
      req.query.from,
      req.query.to,
      req.query.role
    );
    res.status(200).send(leads);
  } catch (err) {
    next(err);
  }
});

router.get("/topDoctors", async (req, res, next) => {
  try {
    const leads = await getTopDoctors(
      req.query.fromDate,
      req.query.toDate,
      req.query.location,
      req.query.role
    );
    console.log(leads);
    res.status(200).send(leads);
  } catch (err) {
    next(err);
  }
});

router.get("/doctorDirectory", async (req, res, next) => {
  try {
    const leads = await getAllDoctorsStatistics(
      req.query.from,
      req.query.to,
      req.query.location,
      req.query.role
    );
    res.status(200).send(leads);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
