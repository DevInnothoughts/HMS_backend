const { getConnectionByLocation } = require("../../databaseUtils");
const { resolveInsuranceNames } = require("./reportModel");
const { addCompanyNames } = require("./utils/insuranceNames");
const { interbranchRoleSql, countedSql } = require("./utils/interbranch");

const getIPDCollection = async (req) => {
  console.log(req.params.location);
  console.log(req.params.from);
  console.log(req.params.to);
  const { connection, location } = getConnectionByLocation(req.query.location); // Ensure `req.params.location` is correct

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    // Using a promise-based approach to handle the connection
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) {
          return reject(err);
        }

        const sql = `
         SELECT 
            ip.patient_id, 
            p.name, 
            ip.receipt_date, 
            ip.cashamt, 
            ip.cardamt, 
            ip.chequeamt, 
            ip.onlineamt, 
            ip.discountamt,
            i.totalamt,
            i.totaldue,
            i.status
          FROM ipd_payment ip
          JOIN patient p ON ip.patient_id = p.patient_id
          JOIN invoice i ON ip.invoice_id = i.invoice_id
          WHERE ip.receipt_date >= ?  
            AND ip.receipt_date <= ?
            AND i.creation_date >= ?  
          AND i.creation_date <= ?
          ORDER BY ip.receipt_date DESC;
        `;

        const queryParams = [
          req.query.from,
          req.query.to,
          req.query.from,
          req.query.to,
        ]; // Parameters for the SQL query

        tempCon.query(sql, queryParams, (error, rows) => {
          tempCon.release();
          if (error) {
            return reject(error);
          }
          resolve(rows);
        });
      });
    });
    console.log(rows);
    return rows;
  } catch (error) {
    throw error;
  }
};

const getIPDCollectionV2 = async (req) => {
  const { connection } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const [from, to] = [req.query.from, req.query.to];

  try {
    const ipdPaymentData = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        const ipdQuery = `
          SELECT 
            ip.patient_id,
            ip.invoice_id,
            ip.receipt_date,
            ip.cashamt,
            ip.cardamt,
            ip.chequeamt,
            ip.onlineamt,
            ip.discountamt,
            ip.tdsamt,
            p.name,
            i.totalamt,
            i.totaldue,
            i.status
          FROM ipd_payment ip
          JOIN patient p ON ip.patient_id = p.patient_id
          JOIN invoice i ON ip.invoice_id = i.invoice_id
          WHERE ip.receipt_date BETWEEN ? AND ?
          ORDER BY ip.receipt_date DESC;
        `;

        tempCon.query(ipdQuery, [from, to], (error, results) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(results);
        });
      });
    });

    const invoiceData = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        const invoiceQuery = `
          SELECT 
            invoice_id,
            totalamt,
            totaldue,
            status
          FROM invoice
          WHERE creation_date BETWEEN ? AND ?;
        `;

        tempCon.query(invoiceQuery, [from, to], (error, results) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(results);
        });
      });
    });

    return {
      ipdPayments: ipdPaymentData,
      invoices: invoiceData,
    };
  } catch (error) {
    throw error;
  }
};

