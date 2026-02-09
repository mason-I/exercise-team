const http = require("http");
const https = require("https");
const { execFile } = require("child_process");
const { loadCalendarConfig, saveCalendarConfig } = require("./google_calendar_config");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_AUTH_PORT = 8123;
const DEFAULT_CALENDAR_ID = "primary";
const DEFAULT_SCOPE = "https://www.googleapis.com/auth/calendar.events";

function getRedirectUri(port = DEFAULT_AUTH_PORT) {
  return `http://localhost:${port}/callback`;
}

function normalizeScopes(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
  }
  if (typeof value === "string") {
    return value
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [DEFAULT_SCOPE];
}

function requestFormEncoded(url, bodyObj) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = new URLSearchParams(bodyObj).toString();
    const options = {
      method: "POST",
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const json = JSON.parse(data || "{}");
          if (res.statusCode && res.statusCode >= 400) {
            const error = new Error(`HTTP ${res.statusCode}: ${JSON.stringify(json)}`);
            error.statusCode = res.statusCode;
            reject(error);
            return;
          }
          resolve(json);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function loadCredentialState() {
  const fileConfig = loadCalendarConfig();
  const scopes = normalizeScopes(
    process.env.GOOGLE_CALENDAR_SCOPES ||
      process.env.GCAL_SCOPES ||
      fileConfig.scopes ||
      DEFAULT_SCOPE
  );

  return {
    clientId:
      process.env.GOOGLE_CALENDAR_CLIENT_ID ||
      process.env.GCAL_CLIENT_ID ||
      fileConfig.clientId ||
      null,
    clientSecret:
      process.env.GOOGLE_CALENDAR_CLIENT_SECRET ||
      process.env.GCAL_CLIENT_SECRET ||
      fileConfig.clientSecret ||
      null,
    accessToken:
      process.env.GOOGLE_CALENDAR_ACCESS_TOKEN ||
      process.env.GCAL_ACCESS_TOKEN ||
      fileConfig.accessToken ||
      null,
    refreshToken:
      process.env.GOOGLE_CALENDAR_REFRESH_TOKEN ||
      process.env.GCAL_REFRESH_TOKEN ||
      fileConfig.refreshToken ||
      null,
    expiresAt:
      Number(process.env.GOOGLE_CALENDAR_EXPIRES_AT || process.env.GCAL_EXPIRES_AT || fileConfig.expiresAt || 0) ||
      null,
    scopes,
    calendarId:
      process.env.GOOGLE_CALENDAR_ID ||
      process.env.GCAL_CALENDAR_ID ||
      fileConfig.calendarId ||
      DEFAULT_CALENDAR_ID,
  };
}

function hasClientCredentials(state) {
  return Boolean(state?.clientId && state?.clientSecret);
}

function hasUsableAccessToken(state) {
  const now = Math.floor(Date.now() / 1000);
  return Boolean(state?.accessToken && state?.expiresAt && Number(state.expiresAt) > now + 60);
}

function needsOAuth(state) {
  if (!hasClientCredentials(state)) return false;
  return !state?.refreshToken;
}

function saveTokenState(tokens) {
  saveCalendarConfig(tokens);
  if (tokens.accessToken) process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = tokens.accessToken;
  if (tokens.refreshToken) process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = tokens.refreshToken;
  if (tokens.expiresAt != null) process.env.GOOGLE_CALENDAR_EXPIRES_AT = String(tokens.expiresAt);
  if (tokens.calendarId) process.env.GOOGLE_CALENDAR_ID = tokens.calendarId;
}

function maybeOpenBrowser(url, logger) {
  if (process.platform !== "darwin") return;
  execFile("open", [url], (error) => {
    if (!error) {
      logger("[calendar-auth] Opened browser automatically.");
      return;
    }
    logger("[calendar-auth] Could not auto-open browser. Use the URL above.");
  });
}

function buildAuthUrl(clientId, scopes, port, stateToken) {
  const params = new URLSearchParams({
    client_id: String(clientId),
    redirect_uri: getRedirectUri(port),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: scopes.join(" "),
  });
  if (stateToken) params.set("state", stateToken);
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

async function exchangeAuthCode({ clientId, clientSecret, code, redirectUri }) {
  return requestFormEncoded(GOOGLE_TOKEN_URL, {
    client_id: String(clientId),
    client_secret: String(clientSecret),
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
}

async function refreshAccessToken(state) {
  if (!hasClientCredentials(state) || !state.refreshToken) return null;
  const response = await requestFormEncoded(GOOGLE_TOKEN_URL, {
    client_id: String(state.clientId),
    client_secret: String(state.clientSecret),
    refresh_token: String(state.refreshToken),
    grant_type: "refresh_token",
  });

  if (!response?.access_token) return null;
  const expiresInSec = Number(response.expires_in || 0);
  const expiresAt = expiresInSec > 0 ? Math.floor(Date.now() / 1000) + expiresInSec : state.expiresAt || null;
  const nextTokens = {
    accessToken: response.access_token,
    refreshToken: state.refreshToken,
    expiresAt,
    scopes: state.scopes,
    calendarId: state.calendarId || DEFAULT_CALENDAR_ID,
  };
  saveTokenState(nextTokens);
  return nextTokens;
}

async function runOAuthInteractive(options = {}) {
  const port = Number(options.port || DEFAULT_AUTH_PORT);
  const timeoutMs = Number(options.timeoutMs || 5 * 60 * 1000);
  const logger = typeof options.logger === "function" ? options.logger : () => {};
  const autoOpenBrowser = options.autoOpenBrowser !== false;
  const state = loadCredentialState();

  if (!hasClientCredentials(state)) {
    const missingError = new Error("Missing GOOGLE_CALENDAR_CLIENT_ID or GOOGLE_CALENDAR_CLIENT_SECRET.");
    missingError.code = "MISSING_CLIENT_CREDENTIALS";
    throw missingError;
  }

  saveCalendarConfig({
    clientId: state.clientId,
    clientSecret: state.clientSecret,
    scopes: state.scopes,
    calendarId: state.calendarId || DEFAULT_CALENDAR_ID,
  });

  const launcherUrl = `http://localhost:${port}/auth`;
  logger("");
  logger("[calendar-auth] Authorization required.");
  logger(`[calendar-auth] Open this URL in your browser: ${launcherUrl}`);
  logger("[calendar-auth] Complete consent, then return to the app.");
  logger("");

  if (autoOpenBrowser) {
    maybeOpenBrowser(launcherUrl, logger);
  }

  return new Promise((resolve, reject) => {
    let finished = false;

    const fail = (message, code) => {
      const error = new Error(message);
      error.code = code;
      return error;
    };

    const finishResolve = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      setTimeout(() => server.close(), 250);
      resolve(value);
    };

    const finishReject = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      setTimeout(() => server.close(), 250);
      reject(error);
    };

    const timeout = setTimeout(() => {
      finishReject(fail("Authentication timed out. Please try again.", "AUTH_TIMEOUT"));
    }, timeoutMs);

    const redirectUri = getRedirectUri(port);
    const stateToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);
      try {
        if (url.pathname === "/auth") {
          res.writeHead(302, { Location: buildAuthUrl(state.clientId, state.scopes, port, stateToken) });
          res.end();
          return;
        }

        if (url.pathname === "/callback") {
          const code = url.searchParams.get("code");
          const oauthError = url.searchParams.get("error");
          const stateValue = url.searchParams.get("state");

          if (oauthError) {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end(`Authorization denied: ${oauthError}`);
            finishReject(fail(`Authorization denied: ${oauthError}`, "AUTH_DENIED"));
            return;
          }

          if (!code) {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("No authorization code received.");
            finishReject(fail("No authorization code received.", "AUTH_NO_CODE"));
            return;
          }

          if (stateValue !== stateToken) {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("State mismatch.");
            finishReject(fail("State mismatch in OAuth callback.", "AUTH_STATE_MISMATCH"));
            return;
          }

          const tokenResponse = await exchangeAuthCode({
            clientId: state.clientId,
            clientSecret: state.clientSecret,
            code,
            redirectUri,
          });

          const accessToken = tokenResponse?.access_token || null;
          const refreshToken = tokenResponse?.refresh_token || state.refreshToken || null;
          const expiresIn = Number(tokenResponse?.expires_in || 0);
          const expiresAt = expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : null;

          if (!accessToken || !refreshToken) {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("Token exchange failed. Missing tokens.");
            finishReject(fail("Token exchange failed. Missing tokens.", "AUTH_TOKEN_MISSING"));
            return;
          }

          saveTokenState({
            accessToken,
            refreshToken,
            expiresAt,
            scopes: state.scopes,
            calendarId: state.calendarId || DEFAULT_CALENDAR_ID,
          });

          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("Google Calendar connected. You can close this tab.");
          finishResolve({ accessToken, refreshToken, expiresAt });
          return;
        }

        if (url.pathname === "/") {
          res.writeHead(302, { Location: "/auth" });
          res.end();
          return;
        }

        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Auth server error.");
        finishReject(err);
      }
    });

    server.on("error", (err) => {
      if (err?.code === "EADDRINUSE") {
        finishReject(fail(`Port ${port} is already in use.`, "EADDRINUSE"));
        return;
      }
      finishReject(err);
    });

    server.listen(port, () => {
      logger(`[calendar-auth] Auth server listening on http://localhost:${port}`);
    });
  });
}

