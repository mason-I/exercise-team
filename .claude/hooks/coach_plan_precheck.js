#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");
const { toIsoDate, dumpJson } = require("../skills/_shared/lib");
const { CANONICAL_SESSION_TYPES } = require("../skills/_shared/schedule_preferences");

const POWER_FRACTION_THRESHOLD = 0.3;
const HR_FRACTION_THRESHOLD = 0.3;

const ALLOWED_HABIT_LEVELS = ["discipline_weekday_type", "discipline_weekday", "discipline"];
const ALLOWED_HABIT_CONFIDENCE = ["low", "medium", "high"];
const ALLOWED_EXCEPTION_CODES = [
  "HARD_CONSTRAINT_COLLISION",
  "RECOVERY_SAFETY_BLOCK",
  "FIXED_SESSION_COLLISION",
  "REST_DAY_CONSTRAINT",
  "NO_FEASIBLE_SAME_DAY_SLOT",
  "RACE_TAPER_KEY_SESSION_ADJUSTMENT",
];

const BASE_CAPS = {
  key: 90,
  support: 150,
  optional: 240,
};

const BASE_WEEKDAY_CHANGE_RATIO = 0.2;
const RACE_TAPER_WEEKDAY_CHANGE_RATIO = 0.35;
const RACE_TAPER_MULTIPLIER = 1.5;

const POWER_TEXT_PATTERNS = [
  /\bftp\b/i,
  /\bwatts?\b/i,
  /\b\d{2,4}\s*w\b/i,
  /\b(?:if|intensity factor)\s*(?:target|range|=|:|at|around)?\s*\d(?:\.\d+)?\b/i,
  /\b\d(?:\.\d+)?\s*if\b/i,
];
const ALLOWED_STRENGTH_PHASE_MODES = ["build", "maintain", "taper", "deload"];
const ALLOWED_STRENGTH_CATEGORIES = ["injury_prevention", "overuse_buffer", "performance_transfer"];
const ALLOWED_STRENGTH_PROGRESSION_COMPARISONS = ["prior_week_reference", "none"];
const ALLOWED_STRENGTH_PROGRESSION_AXES = ["load", "reps", "sets", "tempo", "density"];
const TRAINABLE_DISCIPLINES = ["run", "bike", "swim", "strength"];
const ALLOWED_GENERIC_PHASE_MODES = ["build", "maintain", "taper", "deload"];
const ALLOWED_GENERIC_PROGRESSION_COMPARISONS = ["prior_week_reference", "none"];
const ALLOWED_TARGET_SYSTEMS = ["aerobic_endurance", "threshold", "vo2", "neuromuscular", "race_specific"];
const ALLOWED_BIKE_TARGET_METRICS = ["power", "hr", "rpe"];
const ALLOWED_RUN_TARGET_METRICS = ["pace", "hr", "rpe"];

const DISCIPLINE_TO_COACH_AGENT = Object.freeze({
  run: "run-coach",
  bike: "bike-coach",
  swim: "swim-coach",
});

const REQUIRED_SUBAGENT_ORDER = ["run-coach", "bike-coach", "swim-coach", "nutrition-coach", "strength-coach"];
const REQUIRED_DISCIPLINE_FALLBACK = ["run", "bike", "swim"];

const TASK_ERROR_SENTINELS = [
  /request interrupted by user for tool use/i,
  /^error:/i,
  /^mcp error/i,
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

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function normalizeDiscipline(value) {
  if (!value) return null;
  const lowered = String(value).toLowerCase().replace(/\s+/g, "");
  if (lowered.includes("run")) return "run";
  if (lowered.includes("ride") || lowered.includes("bike") || lowered.includes("cycl")) return "bike";
  if (lowered.includes("swim")) return "swim";
  if (lowered.includes("strength") || lowered.includes("gym") || lowered.includes("workout")) return "strength";
  return null;
}

function unique(values) {
  return [...new Set(values)];
}

function extractDisciplinesFromGoals(goals) {
  const primary = goals?.primary_goal?.disciplines;
  if (!Array.isArray(primary) || !primary.length) return [];
  return unique(primary.map(normalizeDiscipline).filter(Boolean));
}

function extractDisciplinesFromPlan(plan) {
  if (!Array.isArray(plan?.sessions)) return [];
  return unique(
    plan.sessions
      .map((session) => normalizeDiscipline(session?.discipline))
      .filter((discipline) => discipline && discipline !== "rest")
  );
}

function resolveRequiredCoachSubagents(projectDir, profile = null) {
  const goalsPath = path.join(projectDir, "data", "coach", "goals.json");
  const planDir = path.join(projectDir, "data", "coach", "plans");

  let disciplines = [];
  let disciplineSource = "fallback_default";

  const goals = readJson(goalsPath);
  const fromGoals = extractDisciplinesFromGoals(goals);
  if (fromGoals.length) {
    disciplines = fromGoals;
    disciplineSource = "goals.primary_goal.disciplines";
  } else {
    const latestPlan = latestPlanMtime(planDir);
    const latestPlanData = latestPlan ? readJson(latestPlan.filePath) : null;
    const fromPlan = extractDisciplinesFromPlan(latestPlanData);
    if (fromPlan.length) {
      disciplines = fromPlan;
      disciplineSource = "latest_plan.disciplines";
    }
  }

  if (!disciplines.length) {
    disciplines = [...REQUIRED_DISCIPLINE_FALLBACK];
    disciplineSource = "fallback_default";
  }

  const requiredSet = new Set();
  for (const discipline of disciplines) {
    const mapped = DISCIPLINE_TO_COACH_AGENT[discipline];
    if (mapped) requiredSet.add(mapped);
  }

  if (!requiredSet.size) {
    for (const discipline of REQUIRED_DISCIPLINE_FALLBACK) {
      requiredSet.add(DISCIPLINE_TO_COACH_AGENT[discipline]);
    }
    disciplineSource = `${disciplineSource}_fallback_default`;
  }

  requiredSet.add("nutrition-coach");

  if (profile?.preferences?.strength?.enabled === true) {
    requiredSet.add("strength-coach");
  }

  const requiredSubagents = REQUIRED_SUBAGENT_ORDER.filter((name) => requiredSet.has(name));

  return {
    requiredSubagents,
    disciplineSource,
    disciplines,
  };
}

function extractToolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof item.text === "string") return item.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function isErroredTaskToolResult(item) {
  if (item?.is_error === true) return true;
  const text = extractToolResultText(item?.content).trim();
  if (!text) return false;
  return TASK_ERROR_SENTINELS.some((pattern) => pattern.test(text));
}

function parseTaskInvocationsFromTranscript(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") {
    throw new Error("Missing transcript path");
  }

  const raw = fs.readFileSync(transcriptPath, "utf-8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const callsById = new Map();
  const pendingErrorsByCallId = new Map();

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;

    for (const item of content) {
      if (!item || typeof item !== "object") continue;

      if (item.type === "tool_use" && item.name === "Task") {
        const callId = String(item.id || "").trim();
        const subagentType = String(item?.input?.subagent_type || "").trim();
        if (!callId || !subagentType) continue;

        const call = callsById.get(callId) || {
          id: callId,
          subagent_type: subagentType,
          errored: false,
        };
        call.subagent_type = subagentType;
        if (pendingErrorsByCallId.get(callId)) {
          call.errored = true;
        }
        callsById.set(callId, call);
      }

      if (item.type === "tool_result") {
        const callId = String(item.tool_use_id || "").trim();
        if (!callId) continue;
        if (!isErroredTaskToolResult(item)) continue;

        const existing = callsById.get(callId);
        if (existing) {
          existing.errored = true;
        } else {
          pendingErrorsByCallId.set(callId, true);
        }
      }
    }
  }

  const invocationsBySubagent = {};
  for (const call of callsById.values()) {
    const subagent = call.subagent_type;
    if (!invocationsBySubagent[subagent]) {
      invocationsBySubagent[subagent] = {
        invoked_count: 0,
        successful_count: 0,
        failed_count: 0,
        call_ids: [],
      };
    }
    const stat = invocationsBySubagent[subagent];
    stat.invoked_count += 1;
    stat.call_ids.push(call.id);
    if (call.errored) {
      stat.failed_count += 1;
    } else {
      stat.successful_count += 1;
    }
  }

  return {
    parsed_lines: lines.length,
    calls_by_id: Object.fromEntries([...callsById.entries()]),
    invocationsBySubagent,
  };
}

function formatSubagentList(values) {
  return values.length ? values.join(", ") : "(none)";
}

function validateRequiredDelegation({ projectDir, profile, transcriptPath }) {
  const resolved = resolveRequiredCoachSubagents(projectDir, profile);
  const required = resolved.requiredSubagents;

  if (!required.length) {
    return { ok: true, ...resolved };
  }

  if (!transcriptPath || typeof transcriptPath !== "string") {
    return {
      ok: false,
      required,
      found: [],
      missing: [...required],
      failedOnly: [],
      message:
        "Coach plan precheck: mandatory subagent delegation is required for /plan-week.\n" +
        "Delegation transcript is missing from hook input (`transcript_path`).\n" +
        `Required: ${required.join(", ")}\n` +
        "Remediation:\n" +
        `${required.map((name) => `- Use Task(${name}) to generate its JSON patch and merge it into data/coach/plans/<week_start>.json.`).join("\n")}\n` +
        "- Re-merge subagent patches into the canonical week plan and re-run /plan-week.",
    };
  }

  let parsed;
  try {
    parsed = parseTaskInvocationsFromTranscript(transcriptPath);
  } catch (error) {
    const reason = String(error?.message || error);
    return {
      ok: false,
      required,
      found: [],
      missing: [...required],
      failedOnly: [],
      message:
        "Coach plan precheck: mandatory subagent delegation is required for /plan-week.\n" +
        `Unable to read transcript: ${reason}\n` +
        `Required: ${required.join(", ")}\n` +
        "Remediation:\n" +
        `${required.map((name) => `- Use Task(${name}) to generate its JSON patch and merge it into data/coach/plans/<week_start>.json.`).join("\n")}\n` +
        "- Re-merge subagent patches into the canonical week plan and re-run /plan-week.",
    };
  }

  const found = [];
  const missing = [];
  const failedOnly = [];

  for (const name of required) {
    const stat = parsed.invocationsBySubagent[name];
    const successful = Number(stat?.successful_count || 0);
    const invoked = Number(stat?.invoked_count || 0);

    if (successful > 0) {
      found.push(name);
      continue;
    }

    missing.push(name);
    if (invoked > 0) {
      failedOnly.push(name);
    }
  }

  if (!missing.length) {
    return {
      ok: true,
      required,
      found,
      missing,
      failedOnly,
      ...resolved,
      parsed,
    };
  }

  const sourceSummary = `${resolved.disciplineSource}${
    resolved.disciplines.length ? ` (${resolved.disciplines.join(", ")})` : ""
  }`;

  return {
    ok: false,
    required,
    found,
    missing,
    failedOnly,
    ...resolved,
    parsed,
    message:
      "Coach plan precheck: mandatory subagent delegation is required for /plan-week.\n" +
      `Discipline source: ${sourceSummary}\n` +
      `Required: ${formatSubagentList(required)}\n` +
      `Satisfied: ${formatSubagentList(found)}\n` +
      `Missing: ${formatSubagentList(missing)}\n` +
      `Invoked but failed: ${formatSubagentList(failedOnly)}\n` +
      "Remediation:\n" +
      `${missing.map((name) => `- Use Task(${name}) to generate its JSON patch and merge it into data/coach/plans/<week_start>.json.`).join("\n")}\n` +
      "- Re-merge subagent patches into the canonical week plan and re-run /plan-week.",
  };
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasValue(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) return false;
  if (nonEmpty && value.length === 0) return false;
  return value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function isSessionTypeBucket(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      isStringArray(value.prefer) &&
      isStringArray(value.avoid) &&
      (value.notes == null || typeof value.notes === "string")
  );
}

