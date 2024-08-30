var express = require("express");
const { getDeposit, cashDeposit } = require("../models/depositModel");
var router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const result = await getDeposit(req);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const result = await cashDeposit(req);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
