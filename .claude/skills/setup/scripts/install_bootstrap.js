#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const {
  loadCredentialState: loadStravaCredentialState,
  refreshOrGetAccessToken: refreshOrGetStravaAccessToken,
} = require("../../_shared/strava_auth_flow");
const {
  loadCredentialState: loadGoogleCredentialState,
  refreshOrGetAccessToken: refreshOrGetGoogleAccessToken,
  DEFAULT_CALENDAR_ID,
} = require("../../_shared/google_calendar_auth_flow");
const { hydrateSessionEnv } = require("../../_shared/session_env");
const { PATHS, resolveProjectPath } = require("../../_shared/paths");
const {
  upsertSettingsFile,
  REQUIRED_TOP_LEVEL,
  REQUIRED_HOOKS,
  INSTALLER_REQUIRED_PERMISSIONS_ALLOW,
} = require("../../_shared/settings_contract");

const INSTALLER_ENV_KEYS = {
  ANTHROPIC_AUTH_TOKEN: "APP_ANTHROPIC_AUTH_TOKEN",
  ANTHROPIC_BASE_URL: "APP_ANTHROPIC_BASE_URL",
  API_TIMEOUT_MS: "APP_API_TIMEOUT_MS",
  GCAL_CLIENT_ID: "APP_GCAL_CLIENT_ID",
  GCAL_CLIENT_SECRET: "APP_GCAL_CLIENT_SECRET",
};

function resolveProjectDir(explicitProjectDir = null) {
  if (explicitProjectDir) return path.resolve(explicitProjectDir);
  if (process.env.CLAUDE_PROJECT_DIR) return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  return path.resolve(__dirname, "../../../..");
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    projectDir: null,
    autoOpenBrowser: true,
    calendarId: DEFAULT_CALENDAR_ID,
    dryRun: false,
    quiet: false,
    stravaClientId: "",
    stravaClientSecret: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-dir") options.projectDir = String(argv[i + 1] || "").trim() || null;
    if (arg === "--auto-open-browser") options.autoOpenBrowser = true;
    if (arg === "--no-auto-open-browser") options.autoOpenBrowser = false;
    if (arg === "--calendar-id") options.calendarId = String(argv[i + 1] || DEFAULT_CALENDAR_ID);
    if (arg === "--dry-run") options.dryRun = true;
    if (arg === "--quiet") options.quiet = true;
    if (arg === "--strava-client-id") options.stravaClientId = String(argv[i + 1] || "").trim();
    if (arg === "--strava-client-secret") options.stravaClientSecret = String(argv[i + 1] || "").trim();
  }

  if (!options.stravaClientId && process.env.APP_STRAVA_CLIENT_ID) {
    options.stravaClientId = String(process.env.APP_STRAVA_CLIENT_ID).trim();
  }
  if (!options.stravaClientSecret && process.env.APP_STRAVA_CLIENT_SECRET) {
    options.stravaClientSecret = String(process.env.APP_STRAVA_CLIENT_SECRET).trim();
  }

  return options;
}

function safeReadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function safeStat(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      path: filePath,
      exists: true,
      is_file: stat.isFile(),
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    };
  } catch {
    return {
      path: filePath,
      exists: false,
      is_file: false,
      size: 0,
      mtime: null,
    };
  }
}

function resolveScriptPath(projectDir, relScriptPath) {
  return path.join(projectDir, relScriptPath);
}

function runScriptJson(projectDir, relScriptPath, args = []) {
  const scriptPath = resolveScriptPath(projectDir, relScriptPath);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    const error = new Error(
      `Script failed (${result.status}): ${relScriptPath}${result.stderr ? `\n${result.stderr.trim()}` : ""}`
    );
    error.status = result.status;
    throw error;
  }

  const raw = String(result.stdout || "").trim();
  if (!raw) return { ok: true };
  try {
    return JSON.parse(raw);
  } catch {
    return { ok: true, raw_stdout: raw };
  }
}

function spawnScript(projectDir, relScriptPath, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [resolveScriptPath(projectDir, relScriptPath), ...args], {
      cwd: projectDir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      stdio: "inherit",
    });

    child.on("exit", (code, signal) => {
      resolve({
        ok: code === 0,
        code: code == null ? 1 : code,
        signal: signal || null,
      });
    });
  });
}

