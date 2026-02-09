#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");
const https = require("https");
const { parseDate, dumpJson } = require("../../_shared/lib");
const { PATHS } = require("../../_shared/paths");
const { getAccessToken } = require("../../onboard/scripts/strava_auth");

const POWER_WINDOW_DAYS = 28;
const POWER_FRACTION_THRESHOLD = 0.3;
const MIN_VALID_WATTS_SAMPLES = 30;

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    activities: PATHS.external.stravaActivities,
    snapshot: PATHS.coach.snapshot,
    streamDir: PATHS.external.stravaStreamsDir,
    windowDays: POWER_WINDOW_DAYS,
    minValidWattsSamples: MIN_VALID_WATTS_SAMPLES,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--activities") options.activities = args[index + 1];
    if (arg === "--snapshot") options.snapshot = args[index + 1];
    if (arg === "--stream-dir") options.streamDir = args[index + 1];
    if (arg === "--window-days") options.windowDays = Number(args[index + 1]) || POWER_WINDOW_DAYS;
    if (arg === "--min-valid-watts-samples") {
      options.minValidWattsSamples = Number(args[index + 1]) || MIN_VALID_WATTS_SAMPLES;
    }
  }

  return options;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function activityDate(activity) {
  for (const key of ["start_date_local", "start_date", "date"]) {
    if (key in activity) {
      const parsed = parseDate(activity[key]);
      if (parsed) return parsed;
    }
  }
  return null;
}

function normalizeSport(value) {
  if (!value) return null;
  const lowered = String(value).toLowerCase().replace(/\s+/g, "");
  if (lowered.includes("ride") || lowered.includes("bike") || lowered.includes("cycl")) return "bike";
  if (lowered.includes("run")) return "run";
  if (lowered.includes("swim")) return "swim";
  return null;
}

