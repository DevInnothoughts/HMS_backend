var express = require("express");
var router = express.Router();

const { getHelplineCall } = require("../models/helplineCallModel");

router.get("/", async (req, res, next) => {
  try {
    const HelplineCall = await getHelplineCall(req);
    res.status(200).send(HelplineCall);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
