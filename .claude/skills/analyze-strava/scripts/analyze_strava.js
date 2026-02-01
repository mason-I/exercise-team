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

function summarizeActivities(activities, startDate, endDate) {
  const totals = { run: 0, bike: 0, swim: 0 };
  const sessions = { run: 0, bike: 0, swim: 0 };

  for (const act of activities) {
    const actDate = activityDate(act);
    if (!actDate || actDate < startDate || actDate > endDate) continue;
    const discipline = normalizeSport(act.sport_type || act.type);
    if (!discipline) continue;
    sessions[discipline] += 1;
    if (discipline === "bike") totals[discipline] += activityDurationSec(act) / 3600;
    else totals[discipline] += activityDistanceM(act) / 1000;
  }
  return { totals, sessions };
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
    planDir: "plans",
    outputDir: "reports",
  };
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--activities") options.activities = args[i + 1];
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
  const activities = loadJson(options.activities);

  const { totals, sessions } = summarizeActivities(activities, weekStartDate, weekEnd);

  const results = {};
  for (const [discipline, target] of Object.entries(plan.targets)) {
    const plannedVolume = discipline === "bike" ? target.volume_hours : target.volume_km;
    const actualVolume = totals[discipline];
    results[discipline] = {
      planned: plannedVolume,
      actual: Number(actualVolume.toFixed(2)),
      sessions_planned: target.sessions || 0,
      sessions_actual: sessions[discipline],
      status: statusFor(actualVolume, plannedVolume),
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
    const unit = discipline === "bike" ? "hours" : "km";
    reportLines.push(
      `- ${discipline[0].toUpperCase() + discipline.slice(1)}: ${data.status} ` +
        `(${data.actual} / ${data.planned} ${unit}, ${data.sessions_actual} / ${data.sessions_planned} sessions)`
    );
  }

  const outputPath = `${options.outputDir}/${toIsoDate(weekStartDate)}-week.md`;
  saveText(outputPath, reportLines.join("\n").trim() + "\n");
}

if (require.main === module) {
  main();
}
