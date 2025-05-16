var express = require("express");
var router = express.Router();

const {
  getIPDCollection,
  getTotalIPDCollection,
  getIPDBills,
  getIPDDueList,
} = require("../models/ipdCollectionModel");

router.get("/", async (req, res, next) => {
  console.log(req.query.location);
  console.log(req.query.from);
  console.log(req.query.to);
  try {
    const IPDCollection = await getIPDCollection(req);
    res.status(200).send(IPDCollection);
  } catch (err) {
    next(err);
  }
});

router.get("/bills", async (req, res, next) => {
  console.log(req.query.location);
  console.log(req.query.from);
  console.log(req.query.to);
  try {
    const IPDBills = await getIPDBills(req);
    res.status(200).send(IPDBills);
  } catch (err) {
    next(err);
  }
});

router.get("/getTotal", async (req, res, next) => {
  console.log(req.query.location);
  console.log(req.query.from);
  console.log(req.query.to);
  try {
    const TotalIPDCollection = await getTotalIPDCollection(req);
    res.status(200).send(TotalIPDCollection);
  } catch (err) {
    next(err);
  }
});

router.get("/dueList", async (req, res, next) => {
  console.log(req.query.location);

  try {
    const IPDBills = await getIPDDueList(req);
    res.status(200).send(IPDBills);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