const getIPDCollectionV3 = async (req) => {
  const { connection } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const [from, to] = [req.query.from, req.query.to];

  try {
    const [ipdAllPayments, ipdCashless, invoiceData] = await Promise.all([
      // Query 1: Fetch ALL IPD payments (no cashless/non-cashless filter)
      new Promise((resolve, reject) => {
        connection.getConnection((err, tempCon) => {
          if (err) return reject(err);

          const ipdQueryAll = `
            SELECT
    ip.invoice_id,
    ip.patient_id,
    MAX(ip.receipt_date) AS receipt_date,
    SUM(ip.cashamt) AS cashamt,
    SUM(ip.cardamt) AS cardamt,
    SUM(ip.chequeamt) AS chequeamt,
    SUM(ip.onlineamt) AS onlineamt,
    SUM(ip.discountamt) AS discountamt,
    SUM(ip.tdsamt) AS tdsamt,
    p.name,
    i.totalamt,
    i.totaldue,
    i.status,
    i.creation_date AS invoice_date
FROM ipd_payment ip
LEFT JOIN patient p ON ip.patient_id = p.patient_id
LEFT JOIN invoice i ON ip.invoice_id = i.invoice_id
WHERE ip.receipt_date BETWEEN ? AND ?
GROUP BY ip.invoice_id
ORDER BY MAX(ip.receipt_date) DESC;
          `;

          tempCon.query(ipdQueryAll, [from, to], (error, results) => {
            tempCon.release();
            if (error) return reject(error);
            console.log("All IPD Payments:", results.length);
            resolve(results);
          });
        });
      }),

      // Query 2: Cashless payments from insurance_invoice
      new Promise((resolve, reject) => {
        connection.getConnection((err, tempCon) => {
          if (err) return reject(err);

          const ipdQueryCashless = `
            SELECT 
              iv.patientid AS patient_id,
              iv.invoiceid AS invoice_id,
              iv.paymentdate AS receipt_date,
              iv.receivedamt,
              iv.tdsamt AS actualTDS,
              p.name,
              i.totalamt,
              i.totaldue,
              i.creation_date AS invoice_date,
              i.status
            FROM insurance_invoice iv 
            LEFT JOIN patient p ON iv.patientid = p.patient_id
            LEFT JOIN invoice i ON iv.invoiceid = i.invoice_id
            WHERE iv.paymentdate BETWEEN ? AND ?
            ORDER BY iv.paymentdate DESC;
          `;

          tempCon.query(ipdQueryCashless, [from, to], (error, results) => {
            tempCon.release();
            if (error) return reject(error);
            console.log("Cashless results:", results.length);
            resolve(results);
          });
        });
      }),

      // Query 3: Invoices
      new Promise((resolve, reject) => {
        connection.getConnection((err, tempCon) => {
          if (err) return reject(err);

          const invoiceQuery = `
            SELECT 
              invoice_id,
              totalamt,
              totaldue,
              status
            FROM invoice
            WHERE creation_date BETWEEN ? AND ?;
          `;

          tempCon.query(invoiceQuery, [from, to], (error, results) => {
            tempCon.release();
            if (error) return reject(error);
            resolve(results);
          });
        });
      }),
    ]);

    // Step 2: enrich ipdCashless with collections from ipd_payment
    const enrichedIpdCashless = await Promise.all(
      ipdCashless.map(
        (cashlessRow) =>
          new Promise((resolve, reject) => {
            connection.getConnection((err, tempCon) => {
              if (err) return reject(err);

              const collectionQuery = `
                SELECT 
                  COALESCE(SUM(ip.cashamt), 0) AS cashamt,
                  COALESCE(SUM(ip.cardamt), 0) AS cardamt,
                  COALESCE(SUM(ip.chequeamt), 0) AS chequeamt,
                  COALESCE(SUM(ip.onlineamt), 0) AS onlineamt,
                  COALESCE(SUM(ip.discountamt), 0) AS discountamt,
                  COALESCE(SUM(ip.tdsamt), 0) AS tdsamt
                FROM ipd_payment ip
                WHERE ip.invoice_id = ?;
              `;

              tempCon.query(
                collectionQuery,
                [cashlessRow.invoice_id],
                (error, results) => {
                  tempCon.release();
                  if (error) return reject(error);

                  const collection =
                    results && results.length > 0 ? results[0] : {};

                  resolve({
                    ...cashlessRow,
                    cashamt: collection.cashamt || 0,
                    cardamt: collection.cardamt || 0,
                    chequeamt: collection.chequeamt || 0,
                    onlineamt: collection.onlineamt || 0,
                    discountamt: collection.discountamt || 0,
                    tdsamt: collection.tdsamt || 0,
                  });
                },
              );
            });
          }),
      ),
    );

    // // Step 3: Combine normal + cashless (by invoice_id)
    // const combinedPayments = [...ipdAllPayments];

    // enrichedIpdCashless.forEach((cashlessRow) => {
    //   const existingIndex = combinedPayments.findIndex(
    //     (row) => row.invoice_id === cashlessRow.invoice_id,
    //   );

    //   if (existingIndex > -1) {
    //     // Merge values if invoice_id exists
    //     combinedPayments[existingIndex] = {
    //       ...combinedPayments[existingIndex],
    //       ...cashlessRow,
    //     };
    //   } else {
    //     // If not found, just push cashless record
    //     combinedPayments.push(cashlessRow);
    //   }
    // });

    // Step 3: Combine normal + cashless (by invoice_id)
    const combinedPayments = [...ipdAllPayments];

    enrichedIpdCashless.forEach((cashlessRow) => {
      const matchingRows = combinedPayments.filter(
        (row) => row.invoice_id === cashlessRow.invoice_id,
      );

      if (matchingRows.length > 0) {
        // Merge cashless data into ALL matching rows
        matchingRows.forEach((row) => {
          Object.assign(row, {
            receivedamt: cashlessRow.receivedamt,
            actualTDS: cashlessRow.actualTDS,
          });
        });
      } else {
        combinedPayments.push({
          ...cashlessRow,
          cashamt: 0,
          cardamt: 0,
          chequeamt: 0,
          onlineamt: 0,
          discountamt: 0,
          tdsamt: 0,
        });
      }
    });

    //console.log("Total combined payments:", combinedPayments);
    return {
      ipdPayments: combinedPayments,
      invoices: invoiceData,
    };
  } catch (error) {
    throw error;
  }
};

