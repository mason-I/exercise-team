const { loadJson, parseDate, saveText, toIsoDate, weekStart } = require("../../_shared/lib");

function normalizeSport(value) {
  if (!value) return null;
  const lowered = value.toLowerCase();
  if (["run", "running"].includes(lowered)) return "run";
  if (["ride", "bike", "cycling"].includes(lowered)) return "bike";
  if (["swim", "swimming"].includes(lowered)) return "swim";
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

function activityAverageWatts(activity) {
  if ("weighted_average_watts" in activity && activity.weighted_average_watts != null) {
    return Number(activity.weighted_average_watts);
  }
  if ("average_watts" in activity && activity.average_watts != null) return Number(activity.average_watts);
  return null;
}

function activityAverageHeartRate(activity) {
  if ("average_heartrate" in activity && activity.average_heartrate != null) return Number(activity.average_heartrate);
  return null;
}

function activityGradeAdjustedSpeedMps(activity) {
  if ("average_grade_adjusted_speed" in activity && activity.average_grade_adjusted_speed != null) {
    return Number(activity.average_grade_adjusted_speed);
  }
  if ("average_speed_mps" in activity && activity.average_speed_mps != null) return Number(activity.average_speed_mps);
  if ("average_speed" in activity && activity.average_speed != null) return Number(activity.average_speed);
  const distM = activityDistanceM(activity);
  const durSec = activityDurationSec(activity);
  if (!distM || !durSec) return null;
  return distM / durSec;
}

function activityPaceSecPer100m(activity) {
  if ("pace_sec_per_100m" in activity && activity.pace_sec_per_100m != null) return Number(activity.pace_sec_per_100m);
  const distM = activityDistanceM(activity);
  const durSec = activityDurationSec(activity);
  if (!distM || !durSec) return null;
  return durSec / (distM / 100);
}

function activityIsAssistedRide(activity) {
  const type = (activity.sport_type || activity.type || "").toLowerCase();
  return type === "ebikeride" || type === "ebike";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function computeActivityLoad(activity, discipline, thresholds) {
  const durSec = activityDurationSec(activity);
  if (!durSec) return null;
  if (discipline === "bike" && activityIsAssistedRide(activity)) {
    return { load_points: 0, method: "excluded_assisted" };
  }
  const hours = durSec / 3600;
  const avgHr = activityAverageHeartRate(activity);
  const lthr = thresholds.hr_lthr_bpm;

  if (discipline === "bike") {
    const ftp = thresholds.ftp_w;
    const watts = activityAverageWatts(activity);
    if (watts && ftp) {
      const ifVal = clamp(watts / ftp, 0.3, 1.3);
      return { load_points: hours * Math.pow(ifVal, 2), method: "power" };
    }
    if (avgHr && lthr) {
      const ifVal = clamp(avgHr / lthr, 0.6, 1.2);
      return { load_points: hours * Math.pow(ifVal, 2), method: "hr" };
    }
    return { load_points: hours * Math.pow(0.65, 2), method: "assumed" };
  }

  if (discipline === "run") {
    const vthr = thresholds.vthr_run_mps;
    const speed = activityGradeAdjustedSpeedMps(activity);
    if (vthr && speed) {
      const ifVal = clamp(speed / vthr, 0.5, 1.3);
      return { load_points: hours * Math.pow(ifVal, 2), method: "pace" };
    }
    if (avgHr && lthr) {
      const ifVal = clamp(avgHr / lthr, 0.6, 1.2);
      return { load_points: hours * Math.pow(ifVal, 2), method: "hr" };
    }
    return { load_points: hours * Math.pow(0.7, 2), method: "assumed" };
  }

  if (discipline === "swim") {
    const css = thresholds.css_sec_per_100m;
    const pace = activityPaceSecPer100m(activity);
    if (css && pace) {
      const ifVal = clamp(css / pace, 0.5, 1.3);
      return { load_points: hours * Math.pow(ifVal, 2), method: "pace" };
    }
    return { load_points: hours * Math.pow(0.65, 2), method: "assumed" };
  }
  return null;
}

function summarizeActivities(activities, startDate, endDate) {
  const totals = { run: 0, bike: 0, swim: 0 };
  const minutes = { run: 0, bike: 0, swim: 0 };
  const sessions = { run: 0, bike: 0, swim: 0 };

  for (const act of activities) {
    const actDate = activityDate(act);
    if (!actDate || actDate < startDate || actDate > endDate) continue;
    const discipline = normalizeSport(act.sport_type || act.type);
    if (!discipline) continue;
    sessions[discipline] += 1;
    const durSec = activityDurationSec(act);
    if (discipline === "bike") totals[discipline] += durSec / 3600;
    else totals[discipline] += activityDistanceM(act) / 1000;
    minutes[discipline] += durSec / 60;
  }
  return { totals, sessions, minutes };
}

function statusFor(actual, planned) {
  if (planned <= 0) return "no-plan";
  const ratio = actual / planned;
  if (ratio >= 0.85) return "completed";
  if (ratio >= 0.5) return "partial";
  return "missed";
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (!args.length) throw new Error("Usage: node analyze_strava.js <week_start>");
  const options = {
    weekStart: args[0],
    activities: "data/strava_activities.json",
    baseline: "baseline.json",
    planDir: "plans",
    outputDir: "reports",
  };
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--activities") options.activities = args[i + 1];
    if (arg === "--baseline") options.baseline = args[i + 1];
    if (arg === "--plan-dir") options.planDir = args[i + 1];
    if (arg === "--output-dir") options.outputDir = args[i + 1];
  }
  return options;
}

function main() {
  const options = parseArgs();
  const weekStartDate = weekStart(parseDate(options.weekStart));
  const weekEnd = new Date(weekStartDate.getTime());
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);

  const planPath = `${options.planDir}/${toIsoDate(weekStartDate)}.json`;
  const plan = loadJson(planPath);
  const baseline = loadJson(options.baseline);
  const activities = loadJson(options.activities);

  const { totals, sessions, minutes } = summarizeActivities(activities, weekStartDate, weekEnd);

  const thresholds = {
    ftp_w: baseline?.athlete_meta?.ftp_w || null,
    hr_lthr_bpm: baseline?.athlete_meta?.hr_lthr_bpm || null,
    vthr_run_mps: baseline?.disciplines?.run?.threshold?.vthr_mps || null,
    css_sec_per_100m: baseline?.disciplines?.swim?.threshold?.css_sec_per_100m || null,
  };
  const actualLoad = { run: 0, bike: 0, swim: 0 };
  const loadQuality = { run: { assumed: 0, total: 0 }, bike: { assumed: 0, total: 0 }, swim: { assumed: 0, total: 0 } };

  for (const act of activities) {
    const actDate = activityDate(act);
    if (!actDate || actDate < weekStartDate || actDate > weekEnd) continue;
    const discipline = normalizeSport(act.sport_type || act.type);
    if (!discipline) continue;
    const load = computeActivityLoad(act, discipline, thresholds);
    if (!load) continue;
    actualLoad[discipline] += load.load_points;
    loadQuality[discipline].total += 1;
    if (load.method === "assumed") loadQuality[discipline].assumed += 1;
  }

  const results = {};
  for (const [discipline, target] of Object.entries(plan.targets)) {
    const plannedVolume =
      discipline !== "bike" && target.volume_min != null ? target.volume_min : discipline === "bike" ? target.volume_hours : target.volume_km;
    const actualVolume =
      discipline !== "bike" && target.volume_min != null ? minutes[discipline] : totals[discipline];
    results[discipline] = {
      planned: plannedVolume,
      actual: Number(actualVolume.toFixed(2)),
      sessions_planned: target.sessions || 0,
      sessions_actual: sessions[discipline],
      status: statusFor(actualVolume, plannedVolume),
      load_planned: target.load_points || 0,
      load_actual: Number(actualLoad[discipline].toFixed(2)),
    };
  }

  const reportLines = [
    `# Adherence Report for week starting ${toIsoDate(weekStartDate)}`,
    "",
    `Date range: ${toIsoDate(weekStartDate)} to ${toIsoDate(weekEnd)}`,
    "",
    "## Summary",
  ];
  for (const [discipline, data] of Object.entries(results)) {
    const useMinutes = discipline !== "bike" && plan.targets[discipline].volume_min != null;
    const unit = discipline === "bike" ? "hours" : useMinutes ? "min" : "km";
    reportLines.push(
      `- ${discipline[0].toUpperCase() + discipline.slice(1)}: ${data.status} ` +
        `(${data.actual} / ${data.planned} ${unit}, ${data.sessions_actual} / ${data.sessions_planned} sessions)`
    );
    if (data.load_planned || data.load_actual) {
      reportLines.push(
        `  - Load points: ${data.load_actual} / ${data.load_planned}`
      );
      const quality = loadQuality[discipline];
      if (quality.total && quality.assumed / quality.total > 0.5) {
        reportLines.push(`  - Load quality: low (assumed intensity for most sessions)`);
      }
    }
  }

  const outputPath = `${options.outputDir}/${toIsoDate(weekStartDate)}-week.md`;
  saveText(outputPath, reportLines.join("\n").trim() + "\n");
}

if (require.main === module) {
  main();
}
