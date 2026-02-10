#!/usr/bin/env bun

/*
Build data/coach/outcomes.json deterministically from Strava activities + plan files.

Computes:
  1. Session-by-session outcome matching (planned vs. actual)
  2. Fidelity metrics (duration, intensity match)
  3. Rolling adherence summary (4-week window)
  4. Adaptation signal detection (pace/HR trends)
  5. Recovery pattern analysis
*/

const fs = require("fs");
const path = require("path");
const { parseDate, toIsoDate, weekStart, dumpJson } = require("../../_shared/lib");
const { PATHS } = require("../../_shared/paths");

const ADHERENCE_WINDOW_WEEKS = 4;
const ADAPTATION_WINDOW_DAYS = 42; // 6 weeks
const DURATION_MATCH_THRESHOLD = 0.2; // 20% tolerance

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    activities: PATHS.external.stravaActivities,
    plansDir: PATHS.coach.plansDir,
    out: PATHS.coach.outcomes,
    asOfDate: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--activities") options.activities = String(argv[i + 1] || options.activities);
    if (arg === "--plans-dir") options.plansDir = String(argv[i + 1] || options.plansDir);
    if (arg === "--out") options.out = String(argv[i + 1] || options.out);
    if (arg === "--as-of-date") options.asOfDate = String(argv[i + 1] || "").trim() || null;
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
    ["workout", "weighttraining", "strengthtraining", "crossfit", "functionaltraining",
     "gym", "bodyweight", "hiit", "yoga", "pilates", "mobility", "core"]
      .some((key) => lowered.includes(key))
  ) return "strength";
  return null;
}

function activityDateIso(activity) {
  for (const key of ["start_date_local", "start_date", "date"]) {
    if (key in (activity || {})) {
      const dt = parseDate(activity[key]);
      if (dt) return toIsoDate(dt);
    }
  }
  return null;
}

function activityDurationMin(activity) {
  for (const key of ["moving_time_sec", "elapsed_time_sec", "duration_sec", "moving_time", "elapsed_time"]) {
    if (key in (activity || {}) && activity[key] != null) return Math.round((Number(activity[key]) || 0) / 60);
  }
  return 0;
}

function activityDistanceM(activity) {
  if (activity?.distance_m != null) return Number(activity.distance_m) || 0;
  if (activity?.distance != null) return Number(activity.distance) || 0;
  return 0;
}

// ========== Plan Loading ==========

