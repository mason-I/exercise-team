const {
  coefficientOfVariation,
  daterangeWeeks,
  dumpJson,
  iqr,
  loadJson,
  median,
  parseDate,
  saveText,
  toIsoDate,
  weekStart,
} = require("../../_shared/lib");

const DISCIPLINES = { run: "Run", bike: "Ride", swim: "Swim" };

function normalizeSport(value) {
  if (!value) return null;
  const lowered = value.toLowerCase();
  if (["run", "running", "trailrun", "trailrunning"].includes(lowered)) return "run";
  if (
    [
      "ride",
      "bike",
      "biking",
      "cycling",
      "virtualride",
      "gravelride",
      "ebikeride",
      "mountainbikeride",
      "roadbikeride",
    ].includes(lowered)
  )
    return "bike";
  if (["swim", "swimming", "openwaterswim"].includes(lowered)) return "swim";
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
  return null;
}

function activityDistanceM(activity) {
  if ("distance_m" in activity && activity.distance_m != null) return Number(activity.distance_m);
  if ("distance" in activity && activity.distance != null) return Number(activity.distance);
  return null;
}

function activitySpeedKmh(activity) {
  if ("average_speed_kmh" in activity && activity.average_speed_kmh != null) return Number(activity.average_speed_kmh);
  if ("average_speed_mps" in activity && activity.average_speed_mps != null) {
    return Number(activity.average_speed_mps) * 3.6;
  }
  const distM = activityDistanceM(activity);
  const durSec = activityDurationSec(activity);
  if (!distM || !durSec) return null;
  return (distM / 1000) / (durSec / 3600);
}

function activityPaceSecPerKm(activity) {
  if ("pace_sec_per_km" in activity && activity.pace_sec_per_km != null) return Number(activity.pace_sec_per_km);
  const distM = activityDistanceM(activity);
  const durSec = activityDurationSec(activity);
  if (!distM || !durSec) return null;
  return durSec / (distM / 1000);
}

function activityPaceSecPer100m(activity) {
  if ("pace_sec_per_100m" in activity && activity.pace_sec_per_100m != null) {
    return Number(activity.pace_sec_per_100m);
  }
  const distM = activityDistanceM(activity);
  const durSec = activityDurationSec(activity);
  if (!distM || !durSec) return null;
  return durSec / (distM / 100);
}

function activityAverageWatts(activity) {
  if ("average_watts" in activity && activity.average_watts != null) return Number(activity.average_watts);
  return null;
}

function activityAverageHeartRate(activity) {
  if ("average_heartrate" in activity && activity.average_heartrate != null) return Number(activity.average_heartrate);
  return null;
}

function dateRange(activities) {
  let min = null;
  let max = null;
  for (const activity of activities) {
    const dt = activityDate(activity);
    if (!dt) continue;
    if (!min || dt < min) min = dt;
    if (!max || dt > max) max = dt;
  }
  return { min, max };
}

function daysSinceLastActivity(activities, discipline, endDate) {
  let last = null;
  for (const activity of activities) {
    if (normalizeSport(activity.sport_type || activity.type) !== discipline) continue;
    const dt = activityDate(activity);
    if (!dt) continue;
    if (!last || dt > last) last = dt;
  }
  if (!last) return null;
  const diffMs = endDate.getTime() - last.getTime();
  return Math.max(Math.round(diffMs / 86400000), 0);
}

function blendValue(recentValue, historicalValue, gapDays) {
  if (recentValue == null && historicalValue == null) return 0;
  if (recentValue == null) return historicalValue || 0;
  if (historicalValue == null) return recentValue || 0;

  // Weight recent 56 days more heavily, but retain history to avoid false zero baselines.
  let recentWeight = 0.8;
  if (gapDays != null) {
    if (gapDays > 112) recentWeight = 0.4;
    else if (gapDays > 84) recentWeight = 0.5;
    else if (gapDays > 56) recentWeight = 0.6;
    else if (gapDays > 28) recentWeight = 0.7;
  }
  return recentValue * recentWeight + historicalValue * (1 - recentWeight);
}

