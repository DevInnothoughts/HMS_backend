var express = require("express");
var router = express.Router();

const {
  getOPDCollection,
  getTotalOPDCollection,
} = require("../models/opdCollectionModel");

router.get("/", async (req, res, next) => {
  console.log(req.query.location);
  console.log(req.query.from);
  console.log(req.query.to);
  try {
    const OPDCollection = await getOPDCollection(req);
    res.status(200).send(OPDCollection);
  } catch (err) {
    next(err);
  }
});

router.get("/getTotal", async (req, res, next) => {
  console.log(req.query.location);
  console.log(req.query.from);
  console.log(req.query.to);
  try {
    const TotalOPDCollection = await getTotalOPDCollection(req);
    res.status(200).send(TotalOPDCollection);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