const getIPDBills = async (req) => {
  console.log(req.query.location);
  console.log(req.query.from);
  console.log(req.query.to);
  const { connection, location } = getConnectionByLocation(req.query.location); // Ensure `req.params.location` is correct

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    // Using a promise-based approach to handle the connection
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) {
          return reject(err);
        }

        const sql = `
          SELECT i.invoice_id, i.patient_id, p.name,p.phone,p.sex, i.discount, i.status, i.payable_amt, i.totalamt
          FROM invoice i
          JOIN patient p ON i.patient_id = p.patient_id
          WHERE i.creation_date >= ?  
          AND i.creation_date <= ?
          AND i.is_deleted != 1
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
    console.log(rows);
    return rows;
  } catch (error) {
    throw error;
  }
};

const getTotalIPDCollection = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location); // Ensure `req.params.location` is correct

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    // Using a promise-based approach to handle the connection
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) {
          return reject(err);
        }

        const sql = `
          SELECT 
            ip.receipt_date,
            SUM(ip.cashamt) AS total_cashamt,
            SUM(ip.cardamt) AS total_cardamt,
            SUM(ip.onlineamt) AS total_onlineamt,
            SUM(ip.discountamt) AS total_discountamt
          FROM ipd_payment ip
          WHERE ip.receipt_date >= ?  
          AND ip.receipt_date <= ?
          GROUP BY ip.receipt_date
          ORDER BY ip.receipt_date ASC
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
    console.log(rows);
    return rows;
  } catch (error) {
    throw error;
  }
};

const getIPDDueList = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        const sql = `
          SELECT 
              p.patient_id,
              p.name,
              i.invoice_id,
              i.status,
              i.creation_date,
              i.totalamt,
              i.totaldue,
              CASE 
                WHEN DATEDIFF(CURDATE(), i.creation_date) > 90 THEN '>90 days'
                WHEN DATEDIFF(CURDATE(), i.creation_date) > 60 THEN '>60 days'
                WHEN DATEDIFF(CURDATE(), i.creation_date) > 30 THEN '>30 days'
                ELSE '<30 days'
              END AS due_category
          FROM patient p
          JOIN invoice i ON p.patient_id = i.patient_id
          WHERE i.totaldue > 0
          AND i.creation_date >= '2025-04-01'
          ORDER BY due_category, i.creation_date
        `;

        tempCon.query(sql, (error, rows) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(rows);
        });
      });
    });

    // Initialize category buckets with totals
    const groupedPatients = {
      ">90 days": { patients: [], totalDue: 0 },
      ">60 days": { patients: [], totalDue: 0 },
      ">30 days": { patients: [], totalDue: 0 },
      "<30 days": { patients: [], totalDue: 0 },
    };

    // Populate buckets and sum totaldue
    rows.forEach((patient) => {
      const category = patient.due_category;
      if (groupedPatients[category]) {
        groupedPatients[category].patients.push(patient);

        // Ensure totaldue is treated as a number
        const totalDueValue = Number(patient.totaldue) || 0;
        groupedPatients[category].totalDue += totalDueValue;
      }
    });

    console.log(groupedPatients);
    return groupedPatients;
  } catch (error) {
    throw error;
  }
};

const getIPDBillsV2 = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const { from, to, status = "" } = req.query;
  const hasStatusFilter = status && status.trim() !== "";

  try {
    // Main query
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        let sql = `
          SELECT 
              i.invoice_id,
              i.patient_id,
              i.creation_date AS admission_date,
              i.due_date AS discharge_date,
              p.name,
              p.phone,
              p.sex,
              i.discount,
              i.status,
              i.payable_amt,
              i.totalamt,
              i.totaldue,
              COALESCE(SUM(
                  COALESCE(ip.cashamt, 0) + 
                  COALESCE(ip.cardamt, 0) + 
                  COALESCE(ip.chequeamt, 0) + 
                  COALESCE(ip.onlineamt, 0)
              ), 0) AS collection
          FROM invoice i
          JOIN patient p ON i.patient_id = p.patient_id
          LEFT JOIN ipd_payment ip ON i.invoice_id = ip.invoice_id
          WHERE i.creation_date >= ?  
            AND i.creation_date <= ?
            AND i.is_deleted != 1
        `;

        const queryParams = [from, to];

        if (hasStatusFilter) {
          sql += ` AND i.status = ?`;
          queryParams.push(status);
        }

        sql += `
          GROUP BY 
              i.invoice_id, i.patient_id, p.name, p.phone, p.sex, 
              i.discount, i.status, i.payable_amt, i.totalamt, i.totaldue
        `;

        tempCon.query(sql, queryParams, (error, result) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(result);
        });
      });
    });

    // Totals query
    const typeTotals = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        let summarySql = `
          SELECT i.status, SUM(i.totalamt) AS total_amount
          FROM invoice i
          WHERE i.creation_date >= ?
            AND i.creation_date <= ?
            AND i.is_deleted != 1
        `;

        const summaryParams = [from, to];

        if (hasStatusFilter) {
          summarySql += ` AND i.status = ?`;
          summaryParams.push(status);
        }

        summarySql += ` GROUP BY i.status`;

        tempCon.query(summarySql, summaryParams, (error, result) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(result);
        });
      });
    });

    return {
      ipdBills: rows,
      statusWiseTotals: typeTotals,
    };
  } catch (error) {
    console.error("Error in getIPDBillsV2:", error);
    throw error;
  }
};

