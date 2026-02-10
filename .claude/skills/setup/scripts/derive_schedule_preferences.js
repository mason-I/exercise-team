#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");
const { parseDate, toIsoDate } = require("../../_shared/lib");
const { deriveHabitAnchors } = require("../../_shared/schedule_preferences");
const { PATHS } = require("../../_shared/paths");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    activities: PATHS.external.stravaActivities,
    snapshot: PATHS.coach.snapshot,
    out: PATHS.system.stravaInferredSchedule,
    windowDays: 56,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--activities") options.activities = args[i + 1];
    if (arg === "--snapshot") options.snapshot = args[i + 1];
    if (arg === "--out") options.out = args[i + 1];
    if (arg === "--window-days") options.windowDays = Number(args[i + 1]);
  }

  return options;
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function main() {
  const options = parseArgs();
  const activities = readJson(options.activities);
  const snapshot = readJson(options.snapshot);
  const asOfDate = snapshot?.as_of_date ? parseDate(snapshot.as_of_date) : parseDate(new Date());

  if (!Array.isArray(activities)) {
    throw new Error(`Activities file is not an array: ${options.activities}`);
  }
  if (!asOfDate) {
    throw new Error("Unable to resolve as_of_date for habit anchor inference");
  }
  if (!Number.isFinite(options.windowDays) || options.windowDays < 14) {
    throw new Error("--window-days must be a number >= 14");
  }

  const metricsContext = {
    zones: snapshot?.zones?.heart_rate || null,
    ftp: snapshot?.athlete?.ftp || null,
  };
  const inferred = deriveHabitAnchors(activities, asOfDate, options.windowDays, metricsContext);
  const payload = {
    schema_version: inferred.schema_version,
    generated_at: new Date().toISOString(),
    as_of_date: toIsoDate(asOfDate),
    window_days: inferred.window_days,
    habit_anchors: inferred.habit_anchors,
    routine_template: inferred.routine_template || [],
    policy_defaults: inferred.policy_defaults,
  };

  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, `${JSON.stringify(payload, null, 2)}\n`);
  console.error(`Derived habit anchors -> ${options.out}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}
