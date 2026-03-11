// models/voiceCommandService.js
const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * processVoiceCommand({ text, parameter, timePeriod, sampleData })
 * - picks the relevant slice of sampleData (if possible)
 * - builds a strict prompt telling the model to ONLY use the provided data
 * - asks the model to return JSON with keys: summary (string), insights (array)
 */
async function processVoiceCommand({ text, data }) {
  // try to extract the relevant slice of the dataset to keep prompt concise
  let dataToSend = data;

  // Limit size: stringify but if too long, send a truncated form (first N points per series)
  const maxPointsPerSeries = 24;
  const safeData = {};
  for (const key of Object.keys(dataToSend)) {
    const val = dataToSend[key];
    if (Array.isArray(val)) {
      safeData[key] = val.slice(0, maxPointsPerSeries);
    } else if (typeof val === "object" && val !== null) {
      safeData[key] = {};
      for (const seriesKey of Object.keys(val)) {
        const series = val[seriesKey];
        safeData[key][seriesKey] = Array.isArray(series)
          ? series.slice(0, maxPointsPerSeries)
          : series;
      }
    } else {
      safeData[key] = val;
    }
  }

  // Build the instruction prompt.
  // We ask the model to reply in JSON only, with fields: summary, insights (array), numbers (optional)
  const systemMessage = `
You are a precise data-analysis assistant for a healthcare performance dashboard.
IMPORTANT RULES (must follow exactly):
1) You MUST only use the dataset supplied in the user's message. Do NOT use outside facts, or invent values.
2) If the dataset is empty or does not contain the required values, set "summary" = "INSUFFICIENT_DATA" and include a note of what is missing in "insights".
3) Reply ONLY in valid JSON with these keys: 
   - "summary": a short plain-language sentence (max 2 sentences) describing the key trend,
   - "insights": an array of 1-6 short insight strings (e.g., "Mar increased by 10% vs Feb"),
   - "numbers": an object containing **aggregated or highlight metrics** (NOT raw values). Examples:
        • overall_change_percent
        • average_current / average_previous
        • best_month_current / worst_month_current
        • highest_growth_percent / largest_drop_percent
        • cumulative_total_current / previous
        • volatility indicators (range, variation %, etc.)
        • milestone flags (e.g., "record high", "lowest in 12 months")
4) Focus on the provided dataset. If it contains monthly, quarterly, or yearly data, structure 'numbers' with the same grouping key (Monthly / Quarterly / Yearly).
5) Be concise and prefer numeric comparisons (percent, average, delta) instead of restating raw values already in the dataset.
6) If user asks for a visualization or to "do something else", reply that this endpoint only produces textual analysis JSON.
7) Do NOT produce any commentary outside the JSON.
8) Always round percentages to 1 decimal place.

Respond strictly in JSON only.
`;

  const userMessage = `
User instruction: "${text}"
Context:
- dataset (only use this): ${JSON.stringify(safeData)}
Please produce the requested analysis following the rules above and return only JSON.
`;

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini", // pick the model you want and have access to
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage },
      ],
      max_tokens: 500,
      temperature: 0.0, // lower temperature for deterministic numeric answers
    });

    const replyText = completion.choices?.[0]?.message?.content;
    // Try to parse JSON (model is instructed to return valid JSON)
    let parsed = null;
    try {
      parsed = JSON.parse(replyText);
    } catch (err) {
      // fallback: return raw string in reply field
      return {
        reply: replyText,
        success: false,
        note: "Failed to parse JSON from model. Raw content returned in reply.",
      };
    }

    return {
      reply: parsed,
      success: true,
    };
  } catch (err) {
    console.error("OpenAI error:", err);
    // Bubble up a helpful error
    throw new Error("Failed to get response from analysis service");
  }
}

async function processPerformanceSummary({ text, data }) {
  const maxPointsPerSeries = 24;
  const safeData = data;

  const systemMessage = `
You are a precise data-analysis assistant for a healthcare performance dashboard.

STRICT RULES:
1) ONLY use the dataset provided in the user’s message. No external facts.
2) Respond ONLY in valid JSON with this structure:
{
  "summary": "short text (max 50 words)",
  "performance": {
    "best": { "type": string, "period": string, "value": number },
    "worst": { "type": string, "period": string, "value": number }
  }
}
3) "summary" must be concise, describe the key trend (<= 50 words).
4) "performance.best" = the highest value with its type (series name), period (month/quarter/year), and numeric value.
5) "performance.worst" = the lowest value with its type (series name), period, and numeric value.
6) Round values to 1 decimal place if percentage, else keep exact integer/float.
7) If insufficient data, set summary = "INSUFFICIENT_DATA" and best/worst = null.
8) Do NOT add anything outside JSON.
`;

  const userMessage = `
User instruction: "${text}"
Dataset (use only this): ${JSON.stringify(safeData)}
`;

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage },
      ],
      max_tokens: 400,
      temperature: 0.0,
    });

    const replyText = completion.choices?.[0]?.message?.content;
    let parsed = null;
    try {
      parsed = JSON.parse(replyText);
    } catch (err) {
      return {
        reply: replyText,
        success: false,
        note: "Failed to parse JSON from model. Raw content returned.",
      };
    }

    return {
      reply: parsed,
      success: true,
    };
  } catch (err) {
    console.error("OpenAI error:", err);
    throw new Error("Failed to get performance summary");
  }
}

module.exports = { processVoiceCommand, processPerformanceSummary };
