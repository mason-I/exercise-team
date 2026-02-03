const fs = require("fs");
const path = require("path");
const { loadJson, parseDate, toIsoDate } = require("../../_shared/lib");

function validateBaseline(baseline) {
  const errors = [];
  if (!baseline.disciplines) {
    errors.push("baseline missing disciplines");
    return errors;
  }
  for (const name of ["run", "bike", "swim"]) {
    if (!baseline.disciplines[name]) {
      errors.push(`baseline missing discipline ${name}`);
      continue;
    }
    const discipline = baseline.disciplines[name];
    if (!discipline.weekly) errors.push(`${name} missing weekly metrics`);
    if (!discipline.session) errors.push(`${name} missing session metrics`);
    if (!discipline.long_session) errors.push(`${name} missing long_session metrics`);
  }
  return errors;
}

function validateCalendar(calendar) {
  const errors = [];
  if (!calendar.event) {
    errors.push("calendar missing event");
    return errors;
  }
  if (!calendar.phases) errors.push("calendar missing phases");
  return errors;
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

function isTriGoal(profile) {
  const distances = profile?.goal?.event?.distances;
  if (!distances) return false;
  return (
    Number(distances.swim_km || 0) > 0 &&
    Number(distances.bike_km || 0) > 0 &&
    Number(distances.run_km || 0) > 0
  );
}

function validatePlan(plan, baseline, profile, prevPlan) {
  const errors = [];
  const weekStart = parseDate(plan.week_start);
  if (!weekStart) errors.push("plan week_start invalid");
  const targets = plan.targets || {};
  const restIdx = restDayIndex(profile?.preferences?.rest_day);
  const triGoal = isTriGoal(profile);
  const swimBaselineZero = (baseline?.disciplines?.swim?.weekly?.volume_median || 0) <= 0.01;
  const highCardioLowImpact = Boolean(baseline?.composite?.flags?.high_cardio_low_impact);

  const longCounts = { run: 0, bike: 0, swim: 0 };
  let swimSessions = 0;
  if (Array.isArray(plan.sessions)) {
    for (const session of plan.sessions) {
      const dt = parseDate(session.date);
      if (dt && dt.getUTCDay() === restIdx) {
        errors.push(`session scheduled on rest day: ${session.date}`);
      }
      const discipline = session.discipline;
      if (discipline && session.type === "long") {
        longCounts[discipline] = (longCounts[discipline] || 0) + 1;
      }
      if (discipline === "swim") {
        swimSessions += 1;
        if (triGoal && swimBaselineZero && (!session.duration_min || session.duration_min <= 0)) {
          errors.push("swim session has zero duration during swim re-entry");
        }
      }
      if (discipline === "run" && highCardioLowImpact) {
        if (session.distance_km_cap == null) {
          errors.push("run session missing distance_km_cap for high_cardio_low_impact");
        }
      }
    }
  }
  for (const discipline of ["run", "bike", "swim"]) {
    if (longCounts[discipline] > 1) {
      errors.push(`${discipline} has multiple long sessions`);
    }
  }
  if (triGoal && swimBaselineZero && swimSessions === 0) {
    errors.push("swim re-entry required but no swim sessions scheduled");
  }

  for (const discipline of ["run", "bike", "swim"]) {
    if (!targets[discipline]) {
      errors.push(`plan missing ${discipline} target`);
      continue;
    }
    const target = targets[discipline];
    const baselineWeekly = baseline.disciplines[discipline].weekly.volume_median;
    const confidence = baseline.disciplines[discipline].confidence;
    const plannedVolume = discipline === "bike" ? target.volume_hours : target.volume_km;
    const plannedMinutes =
      discipline !== "bike" && target.volume_min != null ? target.volume_min : null;
    if (plannedVolume == null) {
      errors.push(`${discipline} missing planned volume`);
      continue;
    }
    if (plannedVolume < 0) errors.push(`${discipline} planned volume negative`);
    if (confidence === "low" && plannedVolume > baselineWeekly) {
      errors.push(`${discipline} planned volume exceeds baseline for low confidence`);
    }
    const longKey = discipline === "bike" ? "long_hours" : "long_km";
    const longVal = target[longKey] || 0;
    if (plannedVolume && longVal > plannedVolume * 0.6) {
      errors.push(`${discipline} long session exceeds 60% of weekly volume`);
    }
    if (discipline !== "bike" && plannedMinutes != null && target.long_min != null) {
      if (target.long_min > plannedMinutes * 0.6) {
        errors.push(`${discipline} long session exceeds 60% of weekly minutes`);
      }
    }
  }

  if (prevPlan) {
    const runLimit = baseline?.disciplines?.run?.confidence === "low" ? 0.05 : 0.1;
    const limits = { run: runLimit, bike: 0.1, swim: 0.15 };
    for (const discipline of ["run", "bike", "swim"]) {
      const currTarget = targets[discipline];
      const prevTarget = prevPlan?.targets?.[discipline];
      if (!currTarget || !prevTarget) continue;
      const currLoad = currTarget.load_points || 0;
      const prevLoad = prevTarget.load_points || 0;
      if (prevLoad > 0 && currLoad > prevLoad * (1 + limits[discipline])) {
        errors.push(`${discipline} load ramp exceeds ${Math.round(limits[discipline] * 100)}%`);
      }
      if (discipline === "bike") {
        if (prevTarget.volume_hours > 0 && currTarget.volume_hours > prevTarget.volume_hours * (1 + limits[discipline])) {
          errors.push(`${discipline} volume ramp exceeds ${Math.round(limits[discipline] * 100)}%`);
        }
      } else {
        const currMin = currTarget.volume_min != null ? currTarget.volume_min : currTarget.volume_km;
        const prevMin = prevTarget.volume_min != null ? prevTarget.volume_min : prevTarget.volume_km;
        if (prevMin > 0 && currMin > prevMin * (1 + limits[discipline])) {
          errors.push(`${discipline} volume ramp exceeds ${Math.round(limits[discipline] * 100)}%`);
        }
      }
    }
  }
  return errors;
}

function latestPlanFile(planDir) {
  if (!fs.existsSync(planDir)) return null;
  const candidates = fs
    .readdirSync(planDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(planDir, name));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    baseline: "baseline.json",
    calendar: "calendar.json",
    profile: "profile.json",
    plan: null,
    planDir: "plans",
    latestPlan: false,
    skipMissing: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--baseline") options.baseline = args[i + 1];
    if (arg === "--calendar") options.calendar = args[i + 1];
    if (arg === "--profile") options.profile = args[i + 1];
    if (arg === "--plan") options.plan = args[i + 1];
    if (arg === "--plan-dir") options.planDir = args[i + 1];
    if (arg === "--latest-plan") options.latestPlan = true;
    if (arg === "--skip-missing") options.skipMissing = true;
  }
  if (options.latestPlan && !options.plan) {
    options.plan = latestPlanFile(options.planDir);
  }
  return options;
}

