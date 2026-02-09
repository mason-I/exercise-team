#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { parseDate, toIsoDate, weekStart } = require("../skills/_shared/lib");
const { PATHS, resolveProjectPath } = require("../skills/_shared/paths");

const STEP_TIMEOUT_MS = 120000;

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf-8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function appendSessionEnv(todayIso, weekStartIso) {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) return;
  const lines = [
    `export COACH_TODAY="${todayIso}"`,
    `export COACH_WEEK_START="${weekStartIso}"`,
    `export COACH_SESSION_START="${new Date().toISOString()}"`,
  ];
  fs.appendFileSync(envFile, `${lines.join("\n")}\n`);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function safeStat(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      isFile: stat.isFile(),
    };
  } catch {
    return { exists: false, size: 0, mtime: null, isFile: false };
  }
}

function snapshotAsOf(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed?.as_of_date || null;
  } catch {
    return null;
  }
}

function summarizeOutput(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-2).join(" | ");
}

function runBunScript(projectDir, relScriptPath, args = [], timeoutMs = STEP_TIMEOUT_MS) {
  const scriptPath = path.join(projectDir, relScriptPath);
  if (!fs.existsSync(scriptPath)) {
    return {
      ok: false,
      script: relScriptPath,
      code: null,
      stdout: "",
      stderr: `Missing script: ${relScriptPath}`,
      required: true,
    };
  }

  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    encoding: "utf-8",
    timeout: timeoutMs,
  });

  return {
    ok: result.status === 0,
    script: relScriptPath,
    code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    required: true,
  };
}

function buildSyncSteps() {
  return [
    {
      script: ".claude/skills/onboard/scripts/fetch_strava_athlete.js",
      args: [],
      required: true,
      timeoutMs: STEP_TIMEOUT_MS,
    },
    {
      script: ".claude/skills/onboard/scripts/fetch_strava_stats.js",
      args: [],
      required: true,
      timeoutMs: STEP_TIMEOUT_MS,
    },
    {
      script: ".claude/skills/onboard/scripts/fetch_strava_zones.js",
      args: [],
      required: false,
      timeoutMs: STEP_TIMEOUT_MS,
    },
    {
      script: ".claude/skills/setup/scripts/sync_strava_activities.js",
      args: ["--lookback-hours", "72", "--bootstrap-window-days", "56"],
      required: true,
      timeoutMs: STEP_TIMEOUT_MS,
    },
    {
      script: ".claude/skills/coach-sync/scripts/build_strava_snapshot.js",
      args: ["--input", PATHS.external.stravaActivities, "--out", PATHS.coach.snapshot],
      required: true,
      timeoutMs: STEP_TIMEOUT_MS,
    },
    {
      script: ".claude/skills/coach-sync/scripts/audit_bike_power_streams.js",
      args: [
        "--activities",
        PATHS.external.stravaActivities,
        "--snapshot",
        PATHS.coach.snapshot,
        "--stream-dir",
        PATHS.external.stravaStreamsDir,
        "--window-days",
        "28",
      ],
      required: true,
      timeoutMs: STEP_TIMEOUT_MS,
    },
  ];
}

function runSessionRefresh(projectDir) {
  const steps = buildSyncSteps();
  const results = [];
  let ok = true;

  for (const step of steps) {
    const result = runBunScript(projectDir, step.script, step.args, step.timeoutMs);
    const merged = { ...result, required: step.required };
    results.push(merged);
    if (!merged.ok && step.required) {
      ok = false;
    }
  }

  return { ok, results };
}

function renderHookJson(summaryLines, systemMessage = null) {
  const payload = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: summaryLines.join("\n"),
    },
  };
  if (systemMessage) payload.systemMessage = systemMessage;
  return `${JSON.stringify(payload)}\n`;
}

function buildStatusLines(projectDir) {
  const entries = [
    { label: PATHS.system.userEnv, path: resolveProjectPath(projectDir, PATHS.system.userEnv) },
    { label: PATHS.external.stravaActivities, path: resolveProjectPath(projectDir, PATHS.external.stravaActivities) },
    { label: PATHS.system.stravaAthlete, path: resolveProjectPath(projectDir, PATHS.system.stravaAthlete) },
    { label: PATHS.system.stravaStats, path: resolveProjectPath(projectDir, PATHS.system.stravaStats) },
    { label: PATHS.system.stravaZones, path: resolveProjectPath(projectDir, PATHS.system.stravaZones) },
    { label: PATHS.coach.snapshot, path: resolveProjectPath(projectDir, PATHS.coach.snapshot) },
  ];

  const lines = ["[coach-warmup] data status:"];
  for (const entry of entries) {
    const stat = safeStat(entry.path);
    if (!stat.exists) {
      lines.push(`- ${entry.label}: missing`);
      continue;
    }
    if (!stat.isFile) {
      lines.push(`- ${entry.label}: not a file`);
      continue;
    }
    const extra =
      entry.label === PATHS.coach.snapshot
        ? `, as_of=${snapshotAsOf(entry.path) || "unknown"}`
        : "";
    lines.push(`- ${entry.label}: ok (${stat.size} bytes, mtime=${stat.mtime}${extra})`);
  }
  return lines;
}

async function main() {
  const hookInput = readStdinJson();
  const source = String(hookInput.source || "unknown");

  if (!["startup", "resume"].includes(source)) {
    process.stdout.write(`[coach-warmup] skipped for SessionStart source=${source}\n`);
    return;
  }

  const todayDate = parseDate(new Date());
  const todayIso = toIsoDate(todayDate);
  const weekStartIso = toIsoDate(weekStart(todayDate));
  appendSessionEnv(todayIso, weekStartIso);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const summary = [
    `[coach-warmup] source=${source}`,
    `[coach-warmup] dates: today=${todayIso}, week_start=${weekStartIso}`,
    "[coach-warmup] Running deterministic Strava refresh...",
  ];

  const startedAt = new Date().toISOString();
  const refresh = runSessionRefresh(projectDir);
  const finishedAt = new Date().toISOString();

  writeJson(resolveProjectPath(projectDir, PATHS.system.sessionSyncState), {
    started_at: startedAt,
    finished_at: finishedAt,
    source,
    status: refresh.ok ? "ok" : "error",
    steps: refresh.results.map((result) => ({
      script: result.script,
      ok: result.ok,
      required: result.required,
      code: result.code,
      stderr_summary: summarizeOutput(result.stderr),
      stdout_summary: summarizeOutput(result.stdout),
    })),
  });

  if (refresh.ok) {
    summary.push("[coach-warmup] Strava refresh completed.");
  } else {
    summary.push("[coach-warmup] Strava refresh completed_with_errors.");
  }

  for (const result of refresh.results) {
    const state = result.ok ? "ok" : result.required ? "failed" : "optional_failed";
    const detail = summarizeOutput(result.stderr) || summarizeOutput(result.stdout);
    summary.push(`- sync:${state}: ${path.basename(result.script)}${detail ? ` (${detail})` : ""}`);
  }

  summary.push(...buildStatusLines(projectDir));

  const systemMessage = refresh.ok
    ? null
    : "SessionStart Strava refresh had errors. Continuing with last available data. Run /setup if issues persist.";

  process.stdout.write(renderHookJson(summary, systemMessage));
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(
      renderHookJson(
        [`[coach-warmup] unexpected error during Strava refresh: ${error?.message || error}`],
        "SessionStart Strava refresh failed unexpectedly. Continuing with last available data."
      )
    );
    process.exit(0);
  });
}
