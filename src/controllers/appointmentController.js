var express = require("express");
var router = express.Router();
const {
  getAppointment,
  getDoctorsAppointments,
} = require("../models/appointmentModel");

router.get("/", async (req, res, next) => {
  try {
    const result = await getAppointment(req);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

router.get("/doctor", async (req, res, next) => {
  try {
    const result = await getDoctorsAppointments(req);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
