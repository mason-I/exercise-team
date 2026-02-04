const fs = require("fs");
const path = require("path");
const { loadJson, parseDate, saveText, toIsoDate, weekStart } = require("../../_shared/lib");

function normalizeSport(value) {
  if (!value) return null;
  const lowered = String(value).toLowerCase().replace(/\s+/g, "");
  if (lowered.includes("run")) return "run";
  if (lowered.includes("ride") || lowered.includes("bike") || lowered.includes("cycl")) return "bike";
  if (lowered.includes("swim")) return "swim";
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

function activityDateTime(activity) {
  for (const key of ["start_date_local", "start_date", "date"]) {
    if (key in activity && activity[key]) {
      const dt = new Date(activity[key]);
      if (!Number.isNaN(dt.getTime())) return dt;
      const fallback = parseDate(activity[key]);
      if (fallback) return fallback;
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
  const type = String(activity.sport_type || activity.type || "").toLowerCase();
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
  if (ratio >= 1.2) return "over";
  if (ratio >= 0.85) return "completed";
  if (ratio >= 0.5) return "partial";
  return "missed";
}

function activityKey(activity) {
  if (activity.id != null) return `id:${activity.id}`;
  const start = activity.start_date_local || activity.start_date || activity.date || "unknown";
  const sport = activity.sport_type || activity.type || "unknown";
  const distance = activity.distance_m ?? activity.distance ?? 0;
  const moving = activity.moving_time_sec ?? activity.moving_time ?? 0;
  return `${start}|${sport}|${distance}|${moving}`;
}

function dayDiff(a, b) {
  return Math.round((a.getTime() - b.getTime()) / (24 * 3600 * 1000));
}

function plannedSessionMetric(session) {
  if (session.duration_min != null) {
    return { value: Number(session.duration_min), unit: "min", basis: "duration" };
  }
  if (session.distance_km != null) {
    return { value: Number(session.distance_km), unit: "km", basis: "distance" };
  }
  return { value: 0, unit: "unknown", basis: "unknown" };
}

function actualMetricForSession(activity, basis) {
  if (basis === "duration") return activityDurationSec(activity) / 60;
  if (basis === "distance") return activityDistanceM(activity) / 1000;
  return 0;
}

function scoreCandidate(activity, activityDay, session, matchedCount) {
  const sessionDay = parseDate(session.date);
  if (!sessionDay) return -1;
  const dd = Math.abs(dayDiff(activityDay, sessionDay));
  if (dd > 1) return -1;

  let score = dd === 0 ? 5 : 2;
  const planned = plannedSessionMetric(session);
  if (planned.basis === "duration") {
    const actual = activityDurationSec(activity) / 60;
    if (planned.value > 0 && actual > 0) {
      score += 3 * (Math.min(actual, planned.value) / Math.max(actual, planned.value));
    }
  } else if (planned.basis === "distance") {
    const actual = activityDistanceM(activity) / 1000;
    if (planned.value > 0 && actual > 0) {
      score += 3 * (Math.min(actual, planned.value) / Math.max(actual, planned.value));
    }
  }
  if (matchedCount > 0 && dd === 0) score += 0.5;
  return score;
}

function matchActivitiesToSessions(planSessions, activitiesToDate, asOfDate) {
  const sessionsToDate = planSessions
    .map((session, index) => ({ session, index, date: parseDate(session.date) }))
    .filter((entry) => entry.date && entry.date <= asOfDate)
    .sort((a, b) => a.date - b.date);

  const sortedActivities = [...activitiesToDate].sort((a, b) => {
    const aTime = activityDateTime(a)?.getTime() || 0;
    const bTime = activityDateTime(b)?.getTime() || 0;
    return aTime - bTime;
  });

  const sessionMatches = new Map();
  const activityMatch = new Map();
  const unplannedActivities = [];

  for (const act of sortedActivities) {
    const discipline = normalizeSport(act.sport_type || act.type);
    if (!discipline) {
      unplannedActivities.push(act);
      continue;
    }
    const actDay = activityDate(act);
    if (!actDay) {
      unplannedActivities.push(act);
      continue;
    }

    let best = null;
    let bestScore = -1;

    for (const entry of sessionsToDate) {
      if (entry.session.discipline !== discipline) continue;
      const existing = sessionMatches.get(entry.index) || [];
      const score = scoreCandidate(act, actDay, entry.session, existing.length);
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }

    if (!best || bestScore < 3) {
      unplannedActivities.push(act);
      continue;
    }

    if (!sessionMatches.has(best.index)) sessionMatches.set(best.index, []);
    sessionMatches.get(best.index).push(act);
    activityMatch.set(activityKey(act), best.index);
  }

  return { sessionsToDate, sessionMatches, activityMatch, unplannedActivities };
}

function disciplineUsesMinutes(plan, discipline) {
  return discipline !== "bike" && plan?.targets?.[discipline]?.volume_min != null;
}

function plannedDisciplineVolumeFromSession(session, target, useMinutes) {
  if (session.discipline === "bike") {
    return session.duration_min != null ? Number(session.duration_min) / 60 : 0;
  }
  if (useMinutes) {
    if (session.duration_min != null) return Number(session.duration_min);
    if (session.distance_km != null && target?.volume_km > 0 && target?.volume_min > 0) {
      return Number(session.distance_km) * (Number(target.volume_min) / Number(target.volume_km));
    }
    return 0;
  }
  if (session.distance_km != null) return Number(session.distance_km);
  if (session.duration_min != null && target?.volume_min > 0 && target?.volume_km > 0) {
    return Number(session.duration_min) * (Number(target.volume_km) / Number(target.volume_min));
  }
  return 0;
}

function actualDisciplineVolumeFromActivity(activity, discipline, useMinutes) {
  if (discipline === "bike") return activityDurationSec(activity) / 3600;
  return useMinutes ? activityDurationSec(activity) / 60 : activityDistanceM(activity) / 1000;
}

function sessionStatus(actual, planned, sessionDate, asOfDate) {
  if (planned <= 0) return "no-plan";
  if (actual <= 0 && sessionDate.getTime() === asOfDate.getTime()) return "pending";
  return statusFor(actual, planned);
}

function fmt(value, decimals = 2) {
  return Number(value.toFixed(decimals));
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
    outputPath: null,
    asOfDate: null,
    writeActivityReports: false,
    activityReportDir: "reports/activities",
    writeDailyReport: false,
    dailyDate: null,
    dailyOutputDir: "reports/daily",
  };
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--activities") options.activities = args[i + 1];
    if (arg === "--baseline") options.baseline = args[i + 1];
    if (arg === "--plan-dir") options.planDir = args[i + 1];
    if (arg === "--output-dir") options.outputDir = args[i + 1];
    if (arg === "--output-path") options.outputPath = args[i + 1];
    if (arg === "--as-of-date") options.asOfDate = args[i + 1];
    if (arg === "--write-activity-reports") options.writeActivityReports = true;
    if (arg === "--activity-report-dir") options.activityReportDir = args[i + 1];
    if (arg === "--write-daily-report") options.writeDailyReport = true;
    if (arg === "--daily-date") options.dailyDate = args[i + 1];
    if (arg === "--daily-output-dir") options.dailyOutputDir = args[i + 1];
  }
  return options;
}

function ensureDateInWeek(weekStartDate, weekEndDate, value) {
  if (!value) return weekEndDate;
  const parsed = parseDate(value);
  if (!parsed) throw new Error("Invalid --as-of-date. Use YYYY-MM-DD.");
  if (parsed < weekStartDate) return weekStartDate;
  if (parsed > weekEndDate) return weekEndDate;
  return parsed;
}

function reportPathFor(options, weekStartDate, asOfDate, weekEndDate) {
  if (options.outputPath) return options.outputPath;
  if (asOfDate < weekEndDate) {
    return path.join(options.outputDir, "wtd", `${toIsoDate(weekStartDate)}-asof-${toIsoDate(asOfDate)}.md`);
  }
  return path.join(options.outputDir, `${toIsoDate(weekStartDate)}-week.md`);
}

function writeActivityDebriefs(options, activitiesToDate, activityMatch, sessionsToDate, sessionMatches, plan, disciplineMetrics) {
  fs.mkdirSync(options.activityReportDir, { recursive: true });
  for (const act of activitiesToDate) {
    if (act.id == null) continue;
    const key = activityKey(act);
    const sessionIndex = activityMatch.get(key);
    const discipline = normalizeSport(act.sport_type || act.type) || "unknown";
    const useMinutes = disciplineMetrics[discipline]?.useMinutes || false;
    const unit = discipline === "bike" ? "hours" : useMinutes ? "min" : "km";
    const volume = actualDisciplineVolumeFromActivity(act, discipline, useMinutes);
    const weekTarget = disciplineMetrics[discipline]?.fullWeekPlanned || 0;
    const contribution = weekTarget > 0 ? (volume / weekTarget) * 100 : 0;

    const lines = [
      `# Activity Debrief ${act.id}`,
      "",
      `- Name: ${act.name || "(unnamed)"}`,
      `- Date: ${(act.start_date_local || act.start_date || act.date || "").slice(0, 19)}`,
      `- Discipline: ${discipline}`,
      `- Volume: ${fmt(volume, 2)} ${unit}`,
      `- Weekly target contribution: ${fmt(contribution, 1)}%`,
    ];

    if (sessionIndex != null) {
      const entry = sessionsToDate.find((item) => item.index === sessionIndex);
      const planned = entry ? plannedSessionMetric(entry.session) : null;
      const matchedCount = (sessionMatches.get(sessionIndex) || []).length;
      if (entry && planned) {
        lines.push(`- Matched planned session: ${entry.session.date} ${entry.session.discipline} ${entry.session.type}`);
        lines.push(`- Planned session metric: ${fmt(planned.value, 2)} ${planned.unit}`);
        lines.push(`- Activities matched to session: ${matchedCount}`);
      }
    } else {
      lines.push("- Matched planned session: none (unplanned/substitution)");
    }

    saveText(path.join(options.activityReportDir, `${act.id}.md`), `${lines.join("\n")}\n`);
  }
}

function writeDailyReport(options, dailyDate, plan, activitiesToDate, activityMatch, sessionsToDate, sessionMatches) {
  const isoDay = toIsoDate(dailyDate);
  const plannedToday = sessionsToDate.filter((entry) => entry.session.date === isoDay);
  const actualToday = activitiesToDate.filter((act) => {
    const day = activityDate(act);
    return day && toIsoDate(day) === isoDay;
  });

  const lines = [
    `# Daily Report ${isoDay}`,
    "",
    "## Planned Sessions",
  ];
  if (!plannedToday.length) {
    lines.push("- None");
  } else {
    for (const entry of plannedToday) {
      const planned = plannedSessionMetric(entry.session);
      const matched = sessionMatches.get(entry.index) || [];
      const actual = matched.reduce((sum, act) => sum + actualMetricForSession(act, planned.basis), 0);
      const status = sessionStatus(actual, planned.value, entry.date, dailyDate);
      lines.push(
        `- ${entry.session.discipline} ${entry.session.type}: ${status} (${fmt(actual, 1)} / ${fmt(planned.value, 1)} ${planned.unit})`
      );
    }
  }

  lines.push("", "## Actual Activities");
  if (!actualToday.length) {
    lines.push("- None");
  } else {
    for (const activity of actualToday) {
      const discipline = normalizeSport(activity.sport_type || activity.type) || "unknown";
      const durationMin = activityDurationSec(activity) / 60;
      const distanceKm = activityDistanceM(activity) / 1000;
      const matched = activityMatch.has(activityKey(activity));
      lines.push(
        `- ${activity.name || "(unnamed)"} (${discipline}, ${fmt(durationMin, 1)} min, ${fmt(distanceKm, 2)} km, ${
          matched ? "matched" : "unplanned"
        })`
      );
    }
  }

  fs.mkdirSync(options.dailyOutputDir, { recursive: true });
  saveText(path.join(options.dailyOutputDir, `${isoDay}.md`), `${lines.join("\n")}\n`);
}

function main() {
  const options = parseArgs();
  const weekStartDate = weekStart(parseDate(options.weekStart));
  const weekEnd = new Date(weekStartDate.getTime());
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
  const asOfDate = ensureDateInWeek(weekStartDate, weekEnd, options.asOfDate);

  const planPath = `${options.planDir}/${toIsoDate(weekStartDate)}.json`;
  const plan = loadJson(planPath);
  const baseline = loadJson(options.baseline);
  const activities = loadJson(options.activities);

  const activitiesToDate = activities.filter((act) => {
    const dt = activityDate(act);
    return dt && dt >= weekStartDate && dt <= asOfDate;
  });

  const { totals, sessions, minutes } = summarizeActivities(activities, weekStartDate, asOfDate);
  const thresholds = {
    ftp_w: baseline?.athlete_meta?.ftp_w || null,
    hr_lthr_bpm: baseline?.athlete_meta?.hr_lthr_bpm || null,
    vthr_run_mps: baseline?.disciplines?.run?.threshold?.vthr_mps || null,
    css_sec_per_100m: baseline?.disciplines?.swim?.threshold?.css_sec_per_100m || null,
  };

  const actualLoad = { run: 0, bike: 0, swim: 0 };
  const loadQuality = { run: { assumed: 0, total: 0 }, bike: { assumed: 0, total: 0 }, swim: { assumed: 0, total: 0 } };
  for (const act of activitiesToDate) {
    const discipline = normalizeSport(act.sport_type || act.type);
    if (!discipline) continue;
    const load = computeActivityLoad(act, discipline, thresholds);
    if (!load) continue;
    actualLoad[discipline] += load.load_points;
    loadQuality[discipline].total += 1;
    if (load.method === "assumed") loadQuality[discipline].assumed += 1;
  }

  const { sessionsToDate, sessionMatches, activityMatch, unplannedActivities } = matchActivitiesToSessions(
    plan.sessions || [],
    activitiesToDate,
    asOfDate
  );

  const disciplineMetrics = {};
  for (const discipline of ["run", "bike", "swim"]) {
    const target = plan.targets?.[discipline] || {};
    const useMinutes = disciplineUsesMinutes(plan, discipline);
    const fullWeekPlanned =
      discipline === "bike" ? Number(target.volume_hours || 0) : useMinutes ? Number(target.volume_min || 0) : Number(target.volume_km || 0);
    disciplineMetrics[discipline] = {
      target,
      useMinutes,
      unit: discipline === "bike" ? "hours" : useMinutes ? "min" : "km",
      fullWeekPlanned,
      plannedToDate: 0,
      sessionsPlannedToDate: 0,
      sessionsWithActivity: 0,
    };
  }

  const sessionLines = [];
  for (const entry of sessionsToDate) {
    const discipline = entry.session.discipline;
    if (!disciplineMetrics[discipline]) continue;

    const planned = plannedSessionMetric(entry.session);
    const matches = sessionMatches.get(entry.index) || [];
    const actual = matches.reduce((sum, act) => sum + actualMetricForSession(act, planned.basis), 0);
    const sStatus = sessionStatus(actual, planned.value, entry.date, asOfDate);
    const ids = matches.map((act) => act.id).filter((id) => id != null);

    disciplineMetrics[discipline].plannedToDate += plannedDisciplineVolumeFromSession(
      entry.session,
      disciplineMetrics[discipline].target,
      disciplineMetrics[discipline].useMinutes
    );
    disciplineMetrics[discipline].sessionsPlannedToDate += 1;
    if (matches.length) disciplineMetrics[discipline].sessionsWithActivity += 1;

    sessionLines.push(
      `- ${entry.session.date} ${discipline} ${entry.session.type}: ${sStatus} (${fmt(actual, 1)} / ${fmt(planned.value, 1)} ${planned.unit})` +
        (ids.length ? ` [activities: ${ids.join(", ")}]` : "")
    );
  }

  const summaryLines = [];
  for (const discipline of ["run", "bike", "swim"]) {
    const metrics = disciplineMetrics[discipline];
    const plannedToDate = metrics.plannedToDate;
    const actualToDate = discipline === "bike" ? totals[discipline] : metrics.useMinutes ? minutes[discipline] : totals[discipline];

    const statusToDate = statusFor(actualToDate, plannedToDate);
    const fullWeekProgressPct = metrics.fullWeekPlanned > 0 ? (actualToDate / metrics.fullWeekPlanned) * 100 : 0;
    const plannedLoadToDate =
      metrics.target.load_points && metrics.fullWeekPlanned > 0
        ? Number(metrics.target.load_points) * (plannedToDate / metrics.fullWeekPlanned)
        : 0;

    const asOfDayIndex = dayDiff(asOfDate, weekStartDate) + 1;
    const projected = asOfDayIndex > 0 ? (actualToDate * 7) / asOfDayIndex : actualToDate;
    const projectedStatus = statusFor(projected, metrics.fullWeekPlanned);

    summaryLines.push(
      `- ${discipline[0].toUpperCase() + discipline.slice(1)}: ${statusToDate} ` +
        `(${fmt(actualToDate, 2)} / ${fmt(plannedToDate, 2)} ${metrics.unit} expected-to-date, ` +
        `${sessions[discipline]} activities, ${metrics.sessionsWithActivity}/${metrics.sessionsPlannedToDate} planned sessions touched)`
    );
    summaryLines.push(
      `  - Full week progress: ${fmt(fullWeekProgressPct, 1)}% of ${fmt(metrics.fullWeekPlanned, 2)} ${metrics.unit}; ` +
        `projection: ${fmt(projected, 2)} ${metrics.unit} (${projectedStatus})`
    );
    summaryLines.push(
      `  - Load points: ${fmt(actualLoad[discipline], 2)} / ${fmt(plannedLoadToDate, 2)} expected-to-date ` +
        `(full-week planned ${fmt(Number(metrics.target.load_points || 0), 2)})`
    );
    const quality = loadQuality[discipline];
    if (quality.total && quality.assumed / quality.total > 0.5) {
      summaryLines.push("  - Load quality: low (assumed intensity for most sessions)");
    }
  }

  const latestActivity = [...activitiesToDate].sort((a, b) => {
    const aTs = activityDateTime(a)?.getTime() || 0;
    const bTs = activityDateTime(b)?.getTime() || 0;
    return bTs - aTs;
  })[0];

  const reportLines = [
    `# Adherence Report for week starting ${toIsoDate(weekStartDate)}`,
    "",
    `Date range: ${toIsoDate(weekStartDate)} to ${toIsoDate(weekEnd)}`,
    `As of: ${toIsoDate(asOfDate)}`,
    asOfDate < weekEnd ? "Mode: week-to-date (expected-to-date pacing)" : "Mode: full-week",
    "",
    "## Summary",
    ...summaryLines,
    "",
    "## Session Matching",
  ];
  if (sessionLines.length) reportLines.push(...sessionLines);
  else reportLines.push("- No planned sessions found up to as-of date.");

  reportLines.push("", "## Unplanned Activities");
  if (!unplannedActivities.length) {
    reportLines.push("- None");
  } else {
    for (const act of unplannedActivities) {
      const discipline = normalizeSport(act.sport_type || act.type) || "unknown";
      const date = toIsoDate(activityDate(act));
      const durationMin = activityDurationSec(act) / 60;
      const distanceKm = activityDistanceM(act) / 1000;
      reportLines.push(
        `- ${date} ${discipline}: ${act.name || "(unnamed)"} (${fmt(durationMin, 1)} min, ${fmt(distanceKm, 2)} km)`
      );
    }
  }

  reportLines.push("", "## Latest Activity");
  if (latestActivity) {
    const discipline = normalizeSport(latestActivity.sport_type || latestActivity.type) || "unknown";
    const metrics = disciplineMetrics[discipline] || { useMinutes: false, fullWeekPlanned: 0, unit: "units" };
    const volume = actualDisciplineVolumeFromActivity(latestActivity, discipline, metrics.useMinutes);
    const contribution = metrics.fullWeekPlanned > 0 ? (volume / metrics.fullWeekPlanned) * 100 : 0;
    const matchedIndex = activityMatch.get(activityKey(latestActivity));
    const matchedSession = matchedIndex != null ? sessionsToDate.find((entry) => entry.index === matchedIndex) : null;
    reportLines.push(
      `- ${latestActivity.name || "(unnamed)"} (${toIsoDate(activityDate(latestActivity))}, ${discipline}) contributed ` +
        `${fmt(contribution, 1)}% of the weekly ${discipline} target`
    );
    if (matchedSession) {
      reportLines.push(
        `  - Matched planned session: ${matchedSession.session.date} ${matchedSession.session.discipline} ${matchedSession.session.type}`
      );
    } else {
      reportLines.push("  - Matched planned session: none (unplanned/substitution)");
    }
  } else {
    reportLines.push("- No completed activities found in the analysis window.");
  }

  const outputPath = reportPathFor(options, weekStartDate, asOfDate, weekEnd);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  saveText(outputPath, `${reportLines.join("\n").trim()}\n`);

  if (options.writeActivityReports) {
    writeActivityDebriefs(options, activitiesToDate, activityMatch, sessionsToDate, sessionMatches, plan, disciplineMetrics);
  }

  if (options.writeDailyReport) {
    const dailyDateRaw = options.dailyDate ? parseDate(options.dailyDate) : asOfDate;
    if (!dailyDateRaw) throw new Error("Invalid --daily-date. Use YYYY-MM-DD.");
    const dailyDate = dailyDateRaw < weekStartDate ? weekStartDate : dailyDateRaw > asOfDate ? asOfDate : dailyDateRaw;
    writeDailyReport(options, dailyDate, plan, activitiesToDate, activityMatch, sessionsToDate, sessionMatches);
  }
}

if (require.main === module) {
  main();
}
