var express = require("express");
var router = express.Router();
const { getPatient } = require("../models/patientModel");

router.get("/", async (req, res, next) => {
  try {
    const result = await getPatient(req);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
