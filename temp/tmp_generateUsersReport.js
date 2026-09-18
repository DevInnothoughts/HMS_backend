/**
 * tmp_generateUsersReport.js  —  TEMPORARY / THROWAWAY SCRIPT
 * ---------------------------------------------------------------------------
 * Every login in the Firestore `users` collection, as an Excel workbook.
 *
 *      Summary      counts by role, sub-role, and access state
 *      Users        one row per login, sorted by name
 *
 * ── ⚠️ THIS NEEDS firebase-admin, NOT @react-native-firebase ────────────────
 * The app reads Firestore with @react-native-firebase, which only runs inside
 * React Native. A Node script cannot use it. This uses the Admin SDK:
 *
 *      npm i firebase-admin xlsx-js-style
 *
 * and a service-account key with read access to the project. Point
 * SERVICE_ACCOUNT below at the JSON file, or export
 * GOOGLE_APPLICATION_CREDENTIALS and leave it null.
 *
 * Get the key from: Firebase console → Project settings → Service accounts →
 * Generate new private key. It grants full project access — keep it out of git.
 *
 * ── FIELD MEANINGS (from AddUserForm / DeptUsers / UserList) ────────────────
 * The two boolean columns are relabelled as asked, because the raw names are
 * routinely misread as each other:
 *
 *   isActive  → "Logged-in"           the DEVICE LOCK. true means the account
 *                                     is signed in on the device in deviceId.
 *                                     A new account is false, which is what
 *                                     lets the first login claim a device.
 *   isAllowed → "Access Permission"    the LOGIN GATE. false (or missing)
 *                                     blocks sign-in entirely.
 *
 * true → Yes, false → No, as requested.
 *
 * ── ⚠️ A MISSING isAllowed IS NOT false ────────────────────────────────────
 * It is undefined, and the login check reads that as "not allowed" — so the
 * account exists and silently refuses to let anyone in. Those cells render
 * "No" (the behaviour is genuinely No) but are shown amber and counted on the
 * Summary tab, because a missing flag is a bug and a real false is a decision.
 *
 * ── ⚠️ `location` IS SOMETIMES AN ARRAY ─────────────────────────────────────
 * AddUserForm writes an ARRAY for role 'Admin' and a plain STRING for everyone
 * else. Both shapes are flattened here; a stray object would otherwise print
 * as [object Object].
 *
 * ── Place this file in temp/ ────────────────────────────────────────────────
 * (alongside the other tmp_* runners) — the output dir matches theirs.
 *
 * ── Call it from app.js ─────────────────────────────────────────────────────
 *   const { generateUsersExcel } = require("./temp/tmp_generateUsersReport");
 *
 *   generateUsersExcel()
 *     .then(r => console.log("Users workbook:", r.filePath))
 *     .catch(e => console.error("Users export failed:", e.message));
 *
 * ── Or run it standalone ────────────────────────────────────────────────────
 *   node temp/tmp_generateUsersReport.js
 *
 * ── Output ──────────────────────────────────────────────────────────────────
 *   src/report/Users_<YYYY-MM-DD>.xlsx
 *
 * ⚠️  Contains names, mobile numbers, emails and device ids for every staff
 *     login in the company. Share only over approved channels; delete the
 *     script, the key and the workbook when done.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx-js-style");
const admin = require("firebase-admin");

/* ── Config ──────────────────────────────────────────────────────────────── */

// Absolute or relative path to the service-account JSON. Leave null to fall
// back to GOOGLE_APPLICATION_CREDENTIALS.
const SERVICE_ACCOUNT =
  "C:\\Users\\tisha\\OneDrive\\Desktop\\HMS-Pro\\HMS_backend\\hhc-hms-firebase-adminsdk-1rpj7-fdd7d9b78e.json"; // e.g. path.join(__dirname, "serviceAccountKey.json")

const COLLECTION = "users";

const reportsDir = path.join(__dirname, "..", "src", "report");

/* ── Palette (matches the other tmp_* reports) ───────────────────────────── */

const INK = "0F1A16";
const BRAND = "184D67"; // admin blue — this is a user/access report
const BAND_HEAD = "2A4438";
const GREEN = "1E7A5A";
const GREEN_SOFT = "E7F2EC";
const AMBER = "B26A00";
const AMBER_SOFT = "FBF0DD";
const RED = "B3382B";
const RED_SOFT = "F8E6E3";
const GREY = "9AA5B1";
const ZEBRA = "F7F9F8";

const THIN = { style: "thin", color: { rgb: "D9E0DC" } };
const BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };

const mk = (v, s) => ({ v, s });