function filterWindow(activities, endDate, windowDays) {
  const startDate = new Date(endDate.getTime());
  startDate.setUTCDate(startDate.getUTCDate() - (windowDays - 1));
  const filtered = activities.filter((activity) => {
    const actDate = activityDate(activity);
    if (!actDate) return false;
    return actDate >= startDate && actDate <= endDate;
  });
  return { filtered, startDate };
}

function weeklyBuckets(activities, startDate, endDate) {
  const weekMap = new Map();
  for (const activity of activities) {
    const actDate = activityDate(activity);
    if (!actDate) continue;
    const wk = weekStart(actDate).toISOString();
    if (!weekMap.has(wk)) weekMap.set(wk, []);
    weekMap.get(wk).push(activity);
  }
  const weeks = daterangeWeeks(startDate, endDate);
  return { weeks, weekMap };
}

function disciplineMetrics(activities, startDate, endDate, discipline) {
  const { weeks, weekMap } = weeklyBuckets(activities, startDate, endDate);
  const weeklyVolumes = [];
  const weeklySessions = [];
  const weeklyMaxSessions = [];
  const weeklyElevationGains = [];
  const sessionDistances = [];
  const sessionDurations = [];
  const sessionElevationGains = [];
  const paceSamples = [];
  const paceDistanceWeights = [];
  const speedSamples = [];
  const speedDistanceWeights = [];
  const powerSamples = [];
  const powerDurationWeights = [];
  const heartRateSamples = [];
  const heartRateDurationWeights = [];

  for (const wk of weeks) {
    const weekActs = (weekMap.get(wk.toISOString()) || []).filter(
      (a) => normalizeSport(a.sport_type || a.type) === discipline
    );
    weeklySessions.push(weekActs.length);

    const volumes = [];
    const elevationGains = [];
    let maxSessionVal = 0;
    for (const act of weekActs) {
      const distM = activityDistanceM(act) || 0;
      const durSec = activityDurationSec(act) || 0;
      const elevationGainM = Number(act.total_elevation_gain_m || act.total_elevation_gain || 0) || 0;
      let volume = 0;
      if (discipline === "bike") {
        volume = durSec / 3600;
        maxSessionVal = Math.max(maxSessionVal, volume);
      } else {
        volume = distM / 1000;
        maxSessionVal = Math.max(maxSessionVal, volume);
      }
      volumes.push(volume);
      if (discipline === "bike") {
        elevationGains.push(elevationGainM);
        if (elevationGainM) sessionElevationGains.push(elevationGainM);
      }
      if (distM) sessionDistances.push(distM / 1000);
      if (durSec) sessionDurations.push(durSec / 60);

      if (discipline === "run") {
        const pace = activityPaceSecPerKm(act);
        if (distM && pace && distM >= 1000 && pace >= 180 && pace <= 900) {
          paceSamples.push(pace);
          paceDistanceWeights.push(distM);
        }
        const hr = activityAverageHeartRate(act);
        if (durSec && hr && hr >= 60 && hr <= 220) {
          heartRateSamples.push(hr);
          heartRateDurationWeights.push(durSec);
        }
      }

      if (discipline === "bike") {
        const speed = activitySpeedKmh(act);
        if (durSec && speed && durSec >= 900 && speed >= 5 && speed <= 60) {
          speedSamples.push(speed);
          speedDistanceWeights.push(distM || 0);
        }
        const watts = activityAverageWatts(act);
        if (durSec && watts && durSec >= 600 && watts > 0 && watts <= 800) {
          powerSamples.push(watts);
          powerDurationWeights.push(durSec);
        }
        const hr = activityAverageHeartRate(act);
        if (durSec && hr && hr >= 60 && hr <= 220) {
          heartRateSamples.push(hr);
          heartRateDurationWeights.push(durSec);
        }
      }
    }
    weeklyVolumes.push(volumes.reduce((sum, v) => sum + v, 0));
    weeklyMaxSessions.push(maxSessionVal);
    if (discipline === "bike") {
      weeklyElevationGains.push(elevationGains.reduce((sum, v) => sum + v, 0));
    }
  }

  const zeroWeeks = weeklySessions.filter((v) => v === 0).length;
  const totalSessions = weeklySessions.reduce((sum, v) => sum + v, 0);
  const volumeCv = coefficientOfVariation(weeklyVolumes);

  let confidence = "high";
  if (totalSessions < 6 || zeroWeeks > 2) confidence = "low";
  else if (zeroWeeks > 1 || volumeCv > 0.4) confidence = "medium";
  if (volumeCv > 0.6) confidence = "low";

  const units = {
    volume: discipline === "bike" ? "hours" : "km",
    session_distance: "km",
    session_duration: "min",
    long_session: discipline === "bike" ? "hours" : "km",
  };
  if (discipline === "bike") {
    units.elevation_gain = "m";
  }

  const intensity = {};
  if (discipline === "run") {
    const paceWeightedSum = paceSamples.reduce((sum, v, i) => sum + v * (paceDistanceWeights[i] || 0), 0);
    const paceWeightTotal = paceDistanceWeights.reduce((sum, v) => sum + v, 0);
    intensity.pace = {
      distance_weighted_sec_per_km: Number((paceWeightTotal ? paceWeightedSum / paceWeightTotal : 0).toFixed(2)),
      median_sec_per_km: Number(median(paceSamples).toFixed(2)),
      sample_count: paceSamples.length,
    };
    const hrWeightedSum = heartRateSamples.reduce(
      (sum, v, i) => sum + v * (heartRateDurationWeights[i] || 0),
      0
    );
    const hrWeightTotal = heartRateDurationWeights.reduce((sum, v) => sum + v, 0);
    intensity.heart_rate = {
      duration_weighted_bpm: Number((hrWeightTotal ? hrWeightedSum / hrWeightTotal : 0).toFixed(1)),
      median_bpm: Number(median(heartRateSamples).toFixed(1)),
      sample_count: heartRateSamples.length,
    };
  }

  if (discipline === "bike") {
    const speedWeightedSum = speedSamples.reduce((sum, v, i) => sum + v * (speedDistanceWeights[i] || 0), 0);
    const speedWeightTotal = speedDistanceWeights.reduce((sum, v) => sum + v, 0);
    intensity.speed = {
      distance_weighted_kmh: Number((speedWeightTotal ? speedWeightedSum / speedWeightTotal : 0).toFixed(2)),
      median_kmh: Number(median(speedSamples).toFixed(2)),
      sample_count: speedSamples.length,
    };
    const powerWeightedSum = powerSamples.reduce((sum, v, i) => sum + v * (powerDurationWeights[i] || 0), 0);
    const powerWeightTotal = powerDurationWeights.reduce((sum, v) => sum + v, 0);
    intensity.power = {
      duration_weighted_watts: Number((powerWeightTotal ? powerWeightedSum / powerWeightTotal : 0).toFixed(1)),
      median_watts: Number(median(powerSamples).toFixed(1)),
      sample_count: powerSamples.length,
    };
    const hrWeightedSum = heartRateSamples.reduce(
      (sum, v, i) => sum + v * (heartRateDurationWeights[i] || 0),
      0
    );
    const hrWeightTotal = heartRateDurationWeights.reduce((sum, v) => sum + v, 0);
    intensity.heart_rate = {
      duration_weighted_bpm: Number((hrWeightTotal ? hrWeightedSum / hrWeightTotal : 0).toFixed(1)),
      median_bpm: Number(median(heartRateSamples).toFixed(1)),
      sample_count: heartRateSamples.length,
    };
  }

  return {
    units,
    weekly: {
      sessions_median: median(weeklySessions),
      volume_median: median(weeklyVolumes),
      volume_iqr: iqr(weeklyVolumes),
      zero_weeks: zeroWeeks,
      volume_cv: Number(volumeCv.toFixed(3)),
      weeks_tracked: weeklyVolumes.length,
      elevation_gain_median: discipline === "bike" ? median(weeklyElevationGains) : 0,
    },
    session: {
      distance_median: median(sessionDistances),
      duration_median_min: median(sessionDurations),
      sessions_tracked: totalSessions,
      elevation_gain_median_m: discipline === "bike" ? median(sessionElevationGains) : 0,
    },
    long_session: {
      weekly_max_median: median(weeklyMaxSessions),
    },
    intensity,
    confidence,
  };
}

