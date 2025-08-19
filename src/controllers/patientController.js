var express = require("express");
var router = express.Router();
const {
  getPatient,
  getDiagnosis,
  getReference,
  getReferenceV2,
} = require("../models/patientModel");

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

router.get("/reference", async (req, res, next) => {
  try {
    const result = await getReference(req);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

router.get("/referenceV2", async (req, res, next) => {
  try {
    const result = await getReferenceV2(req);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
