#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");

const TARGET_SCRIPT_REL = ".claude/skills/schedule/scripts/sync_plan_to_calendar.js";
const KEY_COVERAGE_THRESHOLD = 0.9;

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf-8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function tokenizeCommand(command) {
  const text = String(command || "");
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function parseFlagValue(tokens, flag) {
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === flag && i + 1 < tokens.length) return tokens[i + 1];
    if (tokens[i].startsWith(`${flag}=`)) return tokens[i].slice(flag.length + 1);
  }
  return null;
}

function hasFlag(tokens, flag) {
  return tokens.includes(flag) || tokens.some((token) => token.startsWith(`${flag}=`));
}

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function isTargetSyncApplyCommand(command, projectDir) {
  const tokens = tokenizeCommand(command);
  if (!hasFlag(tokens, "--apply")) return false;

  const targetAbs = normalizeSlashes(path.resolve(projectDir, TARGET_SCRIPT_REL));
  const targetRel = normalizeSlashes(TARGET_SCRIPT_REL);
  return tokens.some((token) => {
    const normalized = normalizeSlashes(token);
    return normalized === targetRel || normalized === targetAbs || normalized.endsWith(`/${targetRel}`);
  });
}

function parsePlanPathFromCommand(command) {
  const tokens = tokenizeCommand(command);
  return parseFlagValue(tokens, "--plan");
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function validIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function inferWeekStart(plan, planPath) {
  if (validIsoDate(plan?.week_start)) return String(plan.week_start);

  const base = path.basename(String(planPath || ""));
  const baseMatch = base.match(/(\d{4}-\d{2}-\d{2})/);
  if (baseMatch && validIsoDate(baseMatch[1])) return baseMatch[1];

  const dates = Array.isArray(plan?.sessions)
    ? plan.sessions
        .map((session) => String(session?.date || ""))
        .filter((value) => validIsoDate(value))
        .sort()
    : [];

  return dates.length ? dates[0] : "unknown";
}

function asMinutes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed);
}

function parseDateTime(value) {
  if (!value || typeof value !== "string") return null;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function scheduledMinutes(session) {
  const planned = asMinutes(session?.duration_min);
  const start = parseDateTime(session?.scheduled_start_local);
  const end = parseDateTime(session?.scheduled_end_local);
  if (!start || !end || end <= start) return planned;
  const diff = Math.round((end.getTime() - start.getTime()) / 60000);
  return diff > 0 ? diff : planned;
}

function isSchedulableSession(session) {
  const discipline = String(session?.discipline || "").toLowerCase();
  return discipline && discipline !== "rest" && asMinutes(session?.duration_min) > 0;
}

function sessionStatus(session) {
  return String(session?.calendar?.status || "").trim().toLowerCase();
}

function buildAuditFromPlan(plan, planPath, command) {
  const summary = {
    schedulable_total: 0,
    scheduled_total: 0,
    conflict_total: 0,
    unscheduled_total: 0,
    key_sessions_total: 0,
    key_planned_minutes: 0,
    key_scheduled_minutes: 0,
    key_coverage_ratio: 1,
  };
  const impactedKeySessions = [];

  const sessions = Array.isArray(plan?.sessions) ? plan.sessions : [];
  for (const session of sessions) {
    if (!isSchedulableSession(session)) continue;
    summary.schedulable_total += 1;
    const status = sessionStatus(session);
    if (status === "scheduled") summary.scheduled_total += 1;
    else if (status === "conflict") summary.conflict_total += 1;
    else summary.unscheduled_total += 1;

    if (String(session?.priority || "").toLowerCase() !== "key") continue;
    summary.key_sessions_total += 1;
    summary.key_planned_minutes += asMinutes(session?.duration_min);
    if (status === "scheduled") {
      summary.key_scheduled_minutes += scheduledMinutes(session);
    } else {
      impactedKeySessions.push({
        session_id: session?.id || null,
        status: status || "unknown",
      });
    }
  }

  if (summary.key_planned_minutes > 0) {
    summary.key_coverage_ratio = Number(
      (summary.key_scheduled_minutes / summary.key_planned_minutes).toFixed(3)
    );
  }

  const findings = [];
  if (impactedKeySessions.length) {
    findings.push({
      severity: "high",
      code: "key_sessions_impacted",
      message: `Key sessions impacted: ${impactedKeySessions
        .map((item) => `${item.session_id || "unknown"} (${item.status})`)
        .join(", ")}`,
    });
  }
  if (summary.conflict_total >= 2) {
    findings.push({
      severity: "high",
      code: "conflict_count_high",
      message: `Conflict count is ${summary.conflict_total} (threshold: 2).`,
    });
  }
  if (summary.key_coverage_ratio < KEY_COVERAGE_THRESHOLD) {
    findings.push({
      severity: "high",
      code: "key_coverage_low",
      message: `Key coverage ratio is ${summary.key_coverage_ratio} (threshold: ${KEY_COVERAGE_THRESHOLD}).`,
    });
  }
  if (summary.unscheduled_total > 0) {
    findings.push({
      severity: "medium",
      code: "unscheduled_sessions",
      message: `Unscheduled sessions present: ${summary.unscheduled_total}.`,
    });
  }

  const highRisk =
    impactedKeySessions.length > 0 ||
    summary.conflict_total >= 2 ||
    summary.key_coverage_ratio < KEY_COVERAGE_THRESHOLD;
  const blockReason = highRisk
    ? "High-risk post-sync schedule detected. Propose 2-3 manual rescheduling options, explain tradeoffs, and ask the user which option to apply. Do not auto-edit plan/calendar."
    : null;

  return {
    generated_at: new Date().toISOString(),
    week_start: inferWeekStart(plan, planPath),
    plan_path: path.resolve(planPath),
    command: String(command || ""),
    summary,
    impacted_key_sessions: impactedKeySessions,
    findings,
    high_risk: highRisk,
    block_reason: blockReason,
  };
}

function buildAdvisoryAudit(planPath, command, findingCode, findingMessage) {
  return {
    generated_at: new Date().toISOString(),
    week_start: "unknown",
    plan_path: planPath ? path.resolve(planPath) : null,
    command: String(command || ""),
    summary: {
      schedulable_total: 0,
      scheduled_total: 0,
      conflict_total: 0,
      unscheduled_total: 0,
      key_sessions_total: 0,
      key_planned_minutes: 0,
      key_scheduled_minutes: 0,
      key_coverage_ratio: 1,
    },
    impacted_key_sessions: [],
    findings: [
      {
        severity: "low",
        code: findingCode,
        message: findingMessage,
      },
    ],
    high_risk: false,
    block_reason: null,
  };
}

function writeAudit(projectDir, audit) {
  const safeWeekStart = validIsoDate(audit.week_start) ? audit.week_start : "unknown";
  const outDir = path.join(projectDir, "data", "system", "calendar");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `schedule_sanity_${safeWeekStart}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(audit, null, 2)}\n`, "utf-8");
  return outPath;
}