const ST_TITLE = {
  font: { bold: true, sz: 15, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: INK } },
  alignment: { horizontal: "left", vertical: "center" },
};
const ST_SUBTITLE = {
  font: { sz: 10, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: BAND_HEAD } },
  alignment: { horizontal: "left", vertical: "center" },
};
const ST_HEAD = {
  font: { bold: true, sz: 10, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: BRAND } },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
  border: BORDER,
};
const ST_GROUP = {
  font: { bold: true, sz: 10, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: BAND_HEAD } },
  alignment: { horizontal: "center", vertical: "center" },
  border: BORDER,
};
const ST_LABEL = {
  font: { sz: 10, color: { rgb: "16211D" } },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER,
};
const ST_LABEL_ALT = { ...ST_LABEL, fill: { fgColor: { rgb: ZEBRA } } };
const ST_TOTAL = {
  font: { bold: true, sz: 10, color: { rgb: "16211D" } },
  fill: { fgColor: { rgb: "EDF2EF" } },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER,
};
const ST_TOTAL_NUM = {
  ...ST_TOTAL,
  alignment: { horizontal: "center", vertical: "center" },
};
const ST_NOTE = {
  font: { italic: true, sz: 9, color: { rgb: "6C7C75" } },
  alignment: { horizontal: "left", vertical: "center", wrapText: true },
};
const ST_DASH = {
  font: { sz: 10, color: { rgb: GREY } },
  alignment: { horizontal: "center", vertical: "center" },
  border: BORDER,
};

const centred = (extra = {}) => ({
  font: { sz: 10 },
  alignment: { horizontal: "center", vertical: "center" },
  border: BORDER,
  ...extra,
});

const yesNoStyle = (value, missing) => {
  // Missing is amber, not green/red: "No" there is a consequence of the field
  // being absent, not somebody's decision. See the header.
  if (missing) {
    return {
      font: { bold: true, sz: 10, color: { rgb: AMBER } },
      fill: { fgColor: { rgb: AMBER_SOFT } },
      alignment: { horizontal: "center", vertical: "center" },
      border: BORDER,
    };
  }
  const [fg, bg] = value ? [GREEN, GREEN_SOFT] : [RED, RED_SOFT];
  return {
    font: { bold: !value, sz: 10, color: { rgb: fg } },
    fill: { fgColor: { rgb: bg } },
    alignment: { horizontal: "center", vertical: "center" },
    border: BORDER,
  };
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const pad2 = (n) => String(n).padStart(2, "0");
const toYmd = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const clean = (v) => (v === null || v === undefined ? "" : String(v).trim());

// true → "Yes", false → "No". A missing field is behaviourally No (the login
// check treats undefined as not-allowed), so it reads No and is flagged
// separately by `isMissing` rather than being given a third label.
const yesNo = (v) => (v === true ? "Yes" : "No");
const isMissing = (v) => v === undefined || v === null;

/**
 * `location` is an array for role 'Admin' and a string for everyone else; a
 * ticketing user carries their department there instead of a clinic. Flatten
 * whatever shape turned up so nothing prints as [object Object].
 */
const flattenLocation = (loc) => {
  if (loc === null || loc === undefined) return "";
  if (Array.isArray(loc)) {
    return loc
      .map((l) => clean(typeof l === "object" ? l?.name || l?.label : l))
      .filter(Boolean)
      .join(", ");
  }
  if (typeof loc === "object") return clean(loc.name || loc.label);
  return clean(loc);
};

// UserList.js shows 'Owner' as 'Partner'; the workbook should match the screen
// people already read, not the raw stored value.
const SUB_ROLE_LABEL = { Owner: "Partner" };
const subRoleLabel = (s) => {
  const v = clean(s);
  if (!v) return "—";
  return SUB_ROLE_LABEL[v] || v;
};

const bump = (obj, key) => {
  const k = key || "(not set)";
  obj[k] = (obj[k] || 0) + 1;
};

/* ── Firestore read ──────────────────────────────────────────────────────── */

function initFirebase() {
  if (admin.apps.length) return admin.app();

  if (SERVICE_ACCOUNT) {
    if (!fs.existsSync(SERVICE_ACCOUNT)) {
      throw new Error(`Service account key not found at ${SERVICE_ACCOUNT}`);
    }
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const key = require(SERVICE_ACCOUNT);
    return admin.initializeApp({ credential: admin.credential.cert(key) });
  }

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      "No credentials. Set SERVICE_ACCOUNT in this file, or export " +
        "GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json",
    );
  }
  return admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

