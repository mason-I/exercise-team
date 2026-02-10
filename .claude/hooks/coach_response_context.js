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

function isoWeekday(isoDate) {
  const dt = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  const idx = (dt.getUTCDay() + 6) % 7;
  return ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][idx];
}

function normalizeSport(value) {
  if (!value) return null;
  const lowered = String(value).toLowerCase().replace(/\s+/g, "");
  if (lowered.includes("run")) return "run";
  if (lowered.includes("ride") || lowered.includes("bike") || lowered.includes("cycl")) return "bike";
  if (lowered.includes("swim")) return "swim";
  if (
    ["workout", "weighttraining", "strengthtraining", "crossfit", "functionaltraining",
     "gym", "bodyweight", "hiit", "yoga", "pilates", "mobility", "core"]
      .some((key) => lowered.includes(key))
  )
    return "strength";
  return null;
}

function buildCompletedSummary(todayIso, weekStartIso, weekEndIso) {
  const activitiesPath = path.resolve(process.cwd(), "data/external/strava/activities.json");
  const activities = readJson(activitiesPath);
  if (!Array.isArray(activities)) return null;

  const weekActivities = activities.filter((act) => {
    const d = String(act.start_date_local || act.start_date || "").slice(0, 10);
    return d >= weekStartIso && d <= weekEndIso;
  });

  if (!weekActivities.length) return { totalHours: 0, count: 0, detail: "none" };

  let totalMin = 0;
  const byDiscipline = {};
  const items = [];

  for (const act of weekActivities) {
    const mins = Math.round(Number(act.moving_time_sec || act.moving_time || act.elapsed_time_sec || act.elapsed_time || 0) / 60);
    const disc = normalizeSport(act.sport_type || act.type) || "other";
    totalMin += mins;
    byDiscipline[disc] = (byDiscipline[disc] || 0) + mins;
    items.push(`${mins}min ${disc}`);
  }

  const parts = Object.entries(byDiscipline).map(([d, m]) => `${Math.round(m / 6) / 10}h ${d}`);
  return {
    totalHours: Math.round((totalMin / 60) * 100) / 100,
    count: weekActivities.length,
    detail: `${items.length} session${items.length > 1 ? "s" : ""}: ${parts.join(", ")}`,
  };
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

  const todayIso = toIsoDate(today);
  const weekday = isoWeekday(todayIso) || "unknown";
  const weekStartIso = plan.week_start || todayIso;
  const weekEndIso = weekEnd ? toIsoDate(weekEnd) : todayIso;

  // Calculate day position in week (1-7)
  const dayStart = parseDate(weekStartIso);
  const dayNum = dayStart ? Math.floor((today - dayStart) / (24 * 60 * 60 * 1000)) + 1 : "?";
  const daysRemaining = dayStart ? 7 - dayNum + 1 : "?";

  const completed = buildCompletedSummary(todayIso, weekStartIso, weekEndIso);
  const completedLine = completed
    ? `Completed this week so far: ${completed.totalHours}h (${completed.detail}).`
    : "Completed this week so far: unknown (activities.json not found).";

  const context = [
    "Final response contract for this plan write:",
    "1) Start with remaining sessions this week only (no historical sessions).",
    "2) Then add a short rationale/risk note.",
    "3) Then ask a short check-in question.",
    "4) Do not append artifact file paths to the response.",
    "",
    `Today is ${weekday} ${todayIso} (day ${dayNum} of 7 in the plan week, ${daysRemaining} days remaining).`,
    `Plan week: ${weekStartIso} -> ${weekEndIso}`,
    completedLine,
    "IMPORTANT: Do not estimate current-week load from baseline averages. Use the completed hours above.",
    "",
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
