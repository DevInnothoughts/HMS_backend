var express = require("express");
var router = express.Router();
const {
  getDailyOPDCollection,
  getDailyOPDCollectionV1,
} = require("../models/DailyOPDModel");

router.get("/", async (req, res, next) => {
  try {
    const result = await getDailyOPDCollection(req);
    console.log("Result:", result);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

router.get("/v1", async (req, res, next) => {
  try {
    const result = await getDailyOPDCollectionV1(req);
    console.log("Result:", result);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
