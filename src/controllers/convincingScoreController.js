var express = require("express");
var router = express.Router();
const { getConvincingScore } = require("../models/convincingScoreModel");

router.get("/", async (req, res, next) => {
  try {
    const result = await getConvincingScore(req);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