function swimPaceMetrics(activities) {
  const paceSamples = [];
  let distanceSum = 0;
  let weightedSum = 0;

  for (const act of activities) {
    if (normalizeSport(act.sport_type || act.type) !== "swim") continue;
    const distM = activityDistanceM(act);
    const pace = activityPaceSecPer100m(act);
    if (!distM || !pace || distM < 200) continue;
    if (pace < 40 || pace > 300) continue;
    paceSamples.push(pace);
    distanceSum += distM;
    weightedSum += pace * distM;
  }

  const weightedPace = distanceSum ? weightedSum / distanceSum : 0;
  return {
    distance_weighted_sec_per_100m: Number(weightedPace.toFixed(2)),
    median_sec_per_100m: Number(median(paceSamples).toFixed(2)),
    sample_count: paceSamples.length,
  };
}

function blendIqr(recentIqr, historicalIqr, gapDays) {
  const recent = Array.isArray(recentIqr) ? recentIqr : [0, 0];
  const historical = Array.isArray(historicalIqr) ? historicalIqr : [0, 0];
  return [
    Number(blendValue(recent[0], historical[0], gapDays).toFixed(2)),
    Number(blendValue(recent[1], historical[1], gapDays).toFixed(2)),
  ];
}

function blendMetrics(recentMetrics, historicalMetrics, gapDays) {
  const blended = JSON.parse(JSON.stringify(recentMetrics));
  blended.weekly.sessions_median = Number(
    blendValue(recentMetrics.weekly.sessions_median, historicalMetrics.weekly.sessions_median, gapDays).toFixed(2)
  );
  blended.weekly.volume_median = Number(
    blendValue(recentMetrics.weekly.volume_median, historicalMetrics.weekly.volume_median, gapDays).toFixed(2)
  );
  blended.weekly.volume_iqr = blendIqr(recentMetrics.weekly.volume_iqr, historicalMetrics.weekly.volume_iqr, gapDays);
  if (typeof recentMetrics.weekly.elevation_gain_median === "number") {
    blended.weekly.elevation_gain_median = Number(
      blendValue(
        recentMetrics.weekly.elevation_gain_median,
        historicalMetrics.weekly.elevation_gain_median,
        gapDays
      ).toFixed(2)
    );
  }
  blended.weekly.zero_weeks = recentMetrics.weekly.zero_weeks;
  blended.weekly.volume_cv = recentMetrics.weekly.volume_cv;
  blended.session.distance_median = Number(
    blendValue(recentMetrics.session.distance_median, historicalMetrics.session.distance_median, gapDays).toFixed(2)
  );
  blended.session.duration_median_min = Number(
    blendValue(
      recentMetrics.session.duration_median_min,
      historicalMetrics.session.duration_median_min,
      gapDays
    ).toFixed(2)
  );
  if (typeof recentMetrics.session.elevation_gain_median_m === "number") {
    blended.session.elevation_gain_median_m = Number(
      blendValue(
        recentMetrics.session.elevation_gain_median_m,
        historicalMetrics.session.elevation_gain_median_m,
        gapDays
      ).toFixed(2)
    );
  }
  blended.long_session.weekly_max_median = Number(
    blendValue(
      recentMetrics.long_session.weekly_max_median,
      historicalMetrics.long_session.weekly_max_median,
      gapDays
    ).toFixed(2)
  );
  if (recentMetrics.intensity || historicalMetrics.intensity) {
    blended.intensity = blended.intensity || {};
    for (const [key, metric] of Object.entries(recentMetrics.intensity || {})) {
      const historicalMetric = (historicalMetrics.intensity || {})[key];
      if (!historicalMetric) {
        blended.intensity[key] = metric;
        continue;
      }
      const blendedMetric = { ...metric };
      for (const [metricKey, value] of Object.entries(metric)) {
        if (metricKey === "sample_count") {
          blendedMetric.sample_count = metric.sample_count;
          continue;
        }
        blendedMetric[metricKey] = Number(
          blendValue(value, historicalMetric[metricKey], gapDays).toFixed(2)
        );
      }
      blended.intensity[key] = blendedMetric;
    }
  }
  blended.history = {
    gap_days: gapDays,
    recent: {
      weekly: recentMetrics.weekly,
      session: recentMetrics.session,
      long_session: recentMetrics.long_session,
      intensity: recentMetrics.intensity,
    },
    historical: {
      weekly: historicalMetrics.weekly,
      session: historicalMetrics.session,
      long_session: historicalMetrics.long_session,
      intensity: historicalMetrics.intensity,
    },
  };
  return blended;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    input: "data/strava_activities.json",
    windowDays: 56,
    shortWindow: 14,
    longWindow: 112,
    endDate: null,
    outputJson: "baseline.json",
    outputMd: "baseline.md",
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--input") options.input = args[i + 1];
    if (arg === "--window-days") options.windowDays = Number(args[i + 1]);
    if (arg === "--short-window") options.shortWindow = Number(args[i + 1]);
    if (arg === "--long-window") options.longWindow = Number(args[i + 1]);
    if (arg === "--end-date") options.endDate = args[i + 1];
    if (arg === "--output-json") options.outputJson = args[i + 1];
    if (arg === "--output-md") options.outputMd = args[i + 1];
  }
  return options;
}

