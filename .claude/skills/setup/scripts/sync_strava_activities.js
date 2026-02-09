#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { PATHS } = require("../../_shared/paths");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    activities: PATHS.external.stravaActivities,
    state: PATHS.external.stravaSyncState,
    fetchScript: ".claude/skills/setup/scripts/fetch_strava_activities.js",
    lookbackHours: 48,
    bootstrapWindowDays: 14,
    startDate: null,
    endDate: null,
    tempOut: PATHS.external.stravaRecentActivitiesTmp,
    fetchedInput: null,
    keepTemp: false,
    noAuth: false,
    loop: false,
    intervalMin: 5,
    overnightIntervalMin: 30,
    quietStartHour: 22,
    quietEndHour: 6,
    maxRuns: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--activities") options.activities = args[i + 1];
    if (arg === "--state") options.state = args[i + 1];
    if (arg === "--fetch-script") options.fetchScript = args[i + 1];
    if (arg === "--lookback-hours") options.lookbackHours = Number(args[i + 1]);
    if (arg === "--bootstrap-window-days") options.bootstrapWindowDays = Number(args[i + 1]);
    if (arg === "--start-date") options.startDate = args[i + 1];
    if (arg === "--end-date") options.endDate = args[i + 1];
    if (arg === "--temp-out") options.tempOut = args[i + 1];
    if (arg === "--fetched-input") options.fetchedInput = args[i + 1];
    if (arg === "--keep-temp") options.keepTemp = true;
    if (arg === "--no-auth") options.noAuth = true;
    if (arg === "--loop") options.loop = true;
    if (arg === "--interval-min") options.intervalMin = Number(args[i + 1]);
    if (arg === "--overnight-interval-min") options.overnightIntervalMin = Number(args[i + 1]);
    if (arg === "--quiet-start-hour") options.quietStartHour = Number(args[i + 1]);
    if (arg === "--quiet-end-hour") options.quietEndHour = Number(args[i + 1]);
    if (arg === "--max-runs") options.maxRuns = Number(args[i + 1]);
  }

  return options;
}

