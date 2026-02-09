const path = require("path");
const net = require("net");
const {
  DEFAULT_AUTH_PORT: STRAVA_DEFAULT_AUTH_PORT,
  getSetupInstructionsText,
  loadCredentialState: loadStravaCredentialState,
} = require("./strava_auth_flow");
const {
  DEFAULT_AUTH_PORT: GCAL_DEFAULT_AUTH_PORT,
  getRedirectUri: getGoogleRedirectUri,
  loadCredentialState: loadGoogleCredentialState,
} = require("./google_calendar_auth_flow");
const { hydrateSessionEnv, resolveUserEnvPath } = require("./session_env");

const CALENDAR_GATES = new Set(["required_skippable", "required", "optional"]);

function resolveProjectDir() {
  if (process.env.CLAUDE_PROJECT_DIR) {
    return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  }
  return path.resolve(__dirname, "../../..");
}

function hydrateEnv(projectDir) {
  hydrateSessionEnv(projectDir);
}

function normalizeCalendarAliases() {
  const aliasPairs = [
    ["GOOGLE_CALENDAR_CLIENT_ID", "GCAL_CLIENT_ID"],
    ["GOOGLE_CALENDAR_CLIENT_SECRET", "GCAL_CLIENT_SECRET"],
    ["GOOGLE_CALENDAR_ACCESS_TOKEN", "GCAL_ACCESS_TOKEN"],
    ["GOOGLE_CALENDAR_REFRESH_TOKEN", "GCAL_REFRESH_TOKEN"],
    ["GOOGLE_CALENDAR_EXPIRES_AT", "GCAL_EXPIRES_AT"],
    ["GOOGLE_CALENDAR_ID", "GCAL_CALENDAR_ID"],
    ["GOOGLE_CALENDAR_SCOPES", "GCAL_SCOPES"],
  ];

  for (const [canonical, alias] of aliasPairs) {
    if (!process.env[canonical] && process.env[alias]) process.env[canonical] = process.env[alias];
    if (!process.env[alias] && process.env[canonical]) process.env[alias] = process.env[canonical];
  }
}

function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        // no-op
      }
      resolve(value);
    };

    server.once("error", (error) => {
      const code = String(error && error.code ? error.code : "");
      if (code === "EADDRINUSE") {
        finish({ available: false, reason: "in_use" });
        return;
      }
      finish({ available: false, reason: code || "error" });
    });

    server.once("listening", () => {
      finish({ available: true, reason: null });
    });

    try {
      server.listen({ port, host: "127.0.0.1" });
    } catch (error) {
      finish({ available: false, reason: String(error && error.code ? error.code : "error") });
    }
  });
}

function requiredKeysFromState(state, keyMap) {
  return Object.entries(keyMap)
    .filter(([, value]) => !state[value])
    .map(([envKey]) => envKey);
}

function parseCalendarGate(value) {
  const normalized = String(value || "required_skippable").trim().toLowerCase();
  if (!CALENDAR_GATES.has(normalized)) {
    throw new Error(`Invalid calendar gate '${value}'. Use required_skippable|required|optional.`);
  }
  return normalized;
}

