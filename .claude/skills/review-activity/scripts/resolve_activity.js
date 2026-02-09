#!/usr/bin/env bun

const fs = require("fs");
const { parseDate, toIsoDate, weekStart } = require("../../_shared/lib");
const { PATHS } = require("../../_shared/paths");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    query: "",
    activities: PATHS.external.stravaActivities,
    today: process.env.COACH_TODAY || null,
    limit: 3,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--query") options.query = args[index + 1] || "";
    if (arg === "--activities") options.activities = args[index + 1];
    if (arg === "--today") options.today = args[index + 1];
    if (arg === "--limit") options.limit = Number(args[index + 1]) || 3;
  }

  return options;
}

function readActivities(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function activityDate(activity) {
  for (const key of ["start_date_local", "start_date", "date"]) {
    if (activity[key]) {
      const parsed = parseDate(activity[key]);
      if (parsed) return parsed;
    }
  }
  return null;
}

function normalizeSport(value) {
  if (!value) return null;
  const lowered = String(value).toLowerCase();
  if (lowered.includes("ride") || lowered.includes("bike") || lowered.includes("cycl")) return "bike";
  if (lowered.includes("run")) return "run";
  if (lowered.includes("swim")) return "swim";
  return null;
}

function parseSportFromQuery(query) {
  const q = query.toLowerCase();
  if (/(ride|bike|cycling|cycle)/.test(q)) return "bike";
  if (/(run|jog|running)/.test(q)) return "run";
  if (/(swim|swimming|pool)/.test(q)) return "swim";
  return null;
}

function parseDateSignals(query, today) {
  const q = query.toLowerCase();
  const result = {
    exactDate: null,
    weekRange: null,
  };

  const isoMatch = q.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) {
    result.exactDate = parseDate(isoMatch[1]);
    return result;
  }

  if (q.includes("yesterday")) {
    const dt = new Date(today.getTime());
    dt.setUTCDate(dt.getUTCDate() - 1);
    result.exactDate = dt;
    return result;
  }

  if (q.includes("today")) {
    result.exactDate = new Date(today.getTime());
    return result;
  }

  if (q.includes("last week")) {
    const start = weekStart(today);
    start.setUTCDate(start.getUTCDate() - 7);
    const end = new Date(start.getTime());
    end.setUTCDate(end.getUTCDate() + 6);
    result.weekRange = { start, end };
    return result;
  }

  if (q.includes("this week")) {
    const start = weekStart(today);
    result.weekRange = { start, end: today };
    return result;
  }

  return result;
}

function distanceKm(activity) {
  const distanceM = Number(activity?.distance_m ?? activity?.distance ?? 0);
  return Number((distanceM / 1000).toFixed(1));
}

function movingMinutes(activity) {
  const durationSec = Number(
    activity?.moving_time_sec ??
      activity?.elapsed_time_sec ??
      activity?.duration_sec ??
      activity?.moving_time ??
      activity?.elapsed_time ??
      0
  );
  return Math.round(durationSec / 60);
}

function daysBetween(a, b) {
  return Math.floor((a.getTime() - b.getTime()) / (24 * 3600 * 1000));
}

function scoreActivity(activity, signals, today) {
  const date = activityDate(activity);
  if (!date) return -9999;
  let score = 0;

  const sport = normalizeSport(activity?.sport_type || activity?.type);
  if (signals.sport) {
    if (sport === signals.sport) score += 5;
    else score -= 3;
  }

  if (signals.exactDate) {
    const delta = Math.abs(daysBetween(date, signals.exactDate));
    if (delta === 0) score += 7;
    else if (delta === 1) score += 3;
    else score -= 2;
  } else if (signals.weekRange) {
    if (date >= signals.weekRange.start && date <= signals.weekRange.end) score += 4;
  }

  const ageDays = Math.max(0, daysBetween(today, date));
  if (ageDays <= 1) score += 4;
  else if (ageDays <= 3) score += 3;
  else if (ageDays <= 7) score += 2;
  else if (ageDays <= 14) score += 1;

  return score;
}

function formatCandidate(activity, score) {
  const id = String(activity?.id ?? activity?.activity_id ?? "");
  const date = activityDate(activity);
  return {
    activity_id: id,
    sport: normalizeSport(activity?.sport_type || activity?.type),
    sport_type: activity?.sport_type || activity?.type || null,
    start_date_local: activity?.start_date_local || activity?.start_date || null,
    date: date ? toIsoDate(date) : null,
    name: activity?.name || null,
    distance_km: distanceKm(activity),
    moving_time_min: movingMinutes(activity),
    score,
    label: `${toIsoDate(date)} ${activity?.sport_type || activity?.type || "Activity"} ${distanceKm(activity)}km (${movingMinutes(activity)}min)`,
  };
}

function resolveSelection(sortedCandidates, query) {
  if (!sortedCandidates.length) {
    return { selectedId: null, confidence: "none", reason: "no activities found" };
  }

  const top = sortedCandidates[0];
  const second = sortedCandidates[1];
  const hasQuery = query.trim().length > 0;
  if (!hasQuery) {
    return { selectedId: null, confidence: "low", reason: "no query context provided" };
  }

  if (top.score >= 8 && (!second || top.score - second.score >= 2)) {
    return { selectedId: top.activity_id, confidence: "high", reason: "single strong match" };
  }
  if (top.score >= 6 && (!second || top.score - second.score >= 1)) {
    return { selectedId: top.activity_id, confidence: "medium", reason: "best available match" };
  }
  return { selectedId: null, confidence: "low", reason: "ambiguous match set" };
}

function main() {
  const options = parseArgs();
  const activities = readActivities(options.activities);
  const today = parseDate(options.today) || parseDate(new Date());
  const query = String(options.query || "");
  const signals = {
    sport: parseSportFromQuery(query),
    ...parseDateSignals(query, today),
  };

  const scored = activities
    .filter((activity) => activityDate(activity))
    .map((activity) => ({
      activity,
      score: scoreActivity(activity, signals, today),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return activityDate(b.activity) - activityDate(a.activity);
    });

  const candidates = scored.slice(0, options.limit).map(({ activity, score }) => formatCandidate(activity, score));
  const selection = resolveSelection(candidates, query);

  const payload = {
    query,
    selected_activity_id: selection.selectedId,
    confidence: selection.confidence,
    reason: selection.reason,
    signals: {
      sport: signals.sport || null,
      exact_date: signals.exactDate ? toIsoDate(signals.exactDate) : null,
      week_range:
        signals.weekRange != null
          ? { start: toIsoDate(signals.weekRange.start), end: toIsoDate(signals.weekRange.end) }
          : null,
    },
    candidates,
  };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (require.main === module) {
  main();
}