function activityDateTime(activity) {
  const value = activity?.start_date_local || activity?.start_date || activity?.date;
  if (!value) return null;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function loadJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadJsonObject(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function toIsoDateTime(date) {
  return date.toISOString();
}

function activityKey(activity) {
  if (activity && activity.id != null) return `id:${activity.id}`;
  const start = activity?.start_date_local || activity?.start_date || activity?.date || "unknown";
  const sport = activity?.sport_type || activity?.type || "unknown";
  const distance = activity?.distance_m ?? activity?.distance ?? 0;
  const moving = activity?.moving_time_sec ?? activity?.moving_time ?? 0;
  const name = activity?.name || "";
  return `fallback:${start}|${sport}|${distance}|${moving}|${name}`;
}

function sortActivities(activities) {
  return [...activities].sort((a, b) => {
    const aTs = activityDateTime(a)?.getTime() || 0;
    const bTs = activityDateTime(b)?.getTime() || 0;
    if (aTs !== bTs) return bTs - aTs;
    const aId = Number(a?.id || 0);
    const bId = Number(b?.id || 0);
    return bId - aId;
  });
}

function mergeActivities(existing, incoming) {
  const mergedMap = new Map();
  for (const activity of existing) {
    mergedMap.set(activityKey(activity), activity);
  }
  for (const activity of incoming) {
    mergedMap.set(activityKey(activity), activity);
  }
  return sortActivities([...mergedMap.values()]);
}

function maxActivityDate(activities) {
  let maxDate = null;
  for (const activity of activities) {
    const dt = activityDateTime(activity);
    if (!dt) continue;
    if (!maxDate || dt > maxDate) maxDate = dt;
  }
  return maxDate;
}

function deriveWindow(options, state, existingActivities) {
  const now = options.endDate ? new Date(options.endDate) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error("Invalid --end-date");
  }

  if (options.startDate) {
    const explicitStart = new Date(options.startDate);
    if (Number.isNaN(explicitStart.getTime())) {
      throw new Error("Invalid --start-date");
    }
    return {
      startIso: toIsoDateTime(explicitStart),
      endIso: toIsoDateTime(now),
      source: "explicit",
    };
  }

  const lookbackMs = options.lookbackHours * 3600 * 1000;
  if (state.last_successful_sync_at) {
    const lastSync = new Date(state.last_successful_sync_at);
    if (!Number.isNaN(lastSync.getTime())) {
      const start = new Date(lastSync.getTime() - lookbackMs);
      return {
        startIso: toIsoDateTime(start),
        endIso: toIsoDateTime(now),
        source: "state",
      };
    }
  }

  const latestExisting = maxActivityDate(existingActivities);
  if (latestExisting) {
    const start = new Date(latestExisting.getTime() - lookbackMs);
    return {
      startIso: toIsoDateTime(start),
      endIso: toIsoDateTime(now),
      source: "existing-data",
    };
  }

  const start = new Date(now.getTime() - options.bootstrapWindowDays * 24 * 3600 * 1000);
  return {
    startIso: toIsoDateTime(start),
    endIso: toIsoDateTime(now),
    source: "bootstrap-window",
  };
}

function runFetchScript(options, startIso, endIso) {
  if (options.fetchedInput) {
    return loadJsonArray(options.fetchedInput);
  }

  const args = [
    options.fetchScript,
    "--start-date",
    startIso,
    "--end-date",
    endIso,
    "--out",
    options.tempOut,
  ];
  if (options.noAuth) args.push("--no-auth");

  execFileSync("bun", args, { stdio: "inherit" });
  return loadJsonArray(options.tempOut);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function summarizeLatest(activities) {
  if (!activities.length) {
    return { id: null, start_date_local: null };
  }
  const latest = sortActivities(activities)[0];
  return {
    id: latest?.id ?? null,
    start_date_local: latest?.start_date_local || latest?.start_date || latest?.date || null,
  };
}

function inQuietHours(now, quietStartHour, quietEndHour) {
  const hour = now.getHours();
  if (quietStartHour === quietEndHour) return false;
  if (quietStartHour < quietEndHour) {
    return hour >= quietStartHour && hour < quietEndHour;
  }
  return hour >= quietStartHour || hour < quietEndHour;
}

function intervalForNow(options, now) {
  return inQuietHours(now, options.quietStartHour, options.quietEndHour)
    ? options.overnightIntervalMin
    : options.intervalMin;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function syncOnce(options) {
  const existingActivities = loadJsonArray(options.activities);
  const state = loadJsonObject(options.state);
  const window = deriveWindow(options, state, existingActivities);
  const fetched = runFetchScript(options, window.startIso, window.endIso);
  const merged = mergeActivities(existingActivities, fetched);

  writeJson(options.activities, merged);
  const latest = summarizeLatest(merged);
  const newState = {
    last_successful_sync_at: new Date().toISOString(),
    window_start: window.startIso,
    window_end: window.endIso,
    window_source: window.source,
    fetched_count: fetched.length,
    merged_count: merged.length,
    last_activity_id_seen: latest.id,
    last_activity_start_date_local_seen: latest.start_date_local,
    source: "poll",
  };
  writeJson(options.state, newState);

  if (!options.keepTemp && !options.fetchedInput && fs.existsSync(options.tempOut)) {
    fs.rmSync(options.tempOut, { force: true });
  }

  const result = {
    fetched: fetched.length,
    merged: merged.length,
    latest_activity_id: latest.id,
    latest_activity_start_date_local: latest.start_date_local,
    window_start: window.startIso,
    window_end: window.endIso,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function runLoop(options) {
  let runs = 0;
  while (true) {
    try {
      await syncOnce(options);
    } catch (err) {
      console.error(`[sync-loop] ${err.message || err}`);
    }
    runs += 1;
    if (options.maxRuns && runs >= options.maxRuns) return;
    const now = new Date();
    const intervalMin = intervalForNow(options, now);
    await sleep(Math.max(1, intervalMin) * 60 * 1000);
  }
}

async function main() {
  const options = parseArgs();
  if (options.loop) {
    await runLoop(options);
    return;
  }
  await syncOnce(options);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  activityDateTime,
  activityKey,
  mergeActivities,
  deriveWindow,
  syncOnce,
};
