const { createPool } = require("./dbconfig");

// Define your database connections
const conDP = createPool("hmsDPDB");
const conAndheri = createPool("hmsAndheriDB");
const conBaner = createPool("hmsBanerDB");
const conBangalore = createPool("hmsBangaloreDB");
const conBelgavi = createPool("hmsBelgaviDB");
const conChakan = createPool("hmsChakanDB");
const conDighi = createPool("hmsDighiDB");
const conGurgaon14 = createPool("hmsGurgaon14DB");
const conGurgaon49 = createPool("hmsGurgaon49DB");
const conHSR = createPool("hmsHSRDB");
const conHyderabad = createPool("hmsHyderabadDB");
const conIndiranagar = createPool("hmsIndiranagarDB");
const conIndore = createPool("hmsIndoreDB");
const conkc = createPool("hmskcDB");
const conKolhapur = createPool("hmsKolhapurDB");
const conLatur = createPool("hmslaturDB");
const conLudhiana = createPool("hmsLudhianaDB");
const conMysore = createPool("hmsMysoreDB");
const conNashik = createPool("hmsNashikDB");
const conNM = createPool("hmsNMDB");
const conPC = createPool("hmsPCDB");
const conSahakarnagar = createPool("hmsSahakarnagarDB");
const conSecunderabad = createPool("hmsSecunderabadDB");
const conSurat = createPool("hmsSuratDB");
const conSV = createPool("hmsSVDB");
const conThane = createPool("hmsThaneDB");
const conTilakroad = createPool("hmsTilakroadDB");
const conUndri = createPool("hmsUndriDB");
const conVashi = createPool("hmsVashiDB");

const getConnectionByLocation = (loc) => {
  let connection;
  let location;

  switch (loc) {
    case "Hyderabad Helpline":
    case "Hyderabad":
    case "Hyderabad 2":
      connection = conHyderabad;
      location = "Hyderabad";
      break;

    case "Swargate 2":
    case "DP Road":
    case "DP Road 2":
    case "DP Road 3":
    case "Swargate":
    case "Swargate 3":
      connection = conDP;
      location = "DP Road";
      break;

    case "Surat Helpline":
    case "Surat":
    case "Surat 1":
    case "Surat 2":
      connection = conSurat;
      location = "Surat";
      break;

    case "Ludhiana":
    case "Ludhiana 2":
      connection = conLudhiana;
      location = "Ludhiana";
      break;

    case "Indiranagar":
    case "Indiranagar 2":
    case "Indiranagar 3":
      connection = conIndiranagar;
      location = "Indiranagar";
      break;

    case "Dighi":
    case "Dighi 2 AP":
      connection = conDighi;
      location = "Dighi";
      break;

    case "Thane":
    case "Thane 2":
    case "Thane - New":
      connection = conThane;
      location = "Thane";
      break;

    case "Belagavi":
    case "Belgavi":
    case "Belagavi MP":
      connection = conBelgavi;
      location = "Belagavi";
      break;

    case "HSR Layout":
    case "HSR":
      connection = conHSR;
      location = "HSR";
      break;

    case "JP Nagar":
    case "Bangalore JP Nagar 2":
      connection = conBangalore;
      location = "Bangalore";
      break;

    case "Navi Mumbai":
    case "Navi Mumbai 2":
    case "Navi Mumbai 3":
    case "NM - New":
      connection = conNM;
      location = "Navi-Mumbai";
      break;

    case "Chinchwad":
    case "Chinchwad 2":
    case "Chinchwad 3":
      connection = conPC;
      location = "Pimpri-Chinchwad";
      break;

    case "Nashik":
    case "Nashik 2":
      connection = conNashik;
      location = "Nashik";
      break;

    case "Salunke Vihar":
    case "Salunke Vihar 2":
      connection = conSV;
      location = "Salunkhe-Vihar";
      break;

    case "Chakan":
    case "Chakan 2":
    case "Chakan 3":
      connection = conChakan;
      location = "Chakan";
      break;

    case "Baner":
    case "Baner 2":
    case "Baner 3":
      connection = conBaner;
      location = "Baner";
      break;

    case "Kolhapur":
      connection = conKolhapur;
      location = "Kolhapur";
      break;

    case "Secunderabad - LR":
    case "Secunderabad":
    case "Secunderabad Helpline":
      connection = conSecunderabad;
      location = "Secunderabad";
      break;

    case "Andheri":
    case "Andheri  2":
    case "Andheri 2":
    case "Andheri - New":
      connection = conAndheri;
      location = "Andheri";
      break;

    case "Sahakar Nagar":
    case "Sahakar nagar 2":
      connection = conSahakarnagar;
      location = "Sahakarnagar";

      break;

    case "Gurgaon Sector 14":
      connection = conGurgaon14;
      location = "Gurgaon-14";
      break;

    case "Gurgaon Sector 49":
      connection = conGurgaon49;
      location = "Gurgaon-49";
      break;

    case "Kemps Corner":
    case "Kemps Corner 2":
      connection = conkc;
      location = "Kemps-Corner";
      break;

    case "Latur":
      connection = conLatur;
      location = "Latur";
      break;

    case "Indore":
    case "Indore 2 - NJ":
      connection = conIndore;
      location = "Indore";
      break;

    case "Mysore":
    case "Mysore - JJ":
      connection = conMysore;
      location = "Mysore";
      break;

    case "Undri":
      connection = conUndri;
      location = "Undri";
      break;

    case "Vashi":
      connection = conVashi;
      location = "Vashi";

    default:
      connection = null;
      location = null;
  }

  return { connection, location };
};

module.exports = { getConnectionByLocation };
