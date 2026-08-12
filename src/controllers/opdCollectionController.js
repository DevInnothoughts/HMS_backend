var express = require("express");
var router = express.Router();

const {
  getOPDCollection,
  getOPDIPDCollection,
  getOPDCollectionV2,
  getOPDCollectionV3,
} = require("../models/opdCollectionModel");

const { getCollectionV4 } = require("../models/labCollectionModel");

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
    const TotalOPDCollection = await getOPDIPDCollection(req);
    res.status(200).send(TotalOPDCollection);
  } catch (err) {
    next(err);
  }
});

router.get("/v2", async (req, res, next) => {
  console.log(req.query.location);
  console.log(req.query.from);
  console.log(req.query.to);
  try {
    const OPDCollection = await getOPDCollectionV2(req);
    res.status(200).send(OPDCollection);
  } catch (err) {
    next(err);
  }
});

router.get("/v3", async (req, res, next) => {
  console.log(req.query.location);
  console.log(req.query.from);
  console.log(req.query.to);
  try {
    const OPDCollection = await getOPDCollectionV3(req);
    res.status(200).send(OPDCollection);
  } catch (err) {
    next(err);
  }
});

router.get("/v4", async (req, res, next) => {
  try {
    res.status(200).send(await getCollectionV4(req));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
