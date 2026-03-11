var express = require("express");
const {
  getPharmacyCollection,
  getPrescriptionPurchaseAnalysis,
} = require("../models/evitalPharmacyCollectionModal");
var router = express.Router();

router.get("/", async (req, res, next) => {
  console.log(req.query.location);
  console.log(req.query.from);
  console.log(req.query.to);
  try {
    const pharmacyCollection = await getPharmacyCollection(req);
    res.status(200).send(pharmacyCollection);
  } catch (err) {
    next(err);
  }
});

router.get("/prescription-analysis", async (req, res) => {
  try {
    const data = await getPrescriptionPurchaseAnalysis(req);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
