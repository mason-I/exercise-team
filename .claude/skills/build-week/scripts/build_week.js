const fs = require("fs");
const path = require("path");
const {
  dumpJson,
  loadJson,
  parseDate,
  saveText,
  toIsoDate,
  weekStart,
} = require("../../_shared/lib");

const PHASE_FACTORS = {
  prep: 0.9,
  base: 1.0,
  build: 1.05,
  peak: 1.1,
  taper: 0.7,
  offseason: 0.6,
};

const LONG_FACTORS = {
  prep: 0.9,
  base: 1.0,
  build: 1.05,
  peak: 1.1,
  taper: 0.8,
  offseason: 0.8,
};

const DEFAULT_DAYS = {
  swim: [0, 3, 5], // Mon/Thu/Sat
  bike: [1, 3, 5], // Tue/Thu/Sat
  run: [2, 4, 1, 5], // Wed/Fri/Tue/Sat
};

const SESSION_TYPES = {
  prep: ["easy"],
  base: ["easy"],
  build: ["easy", "tempo"],
  peak: ["interval", "tempo"],
  taper: ["easy", "short"],
  offseason: ["easy"],
};

const BIKE_IF = {
  easy: [0.55, 0.7],
  tempo: [0.75, 0.85],
  interval: [0.95, 1.1],
  long: [0.65, 0.75],
  short: [0.5, 0.65],
};

const RUN_IF = {
  easy: [0.65, 0.8],
  tempo: [0.85, 0.95],
  interval: [1.0, 1.1],
  long: [0.7, 0.85],
  short: [0.6, 0.75],
};

const SWIM_IF = {
  technique: [0.6, 0.75],
  easy: [0.65, 0.8],
  tempo: [0.85, 0.95],
  interval: [1.0, 1.1],
  long: [0.7, 0.85],
  short: [0.6, 0.75],
};

function parseArgs() {
  const args = process.argv.slice(2);
  if (!args.length) {
    throw new Error("week_start is required (YYYY-MM-DD).");
  }
  const options = {
    weekStart: args[0],
    baseline: "baseline.json",
    calendar: "calendar.json",
    profile: "profile.json",
    goalAnalysis: "goal_analysis.json",
    outputDir: "plans",
    outputMd: false,
  };
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--baseline") options.baseline = args[i + 1];
    if (arg === "--calendar") options.calendar = args[i + 1];
    if (arg === "--profile") options.profile = args[i + 1];
    if (arg === "--goal-analysis") options.goalAnalysis = args[i + 1];
    if (arg === "--output-dir") options.outputDir = args[i + 1];
    if (arg === "--output-md") options.outputMd = true;
  }
  return options;
}

function findPhase(calendar, weekStartDate) {
  for (const phase of calendar.phases || []) {
    const start = parseDate(phase.start);
    const end = parseDate(phase.end);
    if (start && end && start <= weekStartDate && weekStartDate <= end) {
      return phase.name || "offseason";
    }
  }
  return "offseason";
}

function restDayIndex(value) {
  if (!value) return 6;
  const lowered = String(value).toLowerCase();
  const map = {
    monday: 0,
    tuesday: 1,
    wednesday: 2,
    thursday: 3,
    friday: 4,
    saturday: 5,
    sunday: 6,
  };
  return map[lowered] ?? 6;
}

function resolveDayOffset(offset, restIdx) {
  let day = offset % 7;
  for (let i = 0; i < 7; i += 1) {
    if (day !== restIdx) return day;
    day = (day + 1) % 7;
  }
  return offset % 7;
}

function isTriGoal(profile) {
  const distances = profile?.goal?.event?.distances;
  if (!distances) return false;
  return (
    Number(distances.swim_km || 0) > 0 &&
    Number(distances.bike_km || 0) > 0 &&
    Number(distances.run_km || 0) > 0
  );
}

