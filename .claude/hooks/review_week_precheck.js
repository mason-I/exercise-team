#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");
const { parseDate, toIsoDate } = require("../skills/_shared/lib");

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function hasCheckinShape(checkin) {
  if (!checkin || typeof checkin !== "object") return false;
  const required = ["date", "sleep", "soreness", "stress", "motivation", "pain", "constraints", "notes"];
  return required.every((key) => key in checkin);
}

function main() {
  const today = parseDate(process.env.COACH_TODAY) || parseDate(new Date());
  const todayIso = toIsoDate(today);
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const checkinPath = path.join(projectDir, "data", "coach", "checkins", `${todayIso}.json`);
  const checkin = readJson(checkinPath);

  if (hasCheckinShape(checkin)) {
    return;
  }

  const message = [
    "Review-week precheck: today check-in is missing.",
    `Required file: data/coach/checkins/${todayIso}.json`,
    "Before continuing review:",
    "- Ask sleep, soreness, stress, motivation (1-5)",
    "- Ask pain/niggles (yes/no + details)",
    "- Ask schedule constraints/notes",
    "Write the check-in JSON, then re-run /review-week.",
  ].join("\n");
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

if (require.main === module) {
  main();
}
