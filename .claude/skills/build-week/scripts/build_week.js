const {
  dumpJson,
  loadJson,
  parseDate,
  saveText,
  toIsoDate,
  weekStart,
} = require("../../_shared/lib");

const PHASE_FACTORS = {
  base: 1.0,
  build: 1.05,
  peak: 1.1,
  taper: 0.7,
  offseason: 0.6,
};

const LONG_FACTORS = {
  base: 1.0,
  build: 1.05,
  peak: 1.1,
  taper: 0.8,
  offseason: 0.8,
};

const DEFAULT_DAYS = {
  swim: [0, 4, 5],
  bike: [2, 6],
  run: [1, 3, 5],
};

const SESSION_TYPES = {
  base: ["easy", "long"],
  build: ["easy", "tempo", "long"],
  peak: ["interval", "tempo", "long"],
  taper: ["easy", "short"],
  offseason: ["easy"],
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
    outputDir: "plans",
    outputMd: false,
  };
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--baseline") options.baseline = args[i + 1];
    if (arg === "--calendar") options.calendar = args[i + 1];
    if (arg === "--profile") options.profile = args[i + 1];
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

function buildDiscipline(discipline, baseline, phase) {
  const metrics = baseline.disciplines[discipline];
  const weekly = metrics.weekly;
  const session = metrics.session;
  const longSession = metrics.long_session;
  const confidence = metrics.confidence;

  const sessions = Math.round(weekly.sessions_median) || 1;
  let factor = PHASE_FACTORS[phase] ?? 1.0;
  let longFactor = LONG_FACTORS[phase] ?? 1.0;
  if (confidence === "low") {
    factor *= 0.85;
    longFactor *= 0.9;
  } else if (confidence === "medium") {
    factor *= 0.95;
    longFactor *= 0.95;
  }

  const weeklyVolume = weekly.volume_median * factor;
  const longTarget = Math.min(
    longSession.weekly_max_median * longFactor,
    weeklyVolume ? weeklyVolume * 0.4 : 0
  );

  return {
    sessions,
    weekly_volume: Number(weeklyVolume.toFixed(2)),
    long_session: Number(longTarget.toFixed(2)),
    typical_distance: Number(session.distance_median.toFixed(2)),
    typical_duration_min: Number(session.duration_median_min.toFixed(1)),
    units: metrics.units,
  };
}

function allocateSessions(discipline, target, phase, weekStartDate) {
  const sessions = [];
  const days = DEFAULT_DAYS[discipline] || [];
  const sessionTypes = SESSION_TYPES[phase] || ["easy"];

  const count = target.sessions;
  const longSession = target.long_session;
  const weeklyVolume = target.weekly_volume;
  const remaining = Math.max(weeklyVolume - longSession, 0);
  const remainingSessions = Math.max(count - 1, 0);
  const perSession = remainingSessions ? remaining / remainingSessions : 0;

  for (let idx = 0; idx < count; idx += 1) {
    const dayOffset = days.length ? days[idx % days.length] : idx;
    const sessionDate = new Date(weekStartDate.getTime());
    sessionDate.setUTCDate(sessionDate.getUTCDate() + dayOffset);
    const sessionType = idx === count - 1 ? "long" : sessionTypes[Math.min(idx, sessionTypes.length - 1)];
    const volume = sessionType === "long" ? longSession : perSession;

    const entry = {
      date: toIsoDate(sessionDate),
      discipline,
      type: sessionType,
    };
    if (discipline === "bike") {
      entry.duration_min = Number((volume * 60).toFixed(1));
    } else {
      entry.distance_km = Number(volume.toFixed(2));
      entry.duration_min = Number(
        ((target.typical_duration_min / Math.max(target.typical_distance, 1e-6)) * volume).toFixed(1)
      );
    }
    sessions.push(entry);
  }
  return sessions;
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

  const phase = findPhase(calendar, weekStartDate);

  const targets = {};
  const sessions = [];
  for (const discipline of ["swim", "bike", "run"]) {
    const target = buildDiscipline(discipline, baseline, phase);
    targets[discipline] = target;
    sessions.push(...allocateSessions(discipline, target, phase, weekStartDate));
  }

  const plan = {
    week_start: toIsoDate(weekStartDate),
    phase,
    targets: {
      run: {
        sessions: targets.run.sessions,
        volume_km: targets.run.weekly_volume,
        long_km: targets.run.long_session,
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

  const outputJson = `${options.outputDir}/${toIsoDate(weekStartDate)}.json`;
  dumpJson(outputJson, plan);

  if (options.outputMd) {
    const mdLines = [
      `# Plan for week starting ${toIsoDate(weekStartDate)}`,
      "",
      `Phase: ${phase}`,
      "",
      "## Targets",
      `- Run: ${plan.targets.run.volume_km} km across ${plan.targets.run.sessions} sessions`,
      `- Bike: ${plan.targets.bike.volume_hours} hours across ${plan.targets.bike.sessions} sessions`,
      `- Swim: ${plan.targets.swim.volume_km} km across ${plan.targets.swim.sessions} sessions`,
      "",
      "## Sessions",
    ];
    for (const session of sessions) {
      const detail =
        session.discipline !== "bike"
          ? `${session.distance_km} km`
          : `${session.duration_min} min`;
      mdLines.push(`- ${session.date} ${session.discipline} ${session.type} (${detail})`);
    }
    saveText(`${options.outputDir}/${toIsoDate(weekStartDate)}.md`, mdLines.join("\n").trim() + "\n");
  }
}

if (require.main === module) {
  main();
}