const getIPDBillsV3 = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const { from, to, status = "" } = req.query;
  const hasStatusFilter = status && status.trim() !== "";

  try {
    // Main query
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        let sql = `
          SELECT 
              i.invoice_id,
              i.patient_id,
              i.creation_date AS admission_date,
              i.due_date AS discharge_date,
              p.name,
              p.phone,
              p.sex,
              i.discount,
              i.status,
              i.insurancecompany AS insurance_company,
              i.payable_amt,
              i.totalamt,
              i.totaldue,
              iv.receivedamt,
              iv.tdsamt AS actualTDS,
              COALESCE(SUM(
                  COALESCE(ip.cashamt, 0) + 
                  COALESCE(ip.cardamt, 0) + 
                  COALESCE(ip.chequeamt, 0) + 
                  COALESCE(ip.onlineamt, 0)
              ), 0) AS collection
          FROM invoice i
          JOIN patient p ON i.patient_id = p.patient_id
          LEFT JOIN ipd_payment ip ON i.invoice_id = ip.invoice_id
          LEFT JOIN insurance_invoice iv ON i.invoice_id = iv.invoiceid
          WHERE i.creation_date >= ?  
            AND i.creation_date <= ?
            AND i.is_deleted != 1
        `;

        const queryParams = [from, to];

        if (hasStatusFilter) {
          sql += ` AND i.status = ?`;
          queryParams.push(status);
        }

        sql += `
          GROUP BY 
              i.invoice_id, i.patient_id, p.name, p.phone, p.sex, 
              i.discount, i.status, i.insurancecompany,
              i.payable_amt, i.totalamt, i.totaldue,
              i.creation_date, i.due_date,
              iv.receivedamt, iv.tdsamt
        `;

        tempCon.query(sql, queryParams, (error, result) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(result);
        });
      });
    });

    // Totals query
    const typeTotals = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        let summarySql = `
          SELECT i.status, SUM(i.totalamt) AS total_amount
          FROM invoice i
          WHERE i.creation_date >= ?
            AND i.creation_date <= ?
            AND i.is_deleted != 1
        `;

        const summaryParams = [from, to];

        if (hasStatusFilter) {
          summarySql += ` AND i.status = ?`;
          summaryParams.push(status);
        }

        summarySql += ` GROUP BY i.status`;

        tempCon.query(summarySql, summaryParams, (error, result) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(result);
        });
      });
    });
    //console.log(rows);
    // The id space changed on 1 Jul 2026 — branch-local before, master
    // insuranceMasterData after — so a plain JOIN on insurance_company returns
    // blank for every recent invoice. resolveInsuranceNames routes each row by
    // its own date and overwrites insurance_company in place with the NAME.
    await resolveInsuranceNames(rows, connection, "admission_date");
    return {
      ipdBills: rows,
      statusWiseTotals: typeTotals,
    };
  } catch (error) {
    console.error("Error in getIPDBillsV2:", error);
    throw error;
  }
};

/**
 * getIPDBillsV4 — V3 plus insurer and TPA names.
 *
 * V3 is untouched and still serves the live screens. V4 returns V3's rows with
 * four extra keys — insurancecompany, tpa, insurance_company_name,
 * tpa_company_name — and the identical envelope { ipdBills, statusWiseTotals }.
 * Existing consumers of V3 are unaffected; a V4 consumer reads the extra keys.
 */
