#!/usr/bin/env bun

/*
Build data/coach/training_load.json deterministically from Strava activities + snapshot + profile.

Computes:
  1. Auto-derived training thresholds (FTP, run threshold pace, swim CSS)
  2. Per-activity Training Stress Score (TSS)
  3. CTL (Chronic Training Load, 42-day EMA), ATL (Acute, 7-day EMA), TSB (balance)
  4. Ramp rate, acute:chronic ratio, injury risk classification
  5. Zone update signals (adaptation detection)
*/

const fs = require("fs");
const path = require("path");
const { parseDate, toIsoDate, dumpJson } = require("../../_shared/lib");
const { PATHS } = require("../../_shared/paths");

// --- Constants ---
const CTL_TIME_CONSTANT = 42;
const ATL_TIME_CONSTANT = 7;
const STRENGTH_TSS_PER_MIN = { recovery: 0.6, easy: 0.8, moderate: 1.0, hard: 1.3, very_hard: 1.5 };
const DEFAULT_STRENGTH_TSS_PER_MIN = 1.0;
const RUN_THRESHOLD_ADJUSTMENT = 1.05; // 5% harder than best 20min avg pace
const HISTORY_DAYS = 120; // compute CTL/ATL over this window

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    activities: PATHS.external.stravaActivities,
    snapshot: PATHS.coach.snapshot,
    profile: PATHS.coach.profile,
    out: PATHS.coach.trainingLoad,
    asOfDate: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--activities") options.activities = String(argv[i + 1] || options.activities);
    if (arg === "--snapshot") options.snapshot = String(argv[i + 1] || options.snapshot);
    if (arg === "--profile") options.profile = String(argv[i + 1] || options.profile);
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

function activityDurationSec(activity) {
  for (const key of ["moving_time_sec", "elapsed_time_sec", "duration_sec", "moving_time", "elapsed_time"]) {
    if (key in (activity || {}) && activity[key] != null) return Number(activity[key]) || 0;
  }
  return 0;
}

function activityDistanceM(activity) {
  if (activity?.distance_m != null) return Number(activity.distance_m) || 0;
  if (activity?.distance != null) return Number(activity.distance) || 0;
  return 0;
}

// ========== Threshold Derivation ==========

function deriveBikeFtp(snapshot, profile) {
  // Priority: athlete-confirmed override > Strava profile FTP
  const override = profile?.thresholds?.bike_ftp_watts;
  if (override && Number.isFinite(Number(override)) && Number(override) > 0) {
    return { value: Number(override), source: "athlete_confirmed" };
  }
  const stravaFtp = snapshot?.athlete?.ftp;
  if (stravaFtp && Number.isFinite(Number(stravaFtp)) && Number(stravaFtp) > 0) {
    return { value: Number(stravaFtp), source: "strava_athlete_profile" };
  }
  return { value: null, source: "unavailable" };
}

function deriveRunThreshold(activities, profile, asOfDate) {
  const override = profile?.thresholds?.run_threshold_pace_sec_per_km;
  if (override && Number.isFinite(Number(override)) && Number(override) > 0) {
    return { value: Number(override), source: "athlete_confirmed" };
  }

  const end = parseDate(asOfDate);
  if (!end) return { value: null, source: "unavailable" };
  const windowStart = new Date(end.getTime() - 56 * 24 * 3600 * 1000);

  // Find best pace from runs 15-60 min duration (proxy for threshold-ish efforts)
  const candidates = activities
    .filter((a) => {
      const sport = normalizeSport(a?.sport_type || a?.type);
      if (sport !== "run") return false;
      const dt = parseDate(activityDateIso(a));
      if (!dt || dt < windowStart || dt > end) return false;
      const dur = activityDurationSec(a);
      if (dur < 900 || dur > 3600) return false; // 15-60 min
      const dist = activityDistanceM(a);
      if (dist <= 0) return false;
      return true;
    })
    .map((a) => {
      const dur = activityDurationSec(a);
      const dist = activityDistanceM(a);
      const paceSecPerKm = (dur / dist) * 1000;
      return { paceSecPerKm, durationSec: dur, id: a.id };
    })
    .sort((a, b) => a.paceSecPerKm - b.paceSecPerKm); // fastest first

  if (!candidates.length) return { value: null, source: "unavailable" };

  // Best pace with 5% adjustment (threshold is slightly slower than best effort)
  const bestPace = candidates[0].paceSecPerKm;
  const threshold = Math.round(bestPace * RUN_THRESHOLD_ADJUSTMENT);
  return { value: threshold, source: "estimated_from_best_recent_effort" };
}

