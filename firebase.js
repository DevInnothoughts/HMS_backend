const admin = require("firebase-admin");
const serviceAccount = require("./hhc-hms-firebase-adminsdk-1rpj7-fdd7d9b78e.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
module.exports = db;
