const http = require("http");
const https = require("https");
const { execFile } = require("child_process");
const { loadStravaConfig, saveStravaConfig } = require("./strava_config");

const STRAVA_API_SETTINGS_URL = "https://www.strava.com/settings/api";
const DEFAULT_AUTH_PORT = 8111;
const REQUIRED_SCOPES = "profile:read_all,activity:read_all,activity:read,profile:write";

function getRedirectUri(port = DEFAULT_AUTH_PORT) {
  return `http://localhost:${port}/callback`;
}

function getSetupInstructionsText(port = DEFAULT_AUTH_PORT) {
  return [
    `Open ${STRAVA_API_SETTINGS_URL}`,
    "Copy your Strava Client ID and Client Secret",
    "Set Authorization Callback Domain to localhost",
    "Share your Strava Client ID and Client Secret here so I can save them for you",
    `We use ${getRedirectUri(port)} for OAuth callback`,
  ].join("\n");
}

function getSetupInstructionLines(port = DEFAULT_AUTH_PORT) {
  return getSetupInstructionsText(port).split("\n");
}

function requestJson(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      method,
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        ...headers,
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
    if (payload) req.write(payload);
    req.end();
  });
}

function loadCredentialState() {
  const fileConfig = loadStravaConfig();
  return {
    clientId: process.env.STRAVA_CLIENT_ID || fileConfig.clientId || null,
    clientSecret: process.env.STRAVA_CLIENT_SECRET || fileConfig.clientSecret || null,
    accessToken: process.env.STRAVA_ACCESS_TOKEN || fileConfig.accessToken || null,
    refreshToken: process.env.STRAVA_REFRESH_TOKEN || fileConfig.refreshToken || null,
    expiresAt: Number(fileConfig.expiresAt || 0) || null,
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
  saveStravaConfig(tokens);
  if (tokens.accessToken) process.env.STRAVA_ACCESS_TOKEN = tokens.accessToken;
  if (tokens.refreshToken) process.env.STRAVA_REFRESH_TOKEN = tokens.refreshToken;
  if (tokens.expiresAt != null) process.env.STRAVA_EXPIRES_AT = String(tokens.expiresAt);
}

async function refreshAccessToken(state) {
  if (!hasClientCredentials(state) || !state.refreshToken) {
    return null;
  }
  const response = await requestJson("POST", "https://www.strava.com/oauth/token", {
    client_id: String(state.clientId),
    client_secret: String(state.clientSecret),
    refresh_token: String(state.refreshToken),
    grant_type: "refresh_token",
  });
  if (!response?.access_token) return null;
  const nextTokens = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token || state.refreshToken,
    expiresAt: response.expires_at || state.expiresAt || null,
  };
  saveTokenState(nextTokens);
  return nextTokens;
}

function buildAuthUrl(clientId, port) {
  const params = new URLSearchParams({
    client_id: String(clientId),
    response_type: "code",
    redirect_uri: getRedirectUri(port),
    approval_prompt: "force",
    scope: REQUIRED_SCOPES,
  });
  return `https://www.strava.com/oauth/authorize?${params.toString()}`;
}

async function exchangeAuthCode({ clientId, clientSecret, code }) {
  return requestJson("POST", "https://www.strava.com/oauth/token", {
    client_id: String(clientId),
    client_secret: String(clientSecret),
    code,
    grant_type: "authorization_code",
  });
}

