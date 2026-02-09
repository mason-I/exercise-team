const BASE_POLICY_DEFAULTS = {
  same_day_shift_first: true,
  weekday_change_budget_ratio: 0.2,
  time_deviation_caps_min: {
    key: 90,
    support: 150,
    optional: 240,
  },
  race_taper_multiplier: 1.5,
  race_taper_weekday_change_budget_ratio: 0.35,
};

const CANONICAL_SESSION_TYPES = [
  "recovery",
  "easy",
  "moderate",
  "tempo",
  "interval",
  "vo2",
  "long",
  "technique",
  "durability",
  "strength",
  "other",
];

function normalizeSport(value) {
  if (!value) return null;
  const lowered = String(value).toLowerCase().replace(/\s+/g, "");
  if (lowered.includes("run")) return "run";
  if (lowered.includes("ride") || lowered.includes("bike") || lowered.includes("cycl")) return "bike";
  if (lowered.includes("swim")) return "swim";
  if (
    [
      "workout",
      "weighttraining",
      "strengthtraining",
      "crossfit",
      "functionaltraining",
      "gym",
      "bodyweight",
      "hiit",
      "yoga",
      "pilates",
      "mobility",
      "core",
    ].some((key) => lowered.includes(key))
  ) {
    return "strength";
  }
  return null;
}

function activityDate(activity) {
  return activityDateTimeParts(activity)?.date || null;
}

function parseDatePrefix(raw) {
  const match = String(raw || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return {
    year,
    month,
    day,
    date: new Date(Date.UTC(year, month - 1, day)),
  };
}

function parseTimePrefix(raw) {
  const match = String(raw || "").match(/[T\s](\d{2}):(\d{2})(?::\d{2})?/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function parseDateTimeParts(raw) {
  if (!raw) return null;

  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return {
      date: new Date(Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate())),
      hour: raw.getUTCHours(),
      minute: raw.getUTCMinutes(),
    };
  }

  const fromPrefixDate = parseDatePrefix(raw);
  const fromPrefixTime = parseTimePrefix(raw);
  if (fromPrefixDate) {
    return {
      date: fromPrefixDate.date,
      hour: fromPrefixTime ? fromPrefixTime.hour : 0,
      minute: fromPrefixTime ? fromPrefixTime.minute : 0,
    };
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return {
    date: new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate())),
    hour: parsed.getUTCHours(),
    minute: parsed.getUTCMinutes(),
  };
}

function activityDateTimeParts(activity) {
  for (const key of ["start_date_local", "start_date", "date"]) {
    if (!Object.prototype.hasOwnProperty.call(activity, key)) continue;
    const parsed = parseDateTimeParts(activity[key]);
    if (parsed) return parsed;
  }
  return null;
}

function dayName(idx) {
  return ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][idx] || "monday";
}

function dayIndex(date) {
  const utcDay = date.getUTCDay();
  return (utcDay + 6) % 7;
}

function recencyWeight(activityDt, asOfDate, windowDays) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const ageDays = Math.max(0, Math.floor((asOfDate.getTime() - activityDt.getTime()) / msPerDay));
  const clipped = Math.min(windowDays, ageDays);
  return 1 - 0.75 * (clipped / windowDays);
}

function initHourlyHistogram() {
  const histogram = {};
  for (let h = 0; h < 24; h += 1) histogram[String(h)] = 0;
  return histogram;
}

function canonicalTypeFromText(text) {
  const value = String(text || "").toLowerCase();
  if (!value) return null;
  if (/\b(vo2|max|v02|v\.o\.2)\b/.test(value)) return "vo2";
  if (/\b(interval|repeats|reps|track|fartlek)\b/.test(value)) return "interval";
  if (/\b(tempo|threshold|sweet\s*spot|sst)\b/.test(value)) return "tempo";
  if (/\b(long|endurance|aerobic\s*base|base\s*ride)\b/.test(value)) return "long";
  if (/\b(drill|technique|form|skills?)\b/.test(value)) return "technique";
  if (/\b(durability|stability|mobility|prehab)\b/.test(value)) return "durability";
  if (/\b(recovery|recover|very\s*easy)\b/.test(value)) return "recovery";
  if (/\b(easy|z1|z2|zone\s*2)\b/.test(value)) return "easy";
  if (/\b(strength|gym|weights?)\b/.test(value)) return "strength";
  if (/\b(moderate|steady|aerobic)\b/.test(value)) return "moderate";
  return null;
}

function canonicalTypeFromActivity(activity, discipline) {
  const fromFields = [
    activity?.session_type,
    activity?.workout_type,
    activity?.name,
    activity?.description,
    activity?.type,
    activity?.sport_type,
  ]
    .map((item) => canonicalTypeFromText(item))
    .find(Boolean);

  if (fromFields) return fromFields;

  if (discipline === "swim") return "technique";
  if (discipline === "strength") return "strength";
  if (discipline === "run" || discipline === "bike") return "moderate";
  return "other";
}

function weightedQuantile(samples, quantile) {
  if (!samples.length) return 0;
  const q = Math.max(0, Math.min(1, Number(quantile) || 0));
  const sorted = [...samples].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return sorted[Math.floor(sorted.length / 2)].value;
  const threshold = totalWeight * q;
  let running = 0;
  for (const item of sorted) {
    running += item.weight;
    if (running >= threshold) return item.value;
  }
  return sorted[sorted.length - 1].value;
}

function circularDistanceMinutes(a, b) {
  const aMin = Math.max(0, Math.min(1439, Number(a) || 0));
  const bMin = Math.max(0, Math.min(1439, Number(b) || 0));
  const direct = Math.abs(aMin - bMin);
  return Math.min(direct, 1440 - direct);
}