const getIPDBillsV4 = async (req) => {
  const { connection } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const { from, to, status = "" } = req.query;
  const hasStatusFilter = status && status.trim() !== "";

  try {
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        let sql = `
          SELECT 
              i.invoice_id,
              i.patient_id,
              i.creation_date AS admission_date,
              i.due_date AS discharge_date,
              p.name,
              p.phone,
              p.sex,
              i.discount,
              i.status,
              i.insurancecompany,
              i.tpa,
              i.payable_amt,
              i.totalamt,
              i.totaldue,
              iv.receivedamt,
              iv.tdsamt AS actualTDS,
              COALESCE(SUM(
                  COALESCE(ip.cashamt, 0) + 
                  COALESCE(ip.cardamt, 0) + 
                  COALESCE(ip.chequeamt, 0) + 
                  COALESCE(ip.onlineamt, 0)
              ), 0) AS collection
          FROM invoice i
          JOIN patient p ON i.patient_id = p.patient_id
          LEFT JOIN ipd_payment ip ON i.invoice_id = ip.invoice_id
          LEFT JOIN insurance_invoice iv ON i.invoice_id = iv.invoiceid
          WHERE i.creation_date >= ?  
            AND i.creation_date <= ?
            AND i.is_deleted != 1
        `;

        const queryParams = [from, to];

        if (hasStatusFilter) {
          sql += ` AND i.status = ?`;
          queryParams.push(status);
        }

        sql += `
          GROUP BY 
              i.invoice_id, i.patient_id, i.creation_date, i.due_date,
              p.name, p.phone, p.sex, i.discount, i.status,
              i.insurancecompany, i.tpa,
              i.payable_amt, i.totalamt, i.totaldue,
              iv.receivedamt, iv.tdsamt
        `;

        tempCon.query(sql, queryParams, (error, result) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(result);
        });
      });
    });

    const typeTotals = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        let summarySql = `
          SELECT i.status, SUM(i.totalamt) AS total_amount
          FROM invoice i
          WHERE i.creation_date >= ?
            AND i.creation_date <= ?
            AND i.is_deleted != 1
        `;

        const summaryParams = [from, to];

        if (hasStatusFilter) {
          summarySql += ` AND i.status = ?`;
          summaryParams.push(status);
        }

        summarySql += ` GROUP BY i.status`;

        tempCon.query(summarySql, summaryParams, (error, result) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(result);
        });
      });
    });

    // Insurer and TPA share one id space and one 1 Jul 2026 cutover, so both
    // resolve in a single pass. Names are ADDED as *_name; the raw ids stay.
    await addCompanyNames(rows, connection, "admission_date", [
      "insurancecompany",
      "tpa",
    ]);

    return { ipdBills: rows, statusWiseTotals: typeTotals };
  } catch (error) {
    console.error("Error in getIPDBillsV4:", error);
    throw error;
  }
};

/**
 * getIPDBillsV5 — V4 plus interbranch handling.
 *
 * INTERBRANCH INVOICES
 * ────────────────────
 * When a patient's OPD is at branch A (source) but the surgery happens at
 * branch B (operating), the SAME invoice is written into both branch DBs:
 *
 *   operating branch B:  interbranch_id = 0            patient_location = 'A'
 *   source branch A:     interbranch_id = <B's inv id> patient_location = 'B'
 *
 * Counting both double-books the revenue. The rule is: the revenue belongs to
 * the SOURCE branch. Exception: patient_location 'DP Road' is always treated
 * as a source-branch copy (DP Road only ever operates), so it is counted. So on the operating branch the invoice is still listed,
 * but it is left out of every total — billed, per-status totals, patients,
 * discount, due.
 *
 * Each row gets:
 *   interbranch_role   'operating' | 'source' | null  (null = normal invoice)
 *   counted            1 | 0   — 0 only for 'operating' rows
 *   patient_location   the OTHER branch's name (as stored), trimmed / NULL
 *   interbranch_id     raw column
 *
 * statusWiseTotals excludes 'operating' rows server-side, so a client that
 * sums them gets the right number without knowing about interbranch at all.
 * interbranchSummary reports what was excluded, for display.
 *
 * V4 is untouched.
 */
// Rule lives in utils/interbranch.js (shared with targetComparisonNewModel).
const INTERBRANCH_ROLE_SQL = interbranchRoleSql("i");
const COUNTED_SQL = countedSql("i");