function getActivityId(activity) {
  const id = activity?.id ?? activity?.activity_id;
  if (id == null) return null;
  return String(id);
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
      let payload = "";
      res.on("data", (chunk) => {
        payload += chunk;
      });
      res.on("end", () => {
        try {
          const json = JSON.parse(payload || "{}");
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(json)}`));
            return;
          }
          resolve(json);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

async function fetchStreams(activityId, accessToken) {
  const query = new URLSearchParams({
    keys: "watts,time",
    key_by_type: "true",
  });
  const url = `https://www.strava.com/api/v3/activities/${activityId}/streams?${query.toString()}`;
  return requestJson(url, accessToken);
}

function extractStreamPayload(raw) {
  if (!raw || typeof raw !== "object") return {};
  if (raw.response && typeof raw.response === "object") return raw.response;
  return raw;
}

function extractWattsStreamData(raw) {
  const payload = extractStreamPayload(raw);

  if (Array.isArray(payload)) {
    const wattsEntry = payload.find((entry) => entry?.type === "watts" && Array.isArray(entry?.data));
    return wattsEntry?.data || null;
  }

  if (payload.watts && Array.isArray(payload.watts.data)) {
    return payload.watts.data;
  }

  if (Array.isArray(payload.watts)) {
    return payload.watts;
  }

  return null;
}

function classifyWattsStream(streamPayload, minValidSamples) {
  const wattsData = extractWattsStreamData(streamPayload);
  if (!Array.isArray(wattsData)) {
    return {
      has_watts_stream: false,
      measured_power: false,
      valid_samples: 0,
      total_samples: 0,
    };
  }

  const validSamples = wattsData.filter((sample) => Number.isFinite(sample) && sample > 0).length;
  return {
    has_watts_stream: true,
    measured_power: validSamples >= minValidSamples,
    valid_samples: validSamples,
    total_samples: wattsData.length,
  };
}

async function loadOrFetchStream(activityId, streamPath, accessToken, minValidSamples) {
  if (fs.existsSync(streamPath)) {
    const cached = readJson(streamPath);
    const classification = classifyWattsStream(cached, minValidSamples);
    return {
      ...classification,
      source: "cache",
      fetch_error: null,
    };
  }

  if (!accessToken) {
    return {
      has_watts_stream: false,
      measured_power: false,
      valid_samples: 0,
      total_samples: 0,
      source: "missing_token",
      fetch_error: "No access token available",
    };
  }

  try {
    const response = await fetchStreams(activityId, accessToken);
    const payload = {
      activity_id: activityId,
      fetched_at: new Date().toISOString(),
      keys: ["watts", "time"],
      response,
    };
    fs.mkdirSync(path.dirname(streamPath), { recursive: true });
    dumpJson(streamPath, payload);
    const classification = classifyWattsStream(payload, minValidSamples);
    return {
      ...classification,
      source: "fetched",
      fetch_error: null,
    };
  } catch (error) {
    return {
      has_watts_stream: false,
      measured_power: false,
      valid_samples: 0,
      total_samples: 0,
      source: "fetch_failed",
      fetch_error: String(error.message || error),
    };
  }
}

function withinWindow(date, startDate, endDate) {
  return date && date >= startDate && date <= endDate;
}

function toFraction(count, total) {
  if (!total) return 0;
  return Number((count / total).toFixed(3));
}

async function main() {
  const options = parseArgs();
  const snapshot = readJson(options.snapshot);
  if (!snapshot) {
    throw new Error(`Snapshot not found or invalid at ${options.snapshot}`);
  }

  const activities = readJson(options.activities);
  if (!Array.isArray(activities)) {
    throw new Error(`Activities not found or invalid at ${options.activities}`);
  }

  const asOfDate = parseDate(snapshot.as_of_date) || parseDate(new Date());
  if (!asOfDate) {
    throw new Error("Could not resolve as-of date for power observability audit.");
  }

  const startDate = new Date(asOfDate.getTime());
  startDate.setUTCDate(startDate.getUTCDate() - (options.windowDays - 1));

  const rides = activities.filter((activity) => {
    const discipline = normalizeSport(activity?.sport_type || activity?.type);
    if (discipline !== "bike") return false;
    const date = activityDate(activity);
    return withinWindow(date, startDate, asOfDate);
  });

  const accessToken = await getAccessToken();
  const rideResults = [];
  for (const ride of rides) {
    const activityId = getActivityId(ride);
    if (!activityId) continue;
    const streamPath = path.join(options.streamDir, `${activityId}.json`);
    const streamResult = await loadOrFetchStream(
      activityId,
      streamPath,
      accessToken,
      options.minValidWattsSamples
    );
    rideResults.push({
      activity_id: activityId,
      ...streamResult,
    });
  }

  const ridesConsidered = rideResults.length;
  const ridesWithWattsStream = rideResults.filter((ride) => ride.has_watts_stream).length;
  const measuredPowerRides = rideResults.filter((ride) => ride.measured_power).length;
  const fetchFailures = rideResults.filter((ride) => ride.fetch_error).length;

  const observability = {
    window_days: options.windowDays,
    rides_considered: ridesConsidered,
    rides_with_watts_stream: ridesWithWattsStream,
    measured_power_fraction: toFraction(measuredPowerRides, ridesConsidered),
    estimated_or_none_fraction: toFraction(ridesConsidered - measuredPowerRides, ridesConsidered),
    evaluated_at: new Date().toISOString(),
    notes: [
      `Measured power requires >= ${options.minValidWattsSamples} valid watts samples in activity streams.`,
      `Power mode threshold is measured_power_fraction >= ${POWER_FRACTION_THRESHOLD}.`,
      fetchFailures > 0 ? `Stream fetch failed for ${fetchFailures} ride(s); treated as non-measured.` : "All stream fetches succeeded or used cache.",
    ],
  };

  snapshot.activities_summary = snapshot.activities_summary || {};
  snapshot.activities_summary.by_discipline = snapshot.activities_summary.by_discipline || {};
  snapshot.activities_summary.by_discipline.bike = snapshot.activities_summary.by_discipline.bike || {};
  snapshot.activities_summary.by_discipline.bike.power_observability = observability;

  dumpJson(options.snapshot, snapshot);
  process.stdout.write(`${JSON.stringify({ power_observability: observability }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
