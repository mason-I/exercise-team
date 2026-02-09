#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");
const { PATHS } = require("../../_shared/paths");

function resolveProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR
    ? path.resolve(process.env.CLAUDE_PROJECT_DIR)
    : path.resolve(__dirname, "../../../..");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureFile(filePath, content = "") {
  if (fs.existsSync(filePath)) return false;
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf-8");
  return true;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function cloneJsonTemplate(projectDir, templateName, outPath, overrides = {}) {
  if (fs.existsSync(outPath)) return false;
  const templatePath = path.join(projectDir, "templates", templateName);
  const template = readJson(templatePath);
  const merged = { ...template, ...overrides };
  writeJson(outPath, merged);
  return true;
}

function progressionStateTemplate(todayIso) {
  return {
    as_of_date: todayIso,
    primary_goal_id: "",
    phase_mode: "maintain",
    discipline_state: {
      run: {
        current: {},
        target: {},
        gap: "",
        confidence: "low",
      },
      bike: {
        current: {},
        target: {},
        gap: "",
        confidence: "low",
      },
      swim: {
        current: {},
        target: {},
        gap: "",
        confidence: "low",
      },
      strength: {
        current: {},
        target: {},
        gap: "",
        confidence: "low",
      },
    },
    weekly_change_log: [],
    next_checkpoint: {
      date: todayIso,
      target_markers: [],
    },
    risk_adjustments_pending_user_confirmation: [],
  };
}

function main() {
  const projectDir = resolveProjectDir();
  const todayIso = new Date().toISOString().slice(0, 10);

  const dirs = [
    PATHS.dataRoot,
    PATHS.coachRoot,
    PATHS.coach.plansDir,
    PATHS.coach.reportsDir,
    PATHS.coach.checkinsDir,
    PATHS.externalRoot,
    PATHS.stravaRoot,
    PATHS.external.stravaStreamsDir,
    PATHS.systemRoot,
    PATHS.system.stravaDir,
    PATHS.system.calendarDir,
    PATHS.system.googleCalendarDir,
    path.dirname(PATHS.system.userEnv),
  ];

  const created = {
    dirs: [],
    files: [],
  };

  for (const rel of dirs) {
    const abs = path.join(projectDir, rel);
    const existed = fs.existsSync(abs);
    ensureDir(abs);
    if (!existed) created.dirs.push(rel);
  }

  if (ensureFile(path.join(projectDir, "data", ".gitkeep"), "")) {
    created.files.push("data/.gitkeep");
  }

  if (cloneJsonTemplate(projectDir, "profile.json", path.join(projectDir, ...PATHS.coach.profile.split("/")))) {
    created.files.push("data/coach/profile.json");
  }
  if (cloneJsonTemplate(projectDir, "goals.json", path.join(projectDir, ...PATHS.coach.goals.split("/")))) {
    created.files.push("data/coach/goals.json");
  }
  if (cloneJsonTemplate(projectDir, "baseline.json", path.join(projectDir, ...PATHS.coach.baseline.split("/")), { as_of_date: todayIso })) {
    created.files.push("data/coach/baseline.json");
  }
  if (cloneJsonTemplate(projectDir, "strategy.json", path.join(projectDir, ...PATHS.coach.strategy.split("/")))) {
    created.files.push("data/coach/strategy.json");
  }

  const progressionPath = path.join(projectDir, ...PATHS.coach.progressionState.split("/"));
  if (!fs.existsSync(progressionPath)) {
    writeJson(progressionPath, progressionStateTemplate(todayIso));
    created.files.push("data/coach/progression_state.json");
  }

  const stateStravaConfig = path.join(projectDir, ...PATHS.system.stravaConfig.split("/"));
  if (!fs.existsSync(stateStravaConfig)) {
    writeJson(stateStravaConfig, {});
    created.files.push("data/system/strava/config.json");
  }

  const stateCalendarConfig = path.join(projectDir, ...PATHS.system.calendarConfig.split("/"));
  if (!fs.existsSync(stateCalendarConfig)) {
    writeJson(stateCalendarConfig, {});
    created.files.push("data/system/calendar/config.json");
  }

  const userEnv = path.join(projectDir, ...PATHS.system.userEnv.split("/"));
  if (ensureFile(userEnv, "")) {
    created.files.push("data/system/user/env/user.env");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        project_dir: projectDir,
        created,
      },
      null,
      2
    )}\n`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}
