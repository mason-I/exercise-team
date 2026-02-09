#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");
const { parseDate, toIsoDate, weekStart, dumpJson } = require("../../_shared/lib");
const { PATHS } = require("../../_shared/paths");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    input: PATHS.external.stravaActivities,
    athlete: PATHS.system.stravaAthlete,
    stats: PATHS.system.stravaStats,
    zones: PATHS.system.stravaZones,
    out: PATHS.coach.snapshot,
    asOfDate: null,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--input") options.input = args[i + 1];
    if (arg === "--athlete") options.athlete = args[i + 1];
    if (arg === "--stats") options.stats = args[i + 1];
    if (arg === "--zones") options.zones = args[i + 1];
    if (arg === "--out") options.out = args[i + 1];
    if (arg === "--as-of-date") options.asOfDate = args[i + 1];
  }
  return options;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function summarizeStats(stats) {
  if (!stats) return null;
  return {
    recent_window_days: 28,
    recent: {
      run: stats.recent_run_totals || null,
      ride: stats.recent_ride_totals || null,
      swim: stats.recent_swim_totals || null,
    },
    ytd: {
      run: stats.ytd_run_totals || null,
      ride: stats.ytd_ride_totals || null,
      swim: stats.ytd_swim_totals || null,
    },
    all_time: {
      run: stats.all_run_totals || null,
      ride: stats.all_ride_totals || null,
      swim: stats.all_swim_totals || null,
    },
    biggest_ride_distance: stats.biggest_ride_distance ?? null,
    biggest_climb_elevation_gain: stats.biggest_climb_elevation_gain ?? null,
  };
}

function zonesByType(zones) {
  if (!Array.isArray(zones)) return null;
  return zones.reduce((acc, zone) => {
    if (zone?.type) acc[zone.type] = zone;
    return acc;
  }, {});
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
    if (key in activity) {
      const dt = parseDate(activity[key]);
      if (dt) return dt;
    }
  }
  return null;
}

function activityDurationSec(activity) {
  for (const key of ["moving_time_sec", "elapsed_time_sec", "duration_sec", "moving_time", "elapsed_time"]) {
    if (key in activity && activity[key] != null) return Number(activity[key]);
  }
  return 0;
}

function activityDistanceM(activity) {
  if ("distance_m" in activity && activity.distance_m != null) return Number(activity.distance_m);
  if ("distance" in activity && activity.distance != null) return Number(activity.distance);
  return 0;
}

function coverageStats(activities, discipline) {
  const relevant = activities.filter((act) => normalizeSport(act.sport_type || act.type) === discipline);
  const total = relevant.length || 0;
  const power = relevant.filter((act) => Number.isFinite(act.average_watts) || Number.isFinite(act.weighted_average_watts)).length;
  const hr = relevant.filter((act) => Number.isFinite(act.average_heartrate)).length;
  const pace = relevant.filter((act) => activityDurationSec(act) > 0 && activityDistanceM(act) > 0).length;
  return {
    total_activities: total,
    power_fraction: total ? Number((power / total).toFixed(3)) : 0,
    hr_fraction: total ? Number((hr / total).toFixed(3)) : 0,
    pace_fraction: total ? Number((pace / total).toFixed(3)) : 0,
  };
}

function windowSummary(activities, endDate, windowDays, discipline) {
  const end = new Date(endDate.getTime());
  const start = new Date(endDate.getTime());
  start.setUTCDate(start.getUTCDate() - (windowDays - 1));

  const windowActs = activities.filter((act) => {
    const dt = activityDate(act);
    if (!dt) return false;
    if (dt < start || dt > end) return false;
    return normalizeSport(act.sport_type || act.type) === discipline;
  });

  const sessions = windowActs.length;
  const distance = windowActs.reduce((sum, act) => sum + activityDistanceM(act), 0);
  const moving = windowActs.reduce((sum, act) => sum + activityDurationSec(act), 0);
  const longestDistance = windowActs.reduce((max, act) => Math.max(max, activityDistanceM(act)), 0);
  const longestDuration = windowActs.reduce((max, act) => Math.max(max, activityDurationSec(act)), 0);

  const weekSet = new Set();
  for (const act of windowActs) {
    const dt = activityDate(act);
    if (!dt) continue;
    weekSet.add(weekStart(dt).toISOString());
  }
  const weeksWithSessions = weekSet.size;
  const weeks = windowDays / 7;

  return {
    window_days: windowDays,
    sessions,
    distance_m: Number(distance.toFixed(1)),
    moving_time_sec: Number(moving.toFixed(1)),
    longest_distance_m: Number(longestDistance.toFixed(1)),
    longest_duration_sec: Number(longestDuration.toFixed(1)),
    weeks_with_sessions: weeksWithSessions,
    avg_sessions_per_week: Number((sessions / weeks).toFixed(2)),
    avg_distance_km_per_week: Number((distance / 1000 / weeks).toFixed(2)),
    avg_hours_per_week: Number((moving / 3600 / weeks).toFixed(2)),
  };
}

function gapDays(activities, discipline, endDate) {
  const filtered = activities
    .filter((act) => normalizeSport(act.sport_type || act.type) === discipline)
    .map((act) => activityDate(act))
    .filter(Boolean)
    .sort((a, b) => b - a);
  if (!filtered.length) return null;
  const latest = filtered[0];
  const diffMs = endDate.getTime() - latest.getTime();
  return Math.floor(diffMs / (24 * 3600 * 1000));
}

function latestActivityDate(activities) {
  const dates = activities.map(activityDate).filter(Boolean).sort((a, b) => b - a);
  return dates.length ? toIsoDate(dates[0]) : null;
}

function main() {
  const options = parseArgs();
  const activities = safeReadJson(options.input) || [];
  const athlete = safeReadJson(options.athlete);
  const stats = safeReadJson(options.stats);
  const zones = safeReadJson(options.zones);
  const asOf = options.asOfDate ? parseDate(options.asOfDate) : parseDate(new Date());

  if (!asOf) {
    throw new Error("Invalid --as-of-date (YYYY-MM-DD).");
  }

  const windows = [28, 56, 112, 365];
  const disciplines = ["run", "bike", "swim", "strength"];
  const byDiscipline = {};
  for (const discipline of disciplines) {
    const summaries = {};
    for (const windowDays of windows) {
      summaries[String(windowDays)] = windowSummary(activities, asOf, windowDays, discipline);
    }
    byDiscipline[discipline] = {
      windows: summaries,
      coverage: coverageStats(activities, discipline),
      gap_days: gapDays(activities, discipline, asOf),
    };
  }

  const snapshot = {
    generated_at: new Date().toISOString(),
    as_of_date: toIsoDate(asOf),
    source_files: {
      activities: options.input,
      athlete: options.athlete,
      stats: options.stats,
      zones: options.zones,
    },
    athlete: athlete || null,
    stats: stats || null,
    stats_summary: summarizeStats(stats),
    zones: zones || null,
    zones_by_type: zonesByType(zones),
    activities_summary: {
      windows_days: windows,
      total_activities: activities.length,
      latest_activity_date: latestActivityDate(activities),
      by_discipline: byDiscipline,
    },
    data_quality: {
      missing_athlete: !athlete,
      missing_stats: !stats,
      missing_zones: !zones,
    },
  };

  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  dumpJson(options.out, snapshot);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}