function listPlanFiles(plansDir) {
  try {
    return fs
      .readdirSync(plansDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .sort()
      .map((name) => path.join(plansDir, name));
  } catch {
    return [];
  }
}

function loadRecentPlans(plansDir, asOfDate, windowWeeks) {
  const files = listPlanFiles(plansDir);
  const end = parseDate(asOfDate);
  if (!end) return [];

  const windowStart = new Date(end.getTime() - windowWeeks * 7 * 24 * 3600 * 1000);
  const plans = [];

  for (const filePath of files) {
    const plan = safeReadJson(filePath, null);
    if (!plan || !Array.isArray(plan.sessions)) continue;
    const ws = parseDate(plan.week_start);
    if (!ws || ws < windowStart || ws > end) continue;
    plans.push(plan);
  }

  return plans;
}

// ========== Outcome Matching ==========

function matchSessionToActivity(session, activities) {
  const sessionDate = String(session.date || "");
  const sessionDiscipline = String(session.discipline || "").toLowerCase();
  const sessionDuration = Number(session.duration_min || 0);

  if (!sessionDate || sessionDiscipline === "rest" || sessionDuration <= 0) return null;

  // Find activities on the same date with same discipline
  const candidates = activities.filter((a) => {
    const actDate = activityDateIso(a);
    const actDiscipline = normalizeSport(a.sport_type || a.type);
    return actDate === sessionDate && actDiscipline === sessionDiscipline;
  });

  if (!candidates.length) return null;

  // Pick the closest match by duration
  let best = null;
  let bestDiff = Infinity;
  for (const candidate of candidates) {
    const actDuration = activityDurationMin(candidate);
    const diff = Math.abs(actDuration - sessionDuration);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }

  return best;
}

function classifyFidelity(session, activity) {
  const plannedMin = Number(session.duration_min || 0);
  const actualMin = activityDurationMin(activity);

  const durationPct = plannedMin > 0 ? Math.round((actualMin / plannedMin) * 100) : 0;

  // Intensity matching (simplified: compare pace/HR if available)
  let intensityMatch = "unknown";
  const avgHr = Number(activity.average_heartrate);
  const loadClass = String(session.load_class || "").toLowerCase();

  if (Number.isFinite(avgHr) && avgHr > 0) {
    // Rough heuristic: easy sessions should be < 145bpm, hard > 155bpm
    if (loadClass === "easy" || loadClass === "recovery") {
      intensityMatch = avgHr < 145 ? "as_prescribed" : "harder_than_prescribed";
    } else if (loadClass === "hard" || loadClass === "very_hard") {
      intensityMatch = avgHr > 150 ? "as_prescribed" : "easier_than_prescribed";
    } else {
      intensityMatch = "as_prescribed";
    }
  }

  // Overall classification
  let overall = "completed_as_prescribed";
  if (durationPct < 80) overall = "completed_modified";
  else if (durationPct > 120) overall = "completed_modified";
  else if (intensityMatch === "harder_than_prescribed" || intensityMatch === "easier_than_prescribed") {
    overall = "completed_modified";
  }

  return { duration_pct: durationPct, intensity_match: intensityMatch, overall };
}

function buildSessionOutcomes(plans, activities) {
  const outcomes = [];
  const usedActivityIds = new Set();

  for (const plan of plans) {
    const weekStart = String(plan.week_start || "");

    for (const session of plan.sessions || []) {
      const discipline = String(session.discipline || "").toLowerCase();
      if (discipline === "rest" || Number(session.duration_min || 0) <= 0) continue;

      const match = matchSessionToActivity(session, activities);

      if (match && !usedActivityIds.has(String(match.id))) {
        usedActivityIds.add(String(match.id));
        const fidelity = classifyFidelity(session, match);

        outcomes.push({
          plan_week: weekStart,
          session_id: session.id || "",
          discipline,
          prescribed: {
            type: session.type || "",
            duration_min: Number(session.duration_min || 0),
            canonical_type: session.canonical_type || "",
            load_class: session.load_class || "",
          },
          actual: {
            activity_id: String(match.id || ""),
            duration_min: activityDurationMin(match),
            avg_hr: Number(match.average_heartrate) || null,
            avg_pace_sec_per_km: activityDistanceM(match) > 0
              ? Math.round(((activityDurationMin(match) * 60) / activityDistanceM(match)) * 1000)
              : null,
          },
          fidelity,
          date: session.date || "",
        });
      } else {
        // Missed session
        outcomes.push({
          plan_week: weekStart,
          session_id: session.id || "",
          discipline,
          prescribed: {
            type: session.type || "",
            duration_min: Number(session.duration_min || 0),
            canonical_type: session.canonical_type || "",
            load_class: session.load_class || "",
          },
          actual: null,
          fidelity: { duration_pct: 0, intensity_match: "missed", overall: "missed" },
          date: session.date || "",
        });
      }
    }
  }

  return outcomes;
}

// ========== Adherence Summary ==========

function buildAdherenceSummary(outcomes) {
  const total = outcomes.length;
  if (total === 0) {
    return {
      last_4_weeks: {
        completion_rate: 0,
        by_discipline: {},
        most_skipped_day: null,
        most_skipped_type: null,
        most_modified_type: null,
      },
    };
  }

  const completed = outcomes.filter((o) => o.fidelity.overall !== "missed").length;
  const completionRate = Math.round((completed / total) * 100) / 100;

  // By discipline
  const byDiscipline = {};
  const disciplineGroups = {};
  for (const o of outcomes) {
    if (!disciplineGroups[o.discipline]) disciplineGroups[o.discipline] = { total: 0, completed: 0 };
    disciplineGroups[o.discipline].total += 1;
    if (o.fidelity.overall !== "missed") disciplineGroups[o.discipline].completed += 1;
  }
  for (const [d, g] of Object.entries(disciplineGroups)) {
    byDiscipline[d] = g.total > 0 ? Math.round((g.completed / g.total) * 100) / 100 : 0;
  }

  // Most skipped day
  const missedByDay = {};
  for (const o of outcomes) {
    if (o.fidelity.overall !== "missed" || !o.date) continue;
    const dt = parseDate(o.date);
    if (!dt) continue;
    const dayName = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][dt.getUTCDay()];
    missedByDay[dayName] = (missedByDay[dayName] || 0) + 1;
  }
  const mostSkippedDay = Object.entries(missedByDay).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // Most skipped type
  const missedByType = {};
  for (const o of outcomes) {
    if (o.fidelity.overall !== "missed") continue;
    const key = `${o.discipline}_${o.prescribed.canonical_type || o.prescribed.type}`;
    missedByType[key] = (missedByType[key] || 0) + 1;
  }
  const mostSkippedType = Object.entries(missedByType).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // Most modified type
  const modifiedByType = {};
  for (const o of outcomes) {
    if (o.fidelity.overall !== "completed_modified") continue;
    const key = `${o.discipline}_${o.prescribed.canonical_type || o.prescribed.type}`;
    modifiedByType[key] = (modifiedByType[key] || 0) + 1;
  }
  const mostModifiedType = Object.entries(modifiedByType).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    last_4_weeks: {
      completion_rate: completionRate,
      by_discipline: byDiscipline,
      most_skipped_day: mostSkippedDay,
      most_skipped_type: mostSkippedType,
      most_modified_type: mostModifiedType,
    },
  };
}