function typicalRunPaceSecPerKm(baseline) {
  const pace = baseline?.disciplines?.run?.pace;
  if (pace && pace.median_sec_per_km) return pace.median_sec_per_km;
  const session = baseline?.disciplines?.run?.session;
  if (session && session.distance_median > 0) {
    return (session.duration_median_min * 60) / session.distance_median;
  }
  return 360;
}

function typicalSwimPaceSecPer100m(baseline) {
  const pace = baseline?.disciplines?.swim?.pace;
  if (pace && pace.median_sec_per_100m) return pace.median_sec_per_100m;
  const session = baseline?.disciplines?.swim?.session;
  if (session && session.distance_median > 0) {
    return (session.duration_median_min * 60) / (session.distance_median * 10);
  }
  return 180;
}

function loadGoalAnalysis(goalPath) {
  if (!goalPath) return null;
  if (!fs.existsSync(goalPath)) return null;
  return loadJson(goalPath);
}

function buildDisciplineTarget(discipline, baseline, phase, options) {
  const metrics = baseline.disciplines[discipline];
  const weekly = metrics.weekly;
  const session = metrics.session;
  const longSession = metrics.long_session;
  const confidence = metrics.confidence;

  let sessions = Math.max(1, Math.round(weekly.sessions_median) || 1);
  let factor = PHASE_FACTORS[phase] ?? 1.0;
  let longFactor = LONG_FACTORS[phase] ?? 1.0;
  if (confidence === "low") {
    factor *= 0.85;
    longFactor *= 0.9;
  } else if (confidence === "medium") {
    factor *= 0.95;
    longFactor *= 0.95;
  }

  if (discipline === "run" && options.runTimeBased) {
    const range = options.runIntroRange || [30, 60];
    const paceSecPerKm = options.runPaceSecPerKm;
    let weeklyMin = range[0];
    if (phase === "base") weeklyMin = Math.round((range[0] + range[1]) / 2);
    else if (phase === "build" || phase === "peak") weeklyMin = range[1];
    weeklyMin = Math.round(weeklyMin * factor);

    let longMin = Math.round(weeklyMin * 0.4);
    if (options.runLongCapMin) {
      longMin = Math.min(longMin, Math.round(options.runLongCapMin));
    }

    const weeklyKm = paceSecPerKm ? (weeklyMin * 60) / paceSecPerKm : weekly.volume_median * factor;
    const longKm = paceSecPerKm ? (longMin * 60) / paceSecPerKm : longSession.weekly_max_median * longFactor;

    return {
      sessions,
      weekly_volume: Number(weeklyKm.toFixed(2)),
      weekly_volume_min: weeklyMin,
      long_session: Number(longKm.toFixed(2)),
      long_session_min: longMin,
      typical_distance: Number(session.distance_median.toFixed(2)),
      typical_duration_min: Number(session.duration_median_min.toFixed(1)),
      units: metrics.units,
      time_based: true,
    };
  }

  if (discipline === "swim" && options.swimReentry) {
    if (phase === "base" || phase === "build" || phase === "peak") sessions = 3;
    else sessions = 2;
    const weeklyMin = phase === "base" || phase === "build" || phase === "peak" ? 90 : 40;
    const longMin = Math.round(weeklyMin * 0.4);
    const paceSecPer100m = options.swimPaceSecPer100m;
    const weeklyKm = paceSecPer100m ? (weeklyMin * 60) / (paceSecPer100m * 10) : 0;
    const longKm = paceSecPer100m ? (longMin * 60) / (paceSecPer100m * 10) : 0;
    return {
      sessions,
      weekly_volume: Number(weeklyKm.toFixed(2)),
      weekly_volume_min: weeklyMin,
      long_session: Number(longKm.toFixed(2)),
      long_session_min: longMin,
      typical_distance: Number(session.distance_median.toFixed(2)),
      typical_duration_min: Number(session.duration_median_min.toFixed(1)),
      units: metrics.units,
      time_based: true,
    };
  }

  const weeklyVolume = weekly.volume_median * factor;
  const longTarget = Math.min(longSession.weekly_max_median * longFactor, weeklyVolume ? weeklyVolume * 0.4 : 0);

  return {
    sessions,
    weekly_volume: Number(weeklyVolume.toFixed(2)),
    long_session: Number(longTarget.toFixed(2)),
    typical_distance: Number(session.distance_median.toFixed(2)),
    typical_duration_min: Number(session.duration_median_min.toFixed(1)),
    units: metrics.units,
    time_based: false,
  };
}

