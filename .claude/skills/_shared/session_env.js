const fs = require("fs");
const path = require("path");
const { PATHS } = require("./paths");

function resolveProjectRoot() {
  if (process.env.CLAUDE_PROJECT_DIR) {
    return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  }
  return path.resolve(__dirname, "../../..");
}

function resolveSettingsPath(projectRoot = resolveProjectRoot()) {
  return path.join(projectRoot, ".claude", "settings.json");
}

function resolveUserEnvPath(projectRoot = resolveProjectRoot()) {
  if (process.env.COACH_USER_ENV_PATH) {
    return path.isAbsolute(process.env.COACH_USER_ENV_PATH)
      ? process.env.COACH_USER_ENV_PATH
      : path.join(projectRoot, process.env.COACH_USER_ENV_PATH);
  }
  return path.join(projectRoot, ...PATHS.system.userEnv.split("/"));
}

function parseEnvText(content) {
  const result = {};
  for (const line of String(content || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    result[key] = value;
  }
  return result;
}

function readSettingsEnv(projectRoot = resolveProjectRoot()) {
  const settingsPath = resolveSettingsPath(projectRoot);
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const env = parsed && typeof parsed.env === "object" && parsed.env ? parsed.env : {};
    const normalized = {};
    for (const [key, value] of Object.entries(env)) {
      if (!key) continue;
      normalized[key] = String(value);
    }
    return normalized;
  } catch {
    return {};
  }
}

function readUserEnv(projectRoot = resolveProjectRoot()) {
  const userEnvPath = resolveUserEnvPath(projectRoot);
  try {
    const content = fs.readFileSync(userEnvPath, "utf-8");
    return parseEnvText(content);
  } catch {
    return {};
  }
}

function hydrateSessionEnv(projectRoot = resolveProjectRoot()) {
  const settingsEnv = readSettingsEnv(projectRoot);
  for (const [key, value] of Object.entries(settingsEnv)) {
    if (!process.env[key]) process.env[key] = value;
  }

  const userEnv = readUserEnv(projectRoot);
  for (const [key, value] of Object.entries(userEnv)) {
    if (!process.env[key]) process.env[key] = value;
  }

  return {
    settingsEnv,
    userEnv,
    userEnvPath: resolveUserEnvPath(projectRoot),
  };
}

function persistUserEnvVars(patch, projectRoot = resolveProjectRoot()) {
  const userEnvPath = resolveUserEnvPath(projectRoot);
  const existing = readUserEnv(projectRoot);
  const merged = { ...existing };

  for (const [key, value] of Object.entries(patch || {})) {
    if (value == null || value === "") {
      delete merged[key];
      continue;
    }
    merged[key] = String(value);
  }

  const orderedKeys = Object.keys(merged).sort();
  const body = orderedKeys.map((key) => `${key}=${merged[key]}`).join("\n");

  fs.mkdirSync(path.dirname(userEnvPath), { recursive: true });
  fs.writeFileSync(userEnvPath, body ? `${body}\n` : "", "utf-8");

  for (const [key, value] of Object.entries(patch || {})) {
    if (value == null || value === "") {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  return merged;
}

module.exports = {
  resolveProjectRoot,
  resolveSettingsPath,
  resolveUserEnvPath,
  parseEnvText,
  readSettingsEnv,
  readUserEnv,
  hydrateSessionEnv,
  persistUserEnvVars,
};
