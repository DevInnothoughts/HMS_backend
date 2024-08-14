const { getConnectionByLocation } = require("../../databaseUtils");

async function addAppointment(appointments) {
  const { connection, location } = getConnectionByLocation(
    appointments[0].patient_location
  );
  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const values = appointments.map((appointment) => [
    appointment.doctor_id,
    appointment.patient_phone.replace(/^0+/, ""), // Remove starting "0",
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
    patient.patient_phone.replace(/^0+/, ""), // Remove starting "0",
    0,
    0,
    0,
    0,
    location,
    0,
  ]);

  return new Promise((resolve, reject) => {
    connection.getConnection(function (err, tempCon) {
      if (err) {
        return reject(err);
      }

      if (appointments[0].patient_type === "New") {
        console.log("new");
        const sql =
          "INSERT INTO patient (Uid_no, date, name, sex, phone, age, reference_type, address, registration_id, patient_location, ConfirmPatient) VALUES ?";
        tempCon.query(sql, [patientValues], function (error, result) {
          if (error) {
            tempCon.release();
            return reject(error);
          }

          const patientId = result.insertId;

          const appointmentValues = values.map((value) => [
            patientId,
            ...value,
          ]);

          const appointmentSql =
            "INSERT INTO appointment (patient_id, doctor_id, patient_phone, patient_type, appointment_timestamp, appointment_time, status, patient_location, FDE_Name, note) VALUES ?";
          tempCon.query(
            appointmentSql,
            [appointmentValues],
            function (error, result) {
              tempCon.release();
              if (error) {
                return reject(error);
              }
              resolve("Appointment added!");
            }
          );
        });
      } else {
        console.log("other than new");
        const sql = `SELECT patient_id FROM patient WHERE phone = ? AND ConfirmPatient = 1 ORDER BY date DESC LIMIT 1`;
        tempCon.query(
          sql,
          [appointments[0].patient_phone.replace(/^0+/, "")],
          function (error, results) {
            if (error) {
              tempCon.release();
              return reject(error);
            }

            if (results.length === 0) {
              // Patient not found, insert into patient table
              const insertPatientSql =
                "INSERT INTO patient (Uid_no, date, name, sex, phone, age, reference_type, address, registration_id, patient_location, ConfirmPatient) VALUES ?";
              tempCon.query(
                insertPatientSql,
                [patientValues],
                function (error, result) {
                  if (error) {
                    tempCon.release();
                    return reject(error);
                  }

                  const patientId = result.insertId;

                  const appointmentValues = values.map((value) => {
                    value[2] = "New"; // Change patient_type to 'New'
                    return [patientId, ...value];
                  });

                  const appointmentSql =
                    "INSERT INTO appointment (patient_id, doctor_id, patient_phone, patient_type, appointment_timestamp, appointment_time, status, patient_location, FDE_Name, note) VALUES ?";
                  tempCon.query(
                    appointmentSql,
                    [appointmentValues],
                    function (error, result) {
                      tempCon.release();
                      if (error) {
                        return reject(error);
                      }
                      resolve("Appointment added!");
                    }
                  );
                }
              );
            } else {
              // Patient found, use the existing patient ID
              const patientId = results[0].patient_id;

              const appointmentValues = values.map((value) => [
                patientId,
                ...value,
              ]);

              const appointmentSql =
                "INSERT INTO appointment (patient_id, doctor_id, patient_phone, patient_type, appointment_timestamp, appointment_time, status, patient_location, FDE_Name, note) VALUES ?";
              tempCon.query(
                appointmentSql,
                [appointmentValues],
                function (error, result) {
                  tempCon.release();
                  if (error) {
                    return reject(error);
                  }
                  resolve("Appointment added!");
                }
              );
            }
          }
        );
      }
    });
  });
}

async function getAppointment(req) {
  const { connection, location } = getConnectionByLocation(req.query.location);
  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  return new Promise((resolve, reject) => {
    connection.getConnection(function (err, tempCon) {
      if (err) {
        return reject(err);
      }

      const sql = `
          SELECT 
            ap.patient_phone,
            ap.patient_type,
            ap.appointment_timestamp,
            ap.appointment_time,
            ap.confirm_time,
            ap.FDE_Name,
            p.name AS patient_name,
            d.name AS doctor_name
          FROM appointment ap
          JOIN patient p ON ap.patient_id = p.patient_id
          JOIN doctor d ON ap.doctor_id = d.doctor_id
          WHERE ap.appointment_timestamp >= ?  
          AND ap.appointment_timestamp <= ?
          AND ap.is_deleted != 1
          ORDER BY ap.appointment_id DESC
        `;

      const queryParams = [req.query.from, req.query.to]; // Parameters for the SQL query

      tempCon.query(sql, queryParams, (error, rows) => {
        tempCon.release();
        if (error) {
          return reject(error);
        }
        resolve(rows);
      });
    });
  });
}

module.exports = { addAppointment, getAppointment };
