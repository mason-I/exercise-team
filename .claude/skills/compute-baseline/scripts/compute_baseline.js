const fs = require("fs");
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

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function fileExists(path) {
  try {
    return fs.existsSync(path);
  } catch (error) {
    return false;
  }
}

function resolveHome(pathValue) {
  if (!pathValue) return pathValue;
  if (pathValue.startsWith("~/")) {
    return `${process.env.HOME}${pathValue.slice(1)}`;
  }
  return pathValue;
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

function activityDeviceWatts(activity) {
  if ("device_watts" in activity && activity.device_watts != null) return Boolean(activity.device_watts);
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

function daysSinceLastAny(activities, endDate) {
  let last = null;
  for (const activity of activities) {
    const discipline = normalizeSport(activity.sport_type || activity.type);
    if (!discipline) continue;
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

function disciplineMetrics(activities, startDate, endDate, discipline, athleteMeta = null) {
  const { weeks, weekMap } = weeklyBuckets(activities, startDate, endDate);
  const weeklyVolumes = [];
  const weeklyDistanceKm = [];
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
  const powerWkgSamples = [];
  const powerWkgDurationWeights = [];
  const heartRateSamples = [];
  const heartRateDurationWeights = [];
  let totalActivities = 0;
  let paceSpeedSampleCount = 0;
  let hrSampleCount = 0;
  let powerSampleCount = 0;
  let devicePowerSampleCount = 0;

  for (const wk of weeks) {
    const weekActs = (weekMap.get(wk.toISOString()) || []).filter(
      (a) => normalizeSport(a.sport_type || a.type) === discipline
    );
    weeklySessions.push(weekActs.length);

    const volumes = [];
    const distancesKm = [];
    const elevationGains = [];
    let maxSessionVal = 0;
    for (const act of weekActs) {
      totalActivities += 1;
      const distM = activityDistanceM(act) || 0;
      const durSec = activityDurationSec(act) || 0;
      const elevationGainM = Number(act.total_elevation_gain_m || act.total_elevation_gain || 0) || 0;
      let volume = 0;
      if (discipline === "bike") {
        volume = durSec / 3600;
        maxSessionVal = Math.max(maxSessionVal, volume);
        if (distM) distancesKm.push(distM / 1000);
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
          paceSpeedSampleCount += 1;
        }
        const hr = activityAverageHeartRate(act);
        if (durSec && hr && hr >= 60 && hr <= 220) {
          heartRateSamples.push(hr);
          heartRateDurationWeights.push(durSec);
          hrSampleCount += 1;
        }
      }

      if (discipline === "bike") {
        const speed = activitySpeedKmh(act);
        if (durSec && speed && durSec >= 900 && speed >= 5 && speed <= 60) {
          speedSamples.push(speed);
          speedDistanceWeights.push(distM || 0);
          paceSpeedSampleCount += 1;
        }
        const watts = activityAverageWatts(act);
        if (durSec && watts && durSec >= 600 && watts > 0 && watts <= 800) {
          powerSamples.push(watts);
          powerDurationWeights.push(durSec);
          powerSampleCount += 1;
          const deviceWatts = activityDeviceWatts(act);
          if (deviceWatts) devicePowerSampleCount += 1;
          if (athleteMeta && athleteMeta.weight_kg) {
            powerWkgSamples.push(watts / athleteMeta.weight_kg);
            powerWkgDurationWeights.push(durSec);
          }
        }
        const hr = activityAverageHeartRate(act);
        if (durSec && hr && hr >= 60 && hr <= 220) {
          heartRateSamples.push(hr);
          heartRateDurationWeights.push(durSec);
          hrSampleCount += 1;
        }
      }

      if (discipline === "swim") {
        const pace = activityPaceSecPer100m(act);
        if (distM && pace && distM >= 200 && pace >= 40 && pace <= 300) {
          paceSamples.push(pace);
          paceDistanceWeights.push(distM);
          paceSpeedSampleCount += 1;
        }
      }
    }
    weeklyVolumes.push(volumes.reduce((sum, v) => sum + v, 0));
    weeklyDistanceKm.push(distancesKm.reduce((sum, v) => sum + v, 0));
    weeklyMaxSessions.push(maxSessionVal);
    if (discipline === "bike") {
      weeklyElevationGains.push(elevationGains.reduce((sum, v) => sum + v, 0));
    }
  }

  const zeroWeeks = weeklySessions.filter((v) => v === 0).length;
  const totalSessions = weeklySessions.reduce((sum, v) => sum + v, 0);
  const volumeCv = coefficientOfVariation(weeklyVolumes);

  let confidence = "high";
  if (totalSessions < 6 || zeroWeeks >= 3 || volumeCv > 0.6) confidence = "low";
  else if (totalSessions < 8 || zeroWeeks >= 2 || volumeCv > 0.4) confidence = "medium";

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
    if (powerWkgSamples.length) {
      const powerWkgWeightedSum = powerWkgSamples.reduce(
        (sum, v, i) => sum + v * (powerWkgDurationWeights[i] || 0),
        0
      );
      const powerWkgWeightTotal = powerWkgDurationWeights.reduce((sum, v) => sum + v, 0);
      intensity.power_wkg = {
        duration_weighted_wkg: Number((powerWkgWeightTotal ? powerWkgWeightedSum / powerWkgWeightTotal : 0).toFixed(3)),
        median_wkg: Number(median(powerWkgSamples).toFixed(3)),
        sample_count: powerWkgSamples.length,
      };
    }
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

  const coverage = {
    total_activities: totalActivities,
    pace_or_speed_coverage_fraction: totalActivities ? Number((paceSpeedSampleCount / totalActivities).toFixed(2)) : 0,
    hr_fraction: totalActivities ? Number((hrSampleCount / totalActivities).toFixed(2)) : 0,
  };
  if (discipline === "bike") {
    coverage.power_fraction = totalActivities ? Number((powerSampleCount / totalActivities).toFixed(2)) : 0;
    coverage.device_watts_fraction = powerSampleCount
      ? Number((devicePowerSampleCount / powerSampleCount).toFixed(2))
      : 0;
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
      distance_km_median: discipline === "bike" ? median(weeklyDistanceKm) : 0,
      distance_km_iqr: discipline === "bike" ? iqr(weeklyDistanceKm) : [0, 0],
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
    coverage,
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
    athlete: "data/strava_athlete.json",
    profile: "profile.json",
    stravaConfig: "~/.config/strava-mcp/config.json",
    fetchActivityZones: "auto",
    activityZonesLimit: 60,
    fetchSegmentEfforts: "auto",
    segmentEffortsLimit: 8,
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
    if (arg === "--athlete") options.athlete = args[i + 1];
    if (arg === "--profile") options.profile = args[i + 1];
    if (arg === "--strava-config") options.stravaConfig = args[i + 1];
    if (arg === "--fetch-activity-zones") options.fetchActivityZones = args[i + 1];
    if (arg === "--activity-zones-limit") options.activityZonesLimit = Number(args[i + 1]);
    if (arg === "--fetch-segment-efforts") options.fetchSegmentEfforts = args[i + 1];
    if (arg === "--segment-efforts-limit") options.segmentEffortsLimit = Number(args[i + 1]);
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

function loadAthleteMeta(options) {
  let sex = null;
  let weightKg = null;
  let ftpWatts = null;
  let summit = null;
  let source = null;

  if (options.athlete && fileExists(options.athlete)) {
    const athlete = loadJson(options.athlete);
    if (athlete && typeof athlete === "object") {
      sex = athlete.sex || sex;
      if (athlete.weight != null) weightKg = Number(athlete.weight);
      if (athlete.ftp != null) ftpWatts = Number(athlete.ftp);
      if (athlete.summit != null) summit = Boolean(athlete.summit);
      source = "strava_athlete";
    }
  }

  if ((sex == null || weightKg == null) && options.profile && fileExists(options.profile)) {
    const profile = loadJson(options.profile);
    const athlete = (profile || {}).athlete || {};
    if (sex == null && athlete.sex) sex = athlete.sex;
    if (weightKg == null && athlete.weight_kg != null) weightKg = Number(athlete.weight_kg);
    if (source == null) source = "profile";
  }

  if (!Number.isFinite(weightKg)) weightKg = null;
  if (!Number.isFinite(ftpWatts)) ftpWatts = null;

  return {
    sex: sex || null,
    weight_kg: weightKg,
    has_weight: Number.isFinite(weightKg),
    ftp_w: ftpWatts,
    ftp_source: ftpWatts ? source : null,
    ftp_quality: "unknown",
    summit: summit === null ? false : Boolean(summit),
    source,
  };
}

async function loadStravaConfig(configPath) {
  const resolved = resolveHome(configPath);
  if (!fileExists(resolved)) return null;
  const raw = fs.readFileSync(resolved, "utf-8");
  const config = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  if (config.expiresAt && config.expiresAt > now + 60) {
    return { config, path: resolved };
  }
  if (!config.refreshToken || !config.clientId || !config.clientSecret) {
    return { config, path: resolved };
  }
  try {
    const params = new URLSearchParams({
      client_id: String(config.clientId),
      client_secret: String(config.clientSecret),
      refresh_token: String(config.refreshToken),
      grant_type: "refresh_token",
    });
    const response = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      body: params,
    });
    if (!response.ok) {
      return { config, path: resolved };
    }
    const data = await response.json();
    config.accessToken = data.access_token;
    config.refreshToken = data.refresh_token;
    config.expiresAt = data.expires_at;
    fs.writeFileSync(resolved, JSON.stringify(config, null, 2));
    return { config, path: resolved };
  } catch (error) {
    return { config, path: resolved };
  }
}

function shouldFetchActivityZones(mode, summit) {
  if (mode === "true") return true;
  if (mode === "false") return false;
  return Boolean(summit);
}

function shouldFetchSegmentEfforts(mode, summit) {
  if (mode === "true") return true;
  if (mode === "false") return false;
  return Boolean(summit);
}

function parseRateLimit(headers) {
  const limitHeader = headers.get("x-ratelimit-limit");
  const usageHeader = headers.get("x-ratelimit-usage");
  if (!limitHeader || !usageHeader) return null;
  const limits = limitHeader.split(",").map((v) => Number(v));
  const usage = usageHeader.split(",").map((v) => Number(v));
  if (!limits.length || !usage.length) return null;
  return { limits, usage };
}

async function fetchActivityZones(primaryActs, accessToken, limit = 60) {
  const sorted = [...primaryActs]
    .filter((act) => normalizeSport(act.sport_type || act.type))
    .sort((a, b) => {
      const da = activityDate(a);
      const db = activityDate(b);
      if (!da || !db) return 0;
      return db.getTime() - da.getTime();
    })
    .slice(0, limit);

  let fetched = 0;
  for (const act of sorted) {
    if (!act || !act.id) continue;
    try {
      const response = await fetch(`https://www.strava.com/api/v3/activities/${act.id}/zones`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.status === 429) break;
      if (response.status === 403 || response.status === 402) continue;
      if (!response.ok) continue;
      const data = await response.json();
      if (Array.isArray(data) && data.length) {
        act.zones = data;
        fetched += 1;
      }
      const rate = parseRateLimit(response.headers);
      if (rate && rate.limits[0] && rate.usage[0] / rate.limits[0] > 0.9) {
        break;
      }
    } catch (error) {
      continue;
    }
  }
  return fetched;
}

async function fetchSegmentEfforts(primaryActs, accessToken, limit = 8) {
  const candidates = [...primaryActs]
    .filter((act) => ["run", "bike"].includes(normalizeSport(act.sport_type || act.type)))
    .sort((a, b) => {
      const da = activityDurationSec(a) || 0;
      const db = activityDurationSec(b) || 0;
      return db - da;
    })
    .slice(0, limit);

  let fetchedActivities = 0;
  let effortCount = 0;
  let bikeBestWatts = null;
  let runBestSpeed = null;

  for (const act of candidates) {
    if (!act || !act.id) continue;
    try {
      const response = await fetch(`https://www.strava.com/api/v3/activities/${act.id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.status === 429) break;
      if (!response.ok) continue;
      const detail = await response.json();
      if (Array.isArray(detail.segment_efforts) && detail.segment_efforts.length) {
        act.segment_efforts = detail.segment_efforts;
        fetchedActivities += 1;
        for (const effort of detail.segment_efforts) {
          if (!effort || effort.elapsed_time == null || effort.elapsed_time < 600) continue;
          effortCount += 1;
          const discipline = normalizeSport(act.sport_type || act.type);
          if (discipline === "bike" && effort.average_watts) {
            bikeBestWatts = Math.max(bikeBestWatts || 0, effort.average_watts);
          }
          if (discipline === "run" && effort.average_speed) {
            runBestSpeed = Math.max(runBestSpeed || 0, effort.average_speed);
          }
        }
      }
      const rate = parseRateLimit(response.headers);
      if (rate && rate.limits[0] && rate.usage[0] / rate.limits[0] > 0.9) {
        break;
      }
    } catch (error) {
      continue;
    }
  }

  return {
    fetched_count: fetchedActivities,
    effort_count: effortCount,
    bike_best_avg_watts: bikeBestWatts,
    run_best_avg_speed: runBestSpeed,
  };
}

function intensityRatio(activity, discipline, baseline, athleteMeta) {
  if (!baseline) return 1;
  if (discipline === "run") {
    const obs = activityPaceSecPerKm(activity);
    const ref = baseline.pace ? baseline.pace.median_sec_per_km : 0;
    if (!obs || !ref) return 1;
    return clamp(ref / obs, 0.7, 1.3);
  }
  if (discipline === "swim") {
    const obs = activityPaceSecPer100m(activity);
    const ref = baseline.pace ? baseline.pace.median_sec_per_100m : 0;
    if (!obs || !ref) return 1;
    return clamp(ref / obs, 0.7, 1.3);
  }
  if (discipline === "bike") {
    const watts = activityAverageWatts(activity);
    const speed = activitySpeedKmh(activity);
    const wkg = watts && athleteMeta && athleteMeta.weight_kg ? watts / athleteMeta.weight_kg : null;
    const refWkg = baseline.intensity && baseline.intensity.power_wkg ? baseline.intensity.power_wkg.median_wkg : 0;
    const refW = baseline.intensity && baseline.intensity.power ? baseline.intensity.power.median_watts : 0;
    const refSpeed = baseline.intensity && baseline.intensity.speed ? baseline.intensity.speed.median_kmh : 0;
    if (wkg && refWkg) return clamp(wkg / refWkg, 0.7, 1.3);
    if (watts && refW) return clamp(watts / refW, 0.7, 1.3);
    if (speed && refSpeed) return clamp(speed / refSpeed, 0.7, 1.3);
    return 1;
  }
  return 1;
}

function computeComposite(primaryActs, primaryStart, endDate, baseline, athleteMeta) {
  const { weeks, weekMap } = weeklyBuckets(primaryActs, primaryStart, endDate);
  const totalHours = [];
  const totalSessions = [];
  const aerobicPoints = [];
  const aerobicPointsBySport = { run: [], bike: [], swim: [] };
  const runHours = [];
  const runKm = [];
  const runTimeShare = [];

  for (const wk of weeks) {
    const weekActs = (weekMap.get(wk.toISOString()) || []).filter(
      (a) => normalizeSport(a.sport_type || a.type)
    );
    const weekBySport = { run: [], bike: [], swim: [] };
    for (const act of weekActs) {
      const discipline = normalizeSport(act.sport_type || act.type);
      if (!discipline) continue;
      weekBySport[discipline].push(act);
    }

    let weekTotalHours = 0;
    let weekSessions = 0;
    let weekAerobic = 0;
    const weekAerobicBySport = { run: 0, bike: 0, swim: 0 };
    let weekRunHours = 0;
    let weekRunKm = 0;

    for (const discipline of ["run", "bike", "swim"]) {
      for (const act of weekBySport[discipline]) {
        const durSec = activityDurationSec(act);
        if (!durSec || durSec < 60) continue;
        weekSessions += 1;
        const durHours = durSec / 3600;
        weekTotalHours += durHours;

        if (discipline === "run") {
          const distM = activityDistanceM(act);
          if (distM) weekRunKm += distM / 1000;
          weekRunHours += durHours;
        }

        const ratio = intensityRatio(act, discipline, baseline.disciplines[discipline], athleteMeta);
        const points = durHours * Math.pow(ratio, 2);
        weekAerobic += points;
        weekAerobicBySport[discipline] += points;
      }
    }

    totalHours.push(weekTotalHours);
    totalSessions.push(weekSessions);
    aerobicPoints.push(weekAerobic);
    aerobicPointsBySport.run.push(weekAerobicBySport.run);
    aerobicPointsBySport.bike.push(weekAerobicBySport.bike);
    aerobicPointsBySport.swim.push(weekAerobicBySport.swim);
    runHours.push(weekRunHours);
    runKm.push(weekRunKm);
    runTimeShare.push(weekTotalHours ? weekRunHours / weekTotalHours : 0);
  }

  const composite = {
    weekly: {
      total_endurance_hours_median: Number(median(totalHours).toFixed(2)),
      total_endurance_hours_iqr: iqr(totalHours),
      total_endurance_hours_cv: Number(coefficientOfVariation(totalHours).toFixed(3)),
      total_sessions_median: Number(median(totalSessions).toFixed(2)),
      total_sessions_iqr: iqr(totalSessions),
      total_sessions_cv: Number(coefficientOfVariation(totalSessions).toFixed(3)),
      aerobic_points_median: Number(median(aerobicPoints).toFixed(2)),
      aerobic_points_iqr: iqr(aerobicPoints),
      aerobic_points_cv: Number(coefficientOfVariation(aerobicPoints).toFixed(3)),
    },
    by_sport: {
      weekly_aerobic_points_median: {
        run: Number(median(aerobicPointsBySport.run).toFixed(2)),
        bike: Number(median(aerobicPointsBySport.bike).toFixed(2)),
        swim: Number(median(aerobicPointsBySport.swim).toFixed(2)),
      },
    },
    impact: {
      weekly_run_km_median: Number(median(runKm).toFixed(2)),
      weekly_run_hours_median: Number(median(runHours).toFixed(2)),
      run_time_share_median: Number(median(runTimeShare).toFixed(3)),
    },
    flags: {},
  };

  const highCardioLowImpact =
    composite.weekly.total_endurance_hours_median >= 6 &&
    composite.impact.run_time_share_median <= 0.15 &&
    composite.impact.weekly_run_km_median <= 12;
  composite.flags.high_cardio_low_impact = Boolean(highCardioLowImpact);

  return composite;
}

function computeFtpQuality(athleteMeta, bikeMetrics) {
  if (!athleteMeta || !athleteMeta.ftp_w) return "unknown";
  const ftp = athleteMeta.ftp_w;
  if (ftp < 100 || ftp > 600) return "low";
  const power = bikeMetrics && bikeMetrics.power ? bikeMetrics.power.median_watts : 0;
  const powerSamples = bikeMetrics && bikeMetrics.power ? bikeMetrics.power.sample_count : 0;
  if (!powerSamples || !power) return "medium";
  const ratio = power / ftp;
  if (ratio > 0.9 || ratio < 0.3) return "low";
  if (ratio > 0.45 && ratio < 0.8) {
    const deviceFraction = bikeMetrics.coverage ? bikeMetrics.coverage.device_watts_fraction : 0;
    if (deviceFraction >= 0.5) return "high";
    return "medium";
  }
  return "medium";
}

function computeFtpBands(ftp, ftpQuality, weightKg) {
  if (!ftp) return null;
  let factor = 0.1;
  if (ftpQuality === "high") factor = 0.07;
  else if (ftpQuality === "low") factor = 0.15;
  const band = [
    Number((ftp * (1 - factor)).toFixed(1)),
    Number((ftp * (1 + factor)).toFixed(1)),
  ];
  const result = { ftp_w_band: band };
  if (weightKg) {
    result.ftp_wkg_band = [
      Number((band[0] / weightKg).toFixed(3)),
      Number((band[1] / weightKg).toFixed(3)),
    ];
  }
  return result;
}

function computeBikeFtpLoad(primaryActs, primaryStart, endDate, athleteMeta) {
  if (!athleteMeta || !athleteMeta.ftp_w) return null;
  const ftp = athleteMeta.ftp_w;
  const { weeks, weekMap } = weeklyBuckets(primaryActs, primaryStart, endDate);
  const ifSamples = [];
  const ifWeights = [];
  const weeklyLoadPoints = [];

  for (const wk of weeks) {
    const weekActs = (weekMap.get(wk.toISOString()) || []).filter(
      (a) => normalizeSport(a.sport_type || a.type) === "bike"
    );
    let weekLoad = 0;
    for (const act of weekActs) {
      const watts = activityAverageWatts(act);
      const durSec = activityDurationSec(act);
      if (!watts || !durSec || ftp <= 0) continue;
      const ifVal = watts / ftp;
      ifSamples.push(ifVal);
      ifWeights.push(durSec);
      const durHours = durSec / 3600;
      weekLoad += durHours * Math.pow(ifVal, 2);
    }
    weeklyLoadPoints.push(weekLoad);
  }

  const ifWeightedSum = ifSamples.reduce((sum, v, i) => sum + v * (ifWeights[i] || 0), 0);
  const ifWeightTotal = ifWeights.reduce((sum, v) => sum + v, 0);

  return {
    intensity_if: {
      duration_weighted_if: Number((ifWeightTotal ? ifWeightedSum / ifWeightTotal : 0).toFixed(3)),
      median_if: Number(median(ifSamples).toFixed(3)),
      sample_count: ifSamples.length,
    },
    load_points: {
      weekly_median: Number(median(weeklyLoadPoints).toFixed(2)),
      weekly_iqr: iqr(weeklyLoadPoints),
      weekly_cv: Number(coefficientOfVariation(weeklyLoadPoints).toFixed(3)),
      weeks_tracked: weeklyLoadPoints.length,
      method: "ftp_if",
    },
  };
}

function extractZoneMinutes(activity, zoneType) {
  if (!activity || !Array.isArray(activity.zones)) return null;
  const zone = activity.zones.find((entry) => entry && entry.type === zoneType);
  if (!zone || !Array.isArray(zone.distribution_buckets)) return null;
  const minutes = zone.distribution_buckets.map((bucket) => Number((bucket.time || 0) / 60));
  if (!minutes.length) return null;
  return minutes;
}

function computeZonesForDiscipline(primaryActs, primaryStart, endDate, discipline, zoneType) {
  const { weeks, weekMap } = weeklyBuckets(primaryActs, primaryStart, endDate);
  const weeklyMinutesByZone = [];
  const weeklyHighShare = [];
  let activityCount = 0;

  for (const wk of weeks) {
    const weekActs = (weekMap.get(wk.toISOString()) || []).filter(
      (a) => normalizeSport(a.sport_type || a.type) === discipline
    );
    const minutesByZone = [];
    let totalMinutes = 0;
    let highMinutes = 0;
    for (const act of weekActs) {
      const minutes = extractZoneMinutes(act, zoneType);
      if (!minutes) continue;
      activityCount += 1;
      minutes.forEach((val, idx) => {
        minutesByZone[idx] = (minutesByZone[idx] || 0) + val;
      });
      const zoneTotal = minutes.reduce((sum, v) => sum + v, 0);
      totalMinutes += zoneTotal;
      const high = minutes
        .map((val, idx) => (idx >= 3 ? val : 0))
        .reduce((sum, v) => sum + v, 0);
      highMinutes += high;
    }
    weeklyMinutesByZone.push(minutesByZone);
    weeklyHighShare.push(totalMinutes ? highMinutes / totalMinutes : 0);
  }

  const maxZones = weeklyMinutesByZone.reduce((max, arr) => Math.max(max, arr.length), 0);
  if (!maxZones) return { zones: null, activity_count: 0 };
  const weeklyMedian = [];
  for (let i = 0; i < maxZones; i += 1) {
    const values = weeklyMinutesByZone.map((arr) => arr[i] || 0);
    weeklyMedian.push(Number(median(values).toFixed(2)));
  }

  return {
    zones: {
      type: zoneType,
      weekly_minutes_median_by_zone: weeklyMedian,
      high_intensity_share_median: Number(median(weeklyHighShare).toFixed(3)),
      weeks_tracked: weeklyMinutesByZone.length,
    },
    activity_count: activityCount,
  };
}

function computeRestartCaps(baseline, gapDaysAny) {
  const factors = {
    run: [1.0, 0.6, 0.4, 0.25, 0.15],
    bike: [1.0, 0.7, 0.5, 0.35, 0.2],
    swim: [1.0, 0.8, 0.6, 0.4, 0.25],
  };
  let level = 0;
  if (gapDaysAny == null) level = 4;
  else if (gapDaysAny <= 14) level = 0;
  else if (gapDaysAny <= 28) level = 1;
  else if (gapDaysAny <= 56) level = 2;
  else if (gapDaysAny <= 112) level = 3;
  else level = 4;

  const restart = {
    gap_days_any: gapDaysAny,
    reentry_level: level,
    week1: {},
    week2: {},
  };

  for (const discipline of ["run", "bike", "swim"]) {
    const metrics = baseline.disciplines[discipline];
    const factor = factors[discipline][level];
    const confidence = metrics.confidence;
    const confFactor = confidence === "low" ? 0.85 : 1.0;
    const weekly = metrics.weekly.volume_median || 0;
    const long = metrics.long_session.weekly_max_median || 0;
    const week1Volume = weekly * factor * confFactor;
    const week1Long = long * factor * confFactor;
    const week2Volume = Math.min(weekly, week1Volume * 1.2);
    const week2Long = Math.min(long, week1Long * 1.15);
    restart.week1[discipline] = {
      volume_cap: Number(week1Volume.toFixed(2)),
      long_cap: Number(week1Long.toFixed(2)),
    };
    restart.week2[discipline] = {
      volume_cap: Number(week2Volume.toFixed(2)),
      long_cap: Number(week2Long.toFixed(2)),
    };
  }
  return restart;
}

function computeTransfer(baseline, composite) {
  const transfer = {
    run_easy_pace_sec_per_km_range: null,
    run_easy_pace_reason: null,
    run_intro_weekly_time_min_range: null,
    transfer_confidence: null,
  };
  const runPace = baseline.disciplines.run.pace || {};
  const sampleCount = runPace.sample_count || 0;
  const medianPace = runPace.median_sec_per_km || 0;
  const runConfidence = baseline.disciplines.run.confidence;
  if (sampleCount >= 10 && medianPace) {
    transfer.run_easy_pace_sec_per_km_range = [
      Number((medianPace * 1.05).toFixed(1)),
      Number((medianPace * 1.25).toFixed(1)),
    ];
  } else if (sampleCount >= 3 && medianPace) {
    transfer.run_easy_pace_sec_per_km_range = [
      Number((medianPace * 1.1).toFixed(1)),
      Number((medianPace * 1.35).toFixed(1)),
    ];
    transfer.run_easy_pace_reason = "limited_samples";
  } else if (runConfidence === "low" && medianPace) {
    transfer.run_easy_pace_sec_per_km_range = [
      Number((medianPace * 1.1).toFixed(1)),
      Number((medianPace * 1.35).toFixed(1)),
    ];
    transfer.run_easy_pace_reason = "low_confidence";
  } else {
    transfer.run_easy_pace_reason = "insufficient_run_pace_samples";
  }

  if (composite.flags.high_cardio_low_impact) {
    const hours = composite.weekly.total_endurance_hours_median || 0;
    let range = [30, 60];
    if (hours >= 10) range = [60, 100];
    else if (hours >= 6) range = [45, 90];
    transfer.run_intro_weekly_time_min_range = range;
    transfer.transfer_confidence = "low";
  }
  return transfer;
}

async function main() {
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

  const athleteMeta = loadAthleteMeta(options);
  const shouldFetchZones = shouldFetchActivityZones(options.fetchActivityZones, athleteMeta.summit);
  const shouldFetchSegments = shouldFetchSegmentEfforts(options.fetchSegmentEfforts, athleteMeta.summit);
  let fetchedZonesCount = 0;
  let segmentEffortStats = null;
  if (shouldFetchZones || shouldFetchSegments) {
    const config = await loadStravaConfig(options.stravaConfig);
    if (config && config.config && config.config.accessToken) {
      if (shouldFetchZones) {
        fetchedZonesCount = await fetchActivityZones(primaryActs, config.config.accessToken, options.activityZonesLimit);
      }
      if (shouldFetchSegments) {
        segmentEffortStats = await fetchSegmentEfforts(
          primaryActs,
          config.config.accessToken,
          options.segmentEffortsLimit
        );
      }
    }
  }

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
    athlete_meta: athleteMeta,
    premium_features: {
      summit: athleteMeta.summit,
      activity_zones: {
        attempted: shouldFetchZones,
        available: fetchedZonesCount > 0,
        fetched_count: fetchedZonesCount,
      },
      segment_efforts: {
        attempted: shouldFetchSegments,
        fetched_count: segmentEffortStats ? segmentEffortStats.fetched_count : 0,
        effort_count: segmentEffortStats ? segmentEffortStats.effort_count : 0,
      },
    },
    disciplines: {},
    context: {},
  };

  const metricsByDiscipline = {};
  for (const discipline of ["run", "bike", "swim"]) {
    const recentMetrics = disciplineMetrics(primaryActs, primaryStart, endDate, discipline, athleteMeta);
    const historySource = historicalActs.length ? historicalActs : activities;
    const historyStart = historicalStart || allStart;
    const historyEnd = historicalEnd || endDate;
    const historicalMetrics = disciplineMetrics(historySource, historyStart, historyEnd, discipline, athleteMeta);
    const gapDays = daysSinceLastActivity(activities, discipline, endDate);
    baseline.disciplines[discipline] = blendMetrics(recentMetrics, historicalMetrics, gapDays);
    baseline.disciplines[discipline].gap_days_discipline = gapDays;
    baseline.disciplines[discipline].coverage = recentMetrics.coverage;
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
  if (baseline.disciplines.bike.intensity && baseline.disciplines.bike.intensity.power_wkg) {
    baseline.disciplines.bike.power_wkg = baseline.disciplines.bike.intensity.power_wkg;
  }

  athleteMeta.ftp_quality = computeFtpQuality(athleteMeta, baseline.disciplines.bike);
  if (segmentEffortStats && athleteMeta.ftp_w && segmentEffortStats.bike_best_avg_watts) {
    const ratio = segmentEffortStats.bike_best_avg_watts / athleteMeta.ftp_w;
    if (ratio > 1.2) athleteMeta.ftp_quality = "low";
  }
  baseline.athlete_meta = athleteMeta;
  if (athleteMeta.ftp_w) {
    const bands = computeFtpBands(athleteMeta.ftp_w, athleteMeta.ftp_quality, athleteMeta.weight_kg);
    if (bands) {
      baseline.disciplines.bike.threshold = {
        ftp_w_band: bands.ftp_w_band,
        ftp_wkg_band: bands.ftp_wkg_band || null,
        quality: athleteMeta.ftp_quality,
      };
    }
    const ftpMetrics = computeBikeFtpLoad(primaryActs, primaryStart, endDate, athleteMeta);
    if (ftpMetrics) {
      baseline.disciplines.bike.intensity = baseline.disciplines.bike.intensity || {};
      baseline.disciplines.bike.intensity.if = ftpMetrics.intensity_if;
      baseline.disciplines.bike.load_points = ftpMetrics.load_points;
    }
  }

  if (athleteMeta.summit) {
    const activitiesWithZones = primaryActs.filter((act) => Array.isArray(act.zones) && act.zones.length).length;
    for (const discipline of ["run", "bike", "swim"]) {
      const hrZones = computeZonesForDiscipline(primaryActs, primaryStart, endDate, discipline, "heartrate");
      const powerZones = computeZonesForDiscipline(primaryActs, primaryStart, endDate, discipline, "power");
      if (hrZones.zones || powerZones.zones) {
        baseline.disciplines[discipline].zones = {
          source: "activity_zones",
          heartrate: hrZones.zones,
          power: powerZones.zones,
        };
      }
    }
    baseline.premium_features.activity_zones.fetched_count = Math.max(
      baseline.premium_features.activity_zones.fetched_count || 0,
      activitiesWithZones
    );
    baseline.premium_features.activity_zones.available = baseline.premium_features.activity_zones.fetched_count > 0;
  }
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

  baseline.composite = computeComposite(primaryActs, primaryStart, endDate, baseline, athleteMeta);
  const gapDaysAny = daysSinceLastAny(activities, endDate);
  baseline.restart = computeRestartCaps(baseline, gapDaysAny);
  baseline.transfer = computeTransfer(baseline, baseline.composite);

  dumpJson(options.outputJson, baseline);

  const mdLines = [
    "# Baseline Summary",
    "",
    `Window: ${baseline.windows.primary_start} to ${baseline.windows.primary_end}`,
    "",
  ];
  mdLines.push("## Athlete");
  mdLines.push(`- Sex: ${baseline.athlete_meta.sex || "unknown"}`);
  mdLines.push(
    `- Weight: ${baseline.athlete_meta.has_weight ? baseline.athlete_meta.weight_kg + " kg" : "unknown"}`
  );
  mdLines.push(`- FTP: ${baseline.athlete_meta.ftp_w || "unknown"}`);
  mdLines.push(`- FTP quality: ${baseline.athlete_meta.ftp_quality || "unknown"}`);
  mdLines.push(`- Summit: ${baseline.athlete_meta.summit ? "yes" : "no"}`);
  mdLines.push("");
  for (const [discipline, metrics] of Object.entries(baseline.disciplines)) {
    mdLines.push(`## ${discipline.charAt(0).toUpperCase() + discipline.slice(1)}`);
    mdLines.push(`- Confidence: ${metrics.confidence}`);
    mdLines.push(`- Weekly volume median: ${metrics.weekly.volume_median} ${metrics.units.volume}`);
    if (discipline === "bike") {
      mdLines.push(`- Weekly distance median: ${metrics.weekly.distance_km_median || 0} km`);
    }
    mdLines.push(`- Weekly sessions median: ${metrics.weekly.sessions_median}`);
    mdLines.push(`- Long session median: ${metrics.long_session.weekly_max_median} ${metrics.units.long_session}`);
    mdLines.push(`- Gap days: ${metrics.gap_days_discipline == null ? "unknown" : metrics.gap_days_discipline}`);
    if (metrics.coverage) {
      mdLines.push(`- Coverage (pace/speed): ${metrics.coverage.pace_or_speed_coverage_fraction || 0}`);
      mdLines.push(`- Coverage (HR): ${metrics.coverage.hr_fraction || 0}`);
      if (discipline === "bike") {
        mdLines.push(`- Coverage (power): ${metrics.coverage.power_fraction || 0}`);
        mdLines.push(`- Coverage (device watts): ${metrics.coverage.device_watts_fraction || 0}`);
      }
    }
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
      const intensityIf = metrics.intensity ? metrics.intensity.if || {} : {};
      const threshold = metrics.threshold || {};
      const loadPoints = metrics.load_points || {};
      mdLines.push(`- Speed (weighted): ${speed.distance_weighted_kmh || 0} km/h`);
      mdLines.push(`- Speed (median): ${speed.median_kmh || 0} km/h`);
      mdLines.push(`- Speed samples: ${speed.sample_count || 0}`);
      mdLines.push(`- Weekly elevation median: ${metrics.weekly.elevation_gain_median || 0} m`);
      mdLines.push(`- Session elevation median: ${metrics.session.elevation_gain_median_m || 0} m`);
      mdLines.push(`- Power (weighted): ${power.duration_weighted_watts || 0} W`);
      mdLines.push(`- Power (median): ${power.median_watts || 0} W`);
      mdLines.push(`- Power samples: ${power.sample_count || 0}`);
      if (metrics.power_wkg) {
        mdLines.push(`- Power (W/kg, weighted): ${metrics.power_wkg.duration_weighted_wkg || 0}`);
        mdLines.push(`- Power (W/kg, median): ${metrics.power_wkg.median_wkg || 0}`);
        mdLines.push(`- Power (W/kg) samples: ${metrics.power_wkg.sample_count || 0}`);
      }
      if (threshold.ftp_w_band) {
        mdLines.push(`- FTP band: ${threshold.ftp_w_band[0]}–${threshold.ftp_w_band[1]} W`);
      }
      if (threshold.ftp_wkg_band) {
        mdLines.push(`- FTP band (W/kg): ${threshold.ftp_wkg_band[0]}–${threshold.ftp_wkg_band[1]}`);
      }
      if (intensityIf.sample_count) {
        mdLines.push(`- IF (weighted): ${intensityIf.duration_weighted_if || 0}`);
        mdLines.push(`- IF (median): ${intensityIf.median_if || 0}`);
        mdLines.push(`- IF samples: ${intensityIf.sample_count || 0}`);
      }
      if (loadPoints.weekly_median != null) {
        mdLines.push(`- Load points weekly median: ${loadPoints.weekly_median}`);
      }
      mdLines.push("");
    }
  }

  mdLines.push("## Composite");
  mdLines.push(`- Total endurance hours (median): ${baseline.composite.weekly.total_endurance_hours_median}`);
  mdLines.push(`- Total sessions (median): ${baseline.composite.weekly.total_sessions_median}`);
  mdLines.push(`- Aerobic points (median): ${baseline.composite.weekly.aerobic_points_median}`);
  mdLines.push(`- Run time share (median): ${baseline.composite.impact.run_time_share_median}`);
  mdLines.push(
    `- Flag high_cardio_low_impact: ${baseline.composite.flags.high_cardio_low_impact ? "yes" : "no"}`
  );
  mdLines.push("");

  mdLines.push("## Premium Features");
  mdLines.push(`- Summit: ${baseline.premium_features.summit ? "yes" : "no"}`);
  mdLines.push(
    `- Activity zones attempted: ${baseline.premium_features.activity_zones.attempted ? "yes" : "no"}`
  );
  mdLines.push(
    `- Activity zones available: ${baseline.premium_features.activity_zones.available ? "yes" : "no"}`
  );
  mdLines.push(`- Activity zones fetched: ${baseline.premium_features.activity_zones.fetched_count || 0}`);
  mdLines.push(
    `- Segment efforts attempted: ${baseline.premium_features.segment_efforts.attempted ? "yes" : "no"}`
  );
  mdLines.push(`- Segment efforts fetched: ${baseline.premium_features.segment_efforts.fetched_count || 0}`);
  mdLines.push(`- Segment efforts count: ${baseline.premium_features.segment_efforts.effort_count || 0}`);
  mdLines.push("");

  if (baseline.restart) {
    mdLines.push("## Restart Caps");
    mdLines.push(`- Gap days any: ${baseline.restart.gap_days_any == null ? "unknown" : baseline.restart.gap_days_any}`);
    mdLines.push(`- Reentry level: ${baseline.restart.reentry_level}`);
    for (const discipline of ["run", "bike", "swim"]) {
      const w1 = baseline.restart.week1[discipline];
      const w2 = baseline.restart.week2[discipline];
      mdLines.push(
        `- ${discipline} week1 cap: ${w1.volume_cap} (${baseline.disciplines[discipline].units.volume}), long ${w1.long_cap}`
      );
      mdLines.push(
        `- ${discipline} week2 cap: ${w2.volume_cap} (${baseline.disciplines[discipline].units.volume}), long ${w2.long_cap}`
      );
    }
    mdLines.push("");
  }

  if (baseline.transfer) {
    mdLines.push("## Transfer");
    if (baseline.transfer.run_easy_pace_sec_per_km_range) {
      const range = baseline.transfer.run_easy_pace_sec_per_km_range;
      mdLines.push(`- Run easy pace range: ${range[0]}–${range[1]} sec/km`);
    } else {
      mdLines.push(`- Run easy pace range: unavailable (${baseline.transfer.run_easy_pace_reason || "n/a"})`);
    }
    if (baseline.transfer.run_intro_weekly_time_min_range) {
      const range = baseline.transfer.run_intro_weekly_time_min_range;
      mdLines.push(`- Run intro weekly time: ${range[0]}–${range[1]} min`);
    }
    mdLines.push("");
  }

  saveText(options.outputMd, mdLines.join("\n").trim() + "\n");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
