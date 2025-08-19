var express = require("express");
var router = express.Router();
const {
  getLeads,
  getChatBotLeads,
  getDatewiseLeads,
  getDatewiseBotLeads,
} = require("../models/leadManagementModel");

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

router.get("/datewise", async (req, res, next) => {
  try {
    const leads = await getDatewiseLeads(
      req.query.location,
      req.query.from,
      req.query.to
    );
    res.status(200).send(leads);
  } catch (err) {
    next(err);
  }
});

router.get("/datewiseBot", async (req, res, next) => {
  try {
    const leads = await getDatewiseBotLeads(
      req.query.location,
      req.query.from,
      req.query.to
    );
    res.status(200).send(leads);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