function runDistanceCapKm(baseline, sessions) {
  const restart = baseline.restart?.week1?.run?.volume_cap;
  if (restart && sessions) {
    return Number((restart / sessions).toFixed(1));
  }
  return null;
}

function paceRangeFromVthr(vthr, ifRange) {
  if (!vthr || !ifRange) return null;
  const [ifLow, ifHigh] = ifRange;
  const speedLow = vthr * ifLow;
  const speedHigh = vthr * ifHigh;
  const paceHigh = speedLow ? 1000 / speedLow : null;
  const paceLow = speedHigh ? 1000 / speedHigh : null;
  if (!paceLow || !paceHigh) return null;
  return [Number(paceLow.toFixed(1)), Number(paceHigh.toFixed(1))];
}

function paceRangeFromCss(css, ifRange) {
  if (!css || !ifRange) return null;
  const [ifLow, ifHigh] = ifRange;
  const paceLow = css / ifHigh;
  const paceHigh = css / ifLow;
  return [Number(paceLow.toFixed(1)), Number(paceHigh.toFixed(1))];
}

function sessionIntensity(discipline, type, baseline) {
  if (discipline === "bike") {
    const ifRange = BIKE_IF[type] || BIKE_IF.easy;
    const ftpBand = baseline?.disciplines?.bike?.threshold?.ftp_w_band;
    const intensity = {
      target_if_range: ifRange.map((v) => Number(v.toFixed(2))),
      zone_hint: type === "interval" ? "Z4" : type === "tempo" ? "Z3" : "Z2",
    };
    if (ftpBand && ftpBand.length === 2) {
      intensity.target_power_w_range = [
        Number((ftpBand[0] * ifRange[0]).toFixed(1)),
        Number((ftpBand[1] * ifRange[1]).toFixed(1)),
      ];
    }
    return intensity;
  }

  if (discipline === "run") {
    const vthr = baseline?.disciplines?.run?.threshold?.vthr_mps;
    const easyRange = baseline?.transfer?.run_easy_pace_sec_per_km_range;
    const ifRange = RUN_IF[type] || RUN_IF.easy;
    let paceRange = null;
    if (type === "easy" || type === "long") {
      paceRange = easyRange || paceRangeFromVthr(vthr, ifRange);
    } else {
      paceRange = paceRangeFromVthr(vthr, ifRange);
    }
    const intensity = { effort_hint: type };
    if (paceRange) intensity.pace_sec_per_km_range = paceRange;
    return intensity;
  }

  if (discipline === "swim") {
    const css = baseline?.disciplines?.swim?.threshold?.css_sec_per_100m;
    const ifRange = SWIM_IF[type] || SWIM_IF.easy;
    const paceRange = paceRangeFromCss(css, ifRange);
    const intensity = { effort_hint: type === "technique" ? "technique" : type };
    if (paceRange) intensity.pace_sec_per_100m_range = paceRange;
    return intensity;
  }
  return null;
}

function estimateSessionIf(discipline, type, baseline, intensity) {
  if (discipline === "bike") {
    const ifRange = (intensity && intensity.target_if_range) || BIKE_IF[type] || BIKE_IF.easy;
    return (ifRange[0] + ifRange[1]) / 2;
  }
  if (discipline === "run") {
    const vthr = baseline?.disciplines?.run?.threshold?.vthr_mps;
    if (intensity?.pace_sec_per_km_range && vthr) {
      const midPace = (intensity.pace_sec_per_km_range[0] + intensity.pace_sec_per_km_range[1]) / 2;
      const speed = midPace ? 1000 / midPace : null;
      if (speed && vthr) return Math.min(1.3, Math.max(0.5, speed / vthr));
    }
    const ifRange = RUN_IF[type] || RUN_IF.easy;
    return (ifRange[0] + ifRange[1]) / 2;
  }
  if (discipline === "swim") {
    const css = baseline?.disciplines?.swim?.threshold?.css_sec_per_100m;
    if (intensity?.pace_sec_per_100m_range && css) {
      const midPace =
        (intensity.pace_sec_per_100m_range[0] + intensity.pace_sec_per_100m_range[1]) / 2;
      return Math.min(1.3, Math.max(0.5, css / midPace));
    }
    const ifRange = SWIM_IF[type] || SWIM_IF.easy;
    return (ifRange[0] + ifRange[1]) / 2;
  }
  return 0.65;
}

