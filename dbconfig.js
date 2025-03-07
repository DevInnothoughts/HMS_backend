// dbConfig.js

const mysql = require("mysql");
//Live DB Credentials
const HOST = "172.105.47.198";
const USER = "shubham";
const PASSWORD = "hhc@4775";

// const HOST = "localhost";
// const USER = "shubham";
// const PASSWORD = "hhc@4775";

// const HOST = "localhost";
// const USER = "root";
// const PASSWORD = "";

const createPool = (database) => {
  return mysql.createPool({
    connectionLimit: 5,
    host: HOST,
    user: USER,
    password: PASSWORD,
    database: database,
    idleTimeoutMillis: 5000, // 5 seconds
  });
};

module.exports = {
  createPool,
};
