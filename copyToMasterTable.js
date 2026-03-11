const util = require("util");
const { getConnectionByLocation } = require("./databaseUtils");

async function copyPatients(location) {
  const { connection: leadsDB } = getConnectionByLocation("lead");
  const { connection: clinicDB } = getConnectionByLocation(location);

  if (!leadsDB || !clinicDB) {
    const err = new Error(`Invalid location: ${location}`);
    err.status = 404;
    throw err;
  }

  try {
    console.log(
      `🔄 Patient Sync started for ${location} at`,
      new Date().toLocaleString()
    );

    // Promisify query methods
    const clinicQuery = util.promisify(clinicDB.query).bind(clinicDB);
    const leadsQuery = util.promisify(leadsDB.query).bind(leadsDB);

    // Step 1: Fetch patients from clinic DB
    const patients = await clinicQuery(
      "SELECT uid_no, date, name, phone, mobile_2 FROM patient WHERE ConfirmPatient !=0 AND is_deleted !=1"
    );

    if (!patients || patients.length === 0) {
      console.log(`✅ No patients found in ${location}`);
      return;
    }

    console.log(`📥 Found ${patients.length} patients in ${location}`);

    // Step 2: Loop through each patient and insert into master_patient
    for (const p of patients) {
      const sql = `
  INSERT INTO patientsMasterData (uid_no, name, date, phone, mobile_2, location)
  VALUES (?, ?, ?, ?, ?, ?)
`;

      await leadsQuery(sql, [
        p.uid_no,
        p.name,
        p.date,
        p.phone,
        p.mobile_2,
        location, // track from which DB it came
      ]);
      // console.log(p);
    }

    console.log(
      `✅ ${location}: Copied ${patients.length} patients to Lead.master_patient`
    );
  } catch (err) {
    console.error(`❌ Error during patient copy for ${location}:`, err.message);
  }
}

// Example usage:
(async () => {
  await copyPatients("Kolhapur"); // 👈 pass any clinic location from your dbUtils switch
})();
