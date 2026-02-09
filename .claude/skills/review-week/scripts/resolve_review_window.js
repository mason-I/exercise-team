#!/usr/bin/env bun

const { parseDate, weekStart, toIsoDate } = require("../../_shared/lib");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    mode: "current",
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

function resolveCurrentWeekStart(options, todayDate) {
  const fromEnv = parseDate(options.currentWeekStart);
  if (fromEnv) return fromEnv;
  return weekStart(todayDate);
}

function main() {
  const options = parseArgs();
  const today = parseDate(options.today) || parseDate(new Date());
  const currentStart = resolveCurrentWeekStart(options, today);

  let weekStartDate = new Date(currentStart.getTime());
  let asOfDate = new Date(today.getTime());

  if (options.mode === "last") {
    weekStartDate.setUTCDate(weekStartDate.getUTCDate() - 7);
    asOfDate = new Date(weekStartDate.getTime());
    asOfDate.setUTCDate(asOfDate.getUTCDate() + 6);
  }

  const payload = {
    mode: options.mode === "last" ? "last" : "current",
    week_start: toIsoDate(weekStartDate),
    as_of_date: toIsoDate(asOfDate),
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (require.main === module) {
  main();
}
