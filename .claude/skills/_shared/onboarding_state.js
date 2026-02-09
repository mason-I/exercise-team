const fs = require("fs");
const path = require("path");
const { PATHS } = require("./paths");

const DEFAULT_RELATIVE_PATH = path.join(...PATHS.system.onboardingSession.split("/"));

function resolveProjectDir() {
  if (process.env.CLAUDE_PROJECT_DIR) {
    return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  }
  return path.resolve(__dirname, "../../..");
}

function resolveStatePath(projectDir = resolveProjectDir(), overridePath = null) {
  if (overridePath) {
    return path.isAbsolute(overridePath) ? overridePath : path.join(projectDir, overridePath);
  }
  return path.join(projectDir, DEFAULT_RELATIVE_PATH);
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function nowIso() {
  return new Date().toISOString();
}

function createInitialState(seed = {}) {
  const timestamp = nowIso();
  return {
    version: 1,
    stage: "preflight",
    status: "running",
    started_at: timestamp,
    updated_at: timestamp,
    completed_at: null,
    strava: {
      status: "pending",
      method: null,
      last_error: null,
      ...seed.strava,
    },
    google_calendar: {
      status: "pending",
      method: null,
      last_error: null,
      skipped_reason: null,
      ...seed.google_calendar,
    },
    intake: {
      status: "pending",
      questions: [],
      missing_required_count: 0,
      ...seed.intake,
    },
    artifacts: {
      status: "pending",
      files: [],
      ...seed.artifacts,
    },
    week1_plan: {
      status: "pending",
      file_path: null,
      ...seed.week1_plan,
    },
    calendar_sync: {
      status: "pending",
      mode: null,
      preview: null,
      applied: null,
      ...seed.calendar_sync,
    },
    errors: Array.isArray(seed.errors) ? seed.errors : [],
  };
}

function loadState(statePath) {
  return safeReadJson(statePath);
}

function startSession({ projectDir = resolveProjectDir(), statePath = null, resume = false } = {}) {
  const targetPath = resolveStatePath(projectDir, statePath);
  const existing = loadState(targetPath);
  if (resume && existing && typeof existing === "object") {
    const next = {
      ...existing,
      updated_at: nowIso(),
      status: existing.status === "completed" ? "completed" : "running",
    };
    writeJson(targetPath, next);
    return { statePath: targetPath, state: next, resumed: true };
  }

  const fresh = createInitialState();
  writeJson(targetPath, fresh);
  return { statePath: targetPath, state: fresh, resumed: false };
}

function mutateState(statePath, mutator) {
  const current = loadState(statePath) || createInitialState();
  const updated = mutator ? mutator({ ...current }) || current : current;
  updated.updated_at = nowIso();
  writeJson(statePath, updated);
  return updated;
}

function setStage(statePath, stage, extra = {}) {
  return mutateState(statePath, (state) => ({ ...state, stage, ...extra }));
}

function recordError(statePath, errorPayload) {
  return mutateState(statePath, (state) => {
    const errors = Array.isArray(state.errors) ? [...state.errors] : [];
    errors.push({
      at: nowIso(),
      ...errorPayload,
    });
    return {
      ...state,
      errors,
      status: "error",
    };
  });
}

function markCompleted(statePath, extra = {}) {
  return mutateState(statePath, (state) => ({
    ...state,
    ...extra,
    status: "completed",
    completed_at: nowIso(),
  }));
}

module.exports = {
  DEFAULT_RELATIVE_PATH,
  resolveProjectDir,
  resolveStatePath,
  createInitialState,
  loadState,
  startSession,
  mutateState,
  setStage,
  recordError,
  markCompleted,
};
