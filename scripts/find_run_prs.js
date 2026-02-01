const fs = require("fs");
const path = require("path");

const API_BASE = "https://www.strava.com/api/v3";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    token: null,
    perPage: 50,
    pages: 4,
    maxActivities: null,
    minDistanceM: 3000,
    minDurationSec: 600,
    targets: [5000, 10000],
    maxPaceSecPerKm: 900,
    minPaceSecPerKm: 150,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--token") options.token = args[i + 1];
    if (arg === "--per-page") options.perPage = Number(args[i + 1]);
    if (arg === "--pages") options.pages = Number(args[i + 1]);
    if (arg === "--max-activities") options.maxActivities = Number(args[i + 1]);
    if (arg === "--min-distance-m") options.minDistanceM = Number(args[i + 1]);
    if (arg === "--min-duration-sec") options.minDurationSec = Number(args[i + 1]);
  }

  return options;
}

function readConfigToken() {
  const configPath = path.join(process.env.HOME || "", ".config/strava-mcp/config.json");
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed.accessToken || null;
  } catch (err) {
    return null;
  }
}

async function apiGet(pathname, token) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strava API error ${res.status}: ${text}`);
  }
  return res.json();
}

function toDataArray(stream) {
  if (!stream) return null;
  if (Array.isArray(stream)) return stream;
  if (Array.isArray(stream.data)) return stream.data;
  return null;
}

function bestSegmentForTarget(distance, time, targetMeters) {
  let best = null;
  let j = 0;

  for (let i = 0; i < distance.length; i += 1) {
    if (j < i) j = i;
    while (j < distance.length && distance[j] - distance[i] < targetMeters) {
      j += 1;
    }
    if (j >= distance.length) break;

    const d0 = distance[i];
    const t0 = time[i];
    const d1 = distance[j];
    const t1 = time[j];
    const needed = targetMeters - (d1 - d0);

    let segmentTime = t1 - t0;
    if (needed > 0 && j + 1 < distance.length) {
      const d2 = distance[j + 1];
      const t2 = time[j + 1];
      const dd = d2 - d1;
      const dt = t2 - t1;
      if (dd > 0 && dt > 0) {
        const frac = needed / dd;
        segmentTime += dt * frac;
      }
    }

    if (!Number.isFinite(segmentTime) || segmentTime <= 0) continue;
    if (!best || segmentTime < best.timeSec) {
      best = {
        timeSec: segmentTime,
        startIndex: i,
        endIndex: j,
      };
    }
  }

  return best;
}

function formatTime(seconds) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (h) parts.push(String(h).padStart(2, "0"));
  parts.push(String(m).padStart(2, "0"));
  parts.push(String(s).padStart(2, "0"));
  return parts.join(":");
}

async function main() {
  const options = parseArgs();
  const token = options.token || process.env.STRAVA_ACCESS_TOKEN || readConfigToken();
  if (!token) {
    throw new Error("No Strava access token provided. Use --token or STRAVA_ACCESS_TOKEN.");
  }

  const activities = [];
  for (let page = 1; page <= options.pages; page += 1) {
    const batch = await apiGet(`/athlete/activities?per_page=${options.perPage}&page=${page}`, token);
    for (const act of batch) {
      const sport = (act.sport_type || act.type || "").toLowerCase();
      if (sport !== "run") continue;
      if (act.distance < options.minDistanceM) continue;
      if (act.moving_time < options.minDurationSec) continue;
      activities.push(act);
    }
    if (options.maxActivities && activities.length >= options.maxActivities) break;
  }

  if (!activities.length) {
    throw new Error("No qualifying run activities found.");
  }

  const bestByTarget = {};
  for (const target of options.targets) {
    bestByTarget[target] = null;
  }

  for (const act of activities) {
    let streams = null;
    try {
      streams = await apiGet(
        `/activities/${act.id}/streams?keys=distance,time&key_by_type=true&resolution=high`,
        token
      );
    } catch (err) {
      continue;
    }
    const distance = toDataArray(streams.distance);
    const time = toDataArray(streams.time);
    if (!distance || !time || distance.length !== time.length) continue;

    for (const target of options.targets) {
      const bestSeg = bestSegmentForTarget(distance, time, target);
      if (!bestSeg) continue;
      const paceSecPerKm = bestSeg.timeSec / (target / 1000);
      if (paceSecPerKm < options.minPaceSecPerKm || paceSecPerKm > options.maxPaceSecPerKm) {
        continue;
      }
      const currentBest = bestByTarget[target];
      if (!currentBest || bestSeg.timeSec < currentBest.timeSec) {
        bestByTarget[target] = {
          id: act.id,
          name: act.name,
          start_date: act.start_date,
          timeSec: bestSeg.timeSec,
          paceSecPerKm,
          activity_distance_km: Number((act.distance / 1000).toFixed(2)),
        };
      }
    }
  }

  const output = {};
  for (const target of options.targets) {
    const result = bestByTarget[target];
    if (!result) continue;
    output[`${target / 1000}k`] = {
      activity_id: result.id,
      activity_name: result.name,
      start_date: result.start_date,
      segment_time: formatTime(result.timeSec),
      pace_per_km: formatTime(result.paceSecPerKm),
      activity_distance_km: result.activity_distance_km,
    };
  }

  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
