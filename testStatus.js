const crypto = require("crypto");

// --- Worldline UAT config ---
const CONFIG = {
  url: "https://bouat.mrlpay.com/pcpos4/StatusCheck.php?source=629",
  aesKey: "X5mUl3J1jneCd0adISoHWDTj7U8Rnhvd", // 32 chars -> AES-256
  aesIv: "1111111245683783", // 16 chars
};

// Body shape. Your Initiate call works by POSTing the bare cipher string,
// so Status Check does the same. If the server rejects it, flip this to true
// to send the {"data": "<cipher>"} envelope shown in the PDF instead.
const USE_DATA_ENVELOPE = false;

// --- AES-256-CBC encrypt / decrypt ---
function encrypt(plaintext) {
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(CONFIG.aesKey, "utf8"),
    Buffer.from(CONFIG.aesIv, "utf8"),
  );
  return Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]).toString("base64");
}

function decrypt(cipherB64) {
  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    Buffer.from(CONFIG.aesKey, "utf8"),
    Buffer.from(CONFIG.aesIv, "utf8"),
  );
  return Buffer.concat([
    decipher.update(Buffer.from(cipherB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// --- Build the Status Check request body ---
// urn + tid are mandatory. request_urn is the fallback reference you sent in
// the Initiate call (useful if Initiate timed out before returning a urn).
function buildStatusPayload(p) {
  return {
    urn: String(p.urn || ""),
    tid: p.tid,
    request_urn: p.requestUrn || "",
  };
}

// --- Map (response_code + status) to a business outcome (spec 2.1 table) ---
const OUTCOME = {
  PENDING: "PENDING", // 0 + INITIATE / FETCHED -> keep polling
  SUCCESS: "SUCCESS", // 0 + SUCCESS            -> paid
  FAILED: "FAILED", // 0 + EXPIRED             -> failed (24h)
  NOT_FOUND: "NOT_FOUND", // 1                  -> no records found
  UNKNOWN: "UNKNOWN",
};

function interpretStatus(res) {
  if (!res) return OUTCOME.UNKNOWN;
  const code = String(res.response_code);
  const status = String(res.status || "").toUpperCase();
  if (code === "1") return OUTCOME.NOT_FOUND;
  if (code === "0" && (status === "INITIATE" || status === "FETCHED"))
    return OUTCOME.PENDING;
  if (code === "0" && status === "SUCCESS") return OUTCOME.SUCCESS;
  if (code === "0" && status === "EXPIRED") return OUTCOME.FAILED;
  return OUTCOME.UNKNOWN;
}

const isTerminal = (o) =>
  o === OUTCOME.SUCCESS || o === OUTCOME.FAILED || o === OUTCOME.NOT_FOUND;

// --- Check Status (DIAGNOSTIC: prints every step) ---
async function checkStatus(params) {
  const payload = buildStatusPayload(params);
  const plaintext = JSON.stringify(payload);
  const cipher = encrypt(plaintext);
  const body = USE_DATA_ENVELOPE ? { data: cipher } : cipher;

  console.log("\n=== 1) PLAINTEXT payload ===\n" + plaintext);
  console.log("\n=== 2) ENCRYPTED body sent ===\n" + JSON.stringify(body));

  const res = await fetch(CONFIG.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  console.log("\n=== 3) HTTP status ===\n" + res.status + " " + res.statusText);
  console.log("\n=== 4) RAW response from server ===\n" + raw);

  let out;
  try {
    out = JSON.parse(raw);
  } catch (e) {
    console.log("\n!! Server did not return JSON (see RAW response above) !!");
    return { notJson: true, raw };
  }

  // Response may be {"data":"<cipher>"} or a bare cipher string.
  const respCipher = typeof out === "string" ? out : out && out.data;
  if (respCipher) {
    const decrypted = decrypt(respCipher);
    console.log("\n=== 5) DECRYPTED response ===\n" + decrypted);
    out = JSON.parse(decrypted);
  }

  const outcome = interpretStatus(out);
  console.log(
    "\n=== 6) OUTCOME ===\n" +
      outcome +
      "  (status=" +
      out.status +
      ", response_code=" +
      out.response_code +
      ")",
  );
  return { ...out, outcome };
}

// --- Poll until the customer finishes at the terminal (or it fails) ---
// The POS flow is asynchronous; the spec suggests checking every 5 seconds.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollUntilComplete(
  params,
  { intervalMs = 5000, maxAttempts = 24 } = {},
) {
  let last;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(
      `\n---------- poll attempt ${attempt}/${maxAttempts} ----------`,
    );
    last = await checkStatus(params);
    if (isTerminal(last.outcome)) return last;
    await sleep(intervalMs);
  }
  return last; // still PENDING when the window ran out
}

module.exports = {
  checkStatus,
  pollUntilComplete,
  interpretStatus,
  isTerminal,
  encrypt,
  decrypt,
  buildStatusPayload,
  OUTCOME,
};

// --- Run directly:  node check-status.js ---
if (require.main === module) {
  checkStatus({
    urn: "75122", // <-- the urn returned by initiateTransaction
    tid: "2532415U",
    requestUrn: "HMS-BILL-4568",
  })
    .then((response) => console.log("\n=== RESULT OBJECT ===\n", response))
    .catch((err) => console.error("\n=== ERROR ===\n", err.message));
}
