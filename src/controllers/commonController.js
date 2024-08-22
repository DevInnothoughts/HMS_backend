var express = require("express");
var router = express.Router();
const { userLogin } = require("../models/commonModel");

router.get("/", async (req, res, next) => {
  try {
    const result = await userLogin(req, res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
