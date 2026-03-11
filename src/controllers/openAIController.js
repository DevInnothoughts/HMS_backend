// routes/voiceCommandController.js
const express = require("express");
const { processVoiceCommand } = require("../models/openAIModel");
const router = express.Router();

router.post("/", async (req, res, next) => {
  try {
    // body: { text, parameter, timePeriod, sampleData }
    const { text, data } = req.body;
    if (!text || !data) {
      return res
        .status(400)
        .json({ error: "Missing text or sampleData in body" });
    }

    const result = await processVoiceCommand({
      text,
      data,
    });
    res.status(200).json(result);
  } catch (err) {
    console.error("voiceCommandController error:", err);
    next(err);
  }
});

module.exports = router;
