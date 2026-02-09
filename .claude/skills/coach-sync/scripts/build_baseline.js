#!/usr/bin/env bun

/*
Build data/coach/baseline_raw.json deterministically from Strava activities + snapshot + athlete profile.
The model then interprets this raw output into data/coach/baseline.json with coaching context.

This repo previously relied on a template baseline that never got updated, which produced:
  weekly_hours_range: [0, 0]
even when Strava data existed. This script makes baseline computation explicit and repeatable.
*/

const fs = require("fs");
const path = require("path");
const {
  parseDate,
  toIsoDate,
  weekStart,
  daterangeWeeks,
  median,
  iqr,
  dumpJson,
} = require("../../_shared/lib");
const { PATHS } = require("../../_shared/paths");

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    snapshot: PATHS.coach.snapshot,
    activities: PATHS.external.stravaActivities,
    profile: PATHS.coach.profile,
    out: PATHS.coach.baselineRaw,
    windowDays: 56,
    asOfDate: null,
    includeZeroWeeks: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--snapshot") options.snapshot = String(argv[i + 1] || options.snapshot);
    if (arg === "--activities") options.activities = String(argv[i + 1] || options.activities);
    if (arg === "--profile") options.profile = String(argv[i + 1] || options.profile);
    if (arg === "--out") options.out = String(argv[i + 1] || options.out);
    if (arg === "--window-days") options.windowDays = Number(argv[i + 1] || options.windowDays);
    if (arg === "--as-of-date") options.asOfDate = String(argv[i + 1] || "").trim() || null;
    if (arg === "--exclude-zero-weeks") options.includeZeroWeeks = false;
  }

  if (!Number.isFinite(options.windowDays) || options.windowDays <= 0) {
    throw new Error(`Invalid --window-days '${options.windowDays}'`);
  }
  return options;
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function normalizeSport(value) {
  if (!value) return null;
  const lowered = String(value).toLowerCase().replace(/\s+/g, "");
  if (lowered.includes("run")) return "run";
  if (lowered.includes("ride") || lowered.includes("bike") || lowered.includes("cycl")) return "bike";
  if (lowered.includes("swim")) return "swim";
  if (
    [
      "workout",
      "weighttraining",
      "strengthtraining",
      "crossfit",
      "functionaltraining",
      "gym",
      "bodyweight",
      "hiit",
      "yoga",
      "pilates",
      "mobility",
      "core",
    ].some((key) => lowered.includes(key))
  )
    return "strength";
  return null;
}

function activityDate(activity) {
  for (const key of ["start_date_local", "start_date", "date"]) {
    if (key in (activity || {})) {
      const dt = parseDate(activity[key]);
      if (dt) return dt;
    }
  }
  return null;
}

