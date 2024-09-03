var express = require("express");
var router = express.Router();
const { getDailyOPDCollection } = require("../models/DailyOPDModel");

router.get("/", async (req, res, next) => {
  try {
    const result = await getDailyOPDCollection(req);
    console.log("Result:", result);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