function buildAdditionalContext(audit, auditPath) {
  const impacted = audit.impacted_key_sessions.length
    ? audit.impacted_key_sessions
        .map((item) => `${item.session_id || "unknown"} (${item.status})`)
        .join(", ")
    : "none";

  const findingLines = audit.findings.length
    ? audit.findings.map((item) => `- [${item.severity}] ${item.message}`)
    : ["- No risk findings."];

  return [
    "Post-sync schedule sanity check:",
    `Plan week: ${audit.week_start}`,
    `Audit file: ${auditPath}`,
    `Summary: schedulable=${audit.summary.schedulable_total}, scheduled=${audit.summary.scheduled_total}, conflicts=${audit.summary.conflict_total}, unscheduled=${audit.summary.unscheduled_total}, key_coverage_ratio=${audit.summary.key_coverage_ratio}`,
    `Impacted key sessions: ${impacted}`,
    "Findings:",
    ...findingLines,
    "Self-check checklist before final response:",
    "1) Does weekly load distribution still make sense?",
    "2) Are recovery gaps and hard/easy sequencing still safe?",
    "3) Are key sessions protected this week?",
    "4) Does the final calendar respect the athlete's fixed constraints/preferences?",
  ].join("\n");
}

function buildHookPayload(audit, auditPath) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: buildAdditionalContext(audit, auditPath),
    },
  };

  if (audit.high_risk) {
    payload.decision = "block";
    payload.reason = String(audit.block_reason || "High-risk post-sync schedule detected.");
  }

  return payload;
}

function processHookInput(input, options = {}) {
  const projectDir = path.resolve(options.projectDir || process.cwd());
  if (String(input?.hook_event_name || "") !== "PostToolUse") return null;
  if (String(input?.tool_name || "") !== "Bash") return null;

  const command = String(input?.tool_input?.command || "").trim();
  if (!command || !isTargetSyncApplyCommand(command, projectDir)) return null;

  const planArg = parsePlanPathFromCommand(command);
  const commandCwd = path.resolve(String(input?.cwd || projectDir));
  let audit;

  if (!planArg) {
    audit = buildAdvisoryAudit(
      null,
      command,
      "missing_plan_flag",
      "Unable to evaluate schedule sanity because --plan was not found in the sync command."
    );
  } else {
    const planPath = path.isAbsolute(planArg) ? planArg : path.resolve(commandCwd, planArg);
    try {
      const plan = readJson(planPath);
      if (!plan || !Array.isArray(plan.sessions)) {
        audit = buildAdvisoryAudit(
          planPath,
          command,
          "invalid_plan_shape",
          "Plan file was read but did not contain a sessions array."
        );
      } else {
        audit = buildAuditFromPlan(plan, planPath, command);
      }
    } catch (error) {
      audit = buildAdvisoryAudit(
        planPath,
        command,
        "plan_read_failed",
        `Unable to read plan file for sanity check: ${String(error?.message || error)}`
      );
    }
  }

  const auditPath = writeAudit(projectDir, audit);
  return {
    audit,
    auditPath,
    payload: buildHookPayload(audit, auditPath),
  };
}

function main() {
  const input = readStdinJson();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const result = processHookInput(input, { projectDir });
  if (!result) return;
  process.stdout.write(`${JSON.stringify(result.payload)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch {
    // Non-blocking by default: ignore unexpected hook failures.
  }
}

module.exports = {
  tokenizeCommand,
  parsePlanPathFromCommand,
  isTargetSyncApplyCommand,
  inferWeekStart,
  buildAuditFromPlan,
  processHookInput,
};
