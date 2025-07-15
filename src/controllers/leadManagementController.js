var express = require("express");
var router = express.Router();
const { getLeads, getChatBotLeads } = require("../models/leadManagementModel");

router.get("/", async (req, res, next) => {
  try {
    const leads = await getLeads(req.query.location);
    res.status(200).send(leads);
  } catch (err) {
    next(err);
  }
});

router.get("/bot", async (req, res, next) => {
  try {
    const leads = await getChatBotLeads(req.query.location);
    res.status(200).send(leads);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