function activityDurationSec(activity) {
  for (const key of ["moving_time_sec", "elapsed_time_sec", "duration_sec", "moving_time", "elapsed_time"]) {
    if (key in (activity || {}) && activity[key] != null) return Number(activity[key]) || 0;
  }
  return 0;
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildRiskFlags(profile) {
  const health = profile && typeof profile.health === "object" ? profile.health : {};
  const current = Array.isArray(health.current_niggles) ? health.current_niggles : [];
  const history = Array.isArray(health.injury_history_12mo) ? health.injury_history_12mo : [];

  function areaHints(area) {
    const a = String(area || "").toLowerCase();
    if (a.includes("shin")) {
      return {
        constraint: "Conservative run progression; avoid sudden increases in run volume and intensity.",
        mitigation: "Favor soft/flat surfaces, consider run/walk early, calf/foot strength, stop if pain escalates.",
      };
    }
    if (a.includes("knee")) {
      return {
        constraint: "Avoid rapid run volume increases and high-impact intensity spikes; monitor cumulative load.",
        mitigation: "Prioritize bike/swim volume, include knee/hip strength work, deload when symptoms flare.",
      };
    }
    if (a.includes("hip")) {
      return {
        constraint: "Avoid rapid total-load jumps; monitor intensity and volume accumulation.",
        mitigation: "Hip stability/strength focus, ensure adequate recovery, deload if symptoms return.",
      };
    }
    return {
      constraint: "Progress training load conservatively; avoid sudden changes that trigger recurrence.",
      mitigation: "Use gradual build + deload weeks; substitute lower-impact work when symptomatic.",
    };
  }

  const flags = [];
  for (const item of current) {
    const area = item?.area || "unknown";
    const condition = item?.condition || "issue";
    const hints = areaHints(area);
    flags.push({
      id: `niggle_${slugify(area)}_${slugify(condition)}`.slice(0, 64),
      area,
      severity: item?.severity || "moderate",
      constraint: hints.constraint,
      mitigation: hints.mitigation,
      notes: item?.notes || "",
      source: "profile.health.current_niggles",
    });
  }
  for (const item of history) {
    const area = item?.area || "unknown";
    const condition = item?.condition || "issue";
    const hints = areaHints(area);
    flags.push({
      id: `history_${slugify(area)}_${slugify(condition)}`.slice(0, 64),
      area,
      severity: item?.severity || "moderate",
      constraint: hints.constraint,
      mitigation: hints.mitigation,
      trigger: item?.trigger || "",
      notes: item?.notes || "",
      source: "profile.health.injury_history_12mo",
    });
  }

  // De-dupe by id.
  const seen = new Set();
  const out = [];
  for (const flag of flags) {
    if (!flag?.id) continue;
    if (seen.has(flag.id)) continue;
    seen.add(flag.id);
    out.push(flag);
  }
  return out;
}

function confidenceFromRecent({ sessions, weeksWithSessions, gapDays, avgHoursPerWeek }) {
  const s = Number(sessions || 0);
  const w = Number(weeksWithSessions || 0);
  const g = gapDays == null ? null : Number(gapDays);
  const h = Number(avgHoursPerWeek || 0);

  // Evidence-based confidence: "do we have enough recent signal to plan from?"
  if (s >= 12 && w >= 6 && g != null && g <= 14) return "high";
  if (s >= 6 && w >= 4 && g != null && g <= 28) return "medium";
  if (h >= 1 && w >= 3) return "medium";
  return "low";
}

function computeWeeklyTotals(activities, asOfDate, windowDays) {
  const end = parseDate(asOfDate);
  if (!end) throw new Error("Invalid as-of date.");

  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - (windowDays - 1));

  const weeks = daterangeWeeks(start, end).map((d) => toIsoDate(d));
  const weekMap = new Map();
  for (const weekIso of weeks) {
    weekMap.set(weekIso, {
      totalHours: 0,
      byDisciplineHours: { run: 0, bike: 0, swim: 0, strength: 0 },
      byDisciplineSessions: { run: 0, bike: 0, swim: 0, strength: 0 },
    });
  }

  for (const activity of activities) {
    const dt = activityDate(activity);
    if (!dt) continue;
    if (dt < start || dt > end) continue;

    const discipline = normalizeSport(activity?.sport_type || activity?.type);
    if (!discipline) continue;

    const wk = toIsoDate(weekStart(dt));
    if (!weekMap.has(wk)) continue;

    const durationHours = activityDurationSec(activity) / 3600;
    const entry = weekMap.get(wk);
    entry.totalHours += durationHours;
    if (entry.byDisciplineHours[discipline] != null) {
      entry.byDisciplineHours[discipline] += durationHours;
      entry.byDisciplineSessions[discipline] += 1;
    }
  }

  return {
    startIso: toIsoDate(start),
    endIso: toIsoDate(end),
    weeks,
    weekMap,
  };
}

function gapDaysFromActivities(activities, asOfDate, discipline) {
  const end = parseDate(asOfDate);
  if (!end) return null;
  const dates = activities
    .filter((a) => normalizeSport(a?.sport_type || a?.type) === discipline)
    .map((a) => activityDate(a))
    .filter(Boolean)
    .sort((a, b) => b - a);
  if (!dates.length) return null;
  const diffMs = end.getTime() - dates[0].getTime();
  return Math.floor(diffMs / (24 * 3600 * 1000));
}