const getIPDBillsV5 = async (req) => {
  const { connection } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const { from, to, status = "" } = req.query;
  const hasStatusFilter = status && status.trim() !== "";

  const runQuery = (sql, params) =>
    new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);
        tempCon.query(sql, params, (error, result) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(result);
        });
      });
    });

  try {
    let sql = `
      SELECT
          i.invoice_id,
          i.patient_id,
          i.creation_date AS admission_date,
          i.due_date AS discharge_date,
          p.name,
          p.phone,
          p.sex,
          i.discount,
          i.status,
          i.insurancecompany,
          i.tpa,
          i.payable_amt,
          i.totalamt,
          i.totaldue,
          i.interbranch_id,
          NULLIF(TRIM(i.patient_location), '') AS patient_location,
          ${INTERBRANCH_ROLE_SQL} AS interbranch_role,
          IF(${COUNTED_SQL}, 1, 0) AS counted,
          iv.receivedamt,
          iv.tdsamt AS actualTDS,
          COALESCE(SUM(
              COALESCE(ip.cashamt, 0) +
              COALESCE(ip.cardamt, 0) +
              COALESCE(ip.chequeamt, 0) +
              COALESCE(ip.onlineamt, 0)
          ), 0) AS collection
      FROM invoice i
      JOIN patient p ON i.patient_id = p.patient_id
      LEFT JOIN ipd_payment ip ON i.invoice_id = ip.invoice_id
      LEFT JOIN insurance_invoice iv ON i.invoice_id = iv.invoiceid
      WHERE i.creation_date >= ?
        AND i.creation_date <= ?
        AND i.is_deleted != 1
    `;
    const params = [from, to];

    if (hasStatusFilter) {
      sql += ` AND i.status = ?`;
      params.push(status);
    }

    sql += `
      GROUP BY
          i.invoice_id, i.patient_id, i.creation_date, i.due_date,
          p.name, p.phone, p.sex, i.discount, i.status,
          i.insurancecompany, i.tpa,
          i.payable_amt, i.totalamt, i.totaldue,
          i.interbranch_id, i.patient_location,
          iv.receivedamt, iv.tdsamt
    `;

    // Per-status totals — 'operating' interbranch invoices excluded, so these
    // are this branch's real billed figures.
    let summarySql = `
      SELECT i.status, SUM(i.totalamt) AS total_amount
      FROM invoice i
      WHERE i.creation_date >= ?
        AND i.creation_date <= ?
        AND i.is_deleted != 1
        AND ${COUNTED_SQL}
    `;
    const summaryParams = [from, to];

    if (hasStatusFilter) {
      summarySql += ` AND i.status = ?`;
      summaryParams.push(status);
    }
    summarySql += ` GROUP BY i.status`;

    const [rows, typeTotals] = await Promise.all([
      runQuery(sql, params),
      runQuery(summarySql, summaryParams),
    ]);

    await addCompanyNames(rows, connection, "admission_date", [
      "insurancecompany",
      "tpa",
    ]);

    // What was left out of this branch's totals, for the screen to say so.
    const interbranchSummary = rows.reduce(
      (acc, r) => {
        if (r.interbranch_role === "operating") {
          acc.excludedInvoices += 1;
          acc.excludedAmount += Number(r.totalamt) || 0;
        } else if (r.interbranch_role === "source") {
          acc.sourceInvoices += 1;
        }
        return acc;
      },
      { excludedInvoices: 0, excludedAmount: 0, sourceInvoices: 0 },
    );

    return {
      ipdBills: rows,
      statusWiseTotals: typeTotals,
      interbranchSummary,
    };
  } catch (error) {
    console.error("Error in getIPDBillsV5:", error);
    throw error;
  }
};

const getStatuswiseIPDDueList = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const statusFilter = req.query.status; // e.g., 'Charity', 'Cashless', etc.

  try {
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        // Base SQL
        let sql = `
          SELECT 
              p.patient_id,
              p.name,
              i.invoice_id,
              i.status,
              i.creation_date,
              i.totalamt,
              i.totaldue,
              ic.companyname,
              CASE 
                WHEN DATEDIFF(CURDATE(), i.creation_date) > 90 THEN '>90 days'
                WHEN DATEDIFF(CURDATE(), i.creation_date) > 60 THEN '>60 days'
                WHEN DATEDIFF(CURDATE(), i.creation_date) > 30 THEN '>30 days'
                ELSE '<30 days'
              END AS due_category
          FROM patient p
          JOIN invoice i ON p.patient_id = i.patient_id
          LEFT JOIN insurance_company ic ON i.insurancecompany = ic.comapny_id
          WHERE i.totaldue > 0
            AND i.creation_date >= '2025-04-01'
        `;

        const queryParams = [];

        if (statusFilter) {
          sql += ` AND i.status = ?`;
          queryParams.push(statusFilter);
        }

        sql += ` ORDER BY due_category, i.creation_date`;

        tempCon.query(sql, queryParams, (error, rows) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(rows);
        });
      });
    });

    // Grouping logic
    const groupedPatients = {
      ">90 days": { patients: [], totalDue: 0 },
      ">60 days": { patients: [], totalDue: 0 },
      ">30 days": { patients: [], totalDue: 0 },
      "<30 days": { patients: [], totalDue: 0 },
    };

    rows.forEach((patient) => {
      const category = patient.due_category;
      if (groupedPatients[category]) {
        groupedPatients[category].patients.push(patient);
        groupedPatients[category].totalDue += Number(patient.totaldue) || 0;
      }
    });

    console.log(groupedPatients);
    return groupedPatients;
  } catch (error) {
    throw error;
  }
};

