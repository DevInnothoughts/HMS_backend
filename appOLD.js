var mysql = require("mysql");
var express = require("express");
const cors = require("cors");
var app = express();
const { createPool } = require("./dbconfig");

app.use(express.json());
app.use(cors());

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
const conSurat = createPool("hmssuratDB");
const conSV = createPool("hmsSVDB");
const conThane = createPool("hmsThaneDB");
const conTilakroad = createPool("hmsTilakroadDB");
const conUndri = createPool("hmsUndriDB");

// Reusable function to get the connection based on location
const getConnectionByLocation = (loc) => {
  let connection;
  let location;

  switch (loc) {
    case "Hyderabad Helpline":
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
      connection = conDighi;
      location = "Dighi";
      break;

    case "Thane":
    case "Thane 2":
      connection = conThane;
      location = "Thane";
      break;

    case "Belagavi":
      connection = conBelgavi;
      location = "Belagavi";
      break;

    case "HSR Layout":
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
      connection = conNashik;
      location = "Nashik";
      break;

    case "Salunke Vihar":
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
    case "Secunderabad Helpline":
      connection = conSecunderabad;
      location = "Secunderabad";
      break;

    case "Andheri":
    case "Andheri  2":
    case "Andheri 2":
      connection = conAndheri;
      location = "Andheri";
      break;

    case "Sahakar Nagar":
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
      connection = conMysore;
      location = "Mysore";
      break;

    case "Undri":
      connection = conUndri;
      location = "Undri";
      break;

    default:
      connection = null;
      location = null;
  }

  return { connection, location };
};

// con.connect(function (err) {
//   if (err) throw err;
//   console.log("Connected!");
// });

app.get("/doctor", function (req, res) {
  const loc = req.query.location;

  const { connection } = getConnectionByLocation(loc);

  if (!connection) {
    return res.status(404).send("Invalid location");
  }

  connection.getConnection(function (err, tempCon) {
    if (err) {
      console.error("Error getting connection:", err);
      return res.status(500).send("Error getting connection");
    }

    tempCon.query(
      "SELECT doctor_id, name FROM doctor WHERE is_deleted != 1 ORDER BY doctor_id ASC",
      function (error, rows, fields) {
        tempCon.release();
        if (error) {
          console.error("Error executing query:", error);
          return res.status(500).send("Error executing query");
        }
        console.log("Success!\n");
        res.status(200).send(rows);
      }
    );
  });
});

app.get("/fde", function (req, res) {
  const loc = req.query.location;
  console.log(loc);

  const { connection } = getConnectionByLocation(loc);
  console.log(connection);
  if (!connection) {
    return res.status(404).send("Invalid location");
  }

  connection.getConnection(function (err, tempCon) {
    if (err) {
      console.error("Error getting connection:", err);
      return res.status(500).send("Error getting connection");
    }

    tempCon.query(
      "SELECT FDEID, FDEName FROM fdedetails WHERE is_deleted != 1 ORDER BY FDEID ASC",
      function (error, rows, fields) {
        tempCon.release();
        if (error) {
          console.error("Error executing query:", error);
          return res.status(500).send("Error executing query");
        }
        console.log("Success!\n");

        res.status(200).send(rows);
      }
    );
  });
});

app.post("/enquiry", function (req, res) {
  const appointments = req.body;
  const { connection, location } = getConnectionByLocation(
    appointments[0].patient_location
  );

  if (!connection) {
    return res.status(404).send("Invalid location");
  } else {
    const values = appointments.map((appointment) => [
      //appointment.doctor_id,
      appointment.patient_type,
      appointment.enquirytype,
      appointment.patient_name,
      appointment.patient_phone,
      appointment.date,
      appointment.time,
      location,
      appointment.reference,
      appointment.FDE_Name,
      appointment.note,
    ]);

    connection.getConnection(function (err, tempCon) {
      if (err) {
        tempCon.release();
        console.error("Error getting connection:", err);
        return res.status(500).send("Error getting connection");
      }
      var sql =
        "INSERT INTO appointment_enquiry (patient_type, enquirytype, patient_name, patient_phone, date, time, patient_location, reference, FDE_Name, note) VALUES ?";

      console.log(values);
      tempCon.query(sql, [values], function (error, rows, fields) {
        if (error) {
          console.error("Error executing query:", error);
          return res.status(500).send("Error executing query");
        } else {
          sql = `UPDATE IVRdata 
       SET status = 'Enquiry', note = ?
       WHERE call_date = ? AND call_time = ? AND caller_no = ?`;
          const ivrQueryParams = [
            appointments[0].note,
            appointments[0].Call_Date,
            appointments[0].Call_Time,
            appointments[0].patient_phone,
          ];
          tempCon.query(sql, ivrQueryParams, function (error, rows, fields) {
            tempCon.release();
            if (error) {
              console.error("Error executing query:", error);
              return res.status(500).send("Error executing query");
            }
            console.log("Enquiry added!");
            console.log("Number of rows updated:", rows.affectedRows);
            res.status(200).send("Enquiry added!");
          });
        }
      });
    });
  }
});