function hasValidSessionTypePreferences(value) {
  if (!value || typeof value !== "object") return false;
  if (!isSessionTypeBucket(value.run)) return false;
  if (!isSessionTypeBucket(value.bike)) return false;
  if (!isSessionTypeBucket(value.swim)) return false;
  if (!isSessionTypeBucket(value.strength)) return false;
  if (value.notes != null && typeof value.notes !== "string") return false;
  return true;
}

function latestPlanMtime(planDir) {
  try {
    const files = fs.readdirSync(planDir).filter((name) => name.endsWith(".json"));
    if (!files.length) return null;
    const latest = files
      .map((name) => path.join(planDir, name))
      .map((filePath) => ({ filePath, stat: fs.statSync(filePath) }))
      .filter((entry) => entry.stat.isFile())
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
    if (!latest) return null;
    return { filePath: latest.filePath, mtime: latest.stat.mtime };
  } catch {
    return null;
  }
}

function containsPowerToken(text) {
  return POWER_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

function sessionTextFields(session) {
  const values = [];
  const fields = ["title", "intent", "coach_notes", "fueling", "notes", "description", "summary"];
  for (const key of fields) {
    if (typeof session[key] === "string") values.push(session[key]);
  }

  const arrayFields = ["success_criteria", "warmup", "main_set", "cooldown", "fallbacks", "rpe_targets"];
  for (const key of arrayFields) {
    if (Array.isArray(session[key])) {
      for (const item of session[key]) {
        if (typeof item === "string") values.push(item);
      }
    }
  }

  const intensity = session.intensity_prescription;
  if (intensity && typeof intensity === "object") {
    for (const value of Object.values(intensity)) {
      if (typeof value === "string") values.push(value);
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") values.push(item);
        }
      }
    }
  }

  return values;
}

function validateBikeSessionNoPower(session, hrAvailable) {
  const violations = [];
  const intensity = session.intensity_prescription || {};
  const sessionLabel = `${session.id || "unknown-id"} (${session.date || "unknown-date"})`;

  if (hasValue(intensity.power_w_range)) {
    violations.push(`${sessionLabel}: intensity_prescription.power_w_range is not allowed in no_power_mode`);
  }
  if (hasValue(intensity.if_range)) {
    violations.push(`${sessionLabel}: intensity_prescription.if_range is not allowed in no_power_mode`);
  }

  const powerToken = sessionTextFields(session).find((text) => containsPowerToken(text));
  if (powerToken) {
    violations.push(`${sessionLabel}: contains power token text while no_power_mode=true`);
  }

  const hasHrTarget = hasValue(intensity.hr_zone_range) || hasValue(intensity.hr_bpm_range);
  const hasRpeTarget = hasValue(intensity.rpe_range);

  if (hrAvailable && !hasHrTarget) {
    violations.push(`${sessionLabel}: HR target required (hr_zone_range or hr_bpm_range)`);
  }
  if (!hrAvailable && !hasRpeTarget) {
    violations.push(`${sessionLabel}: RPE target required (rpe_range) when HR is unavailable`);
  }
  if (!hasRpeTarget) {
    violations.push(`${sessionLabel}: RPE fallback required (rpe_range)`);
  }

  return violations;
}

function validateNoPowerPlan(planPath, resolved) {
  if (!resolved?.no_power_mode) return [];
  const plan = readJson(planPath);
  if (!plan || !Array.isArray(plan.sessions)) {
    return [`${path.basename(planPath)}: invalid plan format (missing sessions array)`];
  }

  const violations = [];
  for (const session of plan.sessions) {
    if (String(session?.discipline || "").toLowerCase() !== "bike") continue;
    violations.push(...validateBikeSessionNoPower(session, Boolean(resolved.hr_available)));
  }
  return violations;
}

