const db = require("../../firebase");
const { generateOTP, sendOtp } = require("../../otp-utility");

const userLogin = async (req, res) => {
  try {
    const docRef = db.collection("users").doc(req.query.mobile);
    const doc = await docRef.get();

    if (!doc.exists) {
      console.log("No such document!");
      return res.status(404).json({ message: "No such document!" });
    }

    const doc_data = doc.data();
    console.log(doc_data);
    if (!doc_data.isAllowed) {
      return res
        .status(400)
        .json({ message: "You are not allowed to access HMS." });
    }

    if (doc_data.isActive) {
      return res
        .status(400)
        .json({ message: "You are already logged in on some other device." });
    }

    // Update the user document with OTP
    doc_data.otp = generateOTP();

    await db.collection("users").doc(req.query.mobile).update(doc_data);
    await sendOtp(doc_data.mobile, doc_data.otp.code);

    console.log("Document data:", doc_data);
    return res.status(200).json("OTP sent successfully.");
  } catch (error) {
    console.error("Error getting document:", error);
    return res
      .status(500)
      .json({ message: "Error getting document", error: error.message });
  }
};

module.exports = { userLogin };
