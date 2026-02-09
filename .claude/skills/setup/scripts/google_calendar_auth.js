#!/usr/bin/env bun

const {
  DEFAULT_AUTH_PORT,
  DEFAULT_CALENDAR_ID,
  DEFAULT_SCOPE,
  loadCredentialState,
  refreshOrGetAccessToken,
} = require("../../_shared/google_calendar_auth_flow");
const { saveCalendarConfig } = require("../../_shared/google_calendar_config");
const { hydrateSessionEnv } = require("../../_shared/session_env");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    autoOpenBrowser: true,
    calendarId: DEFAULT_CALENDAR_ID,
    port: DEFAULT_AUTH_PORT,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--auto-open-browser") options.autoOpenBrowser = true;
    if (arg === "--no-auto-open-browser") options.autoOpenBrowser = false;
    if (arg === "--calendar-id") options.calendarId = args[i + 1] || DEFAULT_CALENDAR_ID;
    if (arg === "--port") options.port = Number(args[i + 1] || DEFAULT_AUTH_PORT);
  }
  return options;
}

function hydrateCanonicalEnvVars() {
  const aliases = [
    ["GOOGLE_CALENDAR_CLIENT_ID", ["GCAL_CLIENT_ID"]],
    ["GOOGLE_CALENDAR_CLIENT_SECRET", ["GCAL_CLIENT_SECRET"]],
    ["GOOGLE_CALENDAR_ACCESS_TOKEN", ["GCAL_ACCESS_TOKEN"]],
    ["GOOGLE_CALENDAR_REFRESH_TOKEN", ["GCAL_REFRESH_TOKEN"]],
    ["GOOGLE_CALENDAR_EXPIRES_AT", ["GCAL_EXPIRES_AT"]],
    ["GOOGLE_CALENDAR_ID", ["GCAL_CALENDAR_ID"]],
    ["GOOGLE_CALENDAR_SCOPES", ["GCAL_SCOPES"]],
  ];

  for (const [canonical, sourceKeys] of aliases) {
    if (process.env[canonical]) continue;
    const source = sourceKeys.find((key) => process.env[key]);
    if (source) {
      process.env[canonical] = process.env[source];
    }
  }
}

function setupInstructionText(port) {
  return [
    "Google Calendar client credentials are missing.",
    "Create an OAuth client in Google Cloud Console (Web application).",
    `Add authorized redirect URI: http://localhost:${port}/callback`,
    "Set pre-session env values in .claude/settings.json: GCAL_CLIENT_ID and GCAL_CLIENT_SECRET (or GOOGLE_CALENDAR_CLIENT_ID/SECRET).",
  ].join("\n");
}

async function main() {
  const options = parseArgs();
  hydrateSessionEnv(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  hydrateCanonicalEnvVars();

  const state = loadCredentialState();
  if (!state.clientId || !state.clientSecret) {
    throw new Error(setupInstructionText(options.port));
  }

  saveCalendarConfig({
    clientId: state.clientId,
    clientSecret: state.clientSecret,
    calendarId: options.calendarId || DEFAULT_CALENDAR_ID,
    scopes: state.scopes && state.scopes.length ? state.scopes : [DEFAULT_SCOPE],
  });

  const result = await refreshOrGetAccessToken(null, {
    allowInteractiveOAuth: true,
    port: options.port,
    timeoutMs: 5 * 60 * 1000,
    autoOpenBrowser: options.autoOpenBrowser,
    logger: (line) => {
      if (line) process.stderr.write(`${line}\n`);
    },
  });

  if (!result?.accessToken) {
    throw new Error("Google Calendar OAuth did not return an access token.");
  }

  const latest = loadCredentialState();
  saveCalendarConfig({
    calendarId: options.calendarId || latest.calendarId || DEFAULT_CALENDAR_ID,
    scopes: latest.scopes && latest.scopes.length ? latest.scopes : [DEFAULT_SCOPE],
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        method: result.method,
        calendar_id: options.calendarId || latest.calendarId || DEFAULT_CALENDAR_ID,
        expires_at: latest.expiresAt || null,
      },
      null,
      2
    )}\n`
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  });
}