function allocateSessions(discipline, target, phase, weekStartDate, restIdx, baseline, distanceCapKm) {
  const sessions = [];
  const days = DEFAULT_DAYS[discipline] || [];
  let sessionTypes = SESSION_TYPES[phase] || ["easy"];
  if (discipline === "run" && baseline.disciplines.run.confidence === "low") {
    sessionTypes = ["easy"];
  }
  if (discipline === "swim" && target.time_based) {
    sessionTypes = ["technique"];
  }

  const count = target.sessions;
  const longSession = target.long_session;
  const longSessionMin = target.long_session_min;
  const weeklyVolume = target.weekly_volume;
  const weeklyVolumeMin = target.weekly_volume_min;

  const remaining = Math.max((target.time_based ? weeklyVolumeMin : weeklyVolume) - (target.time_based ? longSessionMin : longSession), 0);
  const remainingSessions = Math.max(count - 1, 0);
  const perSession = remainingSessions ? remaining / remainingSessions : 0;

  for (let idx = 0; idx < count; idx += 1) {
    const dayOffset = resolveDayOffset(days.length ? days[idx % days.length] : idx, restIdx);
    const sessionDate = new Date(weekStartDate.getTime());
    sessionDate.setUTCDate(sessionDate.getUTCDate() + dayOffset);
    const sessionType = idx === count - 1 ? "long" : sessionTypes[Math.min(idx, sessionTypes.length - 1)];
    const volume = sessionType === "long" ? (target.time_based ? longSessionMin : longSession) : perSession;

    const entry = {
      date: toIsoDate(sessionDate),
      discipline,
      type: sessionType,
    };

    if (discipline === "bike") {
      entry.duration_min = Number((volume * 60).toFixed(1));
    } else if (target.time_based) {
      entry.duration_min = Number(volume.toFixed(1));
      const paceSec =
        discipline === "run" ? typicalRunPaceSecPerKm(baseline) : typicalSwimPaceSecPer100m(baseline);
      if (paceSec) {
        const distanceKm =
          discipline === "run"
            ? (entry.duration_min * 60) / paceSec
            : (entry.duration_min * 60) / (paceSec * 10);
        entry.distance_km = Number(distanceKm.toFixed(2));
      }
    } else {
      entry.distance_km = Number(volume.toFixed(2));
      const paceSec =
        discipline === "run" ? typicalRunPaceSecPerKm(baseline) : typicalSwimPaceSecPer100m(baseline);
      entry.duration_min = Number(((paceSec / 60) * volume).toFixed(1));
    }

    if (discipline === "run" && distanceCapKm) {
      entry.distance_km_cap = distanceCapKm;
    }

    entry.intensity = sessionIntensity(discipline, sessionType, baseline);
    sessions.push(entry);
  }
  return sessions;
}

function computeLoadPointsForPlan(plan, baseline) {
  const totals = { run: 0, bike: 0, swim: 0 };
  for (const session of plan.sessions) {
    const discipline = session.discipline;
    if (!totals[discipline]) continue;
    const durationMin = session.duration_min || 0;
    const hours = durationMin / 60;
    const ifVal = estimateSessionIf(discipline, session.type, baseline, session.intensity);
    totals[discipline] += hours * Math.pow(ifVal, 2);
  }
  return {
    run: Number(totals.run.toFixed(2)),
    bike: Number(totals.bike.toFixed(2)),
    swim: Number(totals.swim.toFixed(2)),
  };
}

