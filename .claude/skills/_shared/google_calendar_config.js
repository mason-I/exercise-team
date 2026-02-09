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

function resolveCalendarConfigPath() {
  return resolveUserEnvPath(resolveProjectRoot());
}

function loadCalendarConfig() {
  hydrateSessionEnv(resolveProjectRoot());
  return {
    clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GCAL_CLIENT_ID || null,
    clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GCAL_CLIENT_SECRET || null,
    accessToken: process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || process.env.GCAL_ACCESS_TOKEN || null,
    refreshToken: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN || process.env.GCAL_REFRESH_TOKEN || null,
    expiresAt:
      Number(process.env.GOOGLE_CALENDAR_EXPIRES_AT || process.env.GCAL_EXPIRES_AT || 0) || null,
    calendarId: process.env.GOOGLE_CALENDAR_ID || process.env.GCAL_CALENDAR_ID || null,
    scopes: process.env.GOOGLE_CALENDAR_SCOPES || process.env.GCAL_SCOPES || null,
  };
}

function saveCalendarConfig(patch) {
  hydrateSessionEnv(resolveProjectRoot());
  const envPatch = {};

  if (Object.prototype.hasOwnProperty.call(patch || {}, "accessToken")) {
    envPatch.GOOGLE_CALENDAR_ACCESS_TOKEN = patch.accessToken || "";
    envPatch.GCAL_ACCESS_TOKEN = patch.accessToken || "";
  }
  if (Object.prototype.hasOwnProperty.call(patch || {}, "refreshToken")) {
    envPatch.GOOGLE_CALENDAR_REFRESH_TOKEN = patch.refreshToken || "";
    envPatch.GCAL_REFRESH_TOKEN = patch.refreshToken || "";
  }
  if (Object.prototype.hasOwnProperty.call(patch || {}, "expiresAt")) {
    envPatch.GOOGLE_CALENDAR_EXPIRES_AT = patch.expiresAt == null ? "" : String(patch.expiresAt);
    envPatch.GCAL_EXPIRES_AT = patch.expiresAt == null ? "" : String(patch.expiresAt);
  }
  if (Object.prototype.hasOwnProperty.call(patch || {}, "calendarId")) {
    envPatch.GOOGLE_CALENDAR_ID = patch.calendarId || "";
    envPatch.GCAL_CALENDAR_ID = patch.calendarId || "";
  }
  if (Object.prototype.hasOwnProperty.call(patch || {}, "scopes")) {
    const scopesValue = Array.isArray(patch.scopes) ? patch.scopes.join(",") : String(patch.scopes || "");
    envPatch.GOOGLE_CALENDAR_SCOPES = scopesValue;
    envPatch.GCAL_SCOPES = scopesValue;
  }

  if (Object.prototype.hasOwnProperty.call(patch || {}, "clientId") && patch.clientId) {
    process.env.GOOGLE_CALENDAR_CLIENT_ID = String(patch.clientId);
    process.env.GCAL_CLIENT_ID = String(patch.clientId);
  }
  if (Object.prototype.hasOwnProperty.call(patch || {}, "clientSecret") && patch.clientSecret) {
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = String(patch.clientSecret);
    process.env.GCAL_CLIENT_SECRET = String(patch.clientSecret);
  }

  if (Object.keys(envPatch).length > 0) {
    persistUserEnvVars(envPatch, resolveProjectRoot());
  }

  return loadCalendarConfig();
}

function isCalendarConfigured() {
  const fileConfig = loadCalendarConfig();
  const clientId =
    process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GCAL_CLIENT_ID || fileConfig.clientId;
  const clientSecret =
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET ||
    process.env.GCAL_CLIENT_SECRET ||
    fileConfig.clientSecret;
  const refreshToken =
    process.env.GOOGLE_CALENDAR_REFRESH_TOKEN ||
    process.env.GCAL_REFRESH_TOKEN ||
    fileConfig.refreshToken;
  return Boolean(clientId && clientSecret && refreshToken);
}

module.exports = {
  resolveProjectRoot,
  resolveCalendarConfigPath,
  loadCalendarConfig,
  saveCalendarConfig,
  isCalendarConfigured,
};