function weightedTimeDispersionMinutes(samples, centerMin) {
  if (!samples.length) return 0;
  let weightedDistance = 0;
  let totalWeight = 0;
  for (const sample of samples) {
    const weight = Number(sample.weight) || 0;
    if (weight <= 0) continue;
    weightedDistance += circularDistanceMinutes(sample.startMin, centerMin) * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return 0;
  return weightedDistance / totalWeight;
}

function confidenceFromSamples(weightedCount, dispersionMinutes) {
  const supportHigh = weightedCount >= 7;
  const supportMedium = weightedCount >= 3;
  const concentrationHigh = dispersionMinutes <= 60;
  const concentrationMedium = dispersionMinutes <= 150;

  if (supportHigh && concentrationHigh) return "high";
  if (supportMedium && concentrationMedium) return "medium";
  return "low";
}

function peakHourShare(histogramByHour, weightedCount) {
  if (!weightedCount) return 0;
  const values = Object.values(histogramByHour || {});
  if (!values.length) return 0;
  const peak = Math.max(...values);
  return peak / weightedCount;
}

function buildAnchorRecord(samples, dimensions) {
  const minuteSamples = samples.map((item) => ({ value: item.startMin, weight: item.weight }));
  const histogram = initHourlyHistogram();
  let weightedCount = 0;

  for (const sample of samples) {
    histogram[String(sample.hour)] += sample.weight;
    weightedCount += sample.weight;
  }

  const preferredStart = Math.round(weightedQuantile(minuteSamples, 0.5));
  const windowMin = Math.floor(weightedQuantile(minuteSamples, 0.25));
  const windowMax = Math.ceil(weightedQuantile(minuteSamples, 0.75));
  const dispersion = weightedTimeDispersionMinutes(samples, preferredStart);
  const peakShare = peakHourShare(histogram, weightedCount);

  return {
    ...dimensions,
    preferred_start_min_local: preferredStart,
    preferred_window_min_local: windowMin,
    preferred_window_max_local: windowMax,
    histogram_by_hour: histogram,
    weighted_sample_count: Number(weightedCount.toFixed(2)),
    sample_count: samples.length,
    time_dispersion_min_local: Number(dispersion.toFixed(1)),
    peak_hour_share: Number(peakShare.toFixed(3)),
    confidence: confidenceFromSamples(weightedCount, dispersion),
  };
}

function groupKey(parts) {
  return parts.map((part) => (part == null ? "*" : String(part))).join("|");
}

function deriveHabitAnchors(activities, asOfDate, windowDays = 56) {
  const start = new Date(asOfDate.getTime());
  start.setUTCDate(start.getUTCDate() - (windowDays - 1));

  const groupedDwt = new Map();
  const groupedDw = new Map();
  const groupedD = new Map();

  for (const activity of activities || []) {
    const dateTimeParts = activityDateTimeParts(activity);
    if (!dateTimeParts?.date) continue;
    const date = dateTimeParts.date;
    if (date < start || date > asOfDate) continue;

    const discipline = normalizeSport(activity.sport_type || activity.type);
    if (!discipline) continue;

    const canonicalType = canonicalTypeFromActivity(activity, discipline);
    const weekday = dayName(dayIndex(date));
    const startMin = dateTimeParts.hour * 60 + dateTimeParts.minute;
    const hour = dateTimeParts.hour;
    const weight = recencyWeight(date, asOfDate, windowDays);
    const sample = {
      discipline,
      weekday,
      canonical_type: canonicalType,
      startMin,
      hour,
      weight,
    };

    const kDwt = groupKey([discipline, weekday, canonicalType]);
    if (!groupedDwt.has(kDwt)) groupedDwt.set(kDwt, []);
    groupedDwt.get(kDwt).push(sample);

    const kDw = groupKey([discipline, weekday]);
    if (!groupedDw.has(kDw)) groupedDw.set(kDw, []);
    groupedDw.get(kDw).push(sample);

    const kD = groupKey([discipline]);
    if (!groupedD.has(kD)) groupedD.set(kD, []);
    groupedD.get(kD).push(sample);
  }

  const byDisciplineWeekdayType = [...groupedDwt.values()]
    .map((samples) =>
      buildAnchorRecord(samples, {
        discipline: samples[0].discipline,
        weekday: samples[0].weekday,
        canonical_type: samples[0].canonical_type,
      })
    )
    .sort((a, b) => b.weighted_sample_count - a.weighted_sample_count);

  const byDisciplineWeekday = [...groupedDw.values()]
    .map((samples) =>
      buildAnchorRecord(samples, {
        discipline: samples[0].discipline,
        weekday: samples[0].weekday,
      })
    )
    .sort((a, b) => b.weighted_sample_count - a.weighted_sample_count);

  const byDiscipline = [...groupedD.values()]
    .map((samples) =>
      buildAnchorRecord(samples, {
        discipline: samples[0].discipline,
      })
    )
    .sort((a, b) => b.weighted_sample_count - a.weighted_sample_count);

  return {
    schema_version: 3,
    window_days: windowDays,
    habit_anchors: {
      by_discipline_weekday_type: byDisciplineWeekdayType,
      by_discipline_weekday: byDisciplineWeekday,
      by_discipline: byDiscipline,
    },
    policy_defaults: { ...BASE_POLICY_DEFAULTS },
  };
}

module.exports = {
  BASE_POLICY_DEFAULTS,
  CANONICAL_SESSION_TYPES,
  deriveHabitAnchors,
  normalizeSport,
  activityDate,
  activityDateTimeParts,
  canonicalTypeFromActivity,
  canonicalTypeFromText,
  recencyWeight,
};
