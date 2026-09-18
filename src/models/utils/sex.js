// src/models/utils/sex.js
// ─────────────────────────────────────────────────────────────────────────────
// patient.sex is free text across forty branch databases: "Male", "male", "M",
// "F", "Female", "", NULL, and the occasional stray. Every consumer needs the
// same three buckets, so the rule lives here rather than in each of them.
//
// Lifted verbatim from convincingInsightsModel.js's local normSex. That file
// should now import from here — same behaviour, one definition. Two copies of
// a normalisation rule is how the OPD section and the Convincing Score report
// end up disagreeing about the same patients.
// ─────────────────────────────────────────────────────────────────────────────

function normSex(sex) {
  const s = String(sex || "")
    .trim()
    .toLowerCase();
  if (s.startsWith("m")) return "Male";
  if (s.startsWith("f")) return "Female";
  return "Other";
}

/**
 * Roll raw { sex, cnt } rows into { male, female, other, known, total }.
 *
 * `known` is male + female, and it is what percentages should divide by —
 * dividing by total would quietly show 46% female on a branch where a third of
 * records have no sex recorded, which reads as a real finding rather than a
 * data gap.
 */
function tallySex(rows) {
  const out = { male: 0, female: 0, other: 0 };
  for (const r of rows || []) {
    const n = Number(r.cnt) || 0;
    const b = normSex(r.sex);
    if (b === "Male") out.male += n;
    else if (b === "Female") out.female += n;
    else out.other += n;
  }
  return {
    ...out,
    known: out.male + out.female,
    total: out.male + out.female + out.other,
  };
}

module.exports = { normSex, tallySex };