const getIPDTotalSummary = async (req) => {
  const { connection, location } = getConnectionByLocation(req.query.location);
  const status = req.query.status; // Can be undefined

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    const result = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) return reject(err);

        let sql;
        let values = [];

        if (status) {
          if (status === "Cashless") {
            // Case: Cashless → fetch from insurance_invoice
            sql = `
              SELECT 
                (SELECT SUM(totalamt) 
                 FROM invoice 
                 WHERE creation_date >= '2025-04-01' 
                   AND is_deleted != 1 
                   AND status = ?) AS total_invoice_amount,

                (
                (SELECT COALESCE(SUM(p.cashamt + p.cardamt + p.chequeamt + p.onlineamt), 0)
                 FROM ipd_payment p
                 JOIN invoice i ON p.invoice_id = i.invoice_id
                 WHERE p.receipt_date >= '2025-04-01'
                  AND status = ?)
                +
                (SELECT COALESCE(SUM(iv.receivedamt + iv.tdsamt), 0)
                 FROM insurance_invoice iv
                 JOIN invoice i ON iv.invoiceid = i.invoice_id
                 WHERE iv.paymentdate >= '2025-04-01')
              ) AS total_collection_amount,

                (SELECT SUM(p.discountamt + p.tdsamt)
                 FROM ipd_payment p
                 JOIN invoice i ON p.invoice_id = i.invoice_id
                 WHERE p.receipt_date >= '2025-04-01'
                   AND i.status = ?) AS total_discount_amount,

                (SELECT SUM(totaldue) 
                 FROM invoice 
                 WHERE totaldue > 0 
                   AND creation_date >= '2025-04-01'
                   AND status = ?) AS total_due_amount;
            `;
            values = [status, status, status, status];
          } else {
            // Case: Non-cashless → use ipd_payment only
            sql = `
              SELECT 
                (SELECT SUM(totalamt) 
                 FROM invoice 
                 WHERE creation_date >= '2025-04-01' 
                   AND is_deleted != 1 
                   AND status = ?) AS total_invoice_amount,

                (SELECT SUM(p.cashamt + p.cardamt + p.chequeamt + p.onlineamt)
                 FROM ipd_payment p
                 JOIN invoice i ON p.invoice_id = i.invoice_id
                 WHERE p.receipt_date >= '2025-04-01'
                   AND i.status = ?) AS total_collection_amount,

                (SELECT SUM(p.discountamt + p.tdsamt)
                 FROM ipd_payment p
                 JOIN invoice i ON p.invoice_id = i.invoice_id
                 WHERE p.receipt_date >= '2025-04-01'
                   AND i.status = ?) AS total_discount_amount,

                (SELECT SUM(totaldue) 
                 FROM invoice 
                 WHERE totaldue > 0 
                   AND creation_date >= '2025-04-01'
                   AND status = ?) AS total_due_amount;
            `;
            values = [status, status, status, status];
          }
        } else {
          // Case: No status → include both ipd_payment + insurance_invoice in collection
          sql = `
            SELECT 
              (SELECT SUM(totalamt) 
               FROM invoice 
               WHERE creation_date >= '2025-04-01' 
                 AND is_deleted != 1) AS total_invoice_amount,

              (
                (SELECT COALESCE(SUM(p.cashamt + p.cardamt + p.chequeamt + p.onlineamt), 0)
                 FROM ipd_payment p
                 JOIN invoice i ON p.invoice_id = i.invoice_id
                 WHERE p.receipt_date >= '2025-04-01')
                +
                (SELECT COALESCE(SUM(iv.receivedamt + iv.tdsamt), 0)
                 FROM insurance_invoice iv
                 JOIN invoice i ON iv.invoiceid = i.invoice_id
                 WHERE iv.paymentdate >= '2025-04-01')
              ) AS total_collection_amount,

              (SELECT SUM(p.discountamt + p.tdsamt)
               FROM ipd_payment p
               JOIN invoice i ON p.invoice_id = i.invoice_id
               WHERE p.receipt_date >= '2025-04-01') AS total_discount_amount,

              (SELECT SUM(totaldue) 
               FROM invoice 
               WHERE totaldue > 0 
                 AND creation_date >= '2025-04-01') AS total_due_amount;
          `;
        }

        tempCon.query(sql, values, (error, rows) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(rows[0]);
        });
      });
    });

    console.log(result);
    return result;
  } catch (error) {
    throw error;
  }
};