// ========== Adaptation Signals ==========

function detectAdaptationSignals(activities, asOfDate) {
  const signals = [];
  const end = parseDate(asOfDate);
  if (!end) return signals;

  const windowStart = new Date(end.getTime() - ADAPTATION_WINDOW_DAYS * 24 * 3600 * 1000);
  const midpoint = new Date(end.getTime() - (ADAPTATION_WINDOW_DAYS / 2) * 24 * 3600 * 1000);

  // Run: pace trend for efforts 15-60 min
  const runEarly = [];
  const runRecent = [];
  for (const a of activities) {
    if (normalizeSport(a.sport_type || a.type) !== "run") continue;
    const dt = parseDate(activityDateIso(a));
    if (!dt || dt < windowStart || dt > end) continue;
    const dur = (Number(a.moving_time_sec || a.elapsed_time_sec || 0));
    const dist = activityDistanceM(a);
    if (dur < 900 || dur > 3600 || dist <= 0) continue;
    const paceSecPerKm = (dur / dist) * 1000;
    if (dt < midpoint) runEarly.push(paceSecPerKm);
    else runRecent.push(paceSecPerKm);
  }

  if (runEarly.length >= 2 && runRecent.length >= 2) {
    const earlyMedian = runEarly.sort((a, b) => a - b)[Math.floor(runEarly.length / 2)];
    const recentMedian = runRecent.sort((a, b) => a - b)[Math.floor(runRecent.length / 2)];
    const changePct = ((earlyMedian - recentMedian) / earlyMedian) * 100;

    if (Math.abs(changePct) > 1.5) {
      signals.push({
        discipline: "run",
        metric: "pace_trend",
        window_weeks: Math.round(ADAPTATION_WINDOW_DAYS / 7),
        trend: changePct > 0 ? "improving" : "declining",
        magnitude_pct: Math.round(Math.abs(changePct) * 10) / 10,
        detail: `Run pace ${changePct > 0 ? "improved" : "slowed"} ~${Math.round(Math.abs(changePct))}% over ${Math.round(ADAPTATION_WINDOW_DAYS / 7)} weeks`,
        implication: changePct > 3 ? "Consider updating run threshold pace" : "Monitor trend",
      });
    }
  }

  // Bike: power/HR efficiency trend
  const bikeEarly = [];
  const bikeRecent = [];
  for (const a of activities) {
    if (normalizeSport(a.sport_type || a.type) !== "bike") continue;
    const dt = parseDate(activityDateIso(a));
    if (!dt || dt < windowStart || dt > end) continue;
    const hr = Number(a.average_heartrate);
    const watts = Number(a.average_watts || a.weighted_average_watts);
    if (!Number.isFinite(hr) || hr <= 0 || !Number.isFinite(watts) || watts <= 0) continue;
    const efficiency = watts / hr; // higher = more efficient
    if (dt < midpoint) bikeEarly.push(efficiency);
    else bikeRecent.push(efficiency);
  }

  if (bikeEarly.length >= 2 && bikeRecent.length >= 2) {
    const earlyMedian = bikeEarly.sort((a, b) => a - b)[Math.floor(bikeEarly.length / 2)];
    const recentMedian = bikeRecent.sort((a, b) => a - b)[Math.floor(bikeRecent.length / 2)];
    const changePct = ((recentMedian - earlyMedian) / earlyMedian) * 100;

    if (Math.abs(changePct) > 2) {
      signals.push({
        discipline: "bike",
        metric: "power_hr_efficiency",
        window_weeks: Math.round(ADAPTATION_WINDOW_DAYS / 7),
        trend: changePct > 0 ? "improving" : "declining",
        magnitude_pct: Math.round(Math.abs(changePct) * 10) / 10,
        detail: `Bike power:HR efficiency ${changePct > 0 ? "improved" : "declined"} ~${Math.round(Math.abs(changePct))}% over ${Math.round(ADAPTATION_WINDOW_DAYS / 7)} weeks`,
        implication: changePct > 3 ? "Consider FTP retest" : "Monitor trend",
      });
    }
  }

  return signals;
}