async function readUsers() {
  initFirebase();
  const snap = await admin.firestore().collection(COLLECTION).get();

  const users = snap.docs.map((doc) => {
    const d = doc.data() || {};
    return {
      docId: doc.id,
      // The doc id IS the mobile (AddUserForm writes doc(db,'users',mobile)),
      // so the id is the fallback when the field was never written.
      mobile: clean(d.mobile) || doc.id,
      mobileMismatch: !!clean(d.mobile) && clean(d.mobile) !== doc.id,
      name: clean(d.name),
      email: clean(d.email),
      role: clean(d.role),
      subRole: clean(d.subRole),
      department: clean(d.department),
      location: flattenLocation(d.location),
      locationArray: flattenLocation(d.locationArray),
      isActive: d.isActive,
      isAllowed: d.isAllowed,
      deviceId: clean(d.deviceId),
    };
  });

  // Same sort UserList.js uses: by name, blanks last.
  users.sort((a, b) => {
    if (!a.name) return 1;
    if (!b.name) return -1;
    return a.name.localeCompare(b.name);
  });

  return users;
}

/* ── Sheets ──────────────────────────────────────────────────────────────── */

function usersSheet(users, generatedOn) {
  const head = [
    "#",
    "Name",
    "Mobile",
    "Email",
    "Role",
    "Sub-Role",
    "Logged-in",
    "Access Permission",
    "Location(s)",
    "Department",
    "Device ID",
  ];

  const rows = [
    [mk("All User Logins", ST_TITLE)],
    [mk(`Firestore "${COLLECTION}" · ${generatedOn}`, ST_SUBTITLE)],
    [],
    head.map((h) => mk(h, ST_HEAD)),
  ];

  users.forEach((u, i) => {
    const alt = i % 2 === 1;
    const base = alt ? ST_LABEL_ALT : ST_LABEL;
    const ctr = centred(alt ? { fill: { fgColor: { rgb: ZEBRA } } } : {});

    rows.push([
      mk(i + 1, ctr),
      mk(u.name || "—", base),
      // Mobile as text — a leading zero must not be eaten, and a 10-digit
      // number must not come out as 9.19876E+09.
      { v: u.mobile || "", t: "s", s: base },
      mk(u.email || "—", base),
      mk(u.role || "—", ctr),
      mk(subRoleLabel(u.subRole), ctr),
      mk(
        yesNo(u.isActive),
        yesNoStyle(u.isActive === true, isMissing(u.isActive)),
      ),
      mk(
        yesNo(u.isAllowed),
        yesNoStyle(u.isAllowed === true, isMissing(u.isAllowed)),
      ),
      mk(u.location || u.locationArray || "—", base),
      mk(u.department || "—", base),
      u.deviceId ? { v: u.deviceId, t: "s", s: base } : mk("—", ST_DASH),
    ]);
  });

  if (!users.length) {
    rows.push([mk("The users collection is empty.", ST_LABEL)]);
  }

  const ws = xlsx.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 5 },
    { wch: 26 },
    { wch: 14 },
    { wch: 28 },
    { wch: 12 },
    { wch: 18 },
    { wch: 11 },
    { wch: 18 },
    { wch: 34 },
    { wch: 18 },
    { wch: 26 },
  ];
  ws["!rows"] = [{ hpt: 26 }, { hpt: 18 }];
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: head.length - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: head.length - 1 } },
  ];
  ws["!freeze"] = { xSplit: 2, ySplit: 4 };
  ws["!autofilter"] = {
    ref: xlsx.utils.encode_range({
      s: { r: 3, c: 0 },
      e: { r: Math.max(rows.length - 1, 4), c: head.length - 1 },
    }),
  };
  return ws;
}

