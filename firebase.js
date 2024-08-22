const admin = require("firebase-admin");
const serviceAccount = require("./hhc-hms-firebase-adminsdk-1rpj7-bc3e70bc6a.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
module.exports = db;
