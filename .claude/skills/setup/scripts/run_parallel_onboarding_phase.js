#!/usr/bin/env bun

const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { PATHS } = require("../../_shared/paths");

function resolveProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR
    ? path.resolve(process.env.CLAUDE_PROJECT_DIR)
    : path.resolve(__dirname, "../../../..");
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    activitiesMode: "all",
    windowDays: 56,
    autoOpenBrowser: true,
    outActivities: PATHS.external.stravaActivities,
    snapshotPath: PATHS.coach.snapshot,
    preferencesOut: PATHS.system.stravaInferredSchedule,
    includeGoogleAuth: true,
    requireGoogleAuth: false,
    dryRun: false,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--activities-mode") options.activitiesMode = String(argv[i + 1] || options.activitiesMode);
    if (arg === "--window-days") options.windowDays = Number(argv[i + 1] || options.windowDays);
    if (arg === "--auto-open-browser") options.autoOpenBrowser = true;
    if (arg === "--no-auto-open-browser") options.autoOpenBrowser = false;
    if (arg === "--out-activities") options.outActivities = String(argv[i + 1] || options.outActivities);
    if (arg === "--snapshot") options.snapshotPath = String(argv[i + 1] || options.snapshotPath);
    if (arg === "--preferences-out") options.preferencesOut = String(argv[i + 1] || options.preferencesOut);
    if (arg === "--skip-google-auth") options.includeGoogleAuth = false;
    if (arg === "--require-google-auth") options.requireGoogleAuth = true;
    if (arg === "--dry-run") options.dryRun = true;
    if (arg === "--quiet") options.quiet = true;
  }

  if (!options.includeGoogleAuth) {
    options.requireGoogleAuth = false;
  }

  if (!["all", "window"].includes(options.activitiesMode)) {
    throw new Error(`Invalid --activities-mode: ${options.activitiesMode}. Use all|window.`);
  }
  if (!Number.isFinite(options.windowDays) || options.windowDays <= 0) {
    throw new Error(`Invalid --window-days: ${options.windowDays}`);
  }
  return options;
}

function runBunScript(projectDir, relScriptPath, args = [], { optional = false, quiet = false } = {}) {
  const scriptPath = path.join(projectDir, relScriptPath);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: projectDir,
    env: process.env,
    encoding: "utf-8",
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.status === 0) return;
  if (optional) {
    if (!quiet) process.stderr.write(`[Coaching Team] Optional step failed: ${relScriptPath}\n`);
    if (quiet && result.stderr) process.stderr.write(String(result.stderr));
    return;
  }
  if (quiet && result.stderr) process.stderr.write(String(result.stderr));
  throw new Error(`[Coaching Team] Step failed (${result.status}): ${relScriptPath}`);
}

function buildStravaPipelineSteps(options) {
  const fetchArgs =
    options.activitiesMode === "all"
      ? ["--all", "--out", options.outActivities]
      : ["--window-days", String(options.windowDays), "--out", options.outActivities];

  return [
    {
      script: ".claude/skills/onboard/scripts/fetch_strava_athlete.js",
      args: [],
      optional: false,
      label: "Fetch Strava athlete",
    },
    {
      script: ".claude/skills/onboard/scripts/fetch_strava_stats.js",
      args: [],
      optional: false,
      label: "Fetch Strava stats",
    },
    {
      script: ".claude/skills/onboard/scripts/fetch_strava_zones.js",
      args: [],
      optional: true,
      label: "Fetch Strava zones",
    },
    {
      script: ".claude/skills/setup/scripts/fetch_strava_activities.js",
      args: fetchArgs,
      optional: false,
      label: "Fetch Strava activities",
    },
    {
      script: ".claude/skills/coach-sync/scripts/build_strava_snapshot.js",
      args: ["--input", options.outActivities, "--out", options.snapshotPath],
      optional: false,
      label: "Build Strava snapshot",
    },
    {
      script: ".claude/skills/coach-sync/scripts/build_baseline.js",
      args: ["--snapshot", options.snapshotPath, "--activities", options.outActivities, "--out", PATHS.coach.baseline],
      optional: false,
      label: "Build baseline from Strava",
    },
    {
      script: ".claude/skills/coach-sync/scripts/audit_bike_power_streams.js",
      args: [
        "--activities",
        options.outActivities,
        "--snapshot",
        options.snapshotPath,
        "--stream-dir",
        "data/external/strava/streams",
        "--window-days",
        "28",
      ],
      optional: false,
      label: "Audit bike power streams",
    },
    {
      script: ".claude/skills/setup/scripts/derive_schedule_preferences.js",
      args: [
        "--activities",
        options.outActivities,
        "--snapshot",
        options.snapshotPath,
        "--out",
        options.preferencesOut,
        "--window-days",
        "56",
      ],
      optional: false,
      label: "Derive schedule preferences",
    },
  ];
}

function spawnGoogleOAuth(projectDir, options) {
  const scriptPath = path.join(projectDir, ".claude/skills/setup/scripts/google_calendar_auth.js");
  const args = [scriptPath, options.autoOpenBrowser ? "--auto-open-browser" : "--no-auto-open-browser"];
  const child = spawn(process.execPath, args, {
    cwd: projectDir,
    env: process.env,
    stdio: "inherit",
  });

  const done = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      resolve({ code: code == null ? 1 : code, signal: signal || null });
    });
  });

  return { child, done };
}

async function main() {
  const options = parseArgs();
  const projectDir = resolveProjectDir();
  const steps = buildStravaPipelineSteps(options);

  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          mode: options.activitiesMode,
          include_google_auth: options.includeGoogleAuth,
          require_google_auth: options.requireGoogleAuth,
          steps: steps.map((step) => ({ script: step.script, args: step.args, optional: step.optional })),
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const result = {
    ok: true,
    include_google_auth: options.includeGoogleAuth,
    require_google_auth: options.requireGoogleAuth,
    google_auth: { attempted: false, ok: null, optional_failure: false },
  };

  let google = null;
  if (options.includeGoogleAuth) {
    result.google_auth.attempted = true;
    google = spawnGoogleOAuth(projectDir, options);
  } else {
    if (!options.quiet) process.stderr.write("[Coaching Team] Google Calendar OAuth skipped (--skip-google-auth).\n");
  }

  try {
    for (const step of steps) {
      if (!options.quiet) process.stderr.write(`[Coaching Team] ${step.label}...\n`);
      runBunScript(projectDir, step.script, step.args, { optional: step.optional, quiet: options.quiet });
    }
  } catch (error) {
    if (google && google.child && google.child.exitCode == null) {
      google.child.kill("SIGTERM");
    }
    throw error;
  }

  if (google) {
    const googleResult = await google.done;
    if (googleResult.code !== 0) {
      if (options.requireGoogleAuth) {
        throw new Error(
          `Google Calendar OAuth failed (exit=${googleResult.code}${
            googleResult.signal ? `, signal=${googleResult.signal}` : ""
          }).`
        );
      }
      result.google_auth.ok = false;
      result.google_auth.optional_failure = true;
      result.ok = true;
      if (!options.quiet) {
        process.stderr.write("[Coaching Team] Google Calendar OAuth failed, continuing because auth is optional.\n");
      }
    } else {
      result.google_auth.ok = true;
    }
  }

  if (!options.quiet) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...result,
          activities_mode: options.activitiesMode,
          activities_out: options.outActivities,
          snapshot_out: options.snapshotPath,
          preferences_out: options.preferencesOut,
        },
        null,
        2
      )}\n`
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  });
}
