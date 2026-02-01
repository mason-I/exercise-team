const fs = require("fs");
const path = require("path");

const API_BASE = "https://www.strava.com/api/v3";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    token: null,
    perPage: 50,
    pages: 2,
    riderKg: 80,
    bikeKg: 9,
    crr: 0.004,
    rho: 1.2,
    eta: 0.95,
    windMps: 0,
    minSpeedMps: 0.5,
    minDistanceStepM: 1,
    minDistanceM: 5000,
    minDurationSec: 900,
    maxActivities: null,
    includeTypes: new Set([
      "ride",
      "virtualride",
      "gravelride",
      "ebikeride",
      "mountainbikeride",
      "roadbikeride",
    ]),
    weightBy: "time",
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--token") options.token = args[i + 1];
    if (arg === "--per-page") options.perPage = Number(args[i + 1]);
    if (arg === "--pages") options.pages = Number(args[i + 1]);
    if (arg === "--rider-kg") options.riderKg = Number(args[i + 1]);
    if (arg === "--bike-kg") options.bikeKg = Number(args[i + 1]);
    if (arg === "--crr") options.crr = Number(args[i + 1]);
    if (arg === "--rho") options.rho = Number(args[i + 1]);
    if (arg === "--eta") options.eta = Number(args[i + 1]);
    if (arg === "--wind-mps") options.windMps = Number(args[i + 1]);
    if (arg === "--min-speed-mps") options.minSpeedMps = Number(args[i + 1]);
    if (arg === "--min-distance-step-m") options.minDistanceStepM = Number(args[i + 1]);
    if (arg === "--min-distance-m") options.minDistanceM = Number(args[i + 1]);
    if (arg === "--min-duration-sec") options.minDurationSec = Number(args[i + 1]);
    if (arg === "--max-activities") options.maxActivities = Number(args[i + 1]);
    if (arg === "--weight-by") options.weightBy = args[i + 1];
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

function computeLinearTerms(streams, options) {
  const distance = toDataArray(streams.distance);
  const time = toDataArray(streams.time);
  const altitude = toDataArray(streams.altitude);
  const velocity = toDataArray(streams.velocity_smooth) || toDataArray(streams.velocity);

  if (!distance || !time) return null;

  const m = options.riderKg + options.bikeKg;
  const g = 9.81;
  const roll = m * g * options.crr;

  let A = 0;
  let B = 0;
  let totalTime = 0;
  let totalDistance = 0;

  for (let i = 1; i < distance.length; i += 1) {
    const dd = distance[i] - distance[i - 1];
    if (!Number.isFinite(dd) || dd < options.minDistanceStepM) continue;
    const dt = time[i] - time[i - 1];
    if (!Number.isFinite(dt) || dt <= 0) continue;
    const v = velocity && Number.isFinite(velocity[i]) ? velocity[i] : dd / dt;
    if (!Number.isFinite(v) || v < options.minSpeedMps) continue;

    let grade = 0;
    if (altitude && Number.isFinite(altitude[i])) {
      const dh = altitude[i] - altitude[i - 1];
      if (Number.isFinite(dh)) grade = dh / dd;
    }

    const gravity = m * g * grade;
    const aeroCoeff = 0.5 * options.rho * Math.pow(v + options.windMps, 2);

    A += aeroCoeff * v * dt / options.eta;
    B += (roll + gravity) * v * dt / options.eta;
    totalTime += dt;
    totalDistance += dd;
  }

  if (!totalTime) return null;

  return {
    A,
    B,
    totalTime,
    totalDistance,
  };
}

function fitCda(records, weightBy) {
  let numerator = 0;
  let denominator = 0;

  for (const record of records) {
    const a = record.A / record.totalTime;
    const b = record.B / record.totalTime;
    const weight = weightBy === "distance" ? record.totalDistance : record.totalTime;
    numerator += weight * a * (record.targetWatts - b);
    denominator += weight * a * a;
  }

  if (!denominator) return null;
  return numerator / denominator;
}

function evaluate(records, cda) {
  const results = [];
  for (const record of records) {
    const a = record.A / record.totalTime;
    const b = record.B / record.totalTime;
    const predicted = a * cda + b;
    results.push({
      id: record.id,
      start_date: record.start_date,
      target_watts: record.targetWatts,
      predicted_watts: Number(predicted.toFixed(1)),
      error_watts: Number((predicted - record.targetWatts).toFixed(1)),
      duration_sec: Math.round(record.totalTime),
      distance_km: Number((record.totalDistance / 1000).toFixed(2)),
      device_watts: record.deviceWatts,
    });
  }
  return results;
}

function summarize(results) {
  const errors = results.map((r) => r.error_watts);
  const absErrors = errors.map((e) => Math.abs(e));
  const mean = errors.reduce((s, v) => s + v, 0) / errors.length;
  const mae = absErrors.reduce((s, v) => s + v, 0) / absErrors.length;
  const rmse = Math.sqrt(errors.reduce((s, v) => s + v * v, 0) / errors.length);
  return {
    count: results.length,
    mean_error_watts: Number(mean.toFixed(2)),
    mae_watts: Number(mae.toFixed(2)),
    rmse_watts: Number(rmse.toFixed(2)),
  };
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
      if (!act || !act.id) continue;
      const sport = (act.sport_type || act.type || "").toLowerCase();
      if (!options.includeTypes.has(sport)) continue;
      if (!Number.isFinite(act.average_watts)) continue;
      if (act.distance < options.minDistanceM) continue;
      if (act.moving_time < options.minDurationSec) continue;
      activities.push(act);
    }
    if (options.maxActivities && activities.length >= options.maxActivities) break;
  }

  if (!activities.length) {
    throw new Error("No qualifying activities found for fitting.");
  }

  const records = [];
  for (const act of activities) {
    const streams = await apiGet(
      `/activities/${act.id}/streams?keys=distance,time,altitude,velocity_smooth&key_by_type=true&resolution=high`,
      token
    );
    const terms = computeLinearTerms(streams, options);
    if (!terms) continue;
    records.push({
      id: act.id,
      start_date: act.start_date,
      targetWatts: act.average_watts,
      deviceWatts: act.device_watts,
      ...terms,
    });
  }

  if (!records.length) {
    throw new Error("No activities had usable streams for fitting.");
  }

  const fittedCda = fitCda(records, options.weightBy);
  if (!Number.isFinite(fittedCda)) {
    throw new Error("Failed to fit CdA.");
  }

  const evaluated = evaluate(records, fittedCda);
  const summary = summarize(evaluated);

  const output = {
    fitted_cda: Number(fittedCda.toFixed(4)),
    assumptions: {
      rider_kg: options.riderKg,
      bike_kg: options.bikeKg,
      crr: options.crr,
      rho: options.rho,
      drivetrain_efficiency: options.eta,
      wind_mps: options.windMps,
      weight_by: options.weightBy,
      activity_count: evaluated.length,
    },
    summary,
    activities: evaluated,
  };

  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