function parseDateTime(value) {
  if (!value || typeof value !== "string") return null;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function weekdayLower(dt) {
  return dt.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
}

function fixedSessionForDay(fixedSessions, dateLower, plannedStart, plannedEnd) {
  if (!Array.isArray(fixedSessions)) return null;
  for (const fixed of fixedSessions) {
    if (!fixed || typeof fixed !== "object") continue;
    const day = String(fixed.day || fixed.weekday || fixed.date || "").toLowerCase();
    if (!day) continue;
    if (day !== dateLower && day !== String(plannedStart.toISOString().slice(0, 10)).toLowerCase()) continue;
    const start = parseDateTime(fixed.start_local || fixed.start || null);
    const end = parseDateTime(fixed.end_local || fixed.end || null);
    if (start && end && overlap(plannedStart, plannedEnd, start, end)) return fixed;
  }
  return null;
}

function isVeryHard(session) {
  const loadClass = String(session?.load_class || "").toLowerCase();
  if (loadClass === "very_hard") return true;
  const type = String(session?.type || "").toLowerCase();
  const intent = String(session?.intent || "").toLowerCase();
  return type.includes("vo2") || type.includes("interval") || intent.includes("vo2");
}

function isHardStrength(session) {
  const discipline = String(session?.discipline || "").toLowerCase();
  if (discipline !== "strength") return false;
  const loadClass = String(session?.load_class || "").toLowerCase();
  return loadClass === "hard" || loadClass === "very_hard";
}

function isKeyVo2(session) {
  const discipline = String(session?.discipline || "").toLowerCase();
  if (!["run", "bike"].includes(discipline)) return false;
  const type = String(session?.type || "").toLowerCase();
  const intent = String(session?.intent || "").toLowerCase();
  const priority = String(session?.priority || "").toLowerCase();
  return (
    type.includes("vo2") ||
    type.includes("interval") ||
    intent.includes("vo2") ||
    (priority === "key" && (type.includes("interval") || intent.includes("hard")))
  );
}

function allowsBrickStack(sessionA, sessionB) {
  const textA = `${sessionA?.type || ""} ${sessionA?.intent || ""} ${sessionA?.scheduling_notes || ""}`.toLowerCase();
  const textB = `${sessionB?.type || ""} ${sessionB?.intent || ""} ${sessionB?.scheduling_notes || ""}`.toLowerCase();
  return textA.includes("brick") || textB.includes("brick");
}

function getPriorityDeviationCapMinutes(priority, caps) {
  const key = String(priority || "optional").toLowerCase();
  if (key === "key") return Number(caps.key);
  if (key === "support") return Number(caps.support);
  return Number(caps.optional);
}

function scoreAnchorQuality(levelUsed, confidence) {
  const levelScore = {
    discipline_weekday_type: 10,
    discipline_weekday: 6,
    discipline: 3,
  }[String(levelUsed || "")] || 0;

  const confidenceScore = {
    high: 10,
    medium: 6,
    low: 3,
  }[String(confidence || "")] || 0;

  return Math.min(20, levelScore + confidenceScore);
}

function computeHabitMatchScore({ weekdayMatch, deviationMinutes, capMinutes, levelUsed, confidence }) {
  const weekdayScore = weekdayMatch ? 40 : 0;
  const cap = Number.isFinite(Number(capMinutes)) && Number(capMinutes) > 0 ? Number(capMinutes) : 1;
  const deviation = Math.max(0, Number(deviationMinutes || 0));
  const timeScore = 40 * Math.max(0, 1 - deviation / cap);
  const qualityScore = scoreAnchorQuality(levelUsed, confidence);
  const total = weekdayScore + timeScore + qualityScore;
  return Number(Math.max(0, Math.min(100, total)).toFixed(2));
}

function isRaceTaperWeek(plan) {
  const planFlag = Boolean(plan?.scheduling_context?.is_race_taper_week);
  if (planFlag) return true;
  const policyFlag = Boolean(plan?.scheduling_context?.scheduling_policy?.is_race_taper_week);
  if (policyFlag) return true;
  const phaseText = `${plan?.phase || ""} ${plan?.phase_intent || ""}`.toLowerCase();
  return /(race|taper|peak)/.test(phaseText);
}

function getEffectiveHabitPolicy(plan) {
  const raceWeek = isRaceTaperWeek(plan);
  const policy = plan?.scheduling_context?.scheduling_policy || {};

  const multiplier = raceWeek ? Number(policy.race_taper_multiplier || RACE_TAPER_MULTIPLIER) : 1;

  const capsFromPolicy = policy.time_deviation_caps_min || {};
  const caps = {
    key: Number.isFinite(Number(capsFromPolicy.key)) ? Number(capsFromPolicy.key) : Math.round(BASE_CAPS.key * multiplier),
    support: Number.isFinite(Number(capsFromPolicy.support))
      ? Number(capsFromPolicy.support)
      : Math.round(BASE_CAPS.support * multiplier),
    optional: Number.isFinite(Number(capsFromPolicy.optional))
      ? Number(capsFromPolicy.optional)
      : Math.round(BASE_CAPS.optional * multiplier),
  };

  const ratioDefault = raceWeek ? RACE_TAPER_WEEKDAY_CHANGE_RATIO : BASE_WEEKDAY_CHANGE_RATIO;
  const ratio = Number.isFinite(Number(policy.weekday_change_budget_ratio))
    ? Number(policy.weekday_change_budget_ratio)
    : ratioDefault;

  return {
    raceWeek,
    caps,
    weekdayRatio: ratio,
  };
}

function violation(code, message) {
  return { code, message };
}

function isoDateShiftDays(isoDate, days) {
  if (!isoDate || typeof isoDate !== "string") return null;
  const dt = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function parseRepSpec(value) {
  if (isPositiveInteger(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const direct = trimmed.match(/^(\d+)$/);
  if (direct) return Number(direct[1]);
  const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!range) return null;
  const low = Number(range[1]);
  const high = Number(range[2]);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= 0 || high < low) return null;
  return (low + high) / 2;
}

function isSchedulableNonRestSession(session) {
  if (!session || typeof session !== "object") return false;
  const discipline = String(session?.discipline || "").toLowerCase();
  if (!discipline || discipline === "rest") return false;
  const duration = Number(session?.duration_min || 0);
  return Number.isFinite(duration) && duration > 0;
}

function validateNeedsUserInputStructure(plan) {
  const violations = [];
  const list = plan?.needs_user_input;
  if (list == null) return violations;

  if (!Array.isArray(list)) {
    violations.push(violation("ASK_BEFORE_DOWNSHIFT_INVALID", "needs_user_input must be an array when present"));
    return violations;
  }

  for (const [index, item] of list.entries()) {
    const label = `needs_user_input[${index}]`;
    if (!item || typeof item !== "object") {
      violations.push(violation("ASK_BEFORE_DOWNSHIFT_INVALID", `${label} must be an object`));
      continue;
    }
    if (!isNonEmptyString(item.question)) {
      violations.push(violation("ASK_BEFORE_DOWNSHIFT_INVALID", `${label}.question must be non-empty`));
    }
    if (!isNonEmptyString(item.reason)) {
      violations.push(violation("ASK_BEFORE_DOWNSHIFT_INVALID", `${label}.reason must be non-empty`));
    }
    if (!isStringArray(item.options, { nonEmpty: true }) || item.options.length < 2) {
      violations.push(
        violation("ASK_BEFORE_DOWNSHIFT_INVALID", `${label}.options must be string array with at least two options`)
      );
    }
  }

  return violations;
}

function validateProgressionTraceStructure(session) {
  const violations = [];
  const discipline = String(session?.discipline || "").toLowerCase();
  if (!TRAINABLE_DISCIPLINES.includes(discipline)) return violations;

  const label = session?.id || "unknown-id";
  const trace = session?.progression_trace;
  if (!trace || typeof trace !== "object") {
    violations.push(violation("PROGRESSION_TRACE_INVALID", `${label}: missing progression_trace object`));
    return violations;
  }

  const phaseMode = String(trace.phase_mode || "").toLowerCase();
  if (!ALLOWED_GENERIC_PHASE_MODES.includes(phaseMode)) {
    violations.push(
      violation(
        "PROGRESSION_TRACE_INVALID",
        `${label}: progression_trace.phase_mode must be one of ${ALLOWED_GENERIC_PHASE_MODES.join(", ")}`
      )
    );
  }

  const comparison = String(trace.progression_comparison || "").toLowerCase();
  if (!ALLOWED_GENERIC_PROGRESSION_COMPARISONS.includes(comparison)) {
    violations.push(
      violation(
        "PROGRESSION_TRACE_INVALID",
        `${label}: progression_trace.progression_comparison must be one of ${ALLOWED_GENERIC_PROGRESSION_COMPARISONS.join(", ")}`
      )
    );
  }

  const priorId = trace.prior_week_session_id;
  if (priorId !== null && !isNonEmptyString(priorId)) {
    violations.push(
      violation("PROGRESSION_TRACE_INVALID", `${label}: progression_trace.prior_week_session_id must be string or null`)
    );
  }

  if (!isNonEmptyString(trace.progression_decision)) {
    violations.push(
      violation("PROGRESSION_TRACE_INVALID", `${label}: progression_trace.progression_decision must be non-empty`)
    );
  }

  if (!isStringArray(trace.progressed_fields)) {
    violations.push(
      violation("PROGRESSION_TRACE_INVALID", `${label}: progression_trace.progressed_fields must be an array of strings`)
    );
  }

  if (!isNonEmptyString(trace.load_delta_summary)) {
    violations.push(
      violation("PROGRESSION_TRACE_INVALID", `${label}: progression_trace.load_delta_summary must be non-empty`)
    );
  }

  if (!isNonEmptyString(trace.regression_rule)) {
    violations.push(violation("PROGRESSION_TRACE_INVALID", `${label}: progression_trace.regression_rule must be non-empty`));
  }

  if (!isNonEmptyString(trace.goal_link)) {
    violations.push(violation("PROGRESSION_TRACE_INVALID", `${label}: progression_trace.goal_link must be non-empty`));
  }

  return violations;
}

function validateBikePrescriptionStructure(session) {
  const violations = [];
  if (String(session?.discipline || "").toLowerCase() !== "bike") return violations;

  const label = session?.id || "unknown-id";
  const prescription = session?.bike_prescription;
  if (!prescription || typeof prescription !== "object") {
    violations.push(violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: missing bike_prescription object`));
    return violations;
  }

  if (!isNonEmptyString(prescription.session_objective)) {
    violations.push(
      violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: bike_prescription.session_objective must be non-empty`)
    );
  }

  const targetSystem = String(prescription.target_system || "").toLowerCase();
  if (!ALLOWED_TARGET_SYSTEMS.includes(targetSystem)) {
    violations.push(
      violation(
        "DISCIPLINE_PRESCRIPTION_INVALID",
        `${label}: bike_prescription.target_system must be one of ${ALLOWED_TARGET_SYSTEMS.join(", ")}`
      )
    );
  }

  const blocks = Array.isArray(prescription.blocks) ? prescription.blocks : [];
  if (!blocks.length) {
    violations.push(violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: bike_prescription.blocks must be non-empty`));
    return violations;
  }

  for (const [index, block] of blocks.entries()) {
    if (!block || typeof block !== "object") {
      violations.push(
        violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: bike_prescription.blocks[${index}] must be object`)
      );
      continue;
    }
    if (!isNonEmptyString(block.block_label)) {
      violations.push(
        violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: bike_prescription.blocks[${index}].block_label missing`)
      );
    }
    if (!isPositiveInteger(Number(block.duration_min))) {
      violations.push(
        violation(
          "DISCIPLINE_PRESCRIPTION_INVALID",
          `${label}: bike_prescription.blocks[${index}].duration_min must be positive integer`
        )
      );
    }
    if (!isNonEmptyString(block.work_interval) || !isNonEmptyString(block.recovery_interval)) {
      violations.push(
        violation(
          "DISCIPLINE_PRESCRIPTION_INVALID",
          `${label}: bike_prescription.blocks[${index}] work_interval and recovery_interval are required`
        )
      );
    }
    if (!isPositiveInteger(Number(block.repetitions))) {
      violations.push(
        violation(
          "DISCIPLINE_PRESCRIPTION_INVALID",
          `${label}: bike_prescription.blocks[${index}].repetitions must be positive integer`
        )
      );
    }
    const targetMetric = String(block.target_metric || "").toLowerCase();
    if (!ALLOWED_BIKE_TARGET_METRICS.includes(targetMetric)) {
      violations.push(
        violation(
          "DISCIPLINE_PRESCRIPTION_INVALID",
          `${label}: bike_prescription.blocks[${index}].target_metric must be one of ${ALLOWED_BIKE_TARGET_METRICS.join(", ")}`
        )
      );
    }
    if (!isNonEmptyString(block.target_range)) {
      violations.push(
        violation(
          "DISCIPLINE_PRESCRIPTION_INVALID",
          `${label}: bike_prescription.blocks[${index}].target_range must be non-empty`
        )
      );
    }
    if (!isStringArray(block.execution_cues, { nonEmpty: true })) {
      violations.push(
        violation(
          "DISCIPLINE_PRESCRIPTION_INVALID",
          `${label}: bike_prescription.blocks[${index}].execution_cues must be non-empty string array`
        )
      );
    }
    if (!isStringArray(block.success_criteria, { nonEmpty: true })) {
      violations.push(
        violation(
          "DISCIPLINE_PRESCRIPTION_INVALID",
          `${label}: bike_prescription.blocks[${index}].success_criteria must be non-empty string array`
        )
      );
    }
    if (!isNonEmptyString(block.failure_adjustment)) {
      violations.push(
        violation(
          "DISCIPLINE_PRESCRIPTION_INVALID",
          `${label}: bike_prescription.blocks[${index}].failure_adjustment must be non-empty`
        )
      );
    }
  }

  return violations;
}

function validateRunPrescriptionStructure(session) {
  const violations = [];
  if (String(session?.discipline || "").toLowerCase() !== "run") return violations;

  const label = session?.id || "unknown-id";
  const prescription = session?.run_prescription;
  if (!prescription || typeof prescription !== "object") {
    violations.push(violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: missing run_prescription object`));
    return violations;
  }

  if (!isNonEmptyString(prescription.session_objective)) {
    violations.push(
      violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: run_prescription.session_objective must be non-empty`)
    );
  }

  const targetSystem = String(prescription.target_system || "").toLowerCase();
  if (!ALLOWED_TARGET_SYSTEMS.includes(targetSystem)) {
    violations.push(
      violation(
        "DISCIPLINE_PRESCRIPTION_INVALID",
        `${label}: run_prescription.target_system must be one of ${ALLOWED_TARGET_SYSTEMS.join(", ")}`
      )
    );
  }

  const blocks = Array.isArray(prescription.blocks) ? prescription.blocks : [];
  if (!blocks.length) {
    violations.push(violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: run_prescription.blocks must be non-empty`));
  } else {
    for (const [index, block] of blocks.entries()) {
      if (!block || typeof block !== "object") {
        violations.push(
          violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: run_prescription.blocks[${index}] must be object`)
        );
        continue;
      }

      if (!isNonEmptyString(block.block_label)) {
        violations.push(
          violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: run_prescription.blocks[${index}].block_label missing`)
        );
      }
      const hasDuration = isPositiveInteger(Number(block.duration_min));
      const hasDistance = isPositiveInteger(Number(block.distance_m));
      if (!hasDuration && !hasDistance) {
        violations.push(
          violation(
            "DISCIPLINE_PRESCRIPTION_INVALID",
            `${label}: run_prescription.blocks[${index}].duration_min or distance_m must be a positive integer`
          )
        );
      }
      const targetMetric = String(block.target_metric || "").toLowerCase();
      if (!ALLOWED_RUN_TARGET_METRICS.includes(targetMetric)) {
        violations.push(
          violation(
            "DISCIPLINE_PRESCRIPTION_INVALID",
            `${label}: run_prescription.blocks[${index}].target_metric must be one of ${ALLOWED_RUN_TARGET_METRICS.join(", ")}`
          )
        );
      }
      if (!isNonEmptyString(block.target_range) || !isNonEmptyString(block.terrain_or_mode)) {
        violations.push(
          violation(
            "DISCIPLINE_PRESCRIPTION_INVALID",
            `${label}: run_prescription.blocks[${index}] target_range and terrain_or_mode are required`
          )
        );
      }
      if (!isStringArray(block.execution_cues, { nonEmpty: true })) {
        violations.push(
          violation(
            "DISCIPLINE_PRESCRIPTION_INVALID",
            `${label}: run_prescription.blocks[${index}].execution_cues must be non-empty string array`
          )
        );
      }
      if (!isStringArray(block.success_criteria, { nonEmpty: true })) {
        violations.push(
          violation(
            "DISCIPLINE_PRESCRIPTION_INVALID",
            `${label}: run_prescription.blocks[${index}].success_criteria must be non-empty string array`
          )
        );
      }
      if (!isNonEmptyString(block.failure_adjustment)) {
        violations.push(
          violation(
            "DISCIPLINE_PRESCRIPTION_INVALID",
            `${label}: run_prescription.blocks[${index}].failure_adjustment must be non-empty`
          )
        );
      }
    }
  }

  const impact = prescription?.impact_management;
  if (!impact || typeof impact !== "object") {
    violations.push(
      violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: run_prescription.impact_management must be object`)
    );
  } else {
    if (!isNonEmptyString(impact.surface) || !isNonEmptyString(impact.cadence_cue) || !isNonEmptyString(impact.stride_cue)) {
      violations.push(
        violation(
          "DISCIPLINE_PRESCRIPTION_INVALID",
          `${label}: run_prescription.impact_management surface/cadence_cue/stride_cue are required`
        )
      );
    }
  }

  if (!isStringArray(prescription.success_criteria, { nonEmpty: true })) {
    violations.push(
      violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: run_prescription.success_criteria must be non-empty string array`)
    );
  }
  if (!isNonEmptyString(prescription.failure_adjustment)) {
    violations.push(
      violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: run_prescription.failure_adjustment must be non-empty`)
    );
  }

  return violations;
}

function validateSwimPrescriptionStructure(session) {
  const violations = [];
  if (String(session?.discipline || "").toLowerCase() !== "swim") return violations;

  const label = session?.id || "unknown-id";
  const prescription = session?.swim_prescription;
  if (!prescription || typeof prescription !== "object") {
    violations.push(violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: missing swim_prescription object`));
    return violations;
  }

  if (!isNonEmptyString(prescription.session_objective)) {
    violations.push(
      violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: swim_prescription.session_objective must be non-empty`)
    );
  }

  const targetSystem = String(prescription.target_system || "").toLowerCase();
  if (!ALLOWED_TARGET_SYSTEMS.includes(targetSystem)) {
    violations.push(
      violation(
        "DISCIPLINE_PRESCRIPTION_INVALID",
        `${label}: swim_prescription.target_system must be one of ${ALLOWED_TARGET_SYSTEMS.join(", ")}`
      )
    );
  }

  const blocks = Array.isArray(prescription.blocks) ? prescription.blocks : [];
  if (!blocks.length) {
    violations.push(violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: swim_prescription.blocks must be non-empty`));
  } else {
    for (const [index, block] of blocks.entries()) {
      if (!block || typeof block !== "object") {
        violations.push(
          violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: swim_prescription.blocks[${index}] must be object`)
        );
        continue;
      }
      if (!isNonEmptyString(block.block_label)) {
        violations.push(
          violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: swim_prescription.blocks[${index}].block_label missing`)
        );
      }
      if (!isPositiveInteger(Number(block.distance_m)) || !isPositiveInteger(Number(block.repetitions))) {
        violations.push(
          violation(
            "DISCIPLINE_PRESCRIPTION_INVALID",
            `${label}: swim_prescription.blocks[${index}] distance_m/repetitions must be positive integers`
          )
        );
      }
      if (!Number.isInteger(Number(block.rest_sec)) || Number(block.rest_sec) < 0) {
        violations.push(
          violation(
            "DISCIPLINE_PRESCRIPTION_INVALID",
            `${label}: swim_prescription.blocks[${index}].rest_sec must be non-negative integer`
          )
        );
      }
      if (!isNonEmptyString(block.sendoff) || !isNonEmptyString(String(block.target_rpe || ""))) {
        violations.push(
          violation(
            "DISCIPLINE_PRESCRIPTION_INVALID",
            `${label}: swim_prescription.blocks[${index}] sendoff and target_rpe are required`
          )
        );
      }
      if (!isStringArray(block.execution_cues, { nonEmpty: true })) {
        violations.push(
          violation(
            "DISCIPLINE_PRESCRIPTION_INVALID",
            `${label}: swim_prescription.blocks[${index}].execution_cues must be non-empty string array`
          )
        );
      }
      if (!isStringArray(block.success_criteria, { nonEmpty: true })) {
        violations.push(
          violation(
            "DISCIPLINE_PRESCRIPTION_INVALID",
            `${label}: swim_prescription.blocks[${index}].success_criteria must be non-empty string array`
          )
        );
      }
      if (!isNonEmptyString(block.failure_adjustment)) {
        violations.push(
          violation(
            "DISCIPLINE_PRESCRIPTION_INVALID",
            `${label}: swim_prescription.blocks[${index}].failure_adjustment must be non-empty`
          )
        );
      }
    }
  }

  if (!isStringArray(prescription.technique_focus, { nonEmpty: true })) {
    violations.push(
      violation(
        "DISCIPLINE_PRESCRIPTION_INVALID",
        `${label}: swim_prescription.technique_focus must be non-empty string array`
      )
    );
  }
  if (!isStringArray(prescription.success_criteria, { nonEmpty: true })) {
    violations.push(
      violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: swim_prescription.success_criteria must be non-empty string array`)
    );
  }
  if (!isNonEmptyString(prescription.failure_adjustment)) {
    violations.push(
      violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: swim_prescription.failure_adjustment must be non-empty`)
    );
  }

  return violations;
}

