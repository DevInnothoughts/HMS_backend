const crypto = require("crypto");

// --- Worldline UAT config ---
const CONFIG = {
  url: "https://lb.mrlpay.com/pcpos4/TransactionRequest.php?source=988",
  aesKey: "bTrpIKF4VDZf1MwUx1N362L0aeyzSUu2", // 32 chars -> AES-256
  aesIv: "czAJaZIH3DTgbz0w", // 16 chars
};

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

// --- Build the request body from the params you pass ---
function buildInitiatePayload(p) {
  return {
    tid: p.tid,
    amount: String(p.amount),
    organization_code: p.organizationCode || "Retail",
    invoiceNumber: p.invoiceNumber || "",
    type: p.type || "SALE",
    app_code: p.appCode || "",
    tokenisedValue: p.tokenisedValue || "",
    actionId: p.actionId || "1",
    request_urn: p.requestUrn || "",
  };
}

// --- Initiate Transaction (DIAGNOSTIC: prints every step) ---
async function initiateTransaction() {
  const payload = {
    tid: "65136209",
    amount: "1",
    actionId: "1",
    type: "SALE",
    organization_code: "Retail",
    requestUrn: "HMS-BILL-4568",
  };
  //const payload = buildInitiatePayload(params);
  const plaintext = JSON.stringify(payload);
  const body = encrypt(plaintext);

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

  if (out.data) {
    const decrypted = decrypt(out.data);
    console.log("\n=== 5) DECRYPTED response ===\n" + decrypted);
    return JSON.parse(decrypted);
  }
  return out;
}

module.exports = {
  initiateTransaction,
  encrypt,
  decrypt,
  buildInitiatePayload,
};

// --- Run directly:  node test ---
if (require.main === module) {
  initiateTransaction()
    .then((response) => console.log("\n=== RESULT OBJECT ===\n", response))
    .catch((err) => console.error("\n=== ERROR ===\n", err.message));
}