function summarySheet(users, generatedOn) {
  const byRole = {};
  const bySubRole = {};
  let loggedIn = 0;
  let allowed = 0;
  let missingActive = 0;
  let missingAllowed = 0;
  let mismatches = 0;
  let noName = 0;

  users.forEach((u) => {
    bump(byRole, u.role);
    bump(bySubRole, subRoleLabel(u.subRole));
    if (u.isActive === true) loggedIn++;
    if (u.isAllowed === true) allowed++;
    if (isMissing(u.isActive)) missingActive++;
    if (isMissing(u.isAllowed)) missingAllowed++;
    if (u.mobileMismatch) mismatches++;
    if (!u.name) noName++;
  });

  const rows = [
    [mk("User Logins — Summary", ST_TITLE)],
    [mk(`Firestore "${COLLECTION}" · ${generatedOn}`, ST_SUBTITLE)],
    [],
    [mk("Total logins", ST_TOTAL), mk(users.length, ST_TOTAL_NUM)],
    [
      mk("Logged-in (isActive = Yes)", ST_LABEL),
      mk(loggedIn, centred()),
      mk(`${users.length - loggedIn} not signed in`, ST_NOTE),
    ],
    [
      mk("Access Permission = Yes (isAllowed)", ST_LABEL),
      mk(allowed, centred()),
      mk(`${users.length - allowed} cannot sign in`, ST_NOTE),
    ],
    [],
    [mk("By role", ST_GROUP), mk("Count", ST_GROUP)],
  ];

  Object.entries(byRole)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v], i) => {
      const alt = i % 2 === 1;
      rows.push([
        mk(k, alt ? ST_LABEL_ALT : ST_LABEL),
        mk(v, centred(alt ? { fill: { fgColor: { rgb: ZEBRA } } } : {})),
      ]);
    });

  rows.push([]);
  rows.push([mk("By sub-role", ST_GROUP), mk("Count", ST_GROUP)]);
  Object.entries(bySubRole)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v], i) => {
      const alt = i % 2 === 1;
      rows.push([
        mk(k, alt ? ST_LABEL_ALT : ST_LABEL),
        mk(v, centred(alt ? { fill: { fgColor: { rgb: ZEBRA } } } : {})),
      ]);
    });

  // Data-quality block. These are cheap to compute here and expensive to spot
  // by eye in a few hundred rows.
  rows.push([]);
  rows.push([mk("Needs attention", ST_GROUP), mk("Count", ST_GROUP)]);
  const flags = [
    [
      "isAllowed missing (reads as No — account silently blocked)",
      missingAllowed,
    ],
    ["isActive missing", missingActive],
    ["mobile field does not match the document id", mismatches],
    ["no name set", noName],
  ];
  flags.forEach(([label, n], i) => {
    const alt = i % 2 === 1;
    rows.push([
      mk(label, alt ? ST_LABEL_ALT : ST_LABEL),
      mk(
        n,
        n > 0
          ? {
              font: { bold: true, sz: 10, color: { rgb: n ? AMBER : GREEN } },
              fill: { fgColor: { rgb: AMBER_SOFT } },
              alignment: { horizontal: "center", vertical: "center" },
              border: BORDER,
            }
          : centred(),
      ),
    ]);
  });

  rows.push([]);
  rows.push([
    mk(
      '"Logged-in" is the isActive flag — the device lock. It is true only while ' +
        "the account is signed in on the device recorded in Device ID, and a new " +
        'account is correctly No. "Access Permission" is the isAllowed flag — the ' +
        "login gate; No blocks sign-in entirely. A missing isAllowed is shown No " +
        "and highlighted amber, because undefined is read as not-allowed by the " +
        "login check rather than defaulting to allowed.",
      ST_NOTE,
    ),
  ]);

  const ws = xlsx.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 52 }, { wch: 12 }, { wch: 30 }];
  ws["!rows"] = [{ hpt: 26 }, { hpt: 18 }];
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 2 } },
  ];
  return ws;
}

/* ── Main ────────────────────────────────────────────────────────────────── */

async function generateUsersExcel() {
  const today = toYmd(new Date());

  const users = await readUsers();

  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, summarySheet(users, today), "Summary");
  xlsx.utils.book_append_sheet(wb, usersSheet(users, today), "Users");

  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const fileName = `Users_${today}.xlsx`;
  const filePath = path.join(reportsDir, fileName);
  xlsx.writeFile(wb, filePath);

  return {
    filePath,
    fileName,
    totalUsers: users.length,
    loggedIn: users.filter((u) => u.isActive === true).length,
    allowed: users.filter((u) => u.isAllowed === true).length,
    missingAllowed: users.filter((u) => isMissing(u.isAllowed)).length,
  };
}

module.exports = { generateUsersExcel };

/* ── Standalone runner ───────────────────────────────────────────────────── */

if (require.main === module) {
  (async () => {
    const t0 = Date.now();
    console.log("──────────────────────────────────────────────────────────");
    console.log("All User Logins → Excel (temporary runner)");
    console.log("──────────────────────────────────────────────────────────");

    try {
      const r = await generateUsersExcel();
      console.log(`\n✅ Workbook written: ${r.filePath}`);
      console.log(`   ${r.totalUsers} logins`);
      console.log(`   ${r.loggedIn} logged in, ${r.allowed} with access`);
      if (r.missingAllowed) {
        console.log(
          `   ⚠ ${r.missingAllowed} with no isAllowed field — they cannot sign in`,
        );
      }
      console.log(`   ${Math.round((Date.now() - t0) / 1000)}s`);
      process.exit(0);
    } catch (err) {
      console.error(`\n❌ ${err.message}`);
      process.exit(2);
    }
  })();
}
