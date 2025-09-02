var express = require("express");
const { getPerformance } = require("../models/performanceModel");
var router = express.Router();

router.get("/", async (req, res, next) => {
  console.log(req.query.location);
  try {
    const IPDCollection = await getPerformance(req);
    res.status(200).send(IPDCollection);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
