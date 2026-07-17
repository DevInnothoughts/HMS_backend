const crypto = require("crypto");

// --- Worldline UAT config ---
const CONFIG = {
  url: "https://bouat.mrlpay.com/pcpos4/CancelTransactionRequest.php?source=629",
  aesKey: "X5mUl3J1jneCd0adISoHWDTj7U8Rnhvd", // 32 chars -> AES-256
  aesIv: "1111111245683783", // 16 chars
};

// Your Initiate call works by POSTing the bare cipher string, so Cancel does
// the same. Flip to true to send the {"data": "<cipher>"} envelope instead.
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

// --- Build the Cancel request body ---
// Mandatory: tid AND (urn OR request_urn). Everything else is optional and
// simply echoed back by the server.
function buildCancelPayload(p) {
  return {
    tid: p.tid,
    amount: p.amount !== undefined ? String(p.amount) : "",
    organization_code: p.organizationCode || "Retail",
    invoiceNumber: p.invoiceNumber || "",
    rrn: p.rrn || "",
    type: p.type || "SALE",
    cb_amt: p.cbAmt || "",
    app_code: p.appCode || "",
    tokenisedValue: p.tokenisedValue || "",
    actionId: p.actionId || "1",
    urn: p.urn ? String(p.urn) : "",
    request_urn: p.requestUrn || "",
  };
}

// --- Map the server reply to a business outcome (spec 3.2.4) ---
const OUTCOME = {
  CANCELLED: "CANCELLED", // "0" Transaction Cancelled Successfully
  ALREADY_CANCELLED: "ALREADY_CANCELLED", // "0" Transaction already cancelled.
  COMPLETED: "COMPLETED", // "1" Transaction Completed.
  IN_PROCESS: "IN_PROCESS", // "1" Transaction in process it will not be cancelled.
  UNKNOWN: "UNKNOWN",
};

function interpretCancel(res) {
  if (!res) return OUTCOME.UNKNOWN;
  const code = String(res.response_code); // samples return "0" / "1"
  const msg = String(res.response_message || "").toLowerCase();

  if (code === "0" && msg.includes("already cancelled"))
    return OUTCOME.ALREADY_CANCELLED;
  if (code === "0" && msg.includes("cancelled")) return OUTCOME.CANCELLED;
  if (code === "1" && msg.includes("in process")) return OUTCOME.IN_PROCESS;
  if (code === "1" && msg.includes("completed")) return OUTCOME.COMPLETED;
  return OUTCOME.UNKNOWN;
}

// True when the transaction is now definitively not going to be charged.
const isCancelled = (o) =>
  o === OUTCOME.CANCELLED || o === OUTCOME.ALREADY_CANCELLED;

// --- Cancel Transaction (DIAGNOSTIC: prints every step) ---
async function cancelTransaction(params) {
  if (!params || !params.tid) throw new Error("tid is required to cancel");
  if (!params.urn && !params.requestUrn) {
    throw new Error("Either urn or requestUrn is required to cancel");
  }

  const payload = buildCancelPayload(params);
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

  const outcome = interpretCancel(out);
  console.log(
    "\n=== 6) OUTCOME ===\n" +
      outcome +
      "  (response_code=" +
      out.response_code +
      ', message="' +
      out.response_message +
      '")',
  );
  return { ...out, outcome };
}

module.exports = {
  cancelTransaction,
  interpretCancel,
  isCancelled,
  encrypt,
  decrypt,
  buildCancelPayload,
  OUTCOME,
};

// --- Run directly:  node cancel-transaction.js ---
if (require.main === module) {
  cancelTransaction({
    tid: "2532415U",
    urn: "75124", // the urn returned by initiateTransaction
    requestUrn: "HMS-BILL-4568", // fallback if Initiate timed out with no urn
  })
    .then((response) => console.log("\n=== RESULT OBJECT ===\n", response))
    .catch((err) => console.error("\n=== ERROR ===\n", err.message));
}