function roundHours(value) {
  const num = Number(value || 0);
  // Keep 2 decimals, but avoid -0.
  const rounded = Math.round(num * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function main() {
  const options = parseArgs();
  const snapshot = safeReadJson(options.snapshot, null);
  const activities = safeReadJson(options.activities, []);
  const profile = safeReadJson(options.profile, {});

  const asOf =
    options.asOfDate ||
    (snapshot && snapshot.as_of_date ? String(snapshot.as_of_date) : null) ||
    new Date().toISOString().slice(0, 10);

  const totals = computeWeeklyTotals(Array.isArray(activities) ? activities : [], asOf, options.windowDays);
  const weeklyTotals = totals.weeks.map((wk) => totals.weekMap.get(wk)?.totalHours || 0);
  const weeklyTotalsIncluded = options.includeZeroWeeks ? weeklyTotals : weeklyTotals.filter((h) => h > 0);
  const [q1, q3] = iqr(weeklyTotalsIncluded);
  const p50 = median(weeklyTotalsIncluded);

  const snapshotByDiscipline =
    snapshot && snapshot.activities_summary && snapshot.activities_summary.by_discipline
      ? snapshot.activities_summary.by_discipline
      : {};

  function snapshotWindow(discipline) {
    const d = snapshotByDiscipline && snapshotByDiscipline[discipline] ? snapshotByDiscipline[discipline] : null;
    const w = d && d.windows ? d.windows[String(options.windowDays)] : null;
    return w || null;
  }

  function disciplineStats(discipline) {
    const w = snapshotWindow(discipline);
    const sessions =
      w && Number.isFinite(Number(w.sessions)) ? Number(w.sessions) : weeklyTotalsIncluded.reduce((acc, _, i) => {
        const wk = totals.weeks[i];
        return acc + (totals.weekMap.get(wk)?.byDisciplineSessions?.[discipline] || 0);
      }, 0);
    const weeksWithSessions =
      w && Number.isFinite(Number(w.weeks_with_sessions))
        ? Number(w.weeks_with_sessions)
        : totals.weeks.filter((wk) => (totals.weekMap.get(wk)?.byDisciplineSessions?.[discipline] || 0) > 0).length;
    const avgHoursPerWeek =
      w && Number.isFinite(Number(w.avg_hours_per_week))
        ? Number(w.avg_hours_per_week)
        : (totals.weeks.reduce((sum, wk) => sum + (totals.weekMap.get(wk)?.byDisciplineHours?.[discipline] || 0), 0) /
            Math.max(1, totals.weeks.length));
    const gapDays = snapshotByDiscipline?.[discipline]?.gap_days ?? gapDaysFromActivities(activities, asOf, discipline);
    return { sessions, weeksWithSessions, avgHoursPerWeek, gapDays };
  }

  const runStats = disciplineStats("run");
  const bikeStats = disciplineStats("bike");
  const swimStats = disciplineStats("swim");

  // --- Discipline baselines (per-discipline breakdown) ---
  function buildDisciplineBaseline(discipline) {
    const snap28 = snapshotByDiscipline?.[discipline]?.windows?.["28"] || null;
    const recentWeeks = totals.weeks.slice(-4);
    const recentHours = recentWeeks.map((wk) => totals.weekMap.get(wk)?.byDisciplineHours?.[discipline] || 0);
    const recentSessions = recentWeeks.map((wk) => totals.weekMap.get(wk)?.byDisciplineSessions?.[discipline] || 0);

    const weeklyHoursAvg =
      snap28 && Number.isFinite(Number(snap28.avg_hours_per_week))
        ? Number(snap28.avg_hours_per_week)
        : recentHours.reduce((a, b) => a + b, 0) / Math.max(1, recentWeeks.length);
    const weeklySessionsAvg =
      snap28 && Number.isFinite(Number(snap28.avg_sessions_per_week))
        ? Number(snap28.avg_sessions_per_week)
        : recentSessions.reduce((a, b) => a + b, 0) / Math.max(1, recentWeeks.length);

    const totalSessions = snap28?.sessions || recentSessions.reduce((a, b) => a + b, 0);
    const totalTimeSec = snap28?.moving_time_sec || recentHours.reduce((a, b) => a + b, 0) * 3600;
    const typicalSessionMin = totalSessions > 0 ? Math.round(totalTimeSec / totalSessions / 60) : 0;
    const longestSessionMin = snap28?.longest_duration_sec ? Math.round(snap28.longest_duration_sec / 60) : 0;

    // Trend: compare recent half of window vs prior half
    const midpoint = Math.floor(totals.weeks.length / 2);
    const priorWeeks = totals.weeks.slice(0, midpoint);
    const latterWeeks = totals.weeks.slice(midpoint);
    const priorAvg =
      priorWeeks.length > 0
        ? priorWeeks.reduce((sum, wk) => sum + (totals.weekMap.get(wk)?.byDisciplineHours?.[discipline] || 0), 0) /
          priorWeeks.length
        : 0;
    const latterAvg =
      latterWeeks.length > 0
        ? latterWeeks.reduce((sum, wk) => sum + (totals.weekMap.get(wk)?.byDisciplineHours?.[discipline] || 0), 0) /
          latterWeeks.length
        : 0;

    let trend = "maintaining";
    if (priorAvg > 0 && latterAvg > priorAvg * 1.15) trend = "building";
    else if (priorAvg > 0 && latterAvg < priorAvg * 0.85) trend = "declining";

    return {
      weekly_hours_avg: roundHours(weeklyHoursAvg),
      weekly_sessions_avg: Math.round(weeklySessionsAvg * 10) / 10,
      typical_session_min: typicalSessionMin,
      longest_session_min: longestSessionMin,
      trend,
    };
  }

  const disciplineBaselines = {
    run: buildDisciplineBaseline("run"),
    bike: buildDisciplineBaseline("bike"),
    swim: buildDisciplineBaseline("swim"),
    strength: buildDisciplineBaseline("strength"),
  };

  // --- Recent weekly totals (most recent first) ---
  const recentWeeklyTotals = [...totals.weeks].reverse().map((wk) => {
    const entry = totals.weekMap.get(wk);
    const row = { week: wk, total_hours: roundHours(entry?.totalHours || 0) };
    for (const d of ["run", "bike", "swim", "strength"]) {
      const h = roundHours(entry?.byDisciplineHours?.[d] || 0);
      if (h > 0) row[d] = h;
    }
    return row;
  });

  // --- Derived time budget (from last 4 completed weeks, excluding current incomplete week) ---
  const currentWeek = toIsoDate(weekStart(parseDate(asOf)));
  const completedWeeks = totals.weeks.filter((wk) => wk !== currentWeek);
  const recent4 = completedWeeks.slice(-4);
  const recent4Totals = recent4.map((wk) => totals.weekMap.get(wk)?.totalHours || 0).filter((h) => h > 0);
  let derivedTimeBudget = null;
  if (recent4Totals.length >= 2) {
    const avg = recent4Totals.reduce((a, b) => a + b, 0) / recent4Totals.length;
    const sorted = [...recent4Totals].sort((a, b) => a - b);
    const lo = sorted[0];
    const hi = sorted[sorted.length - 1];
    derivedTimeBudget = {
      min: Math.round(lo),
      typical: Math.round(avg),
      max: Math.round(hi * 1.15),
      source: "baseline_auto",
      notes: `Derived from recent ${recent4Totals.length}-week actuals (avg ${roundHours(avg)}h). Min=lowest week, typical=mean, max=highest week+15%.`,
    };
  }

  const baseline = {
    as_of_date: asOf,
    confidence_by_discipline: {
      run: confidenceFromRecent(runStats),
      bike: confidenceFromRecent(bikeStats),
      swim: confidenceFromRecent(swimStats),
    },
    current_load_tolerance: {
      weekly_hours_range: [roundHours(q1), roundHours(q3)],
      notes: `Derived from Strava moving-time. Window=${options.windowDays}d (${totals.startIso}..${totals.endIso}), weeks=${totals.weeks.length}, p25=${roundHours(
        q1
      )}h p50=${roundHours(p50)}h p75=${roundHours(q3)}h.`,
    },
    risk_flags: buildRiskFlags(profile),
    discipline_baselines: disciplineBaselines,
    recent_weekly_totals: recentWeeklyTotals,
    derived_time_budget: derivedTimeBudget,
    evidence: [
      {
        source: "strava_snapshot",
        path: options.snapshot,
        as_of_date: asOf,
      },
      {
        source: "strava_activities",
        path: options.activities,
        window_days: options.windowDays,
        weeks: totals.weeks,
      },
    ],
  };

  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  dumpJson(options.out, baseline);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        out: options.out,
        as_of_date: asOf,
        weekly_hours: {
          p25: roundHours(q1),
          p50: roundHours(p50),
          p75: roundHours(q3),
          weeks: totals.weeks.length,
        },
        confidence_by_discipline: baseline.confidence_by_discipline,
        discipline_baselines: baseline.discipline_baselines,
        derived_time_budget: baseline.derived_time_budget,
        risk_flag_count: Array.isArray(baseline.risk_flags) ? baseline.risk_flags.length : 0,
      },
      null,
      2
    )}\n`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}