async function runOAuthInteractive(options = {}) {
  const port = Number(options.port || DEFAULT_AUTH_PORT);
  const timeoutMs = Number(options.timeoutMs || 5 * 60 * 1000);
  const logger = typeof options.logger === "function" ? options.logger : () => {};
  const autoOpenBrowser = options.autoOpenBrowser === true;
  const state = loadCredentialState();

  if (!hasClientCredentials(state)) {
    const missingError = new Error(
      `Missing STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET.\n${getSetupInstructionsText(port)}`
    );
    missingError.code = "MISSING_CLIENT_CREDENTIALS";
    throw missingError;
  }

  saveStravaConfig({ clientId: state.clientId, clientSecret: state.clientSecret });

  logger("");
  logger(`[Coaching Team] Strava authorization required.`);
  logger(`[Coaching Team] Open this URL in your browser: http://localhost:${port}/auth`);
  logger("");

  if (autoOpenBrowser && process.platform === "darwin") {
    execFile("open", [`http://localhost:${port}/auth`], (error) => {
      if (!error) {
        logger("[Coaching Team] Opened browser automatically.");
        return;
      }
      logger("[Coaching Team] Could not auto-open browser. Use the URL above.");
    });
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

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);
      try {
        if (url.pathname === "/auth") {
          res.writeHead(302, { Location: buildAuthUrl(state.clientId, port) });
          res.end();
          return;
        }

        if (url.pathname === "/callback") {
          const code = url.searchParams.get("code");
          const oauthError = url.searchParams.get("error");

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

          const tokenResponse = await exchangeAuthCode({
            clientId: state.clientId,
            clientSecret: state.clientSecret,
            code,
          });
          const accessToken = tokenResponse?.access_token;
          const refreshToken = tokenResponse?.refresh_token;
          const expiresAt = tokenResponse?.expires_at || null;
          if (!accessToken || !refreshToken) {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("Token exchange failed. Missing tokens.");
            finishReject(fail("Token exchange failed. Missing tokens.", "AUTH_TOKEN_MISSING"));
            return;
          }

          saveTokenState({ accessToken, refreshToken, expiresAt });
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("Strava connected. You can close this tab.");
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

    server.listen(port, () => {});
  });
}

function classifyAuthError(error) {
  const message = String(error?.message || "").toLowerCase();
  const code = String(error?.code || "");
  if (code === "MISSING_CLIENT_CREDENTIALS" || message.includes("missing strava_client_id")) {
    return "missing_client_credentials";
  }
  if (code === "EADDRINUSE" || message.includes("already in use")) {
    return "port_in_use";
  }
  if (code === "AUTH_DENIED" || message.includes("authorization denied") || message.includes("access_denied")) {
    return "authorization_denied";
  }
  if (code === "AUTH_TIMEOUT" || message.includes("timed out")) {
    return "timeout";
  }
  if (message.includes("redirect_uri") || message.includes("callback")) {
    return "callback_mismatch";
  }
  if (message.includes("http 401")) {
    return "unauthorized";
  }
  return "oauth_error";
}

function getAuthRemediationLines(errorCode, port = DEFAULT_AUTH_PORT) {
  if (errorCode === "port_in_use") {
    return [
      `[coach-warmup] Strava OAuth could not start because port ${port} is in use.`,
      `[coach-warmup] Free port ${port} and reopen the app, or run /setup after freeing the port.`,
    ];
  }
  if (errorCode === "callback_mismatch") {
    return [
      "[coach-warmup] OAuth callback mismatch detected.",
      "[coach-warmup] In Strava API settings, set Authorization Callback Domain to localhost.",
    ];
  }
  if (errorCode === "authorization_denied") {
    return [
      "[coach-warmup] Strava authorization was denied.",
      "[coach-warmup] Reopen the app or run /setup and approve access when prompted.",
    ];
  }
  if (errorCode === "timeout") {
    return [
      "[coach-warmup] Strava OAuth timed out before consent completed.",
      "[coach-warmup] Reopen the app or run /setup and complete consent in the browser.",
    ];
  }
  if (errorCode === "missing_client_credentials") {
    return [
      "[coach-warmup] Strava client credentials are missing.",
      ...getSetupInstructionLines(port).map((line) => `[coach-warmup] ${line}`),
    ];
  }
  return [
    "[coach-warmup] Strava OAuth failed.",
    "[coach-warmup] Reopen the app or run /setup to retry connection.",
  ];
}

async function refreshOrGetAccessToken(stateInput, options = {}) {
  const allowInteractiveOAuth = options.allowInteractiveOAuth !== false;
  const port = Number(options.port || DEFAULT_AUTH_PORT);
  const timeoutMs = Number(options.timeoutMs || 5 * 60 * 1000);
  const logger = typeof options.logger === "function" ? options.logger : () => {};
  const autoOpenBrowser = options.autoOpenBrowser === true;
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
    const noTokenError = new Error(
      "No valid Strava token available. Run /setup or reopen the app to complete OAuth."
    );
    noTokenError.code = "AUTH_REQUIRED";
    throw noTokenError;
  }

  if (!hasClientCredentials(state)) {
    const missingCreds = new Error(
      `Strava client credentials are missing.\n${getSetupInstructionsText(port)}`
    );
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
  getRedirectUri,
  getSetupInstructionsText,
  getSetupInstructionLines,
  loadCredentialState,
  hasClientCredentials,
  needsOAuth,
  runOAuthInteractive,
  refreshOrGetAccessToken,
  classifyAuthError,
  getAuthRemediationLines,
};
