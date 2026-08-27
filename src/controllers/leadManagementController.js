var express = require("express");
var router = express.Router();
const {
  getLeads,
  getChatBotLeads,
  getDatewiseLeads,
  getDatewiseBotLeads,
} = require("../models/leadManagementModel");

const { getPartnerLeads } = require("../models/partnerLeadsModel");

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
      req.query.to,
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
      req.query.to,
    );
    res.status(200).send(leads);
  } catch (err) {
    next(err);
  }
});

router.get("/partnerLeads", async (req, res, next) => {
  try {
    const { location, from, to, source } = req.query;
    if (!location || !from || !to) {
      return res
        .status(400)
        .json({ error: "location, from and to are required" });
    }
    res.status(200).json(await getPartnerLeads(location, from, to, source));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
