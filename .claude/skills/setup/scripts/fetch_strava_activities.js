#!/usr/bin/env node
/*
Fetch Strava activities for a time window and normalize into the baseline input format.
Automatically handles token refresh like the MCP server.
Requires STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN.
*/

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const os = require("os");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
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
    if (!process.env[key]) process.env[key] = value;
  }
}

const CONFIG_DIR = path.join(os.homedir(), ".config", "strava-mcp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const AUTH_PORT = 8111;
const REDIRECT_URI = `http://localhost:${AUTH_PORT}/callback`;
const REQUIRED_SCOPES = "profile:read_all,activity:read_all,activity:read,profile:write";

async function ensureConfigDir() {
  await fs.promises.mkdir(CONFIG_DIR, { recursive: true });
}

async function loadConfigFile() {
  try {
    const content = await fs.promises.readFile(CONFIG_FILE, "utf8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveConfigFile(config) {
  await ensureConfigDir();
  const existing = await loadConfigFile();
  const merged = { ...existing, ...config };
  await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf8");
}

function buildAuthUrl(clientId) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    approval_prompt: "force",
    scope: REQUIRED_SCOPES,
  });
  return `https://www.strava.com/oauth/authorize?${params.toString()}`;
}

function saveEnvFile(filePath, key, value) {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    content = "";
  }

  const lines = content.split(/\r?\n/);
  const newLines = [];
  let found = false;

  for (const line of lines) {
    if (line.startsWith(`${key}=`)) {
      newLines.push(`${key}=${value}`);
      found = true;
    } else if (line.trim() !== "") {
      newLines.push(line);
    }
  }

  if (!found) {
    newLines.push(`${key}=${value}`);
  }

  fs.writeFileSync(filePath, newLines.join("\n").trim() + "\n", "utf8");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    windowDays: 56,
    all: false,
    startDate: null,
    endDate: null,
    out: "data/strava_activities.json",
    noAuth: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--window-days") options.windowDays = Number(args[i + 1]);
    if (arg === "--all") options.all = true;
    if (arg === "--start-date") options.startDate = args[i + 1];
    if (arg === "--end-date") options.endDate = args[i + 1];
    if (arg === "--out") options.out = args[i + 1];
    if (arg === "--no-auth") options.noAuth = true;
  }
  return options;
}

function isoToEpochSeconds(iso) {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return null;
  return Math.floor(dt.getTime() / 1000);
}

