const fs = require("fs");
const path = require("path");
const {
  hydrateSessionEnv,
  persistUserEnvVars,
  resolveUserEnvPath,
} = require("./session_env");

function resolveProjectRoot() {
  if (process.env.CLAUDE_PROJECT_DIR) {
    return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  }
  return path.resolve(__dirname, "../../..");
}

function resolveStravaConfigPath() {
  return resolveUserEnvPath(resolveProjectRoot());
}

function hydrateStravaEnv() {
  hydrateSessionEnv(resolveProjectRoot());
}

function loadStravaConfig() {
  hydrateStravaEnv();
  return {
    clientId: process.env.STRAVA_CLIENT_ID || null,
    clientSecret: process.env.STRAVA_CLIENT_SECRET || null,
    accessToken: process.env.STRAVA_ACCESS_TOKEN || null,
    refreshToken: process.env.STRAVA_REFRESH_TOKEN || null,
    expiresAt: Number(process.env.STRAVA_EXPIRES_AT || 0) || null,
  };
}

function saveStravaConfig(patch) {
  hydrateStravaEnv();
  const envPatch = {};

  if (Object.prototype.hasOwnProperty.call(patch || {}, "accessToken")) {
    envPatch.STRAVA_ACCESS_TOKEN = patch.accessToken || "";
  }
  if (Object.prototype.hasOwnProperty.call(patch || {}, "refreshToken")) {
    envPatch.STRAVA_REFRESH_TOKEN = patch.refreshToken || "";
  }
  if (Object.prototype.hasOwnProperty.call(patch || {}, "expiresAt")) {
    envPatch.STRAVA_EXPIRES_AT = patch.expiresAt == null ? "" : String(patch.expiresAt);
  }

  if (Object.prototype.hasOwnProperty.call(patch || {}, "clientId") && patch.clientId) {
    process.env.STRAVA_CLIENT_ID = String(patch.clientId);
  }
  if (Object.prototype.hasOwnProperty.call(patch || {}, "clientSecret") && patch.clientSecret) {
    process.env.STRAVA_CLIENT_SECRET = String(patch.clientSecret);
  }

  if (Object.keys(envPatch).length > 0) {
    persistUserEnvVars(envPatch, resolveProjectRoot());
  }

  return loadStravaConfig();
}

function isStravaConfigured() {
  hydrateStravaEnv();
  const fileConfig = loadStravaConfig();
  const clientId = process.env.STRAVA_CLIENT_ID || fileConfig.clientId;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET || fileConfig.clientSecret;
  const refreshToken = process.env.STRAVA_REFRESH_TOKEN || fileConfig.refreshToken;
  return Boolean(clientId && clientSecret && refreshToken);
}

module.exports = {
  resolveProjectRoot,
  resolveStravaConfigPath,
  hydrateStravaEnv,
  loadStravaConfig,
  saveStravaConfig,
  isStravaConfigured,
};