function deriveSwimCss(activities, profile, asOfDate) {
  const override = profile?.thresholds?.swim_css_sec_per_100m;
  if (override && Number.isFinite(Number(override)) && Number(override) > 0) {
    return { value: Number(override), source: "athlete_confirmed" };
  }

  const end = parseDate(asOfDate);
  if (!end) return { value: null, source: "unavailable" };
  const windowStart = new Date(end.getTime() - 56 * 24 * 3600 * 1000);

  // Use median pace of recent swims > 10 min
  const paces = activities
    .filter((a) => {
      const sport = normalizeSport(a?.sport_type || a?.type);
      if (sport !== "swim") return false;
      const dt = parseDate(activityDateIso(a));
      if (!dt || dt < windowStart || dt > end) return false;
      const dur = activityDurationSec(a);
      if (dur < 600) return false; // > 10 min
      const dist = activityDistanceM(a);
      if (dist <= 0) return false;
      return true;
    })
    .map((a) => {
      const dur = activityDurationSec(a);
      const dist = activityDistanceM(a);
      return (dur / dist) * 100; // sec per 100m
    })
    .sort((a, b) => a - b);

  if (!paces.length) return { value: null, source: "unavailable" };

  // Use the fastest quartile median as CSS estimate
  const fastQuartile = paces.slice(0, Math.max(1, Math.ceil(paces.length * 0.25)));
  const css = Math.round(fastQuartile.reduce((a, b) => a + b, 0) / fastQuartile.length);
  return { value: css, source: "estimated_from_recent_swims" };
}

// ========== TSS Computation ==========

function computeBikeTss(activity, ftp) {
  const durationSec = activityDurationSec(activity);
  if (durationSec <= 0 || !ftp) return null;

  const np = Number(activity.weighted_average_watts || activity.average_watts);
  if (!Number.isFinite(np) || np <= 0) {
    // No power: estimate from HR or duration-based fallback
    const avgHr = Number(activity.average_heartrate);
    if (Number.isFinite(avgHr) && avgHr > 0) {
      // Simple TRIMP-like estimate: duration * intensity factor from HR
      const hrFactor = Math.min(2.0, Math.max(0.5, (avgHr - 80) / 80));
      return Math.round((durationSec / 3600) * hrFactor * 50);
    }
    // Duration-only fallback (assume moderate effort)
    return Math.round((durationSec / 3600) * 50);
  }

  const intensityFactor = np / ftp;
  return Math.round((durationSec * np * intensityFactor) / (ftp * 3600) * 100);
}

function computeRunTss(activity, thresholdPaceSecPerKm) {
  const durationSec = activityDurationSec(activity);
  const distanceM = activityDistanceM(activity);
  if (durationSec <= 0 || distanceM <= 0) return null;

  const paceSecPerKm = (durationSec / distanceM) * 1000;

  if (!thresholdPaceSecPerKm) {
    // No threshold: estimate from duration alone (assume moderate)
    return Math.round((durationSec / 3600) * 60);
  }

  // rTSS = duration_hours * IF^2 * 100 where IF = threshold_pace / actual_pace
  const intensityFactor = thresholdPaceSecPerKm / paceSecPerKm;
  const durationHours = durationSec / 3600;
  return Math.round(durationHours * intensityFactor * intensityFactor * 100);
}

function computeSwimTss(activity, cssPer100m) {
  const durationSec = activityDurationSec(activity);
  const distanceM = activityDistanceM(activity);
  if (durationSec <= 0 || distanceM <= 0) return null;

  const pacePer100m = (durationSec / distanceM) * 100;

  if (!cssPer100m) {
    return Math.round((durationSec / 3600) * 55);
  }

  const intensityFactor = cssPer100m / pacePer100m;
  const durationHours = durationSec / 3600;
  return Math.round(durationHours * intensityFactor * intensityFactor * 100);
}