function epochSecondsForWindow(windowDays, startDate, endDate) {
  const now = new Date();
  const end = endDate ? new Date(endDate) : now;
  if (Number.isNaN(end.getTime())) throw new Error("Invalid --end-date");
  const start = startDate ? new Date(startDate) : new Date(end.getTime() - windowDays * 86400 * 1000);
  if (Number.isNaN(start.getTime())) throw new Error("Invalid --start-date");
  return {
    after: Math.floor(start.getTime() / 1000),
    before: Math.floor(end.getTime() / 1000),
  };
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
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(json)}`));
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

let cachedAccessToken = null;
let authAttempted = false;
let authDisabled = false;

async function loadConfigFromSources() {
  const fileConfig = await loadConfigFile();
  return {
    clientId: process.env.STRAVA_CLIENT_ID || fileConfig.clientId,
    clientSecret: process.env.STRAVA_CLIENT_SECRET || fileConfig.clientSecret,
    accessToken: process.env.STRAVA_ACCESS_TOKEN || fileConfig.accessToken,
    refreshToken: process.env.STRAVA_REFRESH_TOKEN || fileConfig.refreshToken,
    expiresAt: fileConfig.expiresAt,
  };
}

async function saveTokens({ accessToken, refreshToken, expiresAt }) {
  const envPath = process.env.STRAVA_ENV_PATH || path.resolve(process.cwd(), ".env");
  await saveConfigFile({ accessToken, refreshToken, expiresAt });
  if (fs.existsSync(envPath)) {
    if (accessToken) saveEnvFile(envPath, "STRAVA_ACCESS_TOKEN", accessToken);
    if (refreshToken) saveEnvFile(envPath, "STRAVA_REFRESH_TOKEN", refreshToken);
  }
}

async function startAuthServer(clientId, clientSecret) {
  if (!clientId || !clientSecret) {
    throw new Error("Missing STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET for OAuth setup.");
  }

  await saveConfigFile({ clientId, clientSecret });

  console.error("");
  console.error("🔐 Strava authorization required.");
  console.error(`Open this URL in your browser: http://localhost:${AUTH_PORT}/auth`);
  console.error("Complete the consent screen, then return here.");
  console.error("");

  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        server?.close();
        reject(new Error("Authentication timed out. Please try again."));
      }
    }, 5 * 60 * 1000);

    const finish = (result) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        setTimeout(() => server?.close(), 1000);
        resolve(result);
      }
    };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${AUTH_PORT}`);
      try {
        if (url.pathname === "/auth") {
          res.writeHead(302, { Location: buildAuthUrl(clientId) });
          res.end();
          return;
        }

        if (url.pathname === "/callback") {
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");

          if (error) {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end(`Authorization denied: ${error}`);
            finish({ success: false });
            return;
          }

          if (!code) {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("No authorization code received.");
            finish({ success: false });
            return;
          }

          const tokenResponse = await requestJson("POST", "https://www.strava.com/oauth/token", {
            client_id: clientId,
            client_secret: clientSecret,
            code,
            grant_type: "authorization_code",
          });

          const accessToken = tokenResponse.access_token;
          const refreshToken = tokenResponse.refresh_token;
          const expiresAt = tokenResponse.expires_at;

          if (!accessToken || !refreshToken) {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("Token exchange failed. Missing tokens.");
            finish({ success: false });
            return;
          }

          await saveTokens({ accessToken, refreshToken, expiresAt });
          process.env.STRAVA_ACCESS_TOKEN = accessToken;
          process.env.STRAVA_REFRESH_TOKEN = refreshToken;
          cachedAccessToken = accessToken;

          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("Strava connected. You can close this tab.");
          finish({ success: true });
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
        finish({ success: false });
      }
    });

    server.listen(AUTH_PORT, () => {
      console.error(`Auth server listening on http://localhost:${AUTH_PORT}`);
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${AUTH_PORT} is already in use.`));
      } else {
        reject(err);
      }
    });
  });
}

async function getAccessToken() {
  if (cachedAccessToken) return cachedAccessToken;

  const config = await loadConfigFromSources();
  const clientId = config.clientId;
  const clientSecret = config.clientSecret;
  let refreshToken = config.refreshToken;
  if (!clientId || !clientSecret || !refreshToken) {
    if (!authAttempted && !authDisabled) {
      authAttempted = true;
      await startAuthServer(clientId, clientSecret);
      return getAccessToken();
    }
    throw new Error("Missing STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, or STRAVA_REFRESH_TOKEN");
  }

  try {
    const tokenResponse = await requestJson(
      "POST",
      "https://www.strava.com/oauth/token",
      {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }
    );

    if (!tokenResponse.access_token) {
      throw new Error("Failed to obtain access token from Strava");
    }

    cachedAccessToken = tokenResponse.access_token;
    const newRefreshToken = tokenResponse.refresh_token || refreshToken;
    await saveTokens({
      accessToken: tokenResponse.access_token,
      refreshToken: newRefreshToken,
      expiresAt: tokenResponse.expires_at,
    });
    process.env.STRAVA_REFRESH_TOKEN = newRefreshToken;
    console.error(
      `✅ Token refreshed and saved (expires at ${new Date(tokenResponse.expires_at * 1000).toLocaleString()})`
    );

    return cachedAccessToken;
  } catch (err) {
    throw new Error(`Failed to refresh access token: ${err.message}`);
  }
}

async function fetchActivities(accessToken, after, before) {
  const activities = [];
  let page = 1;
  const perPage = 200;
  let hasRefreshed = false;

  while (true) {
    const url = new URL("https://www.strava.com/api/v3/athlete/activities");
    if (after != null) url.searchParams.set("after", String(after));
    if (before != null) url.searchParams.set("before", String(before));
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(perPage));

    try {
      const batch = await requestJson("GET", url.toString(), null, {
        Authorization: `Bearer ${accessToken}`,
      });

      if (!Array.isArray(batch) || batch.length === 0) break;
      activities.push(...batch);
      if (batch.length < perPage) break;
      page += 1;
      console.error(`Fetched ${activities.length} activities...`);
    } catch (err) {
      // If 401, try refreshing token once (only on first page)
      if (err.message.includes("HTTP 401") && page === 1 && !hasRefreshed) {
        console.error("🔑 Token expired/invalid, refreshing...");
        cachedAccessToken = null;
        accessToken = await getAccessToken();
        hasRefreshed = true;
        continue;
      }
      // If still 401 after refresh, run OAuth flow once
      if (err.message.includes("HTTP 401") && page === 1 && !authAttempted && !authDisabled) {
        authAttempted = true;
        const config = await loadConfigFromSources();
        await startAuthServer(config.clientId, config.clientSecret);
        accessToken = await getAccessToken();
        continue;
      }
      // If still getting 401 after refresh, it's a scope issue
      if (err.message.includes("HTTP 401")) {
        throw new Error(
          "Authorization failed. Your token lacks 'activity:read' permission. Re-run the OAuth flow and approve the requested scopes."
        );
      }
      throw err;
    }
  }

  return activities;
}

function normalizeActivities(raw) {
  return raw
    .map((activity) => {
      const startDateLocal = activity.start_date_local || activity.start_date || null;
      const distance = activity.distance != null ? Number(activity.distance) : null;
      const movingTime = activity.moving_time != null ? Number(activity.moving_time) : null;
      const sportType = activity.sport_type || activity.type || null;

      if (!startDateLocal || distance == null || movingTime == null || !sportType) return null;

      const averageSpeed = activity.average_speed != null ? Number(activity.average_speed) : null;
      const pacePerKm = distance && movingTime ? movingTime / (distance / 1000) : null;
      const pacePer100m = distance && movingTime ? movingTime / (distance / 100) : null;

      return {
        id: activity.id ?? null,
        name: activity.name ?? null,
        start_date_local: startDateLocal,
        sport_type: sportType,
        distance_m: distance,
        moving_time_sec: movingTime,
        elapsed_time_sec: activity.elapsed_time != null ? Number(activity.elapsed_time) : null,
        total_elevation_gain_m:
          activity.total_elevation_gain != null ? Number(activity.total_elevation_gain) : null,
        average_speed_mps: averageSpeed,
        average_speed_kmh: averageSpeed != null ? Number((averageSpeed * 3.6).toFixed(2)) : null,
        average_watts: activity.average_watts != null ? Number(activity.average_watts) : null,
        average_heartrate: activity.average_heartrate != null ? Number(activity.average_heartrate) : null,
        pace_sec_per_km: pacePerKm != null ? Number(pacePerKm.toFixed(2)) : null,
        pace_sec_per_100m: pacePer100m != null ? Number(pacePer100m.toFixed(2)) : null,
      };
    })
    .filter(Boolean);
}

async function main() {
  const options = parseArgs();
  authDisabled = options.noAuth;
  const envPath = process.env.STRAVA_ENV_PATH || path.resolve(process.cwd(), ".env");
  loadEnvFile(envPath);
  const { after, before } = options.all
    ? { after: null, before: null }
    : epochSecondsForWindow(options.windowDays, options.startDate, options.endDate);

  console.error(`Fetching activities${options.all ? " (all history)" : ` (last ${options.windowDays} days)`}...`);
  const accessToken = await getAccessToken();
  const rawActivities = await fetchActivities(accessToken, after, before);
  const normalized = normalizeActivities(rawActivities);

  const outPath = path.resolve(options.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(normalized, null, 2));

  console.error(`Saved ${normalized.length} activities to ${outPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
