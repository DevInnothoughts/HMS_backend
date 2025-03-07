var express = require("express");
var router = express.Router();
const { getCallingList } = require("../models/callingListModel");

router.get("/", async (req, res, next) => {
  try {
    const result = await getCallingList(req);
    res.status(200).send(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
