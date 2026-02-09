#!/usr/bin/env bun
/*
Fetch Strava activities for a time window and normalize into the baseline input format.
Automatically handles token refresh.
Requires STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN.
*/

const fs = require("fs");
const path = require("path");
const https = require("https");
const {
  DEFAULT_AUTH_PORT,
  loadCredentialState,
  refreshOrGetAccessToken,
} = require("../../_shared/strava_auth_flow");
const { PATHS } = require("../../_shared/paths");
const { hydrateSessionEnv } = require("../../_shared/session_env");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    windowDays: 56,
    all: false,
    startDate: null,
    endDate: null,
    out: PATHS.external.stravaActivities,
    noAuth: false,
    autoOpenBrowser: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--window-days") options.windowDays = Number(args[i + 1]);
    if (arg === "--all") options.all = true;
    if (arg === "--start-date") options.startDate = args[i + 1];
    if (arg === "--end-date") options.endDate = args[i + 1];
    if (arg === "--out") options.out = args[i + 1];
    if (arg === "--no-auth") options.noAuth = true;
    if (arg === "--auto-open-browser") options.autoOpenBrowser = true;
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
let authDisabled = false;
let authAutoOpenBrowser = false;

async function getAccessToken() {
  if (cachedAccessToken) return cachedAccessToken;
  const result = await refreshOrGetAccessToken(null, {
    allowInteractiveOAuth: !authDisabled,
    port: DEFAULT_AUTH_PORT,
    timeoutMs: 5 * 60 * 1000,
    logger: (line) => console.error(line),
    autoOpenBrowser: authAutoOpenBrowser,
  });
  if (!result?.accessToken) {
    throw new Error("No Strava access token available. Reopen app or run /setup to connect Strava.");
  }

  cachedAccessToken = result.accessToken;
  const latestState = loadCredentialState();
  process.env.STRAVA_ACCESS_TOKEN = result.accessToken;
  if (latestState.refreshToken) {
    process.env.STRAVA_REFRESH_TOKEN = latestState.refreshToken;
  }

  if (result.method === "refresh" && latestState.expiresAt) {
    console.error(
      `✅ Token refreshed and saved (expires at ${new Date(latestState.expiresAt * 1000).toLocaleString()})`
    );
  } else if (result.method === "oauth") {
    console.error("✅ Strava OAuth completed and tokens saved.");
  }

  return cachedAccessToken;
}

async function fetchActivities(accessToken, after, before) {
  const activities = [];
  let page = 1;
  const perPage = 200;
  let hasRetriedAuth = false;

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
      if (err.message.includes("HTTP 401") && page === 1 && !hasRetriedAuth) {
        console.error("🔑 Token expired/invalid, refreshing...");
        cachedAccessToken = null;
        accessToken = await getAccessToken();
        hasRetriedAuth = true;
        continue;
      }
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
      const weightedAverageWatts =
        activity.weighted_average_watts != null ? Number(activity.weighted_average_watts) : null;
      const deviceWatts = activity.device_watts != null ? Boolean(activity.device_watts) : null;
      const kilojoules = activity.kilojoules != null ? Number(activity.kilojoules) : null;
      const maxHeartrate = activity.max_heartrate != null ? Number(activity.max_heartrate) : null;
      const gradeAdjustedSpeed =
        activity.average_grade_adjusted_speed != null ? Number(activity.average_grade_adjusted_speed) : null;
      const pacePerKm = distance && movingTime ? movingTime / (distance / 1000) : null;
      const pacePer100m = distance && movingTime ? movingTime / (distance / 100) : null;

      return {
        id: activity.id ?? null,
        name: activity.name ?? null,
        start_date_local: startDateLocal,
        sport_type: sportType,
        type: activity.type ?? null,
        distance_m: distance,
        moving_time_sec: movingTime,
        elapsed_time_sec: activity.elapsed_time != null ? Number(activity.elapsed_time) : null,
        total_elevation_gain_m:
          activity.total_elevation_gain != null ? Number(activity.total_elevation_gain) : null,
        average_speed_mps: averageSpeed,
        average_speed_kmh: averageSpeed != null ? Number((averageSpeed * 3.6).toFixed(2)) : null,
        average_watts: activity.average_watts != null ? Number(activity.average_watts) : null,
        weighted_average_watts: weightedAverageWatts,
        device_watts: deviceWatts,
        kilojoules,
        average_heartrate: activity.average_heartrate != null ? Number(activity.average_heartrate) : null,
        max_heartrate: maxHeartrate,
        average_grade_adjusted_speed: gradeAdjustedSpeed,
        commute: activity.commute != null ? Boolean(activity.commute) : null,
        trainer: activity.trainer != null ? Boolean(activity.trainer) : null,
        pace_sec_per_km: pacePerKm != null ? Number(pacePerKm.toFixed(2)) : null,
        pace_sec_per_100m: pacePer100m != null ? Number(pacePer100m.toFixed(2)) : null,
      };
    })
    .filter(Boolean);
}

async function main() {
  const options = parseArgs();
  authDisabled = options.noAuth;
  authAutoOpenBrowser = options.autoOpenBrowser === true;
  hydrateSessionEnv(process.env.CLAUDE_PROJECT_DIR || process.cwd());
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
