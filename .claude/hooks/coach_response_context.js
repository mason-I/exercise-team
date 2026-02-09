#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");
const { parseDate, toIsoDate } = require("../skills/_shared/lib");

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf-8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function dayLabel(isoDate) {
  const dt = parseDate(isoDate);
  if (!dt) return isoDate;
  return dt.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function resolveWeekEnd(plan) {
  const explicit = parseDate(plan?.week_end);
  if (explicit) return explicit;
  const start = parseDate(plan?.week_start);
  if (!start) return null;
  const weekEnd = new Date(start.getTime());
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
  return weekEnd;
}

function buildRemainingSessions(plan, today, weekEnd) {
  if (!Array.isArray(plan?.sessions)) return [];
  return plan.sessions
    .filter((session) => {
      const date = parseDate(session?.date);
      return Boolean(date && date >= today && (!weekEnd || date <= weekEnd));
    })
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
}

function formatSession(session) {
  const discipline = session?.discipline || "session";
  const type = session?.type || "planned";
  const duration = Number.isFinite(session?.duration_min) ? `${session.duration_min} min` : "duration n/a";
  const intent = session?.intent ? ` — ${session.intent}` : "";
  return `- ${dayLabel(session.date)}: ${discipline} (${type}, ${duration})${intent}`;
}

function outputContext(context) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: context,
    },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function main() {
  const input = readStdinJson();
  if (String(input.hook_event_name || "") !== "PostToolUse") return;
  if (String(input.tool_name || "") !== "Write") return;

  const writePath = input?.tool_input?.file_path || input?.tool_response?.filePath;
  if (!writePath) return;

  const cwd = input.cwd || process.cwd();
  const absolutePath = path.isAbsolute(writePath) ? writePath : path.resolve(cwd, writePath);
  const normalizedPath = absolutePath.replace(/\\/g, "/");
  if (!normalizedPath.includes("/data/coach/plans/") || !normalizedPath.endsWith(".json")) return;

  const plan = readJson(absolutePath);
  if (!plan) return;

  const today = parseDate(process.env.COACH_TODAY) || parseDate(new Date());
  const weekEnd = resolveWeekEnd(plan);
  if (!today) return;

  const remaining = buildRemainingSessions(plan, today, weekEnd);
  const sessionsBlock =
    remaining.length > 0
      ? remaining.map((session) => formatSession(session)).join("\n")
      : "- No sessions remain for the current plan week.";

  const context = [
    "Final response contract for this plan write:",
    "1) Start with remaining sessions this week only (no historical sessions).",
    "2) Then add a short rationale/risk note.",
    "3) Then ask a short check-in question.",
    "4) List artifact file paths last.",
    "",
    `Today (for filtering): ${toIsoDate(today)}`,
    `Plan week: ${plan.week_start || "unknown"} -> ${weekEnd ? toIsoDate(weekEnd) : "unknown"}`,
    "Remaining sessions to present:",
    sessionsBlock,
  ].join("\n");

  outputContext(context);
}

if (require.main === module) {
  try {
    main();
  } catch {
    // Non-blocking hook: swallow errors to avoid interrupting normal workflow.
  }
}
