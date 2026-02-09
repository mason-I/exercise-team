#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");
const https = require("https");
const { PATHS } = require("../../_shared/paths");
const { getAccessToken } = require("../../onboard/scripts/strava_auth");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    activityIds: [],
    keys: ["time", "distance", "heartrate", "watts", "cadence", "velocity_smooth", "grade_smooth"],
    outDir: PATHS.external.stravaStreamsDir,
    force: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--activity-id") options.activityIds.push(args[i + 1]);
    if (arg === "--activity-ids") options.activityIds.push(...String(args[i + 1]).split(","));
    if (arg === "--keys") options.keys = String(args[i + 1]).split(",").map((v) => v.trim()).filter(Boolean);
    if (arg === "--out-dir") options.outDir = args[i + 1];
    if (arg === "--force") options.force = true;
  }
  options.activityIds = options.activityIds.map((id) => String(id).trim()).filter(Boolean);
  return options;
}

function requestJson(url, accessToken) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      method: "GET",
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
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
    req.end();
  });
}

async function fetchStreams(activityId, keys, accessToken) {
  const query = new URLSearchParams({
    keys: keys.join(","),
    key_by_type: "true",
  });
  const url = `https://www.strava.com/api/v3/activities/${activityId}/streams?${query.toString()}`;
  return requestJson(url, accessToken);
}

async function main() {
  const options = parseArgs();
  if (!options.activityIds.length) {
    throw new Error("Usage: bun fetch_strava_streams.js --activity-id <id> [--keys time,heartrate,...]");
  }
  const accessToken = await getAccessToken();
  if (!accessToken) {
    throw new Error("No Strava access token available. Run /setup to connect Strava.");
  }

  fs.mkdirSync(options.outDir, { recursive: true });
  const results = [];

  for (const activityId of options.activityIds) {
    const outPath = path.join(options.outDir, `${activityId}.json`);
    if (!options.force && fs.existsSync(outPath)) {
      results.push({ activity_id: activityId, cached: true, path: outPath });
      continue;
    }
    const response = await fetchStreams(activityId, options.keys, accessToken);
    const payload = {
      activity_id: activityId,
      fetched_at: new Date().toISOString(),
      keys: options.keys,
      response,
    };
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    results.push({ activity_id: activityId, cached: false, path: outPath });
  }

  process.stdout.write(`${JSON.stringify({ fetched: results }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