function computeStrengthTss(activity) {
  const durationSec = activityDurationSec(activity);
  if (durationSec <= 0) return null;
  const durationMin = durationSec / 60;
  // Use default moderate rate
  return Math.round(durationMin * DEFAULT_STRENGTH_TSS_PER_MIN);
}

function computeActivityTss(activity, thresholds) {
  const discipline = normalizeSport(activity?.sport_type || activity?.type);
  if (!discipline) return { tss: null, discipline: null };

  let tss = null;
  switch (discipline) {
    case "bike":
      tss = computeBikeTss(activity, thresholds.bike_ftp_watts);
      break;
    case "run":
      tss = computeRunTss(activity, thresholds.run_threshold_pace_sec_per_km);
      break;
    case "swim":
      tss = computeSwimTss(activity, thresholds.swim_css_sec_per_100m);
      break;
    case "strength":
      tss = computeStrengthTss(activity);
      break;
  }

  return { tss, discipline };
}

// ========== CTL/ATL/TSB ==========

function computeLoadModel(dailyTssMap, asOfDateIso, historyDays) {
  const endDate = parseDate(asOfDateIso);
  if (!endDate) return { ctl: 0, atl: 0, tsb: 0, ctlHistory: [], rampRate: 0 };

  const startDate = new Date(endDate.getTime() - historyDays * 24 * 3600 * 1000);

  let ctl = 0;
  let atl = 0;
  const ctlHistory = [];

  const cursor = new Date(startDate.getTime());
  while (cursor <= endDate) {
    const dateIso = toIsoDate(cursor);
    const dayTss = dailyTssMap.get(dateIso) || 0;

    ctl = ctl + (dayTss - ctl) / CTL_TIME_CONSTANT;
    atl = atl + (dayTss - atl) / ATL_TIME_CONSTANT;

    ctlHistory.push({
      date: dateIso,
      ctl: Math.round(ctl * 10) / 10,
      atl: Math.round(atl * 10) / 10,
      tsb: Math.round((ctl - atl) * 10) / 10,
    });

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // Ramp rate: CTL change over last 7 days
  const recentHistory = ctlHistory.slice(-8);
  const rampRate = recentHistory.length >= 2
    ? Math.round((recentHistory[recentHistory.length - 1].ctl - recentHistory[0].ctl) * 10) / 10
    : 0;

  return {
    ctl: Math.round(ctl * 10) / 10,
    atl: Math.round(atl * 10) / 10,
    tsb: Math.round((ctl - atl) * 10) / 10,
    ctlHistory: ctlHistory.slice(-28), // Keep last 28 days for compactness
    rampRate,
  };
}

function classifyInjuryRisk(acuteChronicRatio) {
  if (!Number.isFinite(acuteChronicRatio)) return "unknown";
  if (acuteChronicRatio > 1.5) return "critical";
  if (acuteChronicRatio > 1.3) return "high";
  if (acuteChronicRatio > 1.2) return "moderate";
  return "low";
}

// ========== Zone Update Signals ==========

function detectZoneUpdateSignals(activities, thresholds, asOfDate) {
  const signals = [];
  const end = parseDate(asOfDate);
  if (!end) return signals;

  // Check run pace at threshold HR over 6-week window
  if (thresholds.run_threshold_pace_sec_per_km) {
    const sixWeeksAgo = new Date(end.getTime() - 42 * 24 * 3600 * 1000);
    const threeWeeksAgo = new Date(end.getTime() - 21 * 24 * 3600 * 1000);

    const getRunPaces = (start, endDt) =>
      activities
        .filter((a) => {
          const sport = normalizeSport(a?.sport_type || a?.type);
          if (sport !== "run") return false;
          const dt = parseDate(activityDateIso(a));
          if (!dt || dt < start || dt > endDt) return false;
          const dur = activityDurationSec(a);
          if (dur < 1200 || dur > 3600) return false;
          const dist = activityDistanceM(a);
          return dist > 0;
        })
        .map((a) => (activityDurationSec(a) / activityDistanceM(a)) * 1000);

    const earlyPaces = getRunPaces(sixWeeksAgo, threeWeeksAgo);
    const recentPaces = getRunPaces(threeWeeksAgo, end);

    if (earlyPaces.length >= 2 && recentPaces.length >= 2) {
      const earlyMedian = earlyPaces.sort((a, b) => a - b)[Math.floor(earlyPaces.length / 2)];
      const recentMedian = recentPaces.sort((a, b) => a - b)[Math.floor(recentPaces.length / 2)];
      const improvementPct = ((earlyMedian - recentMedian) / earlyMedian) * 100;

      if (improvementPct > 3) {
        signals.push({
          discipline: "run",
          metric: "pace_trend",
          improvement_pct: Math.round(improvementPct * 10) / 10,
          detail: `Run pace improved ~${Math.round(improvementPct)}% over 6 weeks. Consider updating run threshold.`,
        });
      }
    }
  }

  return signals;
}

// ========== Main ==========

function main() {
  const options = parseArgs();
  const activities = safeReadJson(options.activities, []);
  const snapshot = safeReadJson(options.snapshot, null);
  const profile = safeReadJson(options.profile, {});

  const asOf = options.asOfDate
    || (snapshot?.as_of_date ? String(snapshot.as_of_date) : null)
    || new Date().toISOString().slice(0, 10);

  // 1. Derive thresholds
  const bikeFtp = deriveBikeFtp(snapshot, profile);
  const runThreshold = deriveRunThreshold(Array.isArray(activities) ? activities : [], profile, asOf);
  const swimCss = deriveSwimCss(Array.isArray(activities) ? activities : [], profile, asOf);

  const thresholds = {
    bike_ftp_watts: bikeFtp.value,
    bike_ftp_source: bikeFtp.source,
    run_threshold_pace_sec_per_km: runThreshold.value,
    run_threshold_source: runThreshold.source,
    swim_css_sec_per_100m: swimCss.value,
    swim_css_source: swimCss.source,
  };

  // 2. Compute TSS per activity
  const dailyTssEntries = [];
  const dailyTssMap = new Map();

  const actList = Array.isArray(activities) ? activities : [];
  for (const activity of actList) {
    const dateIso = activityDateIso(activity);
    if (!dateIso) continue;

    const { tss, discipline } = computeActivityTss(activity, thresholds);
    if (tss == null || tss <= 0) continue;

    dailyTssEntries.push({
      date: dateIso,
      tss,
      discipline,
      activity_id: String(activity.id || ""),
    });

    // Accumulate daily TSS for CTL/ATL computation
    dailyTssMap.set(dateIso, (dailyTssMap.get(dateIso) || 0) + tss);
  }

  // Sort by date
  dailyTssEntries.sort((a, b) => a.date.localeCompare(b.date));

  // 3. Compute CTL/ATL/TSB
  const loadModel = computeLoadModel(dailyTssMap, asOf, HISTORY_DAYS);

  // 4. Derived metrics
  const acuteChronicRatio = loadModel.ctl > 0
    ? Math.round((loadModel.atl / loadModel.ctl) * 100) / 100
    : 0;
  const injuryRisk = classifyInjuryRisk(acuteChronicRatio);

  // 5. Zone update signals
  const zoneUpdateSignals = detectZoneUpdateSignals(actList, thresholds, asOf);

  // 6. Build output
  const trainingLoad = {
    as_of_date: asOf,
    thresholds,
    daily_tss: dailyTssEntries.slice(-56), // Keep last 56 days
    ctl: loadModel.ctl,
    atl: loadModel.atl,
    tsb: loadModel.tsb,
    ctl_history: loadModel.ctlHistory,
    ramp_rate: loadModel.rampRate,
    acute_chronic_ratio: acuteChronicRatio,
    injury_risk: injuryRisk,
    zone_update_signals: zoneUpdateSignals,
  };

  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  dumpJson(options.out, trainingLoad);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      out: options.out,
      as_of_date: asOf,
      thresholds: {
        bike_ftp: bikeFtp.value ? `${bikeFtp.value}W (${bikeFtp.source})` : "unavailable",
        run_threshold: runThreshold.value ? `${runThreshold.value}s/km (${runThreshold.source})` : "unavailable",
        swim_css: swimCss.value ? `${swimCss.value}s/100m (${swimCss.source})` : "unavailable",
      },
      ctl: loadModel.ctl,
      atl: loadModel.atl,
      tsb: loadModel.tsb,
      ramp_rate: loadModel.rampRate,
      acute_chronic_ratio: acuteChronicRatio,
      injury_risk: injuryRisk,
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