function validateNutritionPrescriptionStructure(session) {
  const violations = [];
  if (!isSchedulableNonRestSession(session)) return violations;

  const label = session?.id || "unknown-id";
  const prescription = session?.nutrition_prescription;
  if (!prescription || typeof prescription !== "object") {
    violations.push(
      violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: missing nutrition_prescription for non-rest schedulable session`)
    );
    return violations;
  }

  const requiredFields = [
    "pre_session",
    "during_session",
    "post_session",
    "daily_recovery_target",
    "session_specific_adjustment",
  ];
  for (const field of requiredFields) {
    if (!isNonEmptyString(prescription[field])) {
      violations.push(
        violation("DISCIPLINE_PRESCRIPTION_INVALID", `${label}: nutrition_prescription.${field} must be non-empty`)
      );
    }
  }
  if (!isStringArray(prescription.compliance_markers, { nonEmpty: true })) {
    violations.push(
      violation(
        "DISCIPLINE_PRESCRIPTION_INVALID",
        `${label}: nutrition_prescription.compliance_markers must be non-empty string array`
      )
    );
  }

  return violations;
}

function resolveStrengthPhaseMode(plan, strategy) {
  const fromPlan = String(plan?.phase || "").toLowerCase();
  if (fromPlan.includes("deload")) return "deload";
  if (fromPlan.includes("taper") || fromPlan.includes("peak") || fromPlan.includes("race")) return "taper";
  if (fromPlan.includes("build")) return "build";
  if (fromPlan.includes("maintain")) return "maintain";

  const fromStrategy = String(strategy?.phase_intent || "").toLowerCase();
  if (fromStrategy.includes("deload")) return "deload";
  if (fromStrategy.includes("taper") || fromStrategy.includes("peak") || fromStrategy.includes("race")) return "taper";
  if (fromStrategy.includes("build")) return "build";
  if (fromStrategy.includes("maintain")) return "maintain";

  return "maintain";
}

function validateStrengthPrescriptionStructure(session) {
  const violations = [];
  if (String(session?.discipline || "").toLowerCase() !== "strength") return violations;

  const label = session?.id || "unknown-id";
  const prescription = session?.strength_prescription;
  if (!prescription || typeof prescription !== "object") {
    violations.push(
      violation("STRENGTH_PRESCRIPTION_INVALID", `${label}: missing strength_prescription object for strength session`)
    );
    return violations;
  }

  const phaseMode = String(prescription.phase_mode || "").toLowerCase();
  if (!ALLOWED_STRENGTH_PHASE_MODES.includes(phaseMode)) {
    violations.push(
      violation(
        "STRENGTH_PRESCRIPTION_INVALID",
        `${label}: strength_prescription.phase_mode must be one of ${ALLOWED_STRENGTH_PHASE_MODES.join(", ")}`
      )
    );
  }

  if (typeof prescription.progression_decision !== "string" || !prescription.progression_decision.trim()) {
    violations.push(
      violation("STRENGTH_PRESCRIPTION_INVALID", `${label}: strength_prescription.progression_decision must be non-empty`)
    );
  }

  const progressionComparison = String(prescription.progression_comparison || "").toLowerCase();
  if (!ALLOWED_STRENGTH_PROGRESSION_COMPARISONS.includes(progressionComparison)) {
    violations.push(
      violation(
        "STRENGTH_PRESCRIPTION_INVALID",
        `${label}: strength_prescription.progression_comparison must be one of ${ALLOWED_STRENGTH_PROGRESSION_COMPARISONS.join(", ")}`
      )
    );
  }

  if (!Array.isArray(prescription.exercises) || !prescription.exercises.length) {
    violations.push(
      violation("STRENGTH_PRESCRIPTION_INVALID", `${label}: strength_prescription.exercises must be a non-empty array`)
    );
    return violations;
  }

  for (const [index, exercise] of prescription.exercises.entries()) {
    if (!exercise || typeof exercise !== "object") {
      violations.push(
        violation("STRENGTH_PRESCRIPTION_INVALID", `${label}: exercises[${index}] must be an object`)
      );
      continue;
    }

    const category = String(exercise.category || "").toLowerCase();
    if (!ALLOWED_STRENGTH_CATEGORIES.includes(category)) {
      violations.push(
        violation(
          "STRENGTH_PRESCRIPTION_INVALID",
          `${label}: exercises[${index}].category must be one of ${ALLOWED_STRENGTH_CATEGORIES.join(", ")}`
        )
      );
    }

    if (typeof exercise.exercise_name !== "string" || !exercise.exercise_name.trim()) {
      violations.push(
        violation("STRENGTH_PRESCRIPTION_INVALID", `${label}: exercises[${index}].exercise_name must be non-empty`)
      );
    }

    if (typeof exercise.injury_target !== "string" || !exercise.injury_target.trim()) {
      violations.push(
        violation("STRENGTH_PRESCRIPTION_INVALID", `${label}: exercises[${index}].injury_target must be non-empty`)
      );
    }

    if (typeof exercise.sport_transfer_target !== "string" || !exercise.sport_transfer_target.trim()) {
      violations.push(
        violation(
          "STRENGTH_PRESCRIPTION_INVALID",
          `${label}: exercises[${index}].sport_transfer_target must be non-empty`
        )
      );
    }

    if (!isPositiveInteger(exercise.sets)) {
      violations.push(
        violation("STRENGTH_PRESCRIPTION_INVALID", `${label}: exercises[${index}].sets must be positive integer`)
      );
    }

    if (!Number.isFinite(parseRepSpec(exercise.reps))) {
      violations.push(
        violation(
          "STRENGTH_PRESCRIPTION_INVALID",
          `${label}: exercises[${index}].reps must be positive integer or rep-range string`
        )
      );
    }

    if (typeof exercise.tempo !== "string" || !exercise.tempo.trim()) {
      violations.push(violation("STRENGTH_PRESCRIPTION_INVALID", `${label}: exercises[${index}].tempo must be non-empty`));
    }

    if (!isPositiveInteger(exercise.rest_sec)) {
      violations.push(
        violation("STRENGTH_PRESCRIPTION_INVALID", `${label}: exercises[${index}].rest_sec must be positive integer`)
      );
    }

    const load = exercise.load;
    if (!load || typeof load !== "object") {
      violations.push(violation("STRENGTH_PRESCRIPTION_INVALID", `${label}: exercises[${index}].load must be object`));
      continue;
    }

    if (String(load.method || "").toLowerCase() !== "rpe_rir") {
      violations.push(
        violation("STRENGTH_PRESCRIPTION_INVALID", `${label}: exercises[${index}].load.method must be rpe_rir`)
      );
    }

    if (!Number.isFinite(Number(load.target_rpe))) {
      violations.push(
        violation("STRENGTH_PRESCRIPTION_INVALID", `${label}: exercises[${index}].load.target_rpe must be numeric`)
      );
    }

    if (!Number.isFinite(Number(load.target_rir))) {
      violations.push(
        violation("STRENGTH_PRESCRIPTION_INVALID", `${label}: exercises[${index}].load.target_rir must be numeric`)
      );
    }

    const progressionAxis = String(load.progression_axis || "").toLowerCase();
    if (!ALLOWED_STRENGTH_PROGRESSION_AXES.includes(progressionAxis)) {
      violations.push(
        violation(
          "STRENGTH_PRESCRIPTION_INVALID",
          `${label}: exercises[${index}].load.progression_axis must be one of ${ALLOWED_STRENGTH_PROGRESSION_AXES.join(", ")}`
        )
      );
    }

    if (typeof load.regression_rule !== "string" || !load.regression_rule.trim()) {
      violations.push(
        violation(
          "STRENGTH_PRESCRIPTION_INVALID",
          `${label}: exercises[${index}].load.regression_rule must be non-empty`
        )
      );
    }
  }

  return violations;
}

function totalHardSets(session) {
  const prescription = session?.strength_prescription;
  if (!prescription || !Array.isArray(prescription.exercises)) return 0;
  return prescription.exercises.reduce((sum, exercise) => {
    const sets = Number(exercise?.sets || 0);
    return Number.isFinite(sets) && sets > 0 ? sum + sets : sum;
  }, 0);
}

function findComparablePriorStrengthSession(currentSession, priorStrengthSessions) {
  if (!Array.isArray(priorStrengthSessions) || !priorStrengthSessions.length) return null;
  const sameType = priorStrengthSessions.find(
    (candidate) => String(candidate?.type || "").toLowerCase() === String(currentSession?.type || "").toLowerCase()
  );
  if (sameType) return sameType;

  const sameCanonical = priorStrengthSessions.find(
    (candidate) =>
      String(candidate?.canonical_type || "").toLowerCase() === String(currentSession?.canonical_type || "").toLowerCase()
  );
  if (sameCanonical) return sameCanonical;

  return priorStrengthSessions[0];
}

function buildExerciseMap(session) {
  const map = new Map();
  const exercises = session?.strength_prescription?.exercises;
  if (!Array.isArray(exercises)) return map;
  for (const exercise of exercises) {
    const key = String(exercise?.exercise_name || "").trim().toLowerCase();
    if (!key) continue;
    map.set(key, exercise);
  }
  return map;
}

function exerciseProgressDelta(currentExercise, priorExercise) {
  const axis = String(currentExercise?.load?.progression_axis || "").toLowerCase();
  if (!priorExercise) return { axis, progressed: false, magnitude: 0 };

  if (axis === "sets") {
    const delta = Number(currentExercise?.sets || 0) - Number(priorExercise?.sets || 0);
    return { axis, progressed: delta > 0, magnitude: delta };
  }

  if (axis === "reps") {
    const currentReps = parseRepSpec(currentExercise?.reps);
    const priorReps = parseRepSpec(priorExercise?.reps);
    const delta = Number(currentReps || 0) - Number(priorReps || 0);
    return { axis, progressed: delta > 0, magnitude: delta };
  }

  if (axis === "tempo") {
    const progressed = String(currentExercise?.tempo || "").trim() !== String(priorExercise?.tempo || "").trim();
    return { axis, progressed, magnitude: progressed ? 1 : 0 };
  }

  if (axis === "density") {
    const delta = Number(priorExercise?.rest_sec || 0) - Number(currentExercise?.rest_sec || 0);
    return { axis, progressed: delta > 0, magnitude: delta };
  }

  if (axis === "load") {
    const rpeDelta = Number(currentExercise?.load?.target_rpe || 0) - Number(priorExercise?.load?.target_rpe || 0);
    const rirDelta = Number(priorExercise?.load?.target_rir || 0) - Number(currentExercise?.load?.target_rir || 0);
    const magnitude = Math.max(rpeDelta, rirDelta);
    return { axis, progressed: magnitude > 0, magnitude };
  }

  return { axis, progressed: false, magnitude: 0 };
}

function hasPriorWeekRiskFlag(plan) {
  const flags = Array.isArray(plan?.scheduling_risk_flags) ? plan.scheduling_risk_flags : [];
  for (const flag of flags) {
    if (typeof flag === "string" && /prior week|prior-week|no prior/i.test(flag)) return true;
    if (flag && typeof flag === "object") {
      const text = `${flag.id || ""} ${flag.description || ""} ${flag.mitigation || ""}`;
      if (/prior week|prior-week|no prior/i.test(text)) return true;
    }
  }
  return false;
}

function hasProgressionRiskFlag(plan) {
  const flags = Array.isArray(plan?.scheduling_risk_flags) ? plan.scheduling_risk_flags : [];
  return flags.some((flag) => {
    if (typeof flag === "string") return /prior week|prior-week|no prior|progression confidence|lower confidence/i.test(flag);
    if (flag && typeof flag === "object") {
      const text = `${flag.id || ""} ${flag.description || ""} ${flag.mitigation || ""}`;
      return /prior week|prior-week|no prior|progression confidence|lower confidence/i.test(text);
    }
    return false;
  });
}

function findComparablePriorSession(currentSession, priorSessions) {
  if (!Array.isArray(priorSessions) || !priorSessions.length) return null;

  const sameDiscipline = priorSessions.filter(
    (candidate) =>
      String(candidate?.discipline || "").toLowerCase() === String(currentSession?.discipline || "").toLowerCase()
  );
  if (!sameDiscipline.length) return null;

  const sameType = sameDiscipline.find(
    (candidate) => String(candidate?.type || "").toLowerCase() === String(currentSession?.type || "").toLowerCase()
  );
  if (sameType) return sameType;

  const sameCanonical = sameDiscipline.find(
    (candidate) =>
      String(candidate?.canonical_type || "").toLowerCase() === String(currentSession?.canonical_type || "").toLowerCase()
  );
  if (sameCanonical) return sameCanonical;

  return sameDiscipline[0];
}

function readValueByPath(root, dottedPath) {
  if (!root || typeof root !== "object") return undefined;
  if (!isNonEmptyString(dottedPath)) return undefined;
  const parts = dottedPath.split(".").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  let current = root;
  for (const part of parts) {
    if (current == null || typeof current !== "object" || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function valuesDiffer(currentValue, priorValue) {
  return JSON.stringify(currentValue) !== JSON.stringify(priorValue);
}

function goalLinkLooksRelevant(goalLink, discipline, strategy, goals) {
  const normalized = String(goalLink || "").toLowerCase();
  if (!normalized) return false;
  if (normalized.includes(String(discipline || "").toLowerCase())) return true;

  const primaryGoalName = String(goals?.primary_goal?.name || strategy?.primary_goal?.name || "").toLowerCase();
  if (primaryGoalName && normalized.includes(primaryGoalName)) return true;

  const primaryGoalEntry = Array.isArray(goals?.goals)
    ? goals.goals.find((goal) => /primary|a_race/i.test(String(goal?.type || "")))
    : null;
  const primaryGoalId = String(primaryGoalEntry?.id || "").toLowerCase();
  if (primaryGoalId && normalized.includes(primaryGoalId)) return true;

  return normalized.includes("primary_goal");
}

function phaseRequiresProgression(phaseMode) {
  return phaseMode === "build" || phaseMode === "maintain";
}

function phaseRequiresReduction(phaseMode) {
  return phaseMode === "taper" || phaseMode === "deload";
}

function validateGenericProgression(planPath, plan, strategy = null, goals = null) {
  const violations = [];
  const trainableSessions = (plan?.sessions || []).filter((session) =>
    TRAINABLE_DISCIPLINES.includes(String(session?.discipline || "").toLowerCase())
  );
  if (!trainableSessions.length) return violations;

  for (const session of trainableSessions) {
    violations.push(...validateProgressionTraceStructure(session));
  }
  if (violations.length) return violations;

  const previousWeekStart = isoDateShiftDays(String(plan?.week_start || ""), -7);
  const previousPlanPath =
    previousWeekStart && planPath ? path.join(path.dirname(planPath), `${previousWeekStart}.json`) : null;
  const previousPlan = previousPlanPath ? readJson(previousPlanPath) : null;
  const priorSessions = Array.isArray(previousPlan?.sessions) ? previousPlan.sessions : [];

  let missingPriorReference = false;
  const resolvedPhase = resolveStrengthPhaseMode(plan, strategy);

  for (const session of trainableSessions) {
    const label = session?.id || "unknown-id";
    const trace = session.progression_trace || {};
    const tracePhase = String(trace.phase_mode || "").toLowerCase();
    const comparison = String(trace.progression_comparison || "").toLowerCase();
    const discipline = String(session?.discipline || "").toLowerCase();

    if (tracePhase !== resolvedPhase) {
      violations.push(
        violation(
          "PROGRESSION_TRACE_INVALID",
          `${label}: progression_trace.phase_mode (${tracePhase}) does not match resolved phase (${resolvedPhase})`
        )
      );
    }

    if (!goalLinkLooksRelevant(trace.goal_link, discipline, strategy, goals)) {
      violations.push(
        violation("PROGRESSION_GOAL_LINK_INVALID", `${label}: progression_trace.goal_link must reference discipline or primary goal`)
      );
    }

    const prior = findComparablePriorSession(session, priorSessions);
    if (!prior) {
      if (comparison !== "none") {
        violations.push(
          violation(
            "PROGRESSION_PRIOR_WEEK_REFERENCE",
            `${label}: progression_comparison must be \"none\" when no prior-week reference exists`
          )
        );
      }
      if (trace.prior_week_session_id !== null) {
        violations.push(
          violation("PROGRESSION_PRIOR_WEEK_REFERENCE", `${label}: prior_week_session_id must be null when comparison=none`)
        );
      }
      missingPriorReference = true;
      continue;
    }

    if (comparison !== "prior_week_reference") {
      violations.push(
        violation(
          "PROGRESSION_PRIOR_WEEK_REFERENCE",
          `${label}: progression_comparison must be \"prior_week_reference\" when prior session exists`
        )
      );
      continue;
    }

    if (!isNonEmptyString(trace.prior_week_session_id)) {
      violations.push(
        violation("PROGRESSION_PRIOR_WEEK_REFERENCE", `${label}: prior_week_session_id is required with prior_week_reference`)
      );
    } else if (String(trace.prior_week_session_id) !== String(prior?.id || "")) {
      violations.push(
        violation(
          "PROGRESSION_PRIOR_WEEK_REFERENCE",
          `${label}: prior_week_session_id (${trace.prior_week_session_id}) does not match comparable prior session (${prior?.id || "unknown"})`
        )
      );
    }

    const progressedFields = Array.isArray(trace.progressed_fields) ? trace.progressed_fields : [];
    if (!progressedFields.length) {
      violations.push(
        violation("PROGRESSION_DELTA_INVALID", `${label}: progressed_fields must be non-empty when prior-week reference exists`)
      );
      continue;
    }

    let changedFieldCount = 0;
    for (const fieldPath of progressedFields) {
      const currentValue = readValueByPath(session, fieldPath);
      const priorValue = readValueByPath(prior, fieldPath);
      if (valuesDiffer(currentValue, priorValue)) changedFieldCount += 1;
    }

    if (phaseRequiresProgression(tracePhase) && changedFieldCount === 0) {
      violations.push(
        violation(
          "PROGRESSION_DELTA_INVALID",
          `${label}: progressed_fields do not reflect actual changes vs prior week for ${tracePhase} phase`
        )
      );
    }

    if (phaseRequiresReduction(tracePhase)) {
      const summary = String(trace.load_delta_summary || "").toLowerCase();
      if (!/(reduce|reduced|down|deload|taper|-\d|-\s*\d|less)/.test(summary)) {
        violations.push(
          violation(
            "PROGRESSION_DELTA_INVALID",
            `${label}: ${tracePhase} phase load_delta_summary must explicitly describe reduced load/volume`
          )
        );
      }
    }
  }

  if (missingPriorReference && !hasProgressionRiskFlag(plan)) {
    violations.push(
      violation(
        "PROGRESSION_PRIOR_WEEK_REFERENCE",
        `${path.basename(planPath)}: scheduling_risk_flags must note missing prior-week references when progression_comparison=none`
      )
    );
  }

  return violations;
}

