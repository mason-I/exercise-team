#!/usr/bin/env bun

const {
  listEvents,
  createTrainingEvent,
  updateTrainingEvent,
  cancelTrainingEvent,
} = require("../../_shared/google_calendar_api");

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0] || "";
  const flags = {};

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next == null || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }

  return { command, flags };
}

function requireFlag(flags, key) {
  const value = flags[key];
  if (value == null || value === true || String(value).trim() === "") {
    throw new Error(`Missing required --${key}`);
  }
  return String(value);
}

async function main() {
  const { command, flags } = parseArgs();
  const calendarId = flags["calendar-id"] ? String(flags["calendar-id"]) : null;
  const timeZone = flags.timezone ? String(flags.timezone) : undefined;

  if (command === "list") {
    const start = requireFlag(flags, "start");
    const end = requireFlag(flags, "end");
    const result = await listEvents({ start, end, calendarId });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "create-training") {
    const start = requireFlag(flags, "start");
    const end = requireFlag(flags, "end");
    const summary = requireFlag(flags, "summary");
    const description = requireFlag(flags, "description");
    const result = await createTrainingEvent({
      start,
      end,
      summary,
      description,
      calendarId,
      timeZone,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "update-training") {
    const eventId = requireFlag(flags, "event-id");
    const start = requireFlag(flags, "start");
    const end = requireFlag(flags, "end");
    const summary = requireFlag(flags, "summary");
    const description = requireFlag(flags, "description");
    const result = await updateTrainingEvent({
      eventId,
      start,
      end,
      summary,
      description,
      calendarId,
      timeZone,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "cancel-training") {
    const eventId = requireFlag(flags, "event-id");
    const reason = requireFlag(flags, "reason");
    const result = await cancelTrainingEvent({
      eventId,
      reason,
      calendarId,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  throw new Error(
    "Unknown command. Supported: list, create-training, update-training, cancel-training"
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  });
}
