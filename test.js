const mysql = require("mysql");

const connection = mysql.createConnection({
  host: "192.46.212.254",
  user: "inno",
  password: "Inno@2024",
  database: "JLR",
});

connection.connect((err) => {
  if (err) {
    console.error("error connecting: " + err.stack);
    return;
  }
  console.log("connected as id " + connection.threadId);
  connection.end();
});