function scaleDisciplineSessions(plan, discipline, factor) {
  for (const session of plan.sessions) {
    if (session.discipline !== discipline) continue;
    if (session.duration_min != null) session.duration_min = Number((session.duration_min * factor).toFixed(1));
    if (session.distance_km != null) session.distance_km = Number((session.distance_km * factor).toFixed(2));
    if (session.distance_km_cap != null) {
      session.distance_km_cap = Number((session.distance_km_cap * factor).toFixed(2));
    }
  }
}

function planPathForWeek(planDir, weekDate) {
  return path.join(planDir, `${toIsoDate(weekDate)}.json`);
}

function main() {
  const options = parseArgs();
  const weekStartDateRaw = parseDate(options.weekStart);
  if (!weekStartDateRaw) {
    throw new Error("Invalid week_start. Use YYYY-MM-DD.");
  }
  const weekStartDate = weekStart(weekStartDateRaw);

  const baseline = loadJson(options.baseline);
  const calendar = loadJson(options.calendar);
  const profile = loadJson(options.profile);
  const goalAnalysis = loadGoalAnalysis(options.goalAnalysis);

  const phase = findPhase(calendar, weekStartDate);
  const restIdx = restDayIndex(profile?.preferences?.rest_day);
  const triGoal = isTriGoal(profile);

  const runTimeBased = Boolean(baseline?.composite?.flags?.high_cardio_low_impact);
  const swimReentry =
    triGoal && Number(baseline?.disciplines?.swim?.weekly?.volume_median || 0) <= 0.01;
  const runIntroRange = baseline?.transfer?.run_intro_weekly_time_min_range || [30, 60];
  const runPace = typicalRunPaceSecPerKm(baseline);
  const swimPace = typicalSwimPaceSecPer100m(baseline);
  const runLongCapMin = baseline?.restart?.week1?.run?.long_cap
    ? (baseline.restart.week1.run.long_cap * runPace) / 60
    : null;

  const targets = {};
  const sessions = [];

  for (const discipline of ["swim", "bike", "run"]) {
    const target = buildDisciplineTarget(discipline, baseline, phase, {
      runTimeBased,
      swimReentry,
      runIntroRange,
      runPaceSecPerKm: runPace,
      swimPaceSecPer100m: swimPace,
      runLongCapMin,
    });
    targets[discipline] = target;

    const distanceCapKm = discipline === "run" && runTimeBased ? runDistanceCapKm(baseline, target.sessions) : null;
    sessions.push(...allocateSessions(discipline, target, phase, weekStartDate, restIdx, baseline, distanceCapKm));
  }

  const plan = {
    week_start: toIsoDate(weekStartDate),
    phase,
    targets: {
      run: {
        sessions: targets.run.sessions,
        volume_km: targets.run.weekly_volume,
        long_km: targets.run.long_session,
        volume_min: targets.run.weekly_volume_min || null,
        long_min: targets.run.long_session_min || null,
      },
      bike: {
        sessions: targets.bike.sessions,
        volume_hours: targets.bike.weekly_volume,
        long_hours: targets.bike.long_session,
      },
      swim: {
        sessions: targets.swim.sessions,
        volume_km: targets.swim.weekly_volume,
        long_km: targets.swim.long_session,
        volume_min: targets.swim.weekly_volume_min || null,
        long_min: targets.swim.long_session_min || null,
      },
    },
    nutrition: {
      daily_calories_target: (profile.nutrition || {}).daily_calories_target || 0,
      notes: (profile.nutrition || {}).notes || "",
    },
    sessions,
    notes: [],
    flags: [],
  };

  const loadTotals = computeLoadPointsForPlan(plan, baseline);
  plan.targets.run.load_points = loadTotals.run;
  plan.targets.bike.load_points = loadTotals.bike;
  plan.targets.swim.load_points = loadTotals.swim;

  const rampRules = goalAnalysis?.ramp_rules || {
    run: baseline.disciplines.run.confidence === "low" ? 0.05 : 0.1,
    bike: 0.1,
    swim: 0.15,
  };

  const prevWeek = new Date(weekStartDate.getTime());
  prevWeek.setUTCDate(prevWeek.getUTCDate() - 7);
  const prevPlanPath = planPathForWeek(options.outputDir, prevWeek);
  if (fs.existsSync(prevPlanPath)) {
    const prevPlan = loadJson(prevPlanPath);
    const prevLoad = {
      run: prevPlan?.targets?.run?.load_points || 0,
      bike: prevPlan?.targets?.bike?.load_points || 0,
      swim: prevPlan?.targets?.swim?.load_points || 0,
    };

    for (const discipline of ["run", "bike", "swim"]) {
      const current = plan.targets[discipline].load_points || 0;
      const prev = prevLoad[discipline] || 0;
      const limit = rampRules[discipline] ?? 0.1;
      if (prev > 0 && current > prev * (1 + limit)) {
        const factor = (prev * (1 + limit)) / current;
        scaleDisciplineSessions(plan, discipline, factor);
        if (discipline === "bike") {
          plan.targets.bike.volume_hours = Number((plan.targets.bike.volume_hours * factor).toFixed(2));
          plan.targets.bike.long_hours = Number((plan.targets.bike.long_hours * factor).toFixed(2));
        } else {
          plan.targets[discipline].volume_km = Number((plan.targets[discipline].volume_km * factor).toFixed(2));
          plan.targets[discipline].long_km = Number((plan.targets[discipline].long_km * factor).toFixed(2));
          if (plan.targets[discipline].volume_min) {
            plan.targets[discipline].volume_min = Math.round(plan.targets[discipline].volume_min * factor);
          }
          if (plan.targets[discipline].long_min) {
            plan.targets[discipline].long_min = Math.round(plan.targets[discipline].long_min * factor);
          }
        }
        plan.notes.push(`Load cap applied for ${discipline} (${Math.round(limit * 100)}% ramp).`);
      }
    }

    const cappedLoadTotals = computeLoadPointsForPlan(plan, baseline);
    plan.targets.run.load_points = cappedLoadTotals.run;
    plan.targets.bike.load_points = cappedLoadTotals.bike;
    plan.targets.swim.load_points = cappedLoadTotals.swim;
  }

  fs.mkdirSync(options.outputDir, { recursive: true });
  const outputJson = `${options.outputDir}/${toIsoDate(weekStartDate)}.json`;
  dumpJson(outputJson, plan);

  if (options.outputMd) {
    const mdLines = [
      `# Plan for week starting ${toIsoDate(weekStartDate)}`,
      "",
      `Phase: ${phase}`,
      "",
      "## Targets",
      `- Run: ${plan.targets.run.volume_km} km across ${plan.targets.run.sessions} sessions` +
        (plan.targets.run.volume_min ? ` (${plan.targets.run.volume_min} min)` : ""),
      `- Bike: ${plan.targets.bike.volume_hours} hours across ${plan.targets.bike.sessions} sessions`,
      `- Swim: ${plan.targets.swim.volume_km} km across ${plan.targets.swim.sessions} sessions` +
        (plan.targets.swim.volume_min ? ` (${plan.targets.swim.volume_min} min)` : ""),
      "",
      "## Sessions",
    ];
    for (const session of plan.sessions) {
      const detail =
        session.duration_min != null
          ? `${session.duration_min} min` + (session.distance_km != null ? ` (~${session.distance_km} km)` : "")
          : `${session.distance_km || 0} km`;
      mdLines.push(`- ${session.date} ${session.discipline} ${session.type} (${detail})`);
    }
    if (plan.notes.length) {
      mdLines.push("", "## Notes", ...plan.notes.map((note) => `- ${note}`));
    }
    saveText(`${options.outputDir}/${toIsoDate(weekStartDate)}.md`, mdLines.join("\n").trim() + "\n");
  }
}

if (require.main === module) {
  main();
}
