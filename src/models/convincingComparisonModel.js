// convincingComparisonModel.js
// ─────────────────────────────────────────────────────────────────────────────
// Period-over-period comparison for the Convincing Score screen.
//
//   GET /hms/ConvincingScore/comparison
//       ?location=<branch>&from=YYYY-MM-DD&to=YYYY-MM-DD
//       &mode=mom|qoq|yoy&periods=2
//
// This is ADDITIVE — it does not modify convincingScoreModel.js. It re-runs
// getConvincingScoreV3 once per period with a synthetic `req` and diffs the
// results, so the comparison figures are guaranteed to reconcile with the
// numbers already on the screen.
//
// Previous-period rule:
//   • Whole calendar months (from = 1st AND to = last day of its month):
//     shift both ends back 1 / 3 / 12 calendar months. Exact calendar periods.
//   • Any other (custom) range: shift `from` back by the same number of
//     calendar months (clamping the day for short months) and keep the SAME
//     day count, so counts remain comparable.
//
// `periods` (2..6) returns a trend series, oldest → newest, current last.
// Periods are fetched SEQUENTIALLY: each getConvincingScoreV3 call already
// fans out ~5 parallel queries on one connection, so 6 in parallel would mean
// 30 concurrent queries on a single pooled connection.
// ─────────────────────────────────────────────────────────────────────────────

const { getConvincingScoreV3 } = require("./convincingScoreModel");

const DAY_MS = 86400000;

// months to step back for each mode
const MODE_MONTHS = { mom: 1, qoq: 3, yoy: 12 };
const MODE_LABEL = {
  mom: "Month on Month",
  qoq: "Quarter on Quarter",
  yoy: "Year on Year",
};
const MODE_SHORT = { mom: "MoM", qoq: "QoQ", yoy: "YoY" };

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/* ── date helpers (all UTC, dates are plain YYYY-MM-DD) ─────────────────── */

const pad = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const parseYmd = (s) => {
  const [y, m, d] = String(s).split("-").map(Number);
  return { y, m, d };
};
const toUTC = (s) => new Date(`${s}T00:00:00Z`);
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m 1-based
const dayCount = (from, to) =>
  Math.round((toUTC(to) - toUTC(from)) / DAY_MS) + 1;