function main() {
  const options = parseArgs();
  const errors = [];
  let baseline = null;
  let profile = null;

  if (fs.existsSync(options.baseline)) {
    baseline = loadJson(options.baseline);
    errors.push(...validateBaseline(baseline));
  } else if (!options.skipMissing) {
    errors.push(`baseline file not found: ${options.baseline}`);
  }

  if (fs.existsSync(options.calendar)) {
    const calendar = loadJson(options.calendar);
    errors.push(...validateCalendar(calendar));
  } else if (!options.skipMissing) {
    errors.push(`calendar file not found: ${options.calendar}`);
  }

  if (options.plan && baseline) {
    if (fs.existsSync(options.plan)) {
      const plan = loadJson(options.plan);
      if (fs.existsSync(options.profile)) {
        profile = loadJson(options.profile);
      }
      let prevPlan = null;
      const weekStart = parseDate(plan.week_start);
      if (weekStart) {
        const prev = new Date(weekStart.getTime());
        prev.setUTCDate(prev.getUTCDate() - 7);
        const prevPath = path.join(options.planDir, `${toIsoDate(prev)}.json`);
        if (fs.existsSync(prevPath)) {
          prevPlan = loadJson(prevPath);
        }
      }
      errors.push(...validatePlan(plan, baseline, profile, prevPlan));
    } else if (!options.skipMissing) {
      errors.push(`plan file not found: ${options.plan}`);
    }
  } else if (options.plan && !baseline && !options.skipMissing) {
    errors.push("plan validation requires baseline");
  } else if (!options.plan && options.latestPlan && !options.skipMissing) {
    errors.push("no plan file found to validate");
  }

  if (errors.length) {
    for (const err of errors) console.error(`ERROR: ${err}`);
    process.exit(1);
  }
  console.log("Validation passed.");
}

if (require.main === module) {
  main();
}
