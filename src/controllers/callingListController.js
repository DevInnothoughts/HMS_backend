var express = require("express");
var router = express.Router();
const {
  getCallingList,
  getCallingListV1,
  getCallingListV2,
} = require("../models/callingListModel");

router.get("/", async (req, res, next) => {
  try {
    const result = await getCallingList(req);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

router.get("/v1", async (req, res, next) => {
  try {
    const result = await getCallingListV1(req);
    //console.log(result);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

router.get("/v2", async (req, res, next) => {
  try {
    res.status(200).send(await getCallingListV2(req));
  } catch (err) {
    console.error("callingList v2:", err.message);
    next(err);
  }
});

module.exports = router;
