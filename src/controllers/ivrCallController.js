var express = require("express");
var router = express.Router();

const { getIVRCall } = require("../models/ivrCallModel");

router.get("/", async (req, res, next) => {
  try {
    const IVRCall = await getIVRCall(req);
    res.status(200).send(IVRCall);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
