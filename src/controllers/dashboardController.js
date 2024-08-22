var express = require("express");
var router = express.Router();

const { getDashboardValues } = require("../models/dashboardModel");

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

module.exports = router;