function addMonths(y, m, delta) {
  const idx = y * 12 + (m - 1) + delta;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

function isWholeMonths(from, to) {
  const f = parseYmd(from);
  const t = parseYmd(to);
  return f.d === 1 && t.d === lastDayOf(t.y, t.m);
}

/** Shift a range back by `steps` periods of `mode`. */
function shiftRange(from, to, mode, steps = 1) {
  const back = MODE_MONTHS[mode] * steps;
  const f = parseYmd(from);
  const t = parseYmd(to);

  if (isWholeMonths(from, to)) {
    const nf = addMonths(f.y, f.m, -back);
    const nt = addMonths(t.y, t.m, -back);
    return {
      from: ymd(nf.y, nf.m, 1),
      to: ymd(nt.y, nt.m, lastDayOf(nt.y, nt.m)),
      exact: true,
    };
  }

  // Custom range → same calendar anchor, same length.
  const nf = addMonths(f.y, f.m, -back);
  const day = Math.min(f.d, lastDayOf(nf.y, nf.m));
  const prevFrom = ymd(nf.y, nf.m, day);
  const span = dayCount(from, to);
  const end = new Date(toUTC(prevFrom).getTime() + (span - 1) * DAY_MS);
  return {
    from: prevFrom,
    to: ymd(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate()),
    exact: false,
  };
}

function labelForRange(from, to) {
  const f = parseYmd(from);
  const t = parseYmd(to);
  if (isWholeMonths(from, to)) {
    if (f.y === t.y && f.m === t.m) return `${MONTHS[f.m - 1]} ${f.y}`;
    return `${MONTHS[f.m - 1]} ${f.y} – ${MONTHS[t.m - 1]} ${t.y}`;
  }
  const d = (p) => `${pad(p.d)} ${MONTHS[p.m - 1]} ${p.y}`;
  return from === to ? d(f) : `${d(f)} – ${d(t)}`;
}

/* ── metric helpers ─────────────────────────────────────────────────────── */

const round1 = (n) => Math.round(n * 10) / 10;
const rate = (num, den) => (den > 0 ? round1((num / den) * 100) : null);

/** Absolute + % change for a count metric. */
function countDelta(cur, prev) {
  const diff = cur - prev;
  return {
    current: cur,
    previous: prev,
    diff,
    pct: prev > 0 ? round1((diff / prev) * 100) : null, // null = no base
    direction: diff > 0 ? "up" : diff < 0 ? "down" : "flat",
  };
}

/** Percentage-POINT change for a rate metric (never a % of a %). */
function rateDelta(cur, prev) {
  const c = cur == null ? null : cur;
  const p = prev == null ? null : prev;
  const pp = c == null || p == null ? null : round1(c - p);
  return {
    current: c,
    previous: p,
    pp,
    direction: pp == null ? "flat" : pp > 0 ? "up" : pp < 0 ? "down" : "flat",
  };
}

function docMetrics(rows) {
  return (rows || []).map((d) => {
    const advised = d.diagnosisCounts?.Surgery || 0;
    const performed = d.invoiceCount || 0;
    return {
      doctorId: d.doctorId,
      doctorName: d.doctorName,
      diagnosed: d.patientCount || 0,
      advised,
      performed,
      convincingScore: rate(performed, advised),
    };
  });
}

/** Compact label for bar charts — "May '26", "Apr–Jun '26", "FY 25-26". */
function shortLabelForRange(from, to) {
  const f = parseYmd(from);
  const t = parseYmd(to);
  const yy = (y) => String(y).slice(2);

  if (isWholeMonths(from, to)) {
    const span = t.y * 12 + t.m - (f.y * 12 + f.m) + 1;
    if (span === 1) return `${MONTHS[f.m - 1]} '${yy(f.y)}`;
    if (span === 12 && f.m === 4)
      return `FY ${yy(f.y)}-${pad((f.y + 1) % 100)}`;
    if (span === 12) return `${yy(f.y)}-${yy(t.y)}`;
    return `${MONTHS[f.m - 1]}–${MONTHS[t.m - 1]} '${yy(t.y)}`;
  }
  return `${pad(f.d)} ${MONTHS[f.m - 1]}`;
}

/** Flatten a getConvincingScoreV3 result into the comparison metric set. */
function metricsFrom(result) {
  const consultants = result.consultantDoctors || [];
  const assistants = result.assistantDoctors || [];
  const bt = result.branchTotal || {};

  // V3's branchTotal has no surgeries-performed figure; the screen derives it
  // from the consultant cards, so do the same here to stay consistent.
  const performed = consultants.reduce((s, d) => s + (d.invoiceCount || 0), 0);

  const newAppts = bt.newAppointmentCount || 0;
  const diagnosed = bt.totalDiagnosisCount || 0;
  const advised = bt.totalSurgery || 0;

  return {
    newAppts,
    diagnosed,
    advised,
    performed,
    convincingScore: rate(performed, advised),
    overallConversion: rate(performed, diagnosed),
    consultants: docMetrics(consultants),
    assistants: docMetrics(assistants),
  };
}

/**
 * Full per-doctor comparison between two periods, for ONE role.
 *
 * Includes every doctor present in either period. Doctors who appear in only
 * one period are kept and flagged (`status`) rather than dropped — a surgeon
 * who stopped operating is exactly the kind of thing this screen should show.
 *
 * Matching is by doctorId, falling back to a normalised name when the id is
 * missing, so a doctor isn't double-counted across periods.
 */

/** Stable identity for a doctor across periods. Used by both the comparison
 *  builder and the per-doctor series, so they can never drift apart. */
const doctorKey = (d) =>
  d.doctorId != null && d.doctorId !== ""
    ? `id:${d.doctorId}`
    : `name:${String(d.doctorName || "")
        .trim()
        .toLowerCase()}`;
function buildDoctorComparison(curDocs, prevDocs, { minAdvised = 3 } = {}) {
  const merged = new Map();

  const put = (d, side) => {
    const k = doctorKey(d);
    if (!merged.has(k)) {
      merged.set(k, {
        doctorId: d.doctorId ?? null,
        doctorName: d.doctorName,
        current: null,
        previous: null,
      });
    }
    const row = merged.get(k);
    // Prefer whichever period actually has a name on record.
    if (!row.doctorName && d.doctorName) row.doctorName = d.doctorName;
    row[side] = {
      diagnosed: d.diagnosed,
      advised: d.advised,
      performed: d.performed,
      convincingScore: d.convincingScore,
    };
  };

  prevDocs.forEach((d) => put(d, "previous"));
  curDocs.forEach((d) => put(d, "current"));

  const zero = {
    diagnosed: 0,
    advised: 0,
    performed: 0,
    convincingScore: null,
  };

  const rows = [...merged.values()].map((row) => {
    const c = row.current || zero;
    const p = row.previous || zero;

    const status = !row.current ? "dropped" : !row.previous ? "new" : "both";

    // A score move is only meaningful when BOTH periods have a real
    // denominator. Below that, report the counts and suppress the pp figure.
    const comparable =
      status === "both" && c.advised >= minAdvised && p.advised >= minAdvised;

    return {
      doctorId: row.doctorId,
      doctorName: row.doctorName || "Unnamed",
      status,
      comparable,
      current: {
        diagnosed: c.diagnosed,
        advised: c.advised,
        performed: c.performed,
        convincingScore: c.convincingScore,
      },
      previous: {
        diagnosed: p.diagnosed,
        advised: p.advised,
        performed: p.performed,
        convincingScore: p.convincingScore,
      },
      delta: {
        diagnosed: countDelta(c.diagnosed, p.diagnosed),
        advised: countDelta(c.advised, p.advised),
        performed: countDelta(c.performed, p.performed),
        convincingScore: rateDelta(c.convincingScore, p.convincingScore),
      },
    };
  });

  // Default order: biggest current contributors first, then by previous volume
  // so dropped doctors still land near the top if they used to matter.
  rows.sort(
    (a, b) =>
      b.current.advised - a.current.advised ||
      b.previous.advised - a.previous.advised ||
      String(a.doctorName).localeCompare(String(b.doctorName)),
  );

  return rows;
}

/**
 * Attach a per-period trend to every doctor row, oldest → newest, aligned to
 * the branch-level `series` (same labels, same order, same length).
 *
 * Periods where a doctor has no activity get a null score and zero counts
 * rather than being omitted, so bar N always corresponds to period N and the
 * doctor's bars line up with the summary bars above.
 */
function attachDoctorSeries(
  rows,
  series,
  roleKey /* 'consultants' | 'assistants' */,
) {
  const perPeriod = (series || []).map((sp) => {
    const map = new Map();
    const docs = (sp.metrics && sp.metrics[roleKey]) || [];
    docs.forEach((d) => map.set(doctorKey(d), d));
    return {
      label: sp.label,
      shortLabel: sp.shortLabel, // ← add
      from: sp.from,
      to: sp.to,
      map,
    };
  });

  rows.forEach((row) => {
    const k = doctorKey(row);
    row.series = perPeriod.map((p) => {
      const d = p.map.get(k);
      return {
        label: p.label,
        shortLabel: p.shortLabel, // ← add
        from: p.from,
        to: p.to,
        convincingScore: d ? d.convincingScore : null,
        advised: d ? d.advised : 0,
        performed: d ? d.performed : 0,
        diagnosed: d ? d.diagnosed : 0,
      };
    });
  });

  return rows;
}

/** Headline movers, derived from the full list so the two never disagree. */
function deriveMovers(rows, limit = 3) {
  const eligible = rows.filter(
    (r) => r.comparable && r.delta.convincingScore.pp != null,
  );
  const byPp = [...eligible].sort(
    (a, b) => b.delta.convincingScore.pp - a.delta.convincingScore.pp,
  );
  const slim = (r) => ({
    doctorId: r.doctorId,
    doctorName: r.doctorName,
    current: r.current.convincingScore,
    previous: r.previous.convincingScore,
    pp: r.delta.convincingScore.pp,
  });
  return {
    improved: byPp
      .filter((r) => r.delta.convincingScore.pp > 0)
      .slice(0, limit)
      .map(slim),
    declined: byPp
      .filter((r) => r.delta.convincingScore.pp < 0)
      .reverse()
      .slice(0, limit)
      .map(slim),
  };
}

/* ── main ───────────────────────────────────────────────────────────────── */

async function getConvincingComparison(req) {
  const location = req.query.location;
  const from = req.query.from;
  const to = req.query.to;
  const mode = String(req.query.mode || "mom").toLowerCase();

  if (!MODE_MONTHS[mode]) {
    const err = new Error("`mode` must be one of: mom, qoq, yoy");
    err.status = 400;
    throw err;
  }

  let periods = Number(req.query.periods) || 2;
  periods = Math.max(2, Math.min(6, periods)); // current + 1..5 prior

  // Build the range list, oldest → newest (current is last).
  const ranges = [
    {
      from,
      to,
      label: labelForRange(from, to),
      shortLabel: shortLabelForRange(from, to),
      offset: 0,
    },
  ];
  for (let step = 1; step < periods; step++) {
    const r = shiftRange(from, to, mode, step);
    ranges.unshift({
      from: r.from,
      to: r.to,
      label: labelForRange(r.from, r.to),
      shortLabel: shortLabelForRange(r.from, r.to),
      offset: -step,
      exactCalendarShift: r.exact,
    });
  }

  // Sequential on purpose — see file header.
  const series = [];
  for (const r of ranges) {
    const result = await getConvincingScoreV3({
      query: { location, from: r.from, to: r.to },
    });
    series.push({ ...r, metrics: metricsFrom(result) });
  }

  const cur = series[series.length - 1];
  const prev = series[series.length - 2];
  const c = cur.metrics;
  const p = prev.metrics;

  const surgeonRows = attachDoctorSeries(
    buildDoctorComparison(c.consultants, p.consultants),
    series,
    "consultants",
  );
  const assistantRows = attachDoctorSeries(
    buildDoctorComparison(c.assistants, p.assistants),
    series,
    "assistants",
  );

  return {
    mode,
    modeLabel: MODE_LABEL[mode],
    modeShort: MODE_SHORT[mode],
    periods: series.length,
    // true when both periods are exact calendar periods of equal calendar shape
    exactCalendarShift: prev.exactCalendarShift !== false,
    currentDays: dayCount(cur.from, cur.to),
    previousDays: dayCount(prev.from, prev.to),

    current: { from: cur.from, to: cur.to, label: cur.label },
    previous: { from: prev.from, to: prev.to, label: prev.label },

    delta: {
      convincingScore: rateDelta(c.convincingScore, p.convincingScore),
      overallConversion: rateDelta(c.overallConversion, p.overallConversion),
      newAppts: countDelta(c.newAppts, p.newAppts),
      diagnosed: countDelta(c.diagnosed, p.diagnosed),
      advised: countDelta(c.advised, p.advised),
      performed: countDelta(c.performed, p.performed),
    },

    // Compact trend, oldest → newest. Safe to render directly as bars.
    series: series.map((s) => ({
      label: s.label,
      shortLabel: s.shortLabel, // ← add
      from: s.from,
      to: s.to,
      convincingScore: s.metrics.convincingScore,
      advised: s.metrics.advised,
      performed: s.metrics.performed,
      newAppts: s.metrics.newAppts,
      diagnosed: s.metrics.diagnosed,
    })),

    // Full per-doctor comparison, one list per role.
    doctors: {
      surgeons: surgeonRows,
      assistants: assistantRows,
    },

    movers: {
      surgeons: deriveMovers(surgeonRows),
      assistants: deriveMovers(assistantRows),
    },
  };
}

module.exports = {
  getConvincingComparison,
  shiftRange,
  labelForRange,
  isWholeMonths,
  buildDoctorComparison, // ← exported for tests
  attachDoctorSeries,
};
