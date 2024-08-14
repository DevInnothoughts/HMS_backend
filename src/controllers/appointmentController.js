var express = require("express");
var router = express.Router();
const { getAppointment } = require("../models/appointmentModel");

router.get("/", async (req, res, next) => {
  try {
    const result = await getAppointment(req);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
