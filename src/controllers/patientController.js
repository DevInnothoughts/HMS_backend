var express = require("express");
var router = express.Router();
const { getPatient, getDiagnosis } = require("../models/patientModel");

router.get("/", async (req, res, next) => {
  try {
    const result = await getPatient(req);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

router.get("/diagnosis", async (req, res, next) => {
  try {
    const result = await getDiagnosis(req);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
