const fs = require("fs");
const path = require("path");
const { loadJson, parseDate } = require("../../_shared/lib");

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

function validatePlan(plan, baseline) {
  const errors = [];
  const weekStart = parseDate(plan.week_start);
  if (!weekStart) errors.push("plan week_start invalid");
  const targets = plan.targets || {};
  for (const discipline of ["run", "bike", "swim"]) {
    if (!targets[discipline]) {
      errors.push(`plan missing ${discipline} target`);
      continue;
    }
    const target = targets[discipline];
    const baselineWeekly = baseline.disciplines[discipline].weekly.volume_median;
    const confidence = baseline.disciplines[discipline].confidence;
    const plannedVolume = discipline === "bike" ? target.volume_hours : target.volume_km;
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
    plan: null,
    planDir: "plans",
    latestPlan: false,
    skipMissing: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--baseline") options.baseline = args[i + 1];
    if (arg === "--calendar") options.calendar = args[i + 1];
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
      errors.push(...validatePlan(plan, baseline));
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
