var express = require("express");
var router = express.Router();
const {
  getConvincingScore,
  getConvincingScoreV1,
  getConvincingScoreV2,
} = require("../models/convincingScoreModel");

router.get("/", async (req, res, next) => {
  try {
    const result = await getConvincingScore(req);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

router.get("/v1", async (req, res, next) => {
  try {
    const result = await getConvincingScoreV2(req);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