function classifyAuthError(error) {
  const message = String(error?.message || "").toLowerCase();
  const code = String(error?.code || "");
  if (code === "MISSING_CLIENT_CREDENTIALS") return "missing_client_credentials";
  if (code === "EADDRINUSE" || message.includes("already in use")) return "port_in_use";
  if (code === "AUTH_DENIED" || message.includes("authorization denied") || message.includes("access_denied")) {
    return "authorization_denied";
  }
  if (code === "AUTH_TIMEOUT" || message.includes("timed out")) return "timeout";
  if (code === "AUTH_STATE_MISMATCH") return "state_mismatch";
  if (message.includes("redirect_uri") || message.includes("callback")) return "callback_mismatch";
  if (message.includes("http 401")) return "unauthorized";
  return "oauth_error";
}

async function refreshOrGetAccessToken(stateInput, options = {}) {
  const allowInteractiveOAuth = options.allowInteractiveOAuth !== false;
  const port = Number(options.port || DEFAULT_AUTH_PORT);
  const timeoutMs = Number(options.timeoutMs || 5 * 60 * 1000);
  const logger = typeof options.logger === "function" ? options.logger : () => {};
  const autoOpenBrowser = options.autoOpenBrowser !== false;
  const state = stateInput || loadCredentialState();

  if (hasUsableAccessToken(state)) {
    return { accessToken: state.accessToken, method: "cached", state };
  }

  if (hasClientCredentials(state) && state.refreshToken) {
    try {
      const refreshed = await refreshAccessToken(state);
      if (refreshed?.accessToken) {
        return {
          accessToken: refreshed.accessToken,
          method: "refresh",
          state: loadCredentialState(),
        };
      }
    } catch (err) {
      if (!allowInteractiveOAuth) throw err;
    }
  }

  if (!allowInteractiveOAuth) {
    const noTokenError = new Error("No valid Google Calendar token available. Run /setup to complete OAuth.");
    noTokenError.code = "AUTH_REQUIRED";
    throw noTokenError;
  }

  if (!hasClientCredentials(state)) {
    const missingCreds = new Error("Google Calendar client credentials are missing.");
    missingCreds.code = "MISSING_CLIENT_CREDENTIALS";
    throw missingCreds;
  }

  const oauth = await runOAuthInteractive({ port, timeoutMs, logger, autoOpenBrowser });
  const finalState = loadCredentialState();
  return {
    accessToken: oauth.accessToken || finalState.accessToken || null,
    method: "oauth",
    state: finalState,
  };
}

module.exports = {
  DEFAULT_AUTH_PORT,
  DEFAULT_CALENDAR_ID,
  DEFAULT_SCOPE,
  getRedirectUri,
  normalizeScopes,
  loadCredentialState,
  hasClientCredentials,
  needsOAuth,
  runOAuthInteractive,
  refreshOrGetAccessToken,
  classifyAuthError,
};