const getIHXData = async (req) => {
  console.log(req.query.location);
  console.log(req.query.from);
  console.log(req.query.to);
  const { connection, location } = getConnectionByLocation(req.query.location); // Ensure `req.params.location` is correct

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  try {
    // Using a promise-based approach to handle the connection
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) {
          return reject(err);
        }

        const sql = `
          SELECT i.invoice_id, i.patient_id, p.name,p.phone,p.sex, i.discount, i.status, i.payable_amt, i.totalamt, i.IHXData
          FROM invoice i
          JOIN patient p ON i.patient_id = p.patient_id
          WHERE i.creation_date >= ?  
          AND i.creation_date <= ?
          AND i.IHXData IS NOT NULL
          AND i.is_deleted != 1
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
    console.log(rows);
    return rows;
  } catch (error) {
    throw error;
  }
};

/**
 * getStatuswiseIPDDueListV2 — V1 with correctly resolved insurer and TPA names.
 *
 * V1 is untouched and still serves anything already calling it.
 *
 * ⚠️ WHY THE JOIN HAD TO GO
 * ─────────────────────────
 * V1 does `LEFT JOIN insurance_company ic ON ic.comapny_id = i.insurancecompany`
 * against the BRANCH table. From 01 Jul 2026 invoice.insurancecompany holds an
 * id from the MASTER insuranceMasterData instead, and the two id spaces are
 * unrelated — so that join silently returns NULL for every recent invoice, or
 * worse, matches a different company that happens to share the id.
 *
 * The join is dropped and the raw ids are selected instead; addCompanyNames
 * routes each row by its own creation_date and adds
 * insurancecompany_name / tpa_name. A range spanning the cutover gets both
 * maps, which a single join can never do.
 */
const getStatuswiseIPDDueListV2 = async (req) => {
  const { connection } = getConnectionByLocation(req.query.location);

  if (!connection) {
    const err = new Error("Invalid location");
    err.status = 404;
    throw err;
  }

  const { status = "" } = req.query;
  const hasStatusFilter = status && status.trim() !== "";

  try {
    const rows = await new Promise((resolve, reject) => {
      connection.getConnection((err, tempCon) => {
        if (err) {
          if (tempCon) tempCon.release();
          return reject(err);
        }

        let sql = `
          SELECT
              i.invoice_id,
              i.patient_id,
              p.name,
              p.phone,
              i.status,
              i.creation_date,
              i.totalamt,
              i.totaldue,
              i.insurancecompany,
              i.tpa,
              CASE
                WHEN DATEDIFF(CURDATE(), DATE(i.creation_date)) > 90 THEN '>90 days'
                WHEN DATEDIFF(CURDATE(), DATE(i.creation_date)) > 60 THEN '>60 days'
                WHEN DATEDIFF(CURDATE(), DATE(i.creation_date)) > 30 THEN '>30 days'
                ELSE '<30 days'
              END AS due_category
          FROM invoice i
          JOIN patient p ON p.patient_id = i.patient_id
          WHERE i.is_deleted != 1
            AND i.creation_date >= '2025-04-01'
            AND i.totaldue > 0
        `;

        const params = [];
        if (hasStatusFilter) {
          sql += ` AND i.status = ?`;
          params.push(status);
        }

        sql += ` ORDER BY i.creation_date ASC`;

        tempCon.query(sql, params, (error, result) => {
          tempCon.release();
          if (error) return reject(error);
          resolve(result);
        });
      });
    });

    // Insurer and TPA share one id space and one cutover, so both resolve in a
    // single pass against one pair of maps.
    await addCompanyNames(rows, connection, "creation_date", [
      "insurancecompany",
      "tpa",
    ]);

    // Same grouped envelope V1 returns, so the screen only changes its URL.
    const grouped = {};
    for (const row of rows) {
      const key = row.due_category;
      if (!grouped[key]) grouped[key] = { patients: [], totalDue: 0 };
      grouped[key].patients.push({
        ...row,
        // V1 aliased the joined column as `companyname`. Kept so anything
        // reading that key keeps working.
        companyname: row.insurancecompany_name,
      });
      grouped[key].totalDue += Number(row.totaldue) || 0;
    }
    return grouped;
  } catch (error) {
    console.error("Error in getStatuswiseIPDDueListV2:", error);
    throw error;
  }
};

module.exports = {
  getIPDCollection,
  getIPDCollectionV2,
  getIPDCollectionV3,
  getStatuswiseIPDDueListV2,
  getTotalIPDCollection,
  getIPDBills,
  getIPDDueList,
  getIPDBillsV2,
  getIPDBillsV3,
  getIPDBillsV4,
  getIPDBillsV5,
  getStatuswiseIPDDueList,
  getIPDTotalSummary,
  getIHXData,
};
