// src/models/adviceUtils.js
// Single source of truth for reading diagnosis.diagnosisAdvice.
// Stored with a trailing comma ("Surgery,") and possibly multi-valued
// ("Medication,Surgery,") — callingListModel matches it with LIKE, so treat
// it as a comma-separated list rather than one atomic string.

const tokens = (raw) =>
  String(raw || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

// TRUE only when Surgery was actually advised.
// Test / MCDPA / blank / NULL / anything unrecognised is NOT surgery.
const isSurgeryAdvised = (raw) => tokens(raw).includes("surgery");
const isMedicationAdvised = (raw) => tokens(raw).includes("medication");

// Three-way bucket. Surgery wins when a row carries both.
const adviceBucket = (raw) =>
  isSurgeryAdvised(raw)
    ? "Surgery"
    : isMedicationAdvised(raw)
      ? "Medication"
      : "Other";

module.exports = {
  tokens,
  isSurgeryAdvised,
  isMedicationAdvised,
  adviceBucket,
};
