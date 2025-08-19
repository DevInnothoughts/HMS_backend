var express = require("express");
var router = express.Router();

const {
  getHelplineCall,
  getHelplineCallV2,
} = require("../models/helplineCallModel");

router.get("/", async (req, res, next) => {
  try {
    console.log(req.query);
    const HelplineCall = await getHelplineCall(req);
    res.status(200).send(HelplineCall);
  } catch (err) {
    next(err);
  }
});

router.get("/v2", async (req, res, next) => {
  try {
    const HelplineCall = await getHelplineCallV2(req);
    res.status(200).send(HelplineCall);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