// ========== Recovery Patterns ==========

function detectRecoveryPatterns(activities, asOfDate) {
  const patterns = {};
  const end = parseDate(asOfDate);
  if (!end) return patterns;

  const windowStart = new Date(end.getTime() - 56 * 24 * 3600 * 1000);

  for (const discipline of ["run", "bike", "swim"]) {
    const sessionDates = activities
      .filter((a) => {
        const sport = normalizeSport(a.sport_type || a.type);
        if (sport !== discipline) return false;
        const dt = parseDate(activityDateIso(a));
        return dt && dt >= windowStart && dt <= end;
      })
      .map((a) => activityDateIso(a))
      .filter(Boolean)
      .sort();

    if (sessionDates.length < 4) continue;

    // Compute gaps between consecutive sessions
    const gaps = [];
    for (let i = 1; i < sessionDates.length; i++) {
      const prev = parseDate(sessionDates[i - 1]);
      const curr = parseDate(sessionDates[i]);
      if (prev && curr) {
        const diffDays = Math.round((curr.getTime() - prev.getTime()) / (24 * 3600 * 1000));
        if (diffDays > 0 && diffDays <= 7) gaps.push(diffDays);
      }
    }

    if (gaps.length >= 2) {
      gaps.sort((a, b) => a - b);
      const typicalDays = gaps[Math.floor(gaps.length / 2)]; // median
      patterns[`${discipline}_session_gap`] = {
        typical_days: typicalDays,
        sample_size: gaps.length,
      };
    }
  }

  return patterns;
}

// ========== Main ==========

function main() {
  const options = parseArgs();
  const activities = safeReadJson(options.activities, []);
  const actList = Array.isArray(activities) ? activities : [];

  const asOf = options.asOfDate || new Date().toISOString().slice(0, 10);

  // Load recent plans
  const plans = loadRecentPlans(options.plansDir, asOf, ADHERENCE_WINDOW_WEEKS);

  if (!plans.length) {
    // No plans yet -- write minimal outcomes file
    const minimal = {
      as_of_date: asOf,
      session_outcomes: [],
      adherence_summary: { last_4_weeks: { completion_rate: 0, by_discipline: {}, most_skipped_day: null, most_skipped_type: null, most_modified_type: null } },
      adaptation_signals: detectAdaptationSignals(actList, asOf),
      recovery_patterns: detectRecoveryPatterns(actList, asOf),
    };
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    dumpJson(options.out, minimal);
    process.stdout.write(`${JSON.stringify({ ok: true, out: options.out, plans_found: 0, outcomes: 0 }, null, 2)}\n`);
    return;
  }

  // Build session outcomes
  const sessionOutcomes = buildSessionOutcomes(plans, actList);
  const adherenceSummary = buildAdherenceSummary(sessionOutcomes);
  const adaptationSignals = detectAdaptationSignals(actList, asOf);
  const recoveryPatterns = detectRecoveryPatterns(actList, asOf);

  const outcomes = {
    as_of_date: asOf,
    session_outcomes: sessionOutcomes.slice(-60), // Keep last ~60 sessions
    adherence_summary: adherenceSummary,
    adaptation_signals: adaptationSignals,
    recovery_patterns: recoveryPatterns,
  };

  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  dumpJson(options.out, outcomes);

  const completed = sessionOutcomes.filter((o) => o.fidelity.overall !== "missed").length;
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      out: options.out,
      plans_found: plans.length,
      outcomes: sessionOutcomes.length,
      completed,
      missed: sessionOutcomes.length - completed,
      completion_rate: adherenceSummary.last_4_weeks.completion_rate,
      adaptation_signals: adaptationSignals.length,
    }, null, 2)}\n`
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