function upsertSettingsContract(projectDir, envPatch) {
  const settingsPath = path.join(projectDir, ".claude", "settings.json");
  upsertSettingsFile(settingsPath, {
    envPatch,
    requiredTopLevel: REQUIRED_TOP_LEVEL,
    requiredHooks: REQUIRED_HOOKS,
    requiredPermissionsAllow: INSTALLER_REQUIRED_PERMISSIONS_ALLOW,
  });
  return settingsPath;
}

function buildInstallerEnvPatch() {
  const envPatch = {};
  const missing = [];
  for (const [settingsKey, installerEnvKey] of Object.entries(INSTALLER_ENV_KEYS)) {
    const raw = process.env[installerEnvKey];
    const value = String(raw || "").trim();
    if (!value) {
      missing.push(installerEnvKey);
      continue;
    }
    envPatch[settingsKey] = value;
  }
  return { envPatch, missing };
}

function collectArtifacts(projectDir) {
  const relPaths = [
    PATHS.system.installBootstrapState,
    PATHS.system.userEnv,
    PATHS.external.stravaActivities,
    PATHS.system.stravaAthlete,
    PATHS.system.stravaStats,
    PATHS.system.stravaZones,
    PATHS.system.stravaInferredSchedule,
    PATHS.coach.snapshot,
    PATHS.coach.profile,
    PATHS.coach.goals,
    PATHS.coach.baselineRaw,
    PATHS.coach.strategy,
  ];
  return relPaths.map((relPath) => safeStat(resolveProjectPath(projectDir, relPath)));
}

function authRequiresInteractive(error) {
  const code = String(error && error.code ? error.code : "");
  const text = String(error && error.message ? error.message : "");
  return code === "AUTH_REQUIRED" || code === "AUTH_TIMEOUT" || text.includes("No valid");
}

async function ensureStravaAuth(options) {
  const state = loadStravaCredentialState();
  const hasExistingToken = Boolean(state.refreshToken);
  const outcome = {
    ok: false,
    strategy: hasExistingToken ? "refresh_only" : "interactive_if_needed",
    method: null,
    interactive_used: false,
    error: null,
  };

  try {
    const result = await refreshOrGetStravaAccessToken(null, {
      allowInteractiveOAuth: false,
      autoOpenBrowser: false,
      logger: () => {},
    });
    outcome.ok = Boolean(result && result.accessToken);
    outcome.method = result ? result.method || null : null;
    return outcome;
  } catch (error) {
    if (!authRequiresInteractive(error)) {
      outcome.error = String(error && error.message ? error.message : error);
      return outcome;
    }
  }

  const interactiveResult = await refreshOrGetStravaAccessToken(null, {
    allowInteractiveOAuth: true,
    autoOpenBrowser: options.autoOpenBrowser,
    logger: (line) => {
      if (line) process.stderr.write(`${line}\n`);
    },
  });
  outcome.ok = Boolean(interactiveResult && interactiveResult.accessToken);
  outcome.method = interactiveResult ? interactiveResult.method || null : null;
  outcome.interactive_used = true;
  return outcome;
}

async function ensureGoogleAuth(options) {
  const state = loadGoogleCredentialState();
  const hasExistingToken = Boolean(state.refreshToken);
  const outcome = {
    ok: false,
    strategy: hasExistingToken ? "refresh_only" : "interactive_if_needed",
    method: null,
    interactive_used: false,
    error: null,
  };

  try {
    const result = await refreshOrGetGoogleAccessToken(null, {
      allowInteractiveOAuth: false,
      autoOpenBrowser: false,
      logger: () => {},
    });
    outcome.ok = Boolean(result && result.accessToken);
    outcome.method = result ? result.method || null : null;
    return outcome;
  } catch (error) {
    if (!authRequiresInteractive(error)) {
      outcome.error = String(error && error.message ? error.message : error);
      return outcome;
    }
  }

  const interactiveResult = await refreshOrGetGoogleAccessToken(null, {
    allowInteractiveOAuth: true,
    autoOpenBrowser: options.autoOpenBrowser,
    logger: (line) => {
      if (line) process.stderr.write(`${line}\n`);
    },
  });
  outcome.ok = Boolean(interactiveResult && interactiveResult.accessToken);
  outcome.method = interactiveResult ? interactiveResult.method || null : null;
  outcome.interactive_used = true;
  return outcome;
}

function determinePipelineArgs(projectDir) {
  const hasExistingActivities = fs.existsSync(resolveProjectPath(projectDir, PATHS.external.stravaActivities));
  if (hasExistingActivities) {
    return ["--activities-mode", "window", "--window-days", "56", "--require-google-auth"];
  }
  return ["--activities-mode", "all", "--require-google-auth"];
}

