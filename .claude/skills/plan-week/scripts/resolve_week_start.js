#!/usr/bin/env bun

const { parseDate, weekStart, toIsoDate } = require("../../_shared/lib");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    mode: "next",
    today: process.env.COACH_TODAY || null,
    currentWeekStart: process.env.COACH_WEEK_START || null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--mode") options.mode = String(args[index + 1] || "").toLowerCase();
    if (arg === "--today") options.today = args[index + 1];
    if (arg === "--current-week-start") options.currentWeekStart = args[index + 1];
  }
  return options;
}

function resolveCurrentWeekStart(options) {
  const envWeekStart = parseDate(options.currentWeekStart);
  if (envWeekStart) return envWeekStart;
  const today = parseDate(options.today) || parseDate(new Date());
  return weekStart(today);
}

function main() {
  const options = parseArgs();
  const current = resolveCurrentWeekStart(options);
  const target = new Date(current.getTime());
  if (options.mode !== "this") {
    target.setUTCDate(target.getUTCDate() + 7);
  }

  const payload = {
    mode: options.mode === "this" ? "this" : "next",
    current_week_start: toIsoDate(current),
    week_start: toIsoDate(target),
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (require.main === module) {
  main();
}