function findLatestCheckin(projectDir) {
  try {
    const checkinDir = path.join(projectDir, "data", "coach", "checkins");
    const files = fs
      .readdirSync(checkinDir)
      .filter((name) => /^\\d{4}-\\d{2}-\\d{2}\\.json$/.test(name))
      .sort();
    if (!files.length) return null;
    return readJson(path.join(checkinDir, files[files.length - 1]));
  } catch {
    return null;
  }
}

function fatigueOrAdherenceTrigger(plan, latestCheckin) {
  const score = Number(plan?.scheduling_decisions?.habit_adherence_summary?.overall_habit_adherence_score);
  const lowAdherence = Number.isFinite(score) && score < 75;

  const pain = Number(latestCheckin?.pain);
  const soreness = Number(latestCheckin?.soreness);
  const stress = Number(latestCheckin?.stress);
  const motivation = Number(latestCheckin?.motivation);
  const sleep = Number(latestCheckin?.sleep);

  const fatigue = Boolean(
    (Number.isFinite(pain) && pain >= 6) ||
      (Number.isFinite(soreness) && soreness >= 7) ||
      (Number.isFinite(stress) && stress >= 8) ||
      (Number.isFinite(motivation) && motivation <= 3) ||
      (Number.isFinite(sleep) && sleep <= 2)
  );

  return { triggered: fatigue || lowAdherence, fatigue, lowAdherence };
}

function hasPendingUserDecision(plan) {
  return Array.isArray(plan?.needs_user_input) && plan.needs_user_input.length > 0;
}

