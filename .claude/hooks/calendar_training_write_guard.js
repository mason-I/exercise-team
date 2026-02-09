#!/usr/bin/env bun

const fs = require("fs");

const APPROVED_CALENDAR_WRAPPERS = [
  ".claude/skills/schedule/scripts/calendar_events.js",
  ".claude/skills/schedule/scripts/sync_plan_to_calendar.js",
];

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf-8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function extractSummaryArg(command) {
  const match = command.match(/--summary\s+("[^"]*"|'[^']*'|\S+)/);
  if (!match) return null;
  const raw = String(match[1] || "").trim();
  if (!raw) return null;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function parseCalendarEventsSubcommand(command) {
  const m = command.match(/calendar_events\.js\s+([^\s]+)/);
  return m ? String(m[1] || "").trim() : null;
}

function isRawGoogleCalendarWrite(command) {
  const pointsToCalendarApi =
    /calendar\.googleapis\.com/i.test(command) ||
    /googleapis\.com\/calendar\/v3/i.test(command);
  if (!pointsToCalendarApi) return false;
  return /(?:-X|--request)\s*(POST|PUT|PATCH|DELETE)\b/i.test(command);
}

function touchesScheduleScript(command) {
  return /\.claude\/skills\/schedule\/scripts\//.test(command);
}

function referencesApprovedWrapper(command) {
  return APPROVED_CALENDAR_WRAPPERS.some((allowed) => command.includes(allowed));
}

function startsWithTraining(summary) {
  return String(summary || "").trim().startsWith("Training:");
}

function evaluateCommand(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return { ok: true };

  if (isRawGoogleCalendarWrite(cmd)) {
    return {
      ok: false,
      reason:
        "Blocked Bash command: direct write requests to calendar.googleapis.com are not allowed. Use approved schedule wrappers.",
    };
  }

  if (touchesScheduleScript(cmd) && !referencesApprovedWrapper(cmd)) {
    return {
      ok: false,
      reason:
        "Blocked Bash command: unapproved schedule script. Only calendar_events.js and sync_plan_to_calendar.js are allowed.",
    };
  }

  if (cmd.includes("calendar_events.js")) {
    const subcommand = parseCalendarEventsSubcommand(cmd);
    const allowed = new Set(["list", "create-training", "update-training", "cancel-training"]);
    if (!allowed.has(subcommand)) {
      return {
        ok: false,
        reason:
          "Blocked Bash command: calendar_events.js supports only list, create-training, update-training, cancel-training.",
      };
    }

    if (subcommand === "create-training" || subcommand === "update-training") {
      const summary = extractSummaryArg(cmd);
      if (!startsWithTraining(summary)) {
        return {
          ok: false,
          reason:
            'Blocked Bash command: create/update summary must start with "Training:".',
        };
      }
    }
  }

  if (cmd.includes("sync_plan_to_calendar.js")) {
    const hasMode = cmd.includes("--apply") || cmd.includes("--dry-run");
    const hasPlan = /--plan\s+\S+/.test(cmd);
    if (!hasMode || !hasPlan) {
      return {
        ok: false,
        reason:
          "Blocked Bash command: sync_plan_to_calendar.js requires --plan and one mode (--dry-run or --apply).",
      };
    }
  }

  return { ok: true };
}

function main() {
  const input = readStdinJson();
  if (input?.hook_event_name !== "PreToolUse" || input?.tool_name !== "Bash") return;
  const command = String(input?.tool_input?.command || "").trim();
  if (!command) return;

  const verdict = evaluateCommand(command);
  if (!verdict.ok) {
    process.stderr.write(`${verdict.reason}\n`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateCommand,
  extractSummaryArg,
  isRawGoogleCalendarWrite,
};