function selectRecentOrHistorical(recentMetric, historicalMetric, minSamples = 3, gapDays = null) {
  if (!historicalMetric) return recentMetric;
  if (!recentMetric) return historicalMetric;
  if (recentMetric.sample_count >= minSamples) return recentMetric;
  if (gapDays != null && gapDays <= 28 && recentMetric.sample_count > 0) return recentMetric;
  return historicalMetric;
}

function main() {
  const options = parseArgs();
  const endDate = options.endDate ? parseDate(options.endDate) : parseDate(toIsoDate(new Date()));
  if (!endDate) {
    throw new Error("Invalid end date.");
  }

  const activities = loadJson(options.input);
  if (!Array.isArray(activities)) {
    throw new Error("Activities file must be a JSON array.");
  }
  const { min: allStart, max: allEnd } = dateRange(activities);
  if (!allStart || !allEnd) {
    throw new Error("No valid activity dates found.");
  }

  const { filtered: primaryActs, startDate: primaryStart } = filterWindow(
    activities,
    endDate,
    options.windowDays
  );
  const historicalActs = activities.filter((activity) => {
    const actDate = activityDate(activity);
    if (!actDate) return false;
    return actDate < primaryStart;
  });
  const { min: historicalStart, max: historicalEnd } = dateRange(historicalActs);
  const { filtered: shortActs, startDate: shortStart } = filterWindow(
    activities,
    endDate,
    options.shortWindow
  );
  const { filtered: longActs, startDate: longStart } = filterWindow(
    activities,
    endDate,
    options.longWindow
  );

  const baseline = {
    generated_at: toIsoDate(new Date()),
    windows: {
      short_days: options.shortWindow,
      primary_days: options.windowDays,
      long_days: options.longWindow,
      all_start: toIsoDate(allStart),
      all_end: toIsoDate(allEnd),
      primary_start: toIsoDate(primaryStart),
      primary_end: toIsoDate(endDate),
    },
    weighting: {
      mode: "recent_weighted",
      recent_window_days: options.windowDays,
      note: "Recent 56 days weighted more heavily; historical data retained to avoid false zero baselines.",
    },
    disciplines: {},
    context: {},
  };

  const metricsByDiscipline = {};
  for (const discipline of ["run", "bike", "swim"]) {
    const recentMetrics = disciplineMetrics(primaryActs, primaryStart, endDate, discipline);
    const historySource = historicalActs.length ? historicalActs : activities;
    const historyStart = historicalStart || allStart;
    const historyEnd = historicalEnd || endDate;
    const historicalMetrics = disciplineMetrics(historySource, historyStart, historyEnd, discipline);
    const gapDays = daysSinceLastActivity(activities, discipline, endDate);
    baseline.disciplines[discipline] = blendMetrics(recentMetrics, historicalMetrics, gapDays);
    metricsByDiscipline[discipline] = { recentMetrics, historicalMetrics, gapDays };
    if (gapDays != null) {
      if (gapDays > 42) baseline.disciplines[discipline].confidence = "low";
      else if (gapDays > 21 && baseline.disciplines[discipline].confidence === "high") {
        baseline.disciplines[discipline].confidence = "medium";
      }
    }
  }

  const recentSwimPace = swimPaceMetrics(primaryActs);
  const historicalSwimPace = swimPaceMetrics(historicalActs.length ? historicalActs : activities);
  const swimGapDays = metricsByDiscipline.swim.gapDays;
  baseline.disciplines.swim.pace = selectRecentOrHistorical(recentSwimPace, historicalSwimPace, 3, swimGapDays);

  const recentRunPace = metricsByDiscipline.run.recentMetrics.intensity.pace;
  const historicalRunPace = metricsByDiscipline.run.historicalMetrics.intensity.pace;
  const runGapDays = metricsByDiscipline.run.gapDays;
  baseline.disciplines.run.pace = selectRecentOrHistorical(recentRunPace, historicalRunPace, 3, runGapDays);

  const recentBikeSpeed = metricsByDiscipline.bike.recentMetrics.intensity.speed;
  const historicalBikeSpeed = metricsByDiscipline.bike.historicalMetrics.intensity.speed;
  const recentBikePower = metricsByDiscipline.bike.recentMetrics.intensity.power;
  const historicalBikePower = metricsByDiscipline.bike.historicalMetrics.intensity.power;
  const bikeGapDays = metricsByDiscipline.bike.gapDays;
  baseline.disciplines.bike.speed = selectRecentOrHistorical(recentBikeSpeed, historicalBikeSpeed, 3, bikeGapDays);
  baseline.disciplines.bike.power = selectRecentOrHistorical(recentBikePower, historicalBikePower, 3, bikeGapDays);
  baseline.context.short_window = {
    start: toIsoDate(shortStart),
    end: toIsoDate(endDate),
    activity_count: shortActs.length,
  };
  baseline.context.long_window = {
    start: toIsoDate(longStart),
    end: toIsoDate(endDate),
    activity_count: longActs.length,
  };

  dumpJson(options.outputJson, baseline);

  const mdLines = [
    "# Baseline Summary",
    "",
    `Window: ${baseline.windows.primary_start} to ${baseline.windows.primary_end}`,
    "",
  ];
  for (const [discipline, metrics] of Object.entries(baseline.disciplines)) {
    mdLines.push(`## ${discipline.charAt(0).toUpperCase() + discipline.slice(1)}`);
    mdLines.push(`- Confidence: ${metrics.confidence}`);
    mdLines.push(`- Weekly volume median: ${metrics.weekly.volume_median} ${metrics.units.volume}`);
    mdLines.push(`- Weekly sessions median: ${metrics.weekly.sessions_median}`);
    mdLines.push(`- Long session median: ${metrics.long_session.weekly_max_median} ${metrics.units.long_session}`);
    mdLines.push("");
    if (discipline === "swim") {
      const pace = metrics.pace || {};
      mdLines.push(`- Pace (weighted): ${pace.distance_weighted_sec_per_100m || 0} sec/100m`);
      mdLines.push(`- Pace (median): ${pace.median_sec_per_100m || 0} sec/100m`);
      mdLines.push(`- Pace samples: ${pace.sample_count || 0}`);
      mdLines.push("");
    }
    if (discipline === "run") {
      const pace = metrics.pace || {};
      mdLines.push(`- Pace (weighted): ${pace.distance_weighted_sec_per_km || 0} sec/km`);
      mdLines.push(`- Pace (median): ${pace.median_sec_per_km || 0} sec/km`);
      mdLines.push(`- Pace samples: ${pace.sample_count || 0}`);
      mdLines.push("");
    }
    if (discipline === "bike") {
      const speed = metrics.speed || {};
      const power = metrics.power || {};
      mdLines.push(`- Speed (weighted): ${speed.distance_weighted_kmh || 0} km/h`);
      mdLines.push(`- Speed (median): ${speed.median_kmh || 0} km/h`);
      mdLines.push(`- Speed samples: ${speed.sample_count || 0}`);
      mdLines.push(`- Weekly elevation median: ${metrics.weekly.elevation_gain_median || 0} m`);
      mdLines.push(`- Session elevation median: ${metrics.session.elevation_gain_median_m || 0} m`);
      mdLines.push(`- Power (weighted): ${power.duration_weighted_watts || 0} W`);
      mdLines.push(`- Power (median): ${power.median_watts || 0} W`);
      mdLines.push(`- Power samples: ${power.sample_count || 0}`);
      mdLines.push("");
    }
  }

  saveText(options.outputMd, mdLines.join("\n").trim() + "\n");
}

if (require.main === module) {
  main();
}