function hasAutomaticDownshift(plan) {
  const adjustments = Array.isArray(plan?.scheduling_decisions?.adjustments) ? plan.scheduling_decisions.adjustments : [];
  const hasExplicitDowngrade = adjustments.some((item) =>
    /downgraded|downshift|reduced|shortened/i.test(`${item?.action || ""} ${item?.reason || ""} ${item?.impact || ""}`)
  );
  if (hasExplicitDowngrade) return true;

  const trainable = (plan?.sessions || []).filter((session) =>
    TRAINABLE_DISCIPLINES.includes(String(session?.discipline || "").toLowerCase())
  );
  return trainable.some((session) => /downshift|deloaded due to fatigue|reduced due to fatigue/i.test(String(session?.intent || "")));
}

function validateAskBeforeDownshift(plan, latestCheckin) {
  const violations = [];
  const triggerState = fatigueOrAdherenceTrigger(plan, latestCheckin);
  if (!triggerState.triggered) return violations;

  if (!hasPendingUserDecision(plan)) {
    violations.push(
      violation(
        "ASK_BEFORE_DOWNSHIFT_REQUIRED",
        "Fatigue/adherence trigger detected: plan must include needs_user_input options before applying load downshift"
      )
    );
    return violations;
  }

  if (hasAutomaticDownshift(plan)) {
    violations.push(
      violation(
        "ASK_BEFORE_DOWNSHIFT_REQUIRED",
        "Fatigue/adherence trigger detected: automatic downshift is not allowed before user selection"
      )
    );
  }

  return violations;
}

