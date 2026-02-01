const fs = require("fs");

function loadJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf-8"));
}

function toDataArray(stream) {
  if (!stream) return null;
  if (Array.isArray(stream)) return stream;
  if (Array.isArray(stream.data)) return stream.data;
  return null;
}

function mapFromArray(array) {
  const map = {};
  for (const item of array) {
    if (!item || !item.type) continue;
    map[item.type] = item;
  }
  return map;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    input: null,
    riderKg: 80,
    bikeKg: 9,
    cda: 0.32,
    crr: 0.004,
    rho: 1.2,
    eta: 0.95,
    windMps: 0,
    minSpeedMps: 0.5,
    minDistanceStepM: 1,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--input") options.input = args[i + 1];
    if (arg === "--rider-kg") options.riderKg = Number(args[i + 1]);
    if (arg === "--bike-kg") options.bikeKg = Number(args[i + 1]);
    if (arg === "--cda") options.cda = Number(args[i + 1]);
    if (arg === "--crr") options.crr = Number(args[i + 1]);
    if (arg === "--rho") options.rho = Number(args[i + 1]);
    if (arg === "--eta") options.eta = Number(args[i + 1]);
    if (arg === "--wind-mps") options.windMps = Number(args[i + 1]);
    if (arg === "--min-speed-mps") options.minSpeedMps = Number(args[i + 1]);
    if (arg === "--min-distance-step-m") options.minDistanceStepM = Number(args[i + 1]);
  }
  return options;
}

function main() {
  const options = parseArgs();
  if (!options.input) {
    throw new Error("Missing --input <streams.json>");
  }

  const raw = loadJson(options.input);
  let streams = raw;
  if (raw && raw.streams) streams = raw.streams;
  if (Array.isArray(streams)) streams = mapFromArray(streams);

  const time = toDataArray(streams.time);
  const distance = toDataArray(streams.distance);
  const altitude = toDataArray(streams.altitude);
  const velocity = toDataArray(streams.velocity_smooth) || toDataArray(streams.velocity);

  if (!distance || (!time && !velocity)) {
    throw new Error("Need at least distance + (time or velocity_smooth) streams.");
  }

  const m = options.riderKg + options.bikeKg;
  const g = 9.81;
  const rollForce = m * g * options.crr;
  const wind = options.windMps;

  let totalWork = 0;
  let totalTime = 0;
  let totalDistance = 0;

  const n = distance.length;
  for (let i = 1; i < n; i += 1) {
    const d0 = distance[i - 1];
    const d1 = distance[i];
    const dd = d1 - d0;
    if (!Number.isFinite(dd) || dd < options.minDistanceStepM) continue;

    let dt = null;
    if (time) {
      dt = time[i] - time[i - 1];
    } else if (velocity) {
      const v = velocity[i];
      if (v > 0) dt = dd / v;
    }
    if (!dt || dt <= 0) continue;

    let v = null;
    if (velocity) {
      v = velocity[i];
    } else {
      v = dd / dt;
    }
    if (!Number.isFinite(v) || v < options.minSpeedMps) continue;

    let grade = 0;
    if (altitude) {
      const dh = altitude[i] - altitude[i - 1];
      if (Number.isFinite(dh)) grade = dh / dd;
    }

    const aeroForce = 0.5 * options.rho * options.cda * Math.pow(v + wind, 2);
    const gravityForce = m * g * grade;
    let power = (rollForce + aeroForce + gravityForce) * v / options.eta;

    if (!Number.isFinite(power)) continue;
    if (power < 0) power = 0;

    totalWork += power * dt;
    totalTime += dt;
    totalDistance += dd;
  }

  if (!totalTime) {
    throw new Error("No valid data points to compute power.");
  }

  const avgPower = totalWork / totalTime;
  const avgSpeed = totalDistance / totalTime;

  const result = {
    avg_power_watts: Number(avgPower.toFixed(1)),
    avg_speed_kmh: Number((avgSpeed * 3.6).toFixed(2)),
    total_time_sec: Math.round(totalTime),
    total_distance_km: Number((totalDistance / 1000).toFixed(3)),
    assumptions: {
      rider_kg: options.riderKg,
      bike_kg: options.bikeKg,
      cda: options.cda,
      crr: options.crr,
      rho: options.rho,
      drivetrain_efficiency: options.eta,
      wind_mps: options.windMps,
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}