async function runCredentialPreflight(options = {}) {
  const projectDir = options.projectDir ? path.resolve(options.projectDir) : resolveProjectDir();
  const calendarGate = parseCalendarGate(options.calendarGate);
  const stravaPort = Number(options.stravaPort || STRAVA_DEFAULT_AUTH_PORT);
  const gcalPort = Number(options.gcalPort || GCAL_DEFAULT_AUTH_PORT);
  const checkPorts = options.checkPorts !== false;

  hydrateEnv(projectDir);
  normalizeCalendarAliases();

  const stravaState = loadStravaCredentialState();
  const gcalState = loadGoogleCredentialState();

  const stravaMissing = requiredKeysFromState(stravaState, {
    STRAVA_CLIENT_ID: "clientId",
    STRAVA_CLIENT_SECRET: "clientSecret",
  });

  const gcalMissing = requiredKeysFromState(gcalState, {
    GCAL_CLIENT_ID: "clientId",
    GCAL_CLIENT_SECRET: "clientSecret",
  });

  const ports = {
    strava_auth: {
      port: stravaPort,
      ...(checkPorts ? await checkPortAvailable(stravaPort) : { available: true, reason: null }),
    },
    google_calendar_auth: {
      port: gcalPort,
      ...(checkPorts ? await checkPortAvailable(gcalPort) : { available: true, reason: null }),
    },
  };

  const actionableErrors = [];
  const warnings = [];

  if (stravaMissing.length) {
    actionableErrors.push({
      code: "STRAVA_MISSING_CLIENT_CREDENTIALS",
      provider: "strava",
      message: "Strava client credentials are missing.",
      remediation: getSetupInstructionsText(stravaPort),
      missing_keys: stravaMissing,
    });
  }

  const calendarRequired = calendarGate === "required" || calendarGate === "required_skippable";
  if (calendarRequired && gcalMissing.length) {
    actionableErrors.push({
      code: "GCAL_MISSING_CLIENT_CREDENTIALS",
      provider: "google_calendar",
      message: "Google Calendar client credentials are missing.",
      remediation: [
        "Create a Google OAuth Web application credential.",
        `Add redirect URI: ${getGoogleRedirectUri(gcalPort)}`,
        "Set GCAL_CLIENT_ID and GCAL_CLIENT_SECRET (or GOOGLE_CALENDAR_CLIENT_ID/SECRET) in .claude/settings.json env.",
      ].join("\n"),
      missing_keys: gcalMissing,
    });
  }

  if (!ports.strava_auth.available) {
    actionableErrors.push({
      code: "STRAVA_AUTH_PORT_UNAVAILABLE",
      provider: "strava",
      message: `Strava OAuth port ${stravaPort} is unavailable (${ports.strava_auth.reason || "unknown"}).`,
      remediation: `Free port ${stravaPort} before running setup again.`,
      missing_keys: [],
    });
  }

  if (!ports.google_calendar_auth.available && calendarGate === "required") {
    actionableErrors.push({
      code: "GCAL_AUTH_PORT_UNAVAILABLE",
      provider: "google_calendar",
      message: `Google Calendar OAuth port ${gcalPort} is unavailable (${ports.google_calendar_auth.reason || "unknown"}).`,
      remediation: `Free port ${gcalPort} before running setup again.`,
      missing_keys: [],
    });
  } else if (!ports.google_calendar_auth.available) {
    warnings.push(`Google Calendar OAuth port ${gcalPort} is unavailable; calendar connect may require retry.`);
  }

  const result = {
    ok: actionableErrors.length === 0,
    project_dir: projectDir,
    calendar_gate: calendarGate,
    strava: {
      required: true,
      has_client_credentials: stravaMissing.length === 0,
      missing_keys: stravaMissing,
      has_refresh_token: Boolean(stravaState.refreshToken),
      has_access_token: Boolean(stravaState.accessToken),
      config_path: resolveUserEnvPath(projectDir),
    },
    google_calendar: {
      required: calendarRequired,
      can_skip: calendarGate === "required_skippable" || calendarGate === "optional",
      has_client_credentials: gcalMissing.length === 0,
      missing_keys: gcalMissing,
      has_refresh_token: Boolean(gcalState.refreshToken),
      has_access_token: Boolean(gcalState.accessToken),
      config_path: resolveUserEnvPath(projectDir),
      expected_redirect_uri: getGoogleRedirectUri(gcalPort),
    },
    ports,
    actionable_errors: actionableErrors,
    warnings,
  };

  return result;
}

module.exports = {
  CALENDAR_GATES,
  parseCalendarGate,
  runCredentialPreflight,
  checkPortAvailable,
};