function validateStrengthProgression(planPath, plan, profile, strategy = null) {
  const violations = [];
  const strengthSessions = (plan?.sessions || []).filter(
    (session) => String(session?.discipline || "").toLowerCase() === "strength"
  );
  if (!strengthSessions.length) return violations;

  for (const session of strengthSessions) {
    violations.push(...validateStrengthPrescriptionStructure(session));
  }
  if (violations.length) return violations;

  const phaseMode = resolveStrengthPhaseMode(plan, strategy);
  const currentNiggles = Array.isArray(profile?.health?.current_niggles) ? profile.health.current_niggles : [];
  const conservativeMode = currentNiggles.length > 0;

  const previousWeekStart = isoDateShiftDays(String(plan?.week_start || ""), -7);
  const previousPlanPath =
    previousWeekStart && planPath ? path.join(path.dirname(planPath), `${previousWeekStart}.json`) : null;
  const previousPlan = previousPlanPath ? readJson(previousPlanPath) : null;
  const priorStrengthSessions = Array.isArray(previousPlan?.sessions)
    ? previousPlan.sessions.filter((session) => String(session?.discipline || "").toLowerCase() === "strength")
    : [];

  let missingPriorReference = false;

  for (const currentSession of strengthSessions) {
    const label = currentSession?.id || "unknown-id";
    const prescription = currentSession.strength_prescription;
    const sessionPhase = String(prescription.phase_mode || "").toLowerCase();
    if (sessionPhase !== phaseMode) {
      violations.push(
        violation(
          "STRENGTH_PHASE_MISMATCH",
          `${label}: strength_prescription.phase_mode (${sessionPhase}) does not match resolved phase (${phaseMode})`
        )
      );
    }

    if (conservativeMode) {
      for (const [index, exercise] of prescription.exercises.entries()) {
        const rule = String(exercise?.load?.regression_rule || "").toLowerCase();
        if (!/pain|fatigue/.test(rule)) {
          violations.push(
            violation(
              "STRENGTH_NIGGLE_GUARDRAIL",
              `${label}: exercises[${index}] regression_rule must explicitly reference pain/fatigue in niggle mode`
            )
          );
        }
      }
    }

    const priorSession = findComparablePriorStrengthSession(currentSession, priorStrengthSessions);
    const progressionComparison = String(prescription.progression_comparison || "").toLowerCase();

    if (!priorSession) {
      if (progressionComparison !== "none") {
        violations.push(
          violation(
            "STRENGTH_PRIOR_WEEK_REFERENCE",
            `${label}: progression_comparison must be "none" when no prior-week strength reference exists`
          )
        );
      }
      missingPriorReference = true;
      continue;
    }

    if (progressionComparison !== "prior_week_reference") {
      violations.push(
        violation(
          "STRENGTH_PRIOR_WEEK_REFERENCE",
          `${label}: progression_comparison must be "prior_week_reference" when comparable prior-week session exists`
        )
      );
    }

    const priorExercises = buildExerciseMap(priorSession);
    const currentExercises = buildExerciseMap(currentSession);
    let progressedCount = 0;
    let loadAxisUsed = false;
    const progressionAxes = new Set();

    for (const [name, exercise] of currentExercises.entries()) {
      const delta = exerciseProgressDelta(exercise, priorExercises.get(name));
      if (delta.progressed) progressedCount += 1;
      if (delta.progressed) progressionAxes.add(delta.axis);
      if (delta.axis === "load") loadAxisUsed = true;

      if (phaseMode === "build" && delta.axis === "sets" && delta.progressed && delta.magnitude > 1) {
        violations.push(
          violation("STRENGTH_BUILD_PROGRESS_INVALID", `${label}: sets progression must be +1 at most for build phase`)
        );
      }

      if (phaseMode === "build" && delta.axis === "reps" && delta.progressed) {
        const maxRepDelta = conservativeMode ? 1 : 2;
        if (delta.magnitude < 1 || delta.magnitude > maxRepDelta) {
          violations.push(
            violation(
              "STRENGTH_BUILD_PROGRESS_INVALID",
              `${label}: reps progression must be +1 to +${maxRepDelta} for build phase`
            )
          );
        }
      }

      if (phaseMode === "maintain" && delta.progressed && delta.axis === "reps" && delta.magnitude > 1) {
        violations.push(
          violation("STRENGTH_MAINTAIN_PROGRESS_INVALID", `${label}: maintain phase reps progression must be +1 at most`)
        );
      }

      if (phaseMode === "maintain" && delta.progressed && delta.axis === "sets" && delta.magnitude > 1) {
        violations.push(
          violation("STRENGTH_MAINTAIN_PROGRESS_INVALID", `${label}: maintain phase sets progression must be +1 at most`)
        );
      }
    }

    const currentHardSets = totalHardSets(currentSession);
    const priorHardSets = Math.max(1, totalHardSets(priorSession));
    const hardSetDeltaRatio = (currentHardSets - priorHardSets) / priorHardSets;

    if (phaseMode === "build") {
      const maxProgressedExercises = conservativeMode ? 2 : 3;
      if (progressedCount < 1 || progressedCount > maxProgressedExercises) {
        violations.push(
          violation(
            "STRENGTH_BUILD_PROGRESS_INVALID",
            `${label}: build phase must progress 1-${maxProgressedExercises} exercises (found ${progressedCount})`
          )
        );
      }

      const maxHardSetIncrease = conservativeMode ? 0.075 : 0.15;
      if (hardSetDeltaRatio > maxHardSetIncrease) {
        violations.push(
          violation(
            "STRENGTH_BUILD_PROGRESS_INVALID",
            `${label}: build hard-set increase ${(hardSetDeltaRatio * 100).toFixed(1)}% exceeds ${(maxHardSetIncrease * 100).toFixed(1)}% cap`
          )
        );
      }

      if (loadAxisUsed) {
        const decisionText = String(prescription.progression_decision || "");
        const percentageMatches = [...decisionText.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((match) => Number(match[1]));
        const minPct = conservativeMode ? 1.25 : 2.5;
        const maxPct = conservativeMode ? 3.75 : 7.5;
        const hasValidPct = percentageMatches.some((value) => value >= minPct && value <= maxPct);
        if (!hasValidPct) {
          violations.push(
            violation(
              "STRENGTH_BUILD_PROGRESS_INVALID",
              `${label}: load-axis build progression must cite ${minPct}-${maxPct}% change in progression_decision`
            )
          );
        }
      }
    }

    if (phaseMode === "maintain") {
      const lowerBound = conservativeMode ? -0.05 : -0.1;
      const upperBound = conservativeMode ? 0.05 : 0.1;
      if (hardSetDeltaRatio < lowerBound || hardSetDeltaRatio > upperBound) {
        violations.push(
          violation(
            "STRENGTH_MAINTAIN_PROGRESS_INVALID",
            `${label}: maintain hard-set delta ${(hardSetDeltaRatio * 100).toFixed(1)}% must be within ${(lowerBound * 100).toFixed(0)}% to ${(upperBound * 100).toFixed(0)}%`
          )
        );
      }

      if (progressedCount > 1 || progressionAxes.size > 1) {
        violations.push(
          violation(
            "STRENGTH_MAINTAIN_PROGRESS_INVALID",
            `${label}: maintain phase allows only one minor progression change`
          )
        );
      }
    }

    if (phaseMode === "taper" || phaseMode === "deload") {
      if (hardSetDeltaRatio > -0.25 || hardSetDeltaRatio < -0.4) {
        violations.push(
          violation(
            "STRENGTH_DELOAD_INVALID",
            `${label}: ${phaseMode} hard-set reduction ${(Math.abs(hardSetDeltaRatio) * 100).toFixed(1)}% must be 25%-40%`
          )
        );
      }

      const maxRpe = prescription.exercises.reduce((max, exercise) => {
        const value = Number(exercise?.load?.target_rpe || 0);
        if (!Number.isFinite(value)) return max;
        return Math.max(max, value);
      }, 0);
      if (maxRpe > 7) {
        violations.push(
          violation("STRENGTH_DELOAD_INVALID", `${label}: ${phaseMode} phase must cap target_rpe at <= 7`)
        );
      }
    }
  }

  if (missingPriorReference && !hasPriorWeekRiskFlag(plan)) {
    violations.push(
      violation(
        "STRENGTH_PRIOR_WEEK_REFERENCE",
        `${path.basename(planPath)}: scheduling_risk_flags must note missing prior-week strength reference when progression_comparison=none`
      )
    );
  }

  return violations;
}

function validateModelScheduledPlan(planPath, profile, options = {}) {
  const plan = readJson(planPath);
  if (!plan || !Array.isArray(plan.sessions)) {
    return [violation("MISSING_HABIT_METADATA", `${path.basename(planPath)}: invalid plan format (missing sessions array)`)];
  }

  const violations = [];

  if (!plan.scheduling_context || typeof plan.scheduling_context !== "object") {
    violations.push(violation("MISSING_HABIT_METADATA", `${path.basename(planPath)}: missing top-level scheduling_context`));
  }

  if (!plan.scheduling_decisions || typeof plan.scheduling_decisions !== "object") {
    violations.push(
      violation("MISSING_HABIT_METADATA", `${path.basename(planPath)}: missing top-level scheduling_decisions`)
    );
  }

  const adherenceSummary = plan?.scheduling_decisions?.habit_adherence_summary;
  if (!adherenceSummary || typeof adherenceSummary !== "object") {
    violations.push(
      violation(
        "MISSING_HABIT_METADATA",
        `${path.basename(planPath)}: missing scheduling_decisions.habit_adherence_summary`
      )
    );
  }

  if (!Array.isArray(plan.scheduling_risk_flags)) {
    violations.push(
      violation("MISSING_HABIT_METADATA", `${path.basename(planPath)}: scheduling_risk_flags must be an array`)
    );
  }
  violations.push(...validateNeedsUserInputStructure(plan));

  const policy = getEffectiveHabitPolicy(plan);
  const scheduled = [];
  let offHabitWeekdayCount = 0;
  let schedulableCount = 0;

  for (const session of plan.sessions) {
    violations.push(...validateProgressionTraceStructure(session));
    violations.push(...validateBikePrescriptionStructure(session));
    violations.push(...validateRunPrescriptionStructure(session));
    violations.push(...validateSwimPrescriptionStructure(session));
    violations.push(...validateNutritionPrescriptionStructure(session));

    if (String(session?.discipline || "").toLowerCase() === "rest") continue;
    if (!Number.isFinite(Number(session?.duration_min || NaN)) || Number(session.duration_min) <= 0) continue;

    schedulableCount += 1;

    if (!session?.scheduled_start_local || !session?.scheduled_end_local) {
      violations.push(
        violation(
          "MISSING_HABIT_METADATA",
          `${session.id || "unknown-id"}: missing scheduled_start_local/scheduled_end_local`
        )
      );
      continue;
    }

    const priority = String(session?.priority || "").toLowerCase();
    if (!priority) {
      violations.push(violation("MISSING_HABIT_METADATA", `${session.id || "unknown-id"}: missing priority`));
    }
    if (!session?.load_class) {
      violations.push(violation("MISSING_HABIT_METADATA", `${session.id || "unknown-id"}: missing load_class`));
    }

    const canonicalType = String(session?.canonical_type || "").toLowerCase();
    if (!CANONICAL_SESSION_TYPES.includes(canonicalType)) {
      violations.push(
        violation(
          "INVALID_CANONICAL_TYPE",
          `${session.id || "unknown-id"}: canonical_type must be one of ${CANONICAL_SESSION_TYPES.join(", ")}`
        )
      );
    }

    const habitAnchor = session?.habit_anchor;
    if (!habitAnchor || typeof habitAnchor !== "object") {
      violations.push(violation("MISSING_HABIT_METADATA", `${session.id || "unknown-id"}: missing habit_anchor object`));
    }

    const levelUsed = String(habitAnchor?.level_used || "");
    if (!ALLOWED_HABIT_LEVELS.includes(levelUsed)) {
      violations.push(
        violation(
          "MISSING_HABIT_METADATA",
          `${session.id || "unknown-id"}: habit_anchor.level_used must be one of ${ALLOWED_HABIT_LEVELS.join(", ")}`
        )
      );
    }

    const targetStart = parseDateTime(habitAnchor?.target_start_local);
    if (!targetStart) {
      violations.push(
        violation(
          "MISSING_HABIT_METADATA",
          `${session.id || "unknown-id"}: habit_anchor.target_start_local must be valid datetime`
        )
      );
    }

    const confidence = String(habitAnchor?.confidence || "").toLowerCase();
    if (!ALLOWED_HABIT_CONFIDENCE.includes(confidence)) {
      violations.push(
        violation(
          "MISSING_HABIT_METADATA",
          `${session.id || "unknown-id"}: habit_anchor.confidence must be low|medium|high`
        )
      );
    }

    const weekdayMatch = habitAnchor?.weekday_match;
    if (typeof weekdayMatch !== "boolean") {
      violations.push(
        violation(
          "MISSING_HABIT_METADATA",
          `${session.id || "unknown-id"}: habit_anchor.weekday_match must be boolean`
        )
      );
    }

    const habitMatchScore = Number(session?.habit_match_score);
    if (!Number.isFinite(habitMatchScore) || habitMatchScore < 0 || habitMatchScore > 100) {
      violations.push(
        violation("MISSING_HABIT_METADATA", `${session.id || "unknown-id"}: habit_match_score must be 0..100`)
      );
    }

    const deviationMinutes = Number(session?.deviation_minutes);
    if (!Number.isFinite(deviationMinutes) || deviationMinutes < 0) {
      violations.push(
        violation("MISSING_HABIT_METADATA", `${session.id || "unknown-id"}: deviation_minutes must be >= 0`)
      );
    }

    const capMinutes = getPriorityDeviationCapMinutes(priority || "optional", policy.caps);

    const expectedScore = computeHabitMatchScore({
      weekdayMatch: Boolean(weekdayMatch),
      deviationMinutes,
      capMinutes,
      levelUsed,
      confidence,
    });
    if (Number.isFinite(habitMatchScore) && Math.abs(expectedScore - habitMatchScore) > 1) {
      violations.push(
        violation(
          "MISSING_HABIT_METADATA",
          `${session.id || "unknown-id"}: habit_match_score (${habitMatchScore}) does not match scoring formula (${expectedScore})`
        )
      );
    }

    const deviationReason = String(session?.deviation_reason || "").trim();
    const exceptionCode = session?.exception_code == null ? null : String(session.exception_code).trim();

    if (exceptionCode && !ALLOWED_EXCEPTION_CODES.includes(exceptionCode)) {
      violations.push(
        violation(
          "INVALID_EXCEPTION_CODE",
          `${session.id || "unknown-id"}: exception_code must be one of ${ALLOWED_EXCEPTION_CODES.join(", ")}`
        )
      );
    }

    const exceedsCap = Number.isFinite(deviationMinutes) && deviationMinutes > capMinutes;
    if (exceedsCap) {
      violations.push(
        violation(
          "DEVIATION_CAP_EXCEEDED",
          `${session.id || "unknown-id"}: deviation_minutes ${deviationMinutes} exceeds ${priority || "optional"} cap ${capMinutes}`
        )
      );
    }

    const needsException = weekdayMatch === false || exceedsCap;
    if (needsException) {
      if (!deviationReason) {
        violations.push(
          violation(
            "MISSING_HABIT_METADATA",
            `${session.id || "unknown-id"}: deviation_reason is required for weekday mismatch or cap exceedance`
          )
        );
      }
      if (!exceptionCode) {
        violations.push(
          violation(
            "INVALID_EXCEPTION_CODE",
            `${session.id || "unknown-id"}: exception_code is required for weekday mismatch or cap exceedance`
          )
        );
      }
    }

    if (weekdayMatch === false) offHabitWeekdayCount += 1;

    const start = parseDateTime(session.scheduled_start_local);
    const end = parseDateTime(session.scheduled_end_local);
    if (!start || !end || end <= start) {
      violations.push(violation("MISSING_HABIT_METADATA", `${session.id || "unknown-id"}: invalid schedule range`));
      continue;
    }

    const expectedMin = Math.round((end.getTime() - start.getTime()) / 60000);
    const plannedMin = Number(session.duration_min);
    if (Math.abs(expectedMin - plannedMin) > 5) {
      violations.push(
        violation(
          "MISSING_HABIT_METADATA",
          `${session.id || "unknown-id"}: scheduled duration (${expectedMin}m) mismatches duration_min (${plannedMin}m)`
        )
      );
    }

    scheduled.push({ session, start, end, priority: priority || "optional" });
  }

  const offWeekdayBudget = Math.max(1, Math.floor(schedulableCount * Number(policy.weekdayRatio || BASE_WEEKDAY_CHANGE_RATIO)));
  if (offHabitWeekdayCount > offWeekdayBudget) {
    violations.push(
      violation(
        "WEEKDAY_CHANGE_BUDGET_EXCEEDED",
        `off-habit weekday sessions ${offHabitWeekdayCount} exceeds budget ${offWeekdayBudget}`
      )
    );
  }

  for (let i = 0; i < scheduled.length; i += 1) {
    for (let j = i + 1; j < scheduled.length; j += 1) {
      const a = scheduled[i];
      const b = scheduled[j];
      if (overlap(a.start, a.end, b.start, b.end)) {
        violations.push(
          violation(
            "MISSING_HABIT_METADATA",
            `${a.session.id || "unknown-id"} overlaps ${b.session.id || "unknown-id"} in scheduled time`
          )
        );
      }
    }
  }

  const restDay = String(profile?.preferences?.rest_day || "").toLowerCase();
  if (restDay) {
    for (const item of scheduled) {
      if (weekdayLower(item.start) === restDay) {
        violations.push(
          violation("MISSING_HABIT_METADATA", `${item.session.id || "unknown-id"} scheduled on rest day (${restDay})`)
        );
      }
    }
  }

  const fixedSessions = profile?.preferences?.fixed_sessions || [];
  for (const item of scheduled) {
    const fixedConflict = fixedSessionForDay(fixedSessions, weekdayLower(item.start), item.start, item.end);
    if (fixedConflict) {
      violations.push(
        violation("MISSING_HABIT_METADATA", `${item.session.id || "unknown-id"} overlaps fixed session constraint`)
      );
    }
  }

  for (const a of scheduled) {
    if (!isHardStrength(a.session)) continue;
    for (const b of scheduled) {
      if (!isKeyVo2(b.session)) continue;
      const deltaHours = (b.start.getTime() - a.start.getTime()) / 3600000;
      if (deltaHours > 0 && deltaHours < 24) {
        violations.push(
          violation(
            "MISSING_HABIT_METADATA",
            `${a.session.id || "unknown-id"} hard strength is within 24h before key VO2 ${b.session.id || "unknown-id"}`
          )
        );
      }
    }
  }

  const byDate = new Map();
  for (const item of scheduled) {
    const key = item.start.toISOString().slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(item.session);
  }

  for (const [date, sessions] of byDate.entries()) {
    const veryHard = sessions.filter((session) => isVeryHard(session));
    if (veryHard.length > 1) {
      let allowed = false;
      for (let i = 0; i < veryHard.length - 1; i += 1) {
        for (let j = i + 1; j < veryHard.length; j += 1) {
          if (allowsBrickStack(veryHard[i], veryHard[j])) allowed = true;
        }
      }
      if (!allowed) {
        violations.push(
          violation(
            "MISSING_HABIT_METADATA",
            `multiple very_hard sessions on ${date} without explicit brick intent (${veryHard
              .map((session) => session.id || "unknown-id")
              .join(", ")})`
          )
        );
      }
    }
  }

  const strategyPath =
    options && options.projectDir
      ? path.join(options.projectDir, "data", "coach", "strategy.json")
      : path.join(path.dirname(path.dirname(planPath)), "strategy.json");
  const strategy = readJson(strategyPath);
  const goalsPath =
    options && options.projectDir
      ? path.join(options.projectDir, "data", "coach", "goals.json")
      : path.join(path.dirname(path.dirname(planPath)), "goals.json");
  const goals = readJson(goalsPath);

  violations.push(...validateGenericProgression(planPath, plan, strategy, goals));
  violations.push(...validateStrengthProgression(planPath, plan, profile, strategy));

  const latestCheckin = options?.projectDir ? findLatestCheckin(options.projectDir) : null;
  violations.push(...validateAskBeforeDownshift(plan, latestCheckin));

  return violations;
}

function resolveBikeCapabilities(profile, snapshot) {
  const preferences = profile.preferences || {};
  const bikeCapabilities = preferences.bike_capabilities || {};

  const measuredPowerFraction = asNumber(
    snapshot?.activities_summary?.by_discipline?.bike?.power_observability?.measured_power_fraction,
    0
  );
  const bikeHrCoverage = asNumber(snapshot?.activities_summary?.by_discipline?.bike?.coverage?.hr_fraction, 0);
  const heartRateZonesPresent = Boolean(snapshot?.zones_by_type?.heart_rate || snapshot?.zones?.heart_rate);
  const explicitNoPower = bikeCapabilities.power_meter_available === false;
  const explicitHrAvailable = bikeCapabilities.heart_rate_sensor_available === true;

  return {
    no_power_mode: explicitNoPower || measuredPowerFraction < POWER_FRACTION_THRESHOLD,
    hr_available: explicitHrAvailable || heartRateZonesPresent || bikeHrCoverage >= HR_FRACTION_THRESHOLD,
    source: {
      explicit_power_meter_available: bikeCapabilities.power_meter_available ?? null,
      explicit_hr_sensor_available: bikeCapabilities.heart_rate_sensor_available ?? null,
      measured_power_fraction: measuredPowerFraction,
      bike_hr_coverage_fraction: bikeHrCoverage,
      heart_rate_zones_present: heartRateZonesPresent,
      thresholds: {
        measured_power_fraction_min: POWER_FRACTION_THRESHOLD,
        bike_hr_coverage_fraction_min: HR_FRACTION_THRESHOLD,
      },
    },
    evaluated_at: snapshot?.as_of_date || toIsoDate(new Date()),
  };
}

function listPlanFiles(planDir) {
  try {
    return fs
      .readdirSync(planDir)
      .filter((name) => /^\\d{4}-\\d{2}-\\d{2}\\.json$/.test(name))
      .map((name) => path.join(planDir, name))
      .sort();
  } catch {
    return [];
  }
}

function summarizePlanByDiscipline(plan) {
  const summary = {};
  for (const session of plan?.sessions || []) {
    const discipline = String(session?.discipline || "").toLowerCase();
    if (!discipline || discipline === "rest") continue;
    if (!summary[discipline]) {
      summary[discipline] = {
        sessions: 0,
        planned_minutes: 0,
      };
    }
    summary[discipline].sessions += 1;
    const minutes = Number(session?.duration_min || 0);
    if (Number.isFinite(minutes) && minutes > 0) summary[discipline].planned_minutes += minutes;
  }
  return summary;
}

function inferPrimaryGoalId(goals) {
  const goalsList = Array.isArray(goals?.goals) ? goals.goals : [];
  const primary = goalsList.find((goal) => /primary|a_race/i.test(String(goal?.type || ""))) || goalsList[0];
  if (isNonEmptyString(primary?.id)) return String(primary.id);
  if (isNonEmptyString(goals?.primary_goal?.name)) {
    return String(goals.primary_goal.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }
  return "primary_goal";
}

function resolveTargetMarker(strategy, discipline) {
  const focus = strategy?.discipline_focus?.[discipline];
  if (focus && typeof focus === "object") {
    if (isNonEmptyString(focus.key_metric)) return focus.key_metric;
    if (isNonEmptyString(focus.focus)) return focus.focus;
    if (isNonEmptyString(focus.approach)) return focus.approach;
  }
  return "progress toward current goal phase";
}

function confidenceForDiscipline(baseline, discipline) {
  const value = String(baseline?.confidence_by_discipline?.[discipline] || "").toLowerCase();
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}

function buildWeeklyChangeLog(planDir, limit = 12) {
  const files = listPlanFiles(planDir).slice(-limit);
  const entries = [];
  for (const filePath of files) {
    const plan = readJson(filePath);
    if (!plan || !Array.isArray(plan.sessions)) continue;
    entries.push({
      week_start: String(plan.week_start || path.basename(filePath, ".json")),
      totals_by_discipline: summarizePlanByDiscipline(plan),
    });
  }
  return entries;
}

function buildPendingRiskAdjustments(plan, latestCheckin) {
  const pending = [];
  const questions = Array.isArray(plan?.needs_user_input) ? plan.needs_user_input : [];
  for (const entry of questions) {
    if (!entry || typeof entry !== "object") continue;
    pending.push({
      question: String(entry.question || ""),
      reason: String(entry.reason || ""),
      options: Array.isArray(entry.options) ? entry.options : [],
      captured_from_plan_week: String(plan?.week_start || ""),
    });
  }

  const trigger = fatigueOrAdherenceTrigger(plan, latestCheckin);
  if (trigger.triggered && !pending.length) {
    pending.push({
      question: "Fatigue/adherence trigger detected. Choose how to adjust next week load.",
      reason: trigger.fatigue ? "fatigue_signal_detected" : "adherence_signal_detected",
      options: [
        "Hold plan and monitor 48h",
        "Reduce key-session load",
        "Reduce volume only",
      ],
      captured_from_plan_week: String(plan?.week_start || ""),
    });
  }

  return pending;
}

function updateProgressionStateArtifact(projectDir, latestPlanPath) {
  const plan = readJson(latestPlanPath);
  if (!plan || !Array.isArray(plan.sessions)) return;

  const goalsPath = path.join(projectDir, "data", "coach", "goals.json");
  const strategyPath = path.join(projectDir, "data", "coach", "strategy.json");
  const baselinePath = path.join(projectDir, "data", "coach", "baseline.json");
  const progressionPath = path.join(projectDir, "data", "coach", "progression_state.json");
  const planDir = path.join(projectDir, "data", "coach", "plans");

  const goals = readJson(goalsPath) || {};
  const strategy = readJson(strategyPath) || {};
  const baseline = readJson(baselinePath) || {};
  const latestCheckin = findLatestCheckin(projectDir);

  const currentSummary = summarizePlanByDiscipline(plan);
  const goalDisciplines = extractDisciplinesFromGoals(goals);
  const planDisciplines = Object.keys(currentSummary);
  const disciplines = unique([...goalDisciplines, ...planDisciplines, "strength"]).filter(Boolean);

  const disciplineState = {};
  for (const discipline of disciplines) {
    const current = currentSummary[discipline] || { sessions: 0, planned_minutes: 0 };
    const targetMarker = resolveTargetMarker(strategy, discipline);
    const gapText =
      current.sessions > 0
        ? `Current week includes ${current.sessions} session(s) and ${current.planned_minutes} planned minute(s).`
        : "No planned sessions yet for this discipline in current week.";

    disciplineState[discipline] = {
      current,
      target: {
        marker: targetMarker,
      },
      gap: gapText,
      confidence: confidenceForDiscipline(baseline, discipline),
    };
  }

  const weekStart = String(plan?.week_start || "");
  const nextCheckpointDate = isoDateShiftDays(weekStart, 7) || toIsoDate(new Date());
  const nextMarkers = Array.isArray(strategy?.weekly_priorities) && strategy.weekly_priorities.length
    ? strategy.weekly_priorities.slice(0, 4)
    : ["Maintain progression trace quality and adherence to current phase intent."];

  const progressionState = {
    as_of_date: toIsoDate(new Date()),
    primary_goal_id: inferPrimaryGoalId(goals),
    phase_mode: resolveStrengthPhaseMode(plan, strategy),
    discipline_state: disciplineState,
    weekly_change_log: buildWeeklyChangeLog(planDir, 12),
    next_checkpoint: {
      date: nextCheckpointDate,
      target_markers: nextMarkers,
    },
    risk_adjustments_pending_user_confirmation: buildPendingRiskAdjustments(plan, latestCheckin),
  };

  dumpJson(progressionPath, progressionState);
}

function ensureProfileComplete(profilePath, projectDir, enforcePlanWrite, hookInput = {}) {
  const profile = readJson(profilePath);
  if (!profile) {
    return { ok: false, message: "Missing data/coach/profile.json. Run /setup to onboard." };
  }

  const snapshotPath = path.join(projectDir, "data", "coach", "strava_snapshot.json");
  const snapshot = readJson(snapshotPath);
  const previousResolved = profile?.preferences?.bike_capabilities?.resolved || null;
  const resolvedBikeCapabilities = resolveBikeCapabilities(profile, snapshot);
  profile.preferences = profile.preferences || {};
  profile.preferences.bike_capabilities = profile.preferences.bike_capabilities || {};
  profile.preferences.bike_capabilities.resolved = resolvedBikeCapabilities;

  const missing = [];

  const prefs = profile.preferences || {};
  const timeBudget = prefs.time_budget_hours || {};
  const hasBudget =
    Number.isFinite(timeBudget.min) &&
    Number.isFinite(timeBudget.typical) &&
    Number.isFinite(timeBudget.max);

  if (!hasBudget) missing.push("preferences.time_budget_hours (min/typical/max)");
  if (!prefs.rest_day) missing.push("preferences.rest_day");
  if (!Array.isArray(prefs.fixed_sessions)) missing.push("preferences.fixed_sessions (array)");

  if (!hasValidSessionTypePreferences(prefs.session_type_preferences)) {
    missing.push("preferences.session_type_preferences (run/bike/swim/strength with prefer[] and avoid[] arrays)");
  }

  const strength = prefs.strength || {};
  if (strength.enabled == null) missing.push("preferences.strength.enabled");
  if (strength.sessions_per_week == null) missing.push("preferences.strength.sessions_per_week");
  if (strength.session_duration_min == null) missing.push("preferences.strength.session_duration_min");

  const health = profile.health || {};
  if (!Array.isArray(health.current_niggles)) missing.push("health.current_niggles (array)");
  if (!Array.isArray(health.injury_history_12mo)) missing.push("health.injury_history_12mo (array)");

  if (JSON.stringify(previousResolved) !== JSON.stringify(resolvedBikeCapabilities)) {
    profile.preferences.bike_capabilities.resolved = resolvedBikeCapabilities;
    dumpJson(profilePath, profile);
  }

  if (missing.length) {
    return {
      ok: false,
      message:
        "Coach plan precheck: preferences required before planning.\n" +
        `Missing:\n${missing.map((item) => `- ${item}`).join("\n")}\n` +
        "Update data/coach/profile.json, then re-run /plan-week.",
    };
  }

  if (enforcePlanWrite) {
    const planDir = path.join(projectDir, "data", "coach", "plans");
    const latestPlan = latestPlanMtime(planDir);
    const sessionStartRaw = process.env.COACH_SESSION_START;
    const sessionStart = sessionStartRaw ? new Date(sessionStartRaw) : null;

    if (!latestPlan) {
      return {
        ok: false,
        message:
          "Coach plan precheck: no plan file was written. Create data/coach/plans/YYYY-MM-DD.json, then re-run /plan-week.",
      };
    }

    if (sessionStart && latestPlan.mtime < sessionStart) {
      return {
        ok: false,
        message:
          "Coach plan precheck: plan file was not updated this session. Write data/coach/plans/YYYY-MM-DD.json, then re-run /plan-week.",
      };
    }

    const delegation = validateRequiredDelegation({
      projectDir,
      profile,
      transcriptPath: hookInput?.transcript_path,
    });
    if (!delegation.ok) {
      return {
        ok: false,
        message: delegation.message,
      };
    }

    const powerViolations = validateNoPowerPlan(latestPlan.filePath, resolvedBikeCapabilities);
    if (powerViolations.length) {
      return {
        ok: false,
        message:
          "Coach plan precheck: no_power_mode is enabled and bike intensity guardrails failed.\n" +
          `Plan: ${path.basename(latestPlan.filePath)}\n` +
          `${powerViolations.map((item) => `- ${item}`).join("\n")}\n` +
          "Remediation: remove all FTP/IF/watts prescriptions, then provide HR targets (if available) and RPE range for each bike session.",
      };
    }

    const schedulingViolations = validateModelScheduledPlan(latestPlan.filePath, profile, { projectDir });
    if (schedulingViolations.length) {
      return {
        ok: false,
        message:
          "Coach plan precheck: habit-preserving scheduling guardrails failed.\n" +
          `Plan: ${path.basename(latestPlan.filePath)}\n` +
          `${schedulingViolations.map((item) => `- [${item.code}] ${item.message}`).join("\n")}\n` +
          "Remediation: re-run model scheduling to satisfy habit metadata, deviation caps, weekday-change budget, and safety constraints.",
      };
    }

    updateProgressionStateArtifact(projectDir, latestPlan.filePath);
  }

  return { ok: true };
}

function main() {
  const hookInput = readStdinJson();
  const hookEvent = String(hookInput.hook_event_name || "");
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const profilePath = path.join(projectDir, "data", "coach", "profile.json");
  const enforcePlanWrite = hookEvent === "Stop";
  const result = ensureProfileComplete(profilePath, projectDir, enforcePlanWrite, hookInput);
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  validateModelScheduledPlan,
  validateNoPowerPlan,
  ensureProfileComplete,
  resolveRequiredCoachSubagents,
  parseTaskInvocationsFromTranscript,
  validateRequiredDelegation,
  computeHabitMatchScore,
  getPriorityDeviationCapMinutes,
};