async function runBootstrap(options) {
  const projectDir = resolveProjectDir(options.projectDir);
  process.env.CLAUDE_PROJECT_DIR = projectDir;

  const startedAt = new Date().toISOString();
  const bootstrapStatePath = resolveProjectPath(projectDir, PATHS.system.installBootstrapState);
  const { envPatch: installerEnvPatch, missing: missingInstallerEnv } = buildInstallerEnvPatch();

  const envPatch = {
    ...installerEnvPatch,
    STRAVA_CLIENT_ID: options.stravaClientId,
    STRAVA_CLIENT_SECRET: options.stravaClientSecret,
  };

  if (missingInstallerEnv.length) {
    throw new Error(
      `Missing installer environment values: ${missingInstallerEnv.join(", ")}. Run via install.sh so installer populates these values.`
    );
  }

  if (!envPatch.STRAVA_CLIENT_ID || !envPatch.STRAVA_CLIENT_SECRET) {
    throw new Error("Missing Strava client credentials. Provide APP_STRAVA_CLIENT_ID and APP_STRAVA_CLIENT_SECRET.");
  }

  if (options.dryRun) {
    const summary = {
      ok: true,
      status: "dry_run",
      project_dir: projectDir,
      started_at: startedAt,
      bootstrap_state_path: bootstrapStatePath,
      settings_path: path.join(projectDir, ".claude", "settings.json"),
      actions: [
        "init_workspace",
        "upsert_settings_contract",
        "strava_auth",
        "strava_pipeline_including_google_auth",
      ],
      strava_auth_strategy: loadStravaCredentialState().refreshToken ? "refresh_only" : "interactive_if_needed",
      pipeline_args: determinePipelineArgs(projectDir),
    };
    if (!options.quiet) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({ ok: true, status: "dry_run", project_dir: projectDir }, null, 2)}\n`);
    }
    return;
  }

  const initWorkspace = runScriptJson(projectDir, ".claude/skills/setup/scripts/init_workspace.js", []);
  const settingsPath = upsertSettingsContract(projectDir, envPatch);
  hydrateSessionEnv(projectDir);

  const stravaAuth = await ensureStravaAuth(options);
  if (!stravaAuth.ok) {
    throw new Error(`Strava authentication failed: ${stravaAuth.error || "unknown error"}`);
  }

  const pipelineArgs = determinePipelineArgs(projectDir);
  const pipelinePromise = spawnScript(projectDir, ".claude/skills/setup/scripts/run_parallel_onboarding_phase.js", [
    ...pipelineArgs,
    ...(options.quiet ? ["--quiet"] : []),
    ...(options.autoOpenBrowser ? ["--auto-open-browser"] : ["--no-auto-open-browser"]),
  ]);

  const pipeline = await pipelinePromise;
  if (!pipeline.ok) {
    throw new Error(
      `Strava pipeline failed (exit=${pipeline.code}${pipeline.signal ? `, signal=${pipeline.signal}` : ""}).`
    );
  }
  const gcal = loadGoogleCredentialState();
  const calendarConnected = Boolean(gcal.clientId && gcal.clientSecret && gcal.refreshToken);
  if (!calendarConnected) {
    throw new Error("Google Calendar authentication failed: no refresh token present after OAuth.");
  }

  const finishedAt = new Date().toISOString();
  const summary = options.quiet
    ? {
        ok: true,
        status: "completed",
        project_dir: projectDir,
      }
    : {
        ok: true,
        status: "completed",
        project_dir: projectDir,
        started_at: startedAt,
        finished_at: finishedAt,
        settings_path: settingsPath,
        bootstrap_state_path: bootstrapStatePath,
        init_workspace: initWorkspace,
        env_applied_keys: Object.keys(envPatch),
        strava_auth: stravaAuth,
        strava_pipeline: {
          ok: pipeline.ok,
          code: pipeline.code,
          signal: pipeline.signal,
          args: pipelineArgs,
        },
        artifacts: [],
      };

  writeJson(bootstrapStatePath, summary);
  if (!options.quiet) {
    summary.artifacts = collectArtifacts(projectDir);
  }
  writeJson(bootstrapStatePath, summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) {
  runBootstrap(parseArgs()).catch((error) => {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  resolveProjectDir,
  upsertSettingsContract,
  determinePipelineArgs,
};
