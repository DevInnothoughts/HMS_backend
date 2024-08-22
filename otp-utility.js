const date = require("date-and-time");
const axios = require("axios");

function generateOTP() {
  var digits = "0123456789";
  var otpLength = 4;
  var otp = "";
  for (let i = 1; i <= otpLength; i++) {
    var index = Math.floor(Math.random() * digits.length);
    otp = otp + digits[index];
  }
  return { code: otp, validTill: date.addMinutes(new Date(), 5) };
}

async function sendOtp(mobileNo, otp) {
  console.log("Sending OTP ", otp + " to ", mobileNo);

  let url = `http://otpsms.vision360solutions.in/api/sendhttp.php?authkey=353289A0mspYzcgG6019898eP1&sender=VSTRCL&route=4&country=91&DLT_TE_ID=1207169677199659585&mobiles=${mobileNo}&message=${otp} is OTP for login. - Visitor-Clip.com, a service by Docuclip P Ltd.`; //dummy url
  //let url = `http://otpsms.vision360solutions.in/api/sendhttp.php?authkey=353289A0mspYzcgG6019898eP1&sender=VSTRCL&route=4&country=91&DLT_TE_ID=1207169677199659300&mobiles=${mobileNo}&message=${otp} is OTP for login. - Visitor-Clip.com, a service by Docuclip P Ltd.`;
  //let url = `http://otpsms.vision360solutions.in/api/sendhttp.php?authkey=353289A0mspYzcgG6019898eP1&sender=PRKCLP&route=4&country=91&DLT_TE_ID=1207168864174864146&mobiles=${mobileNo}&message=${otp} is OTP for login.  -  Parking-Clip.com, a service by Docuclip P Ltd.`;
  console.log("sms url: ", url);
  axios
    .get(url)
    .then((res) => console.log("Sent OTP :", res.data))
    .catch((err) => console.log("error while sending OTP", err));
}

module.exports = {
  generateOTP,
  sendOtp,
};