app.post("/appointment", function (req, res) {
  const appointments = req.body;
  const { connection, location } = getConnectionByLocation(
    appointments[0].patient_location
  );

  if (!connection) {
    return res.status(404).send("Invalid location");
  } else {
    const values = appointments.map((appointment) => [
      appointment.doctor_id,
      appointment.patient_phone,
      appointment.patient_type,
      appointment.date,
      appointment.time,
      "Pending",
      location,
      appointment.FDE_Name,
      appointment.note,
    ]);

    const patientValues = appointments.map((patient) => [
      0,
      patient.date,
      patient.patient_name,
      0,
      patient.patient_phone,
      0,
      0,
      0,
      0,
      location,
      0,
    ]);

    connection.getConnection(function (err, tempCon) {
      if (err) {
        tempCon.release();
        console.error("Error getting connection:", err);
        return res.status(500).send("Error getting connection");
      }

      // Insert patient data
      var sql =
        "INSERT INTO patient (Uid_no, date, name, sex, phone, age, reference_type, address, registration_id, patient_location, ConfirmPatient) VALUES ?";
      tempCon.query(sql, [patientValues], function (error, result) {
        if (error) {
          tempCon.release();
          console.error("Error executing query:", error);
          return res.status(500).send("Error executing query");
        }
        console.log("Res:", result);
        // Get the patient_id of the recently added patient
        const patientId = result.insertId;

        // Construct the appointment values with patient_id included for each appointment
        const appointmentValues = values.map((value) => [patientId, ...value]);

        // Insert appointment data
        sql =
          "INSERT INTO appointment (patient_id, doctor_id, patient_phone, patient_type, appointment_timestamp, appointment_time, status, patient_location, FDE_Name, note) VALUES ?";
        tempCon.query(sql, [appointmentValues], function (error, rows, fields) {
          if (error) {
            console.error("Error executing query:", error);
            tempCon.release();
            return res.status(500).send("Error executing query");
          }

          // Update IVRdata table
          sql = `UPDATE IVRdata 
                 SET status = 'Appointment', note = ?
                 WHERE call_date = ? AND call_time = ? AND caller_no = ?`;
          const ivrQueryParams = [
            appointments[0].note,
            appointments[0].Call_Date,
            appointments[0].Call_Time,
            appointments[0].patient_phone,
          ];
          tempCon.query(sql, ivrQueryParams, function (error, rows, fields) {
            tempCon.release();
            if (error) {
              console.error("Error executing query:", error);
              return res.status(500).send("Error executing query");
            }
            console.log("Appointment added!");
            console.log("Number of rows updated:", rows.affectedRows);
            res.status(200).send("Appointment added!");
          });
        });
      });
    });
  }
});

app.post("/addNote", function (req, res) {
  const appointments = req.body;
  const { connection, location } = getConnectionByLocation(
    appointments[0].patient_location
  );

  if (!connection) {
    return res.status(404).send("Invalid location");
  } else {
    connection.getConnection(function (err, tempCon) {
      if (err) {
        tempCon.release();
        console.error("Error getting connection:", err);
        return res.status(500).send("Error getting connection");
      }
      // Update IVRdata table
      var sql = `UPDATE IVRdata 
                 SET note = ?
                 WHERE call_date = ? AND call_time = ? AND caller_no = ?`;
      const ivrQueryParams = [
        appointments[0].note,
        appointments[0].Call_Date,
        appointments[0].Call_Time,
        appointments[0].patient_phone,
      ];
      tempCon.query(sql, ivrQueryParams, function (error, rows, fields) {
        tempCon.release();
        if (error) {
          console.error("Error executing query:", error);
          return res.status(500).send("Error executing query");
        }
        console.log("Note added!");
        console.log("Number of rows updated:", rows.affectedRows);
        res.status(200).send("Note added!");
      });
    });
  }
});

app.listen(3001, () => {
  console.log("listening at 3001");
});
