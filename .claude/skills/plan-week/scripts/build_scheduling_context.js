#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");
const { listEvents } = require("../../_shared/google_calendar_api");
const { PATHS } = require("../../_shared/paths");
const {
  BASE_POLICY_DEFAULTS,
  CANONICAL_SESSION_TYPES,
  canonicalTypeFromText,
} = require("../../_shared/schedule_preferences");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    plan: null,
    profile: PATHS.coach.profile,
    goals: PATHS.coach.goals,
    strategy: PATHS.coach.strategy,
    snapshot: PATHS.coach.snapshot,
    inferred: PATHS.system.stravaInferredSchedule,
    out: null,
    timezone: null,
    calendarId: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--plan") options.plan = args[i + 1];
    if (arg === "--profile") options.profile = args[i + 1];
    if (arg === "--goals") options.goals = args[i + 1];
    if (arg === "--strategy") options.strategy = args[i + 1];
    if (arg === "--snapshot") options.snapshot = args[i + 1];
    if (arg === "--inferred") options.inferred = args[i + 1];
    if (arg === "--out") options.out = args[i + 1];
    if (arg === "--timezone") options.timezone = args[i + 1];
    if (arg === "--calendar-id") options.calendarId = args[i + 1];
  }

  return options;
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function addDaysIso(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function inferWeekStart(plan) {
  if (plan?.week_start) return String(plan.week_start);
  const dates = Array.isArray(plan?.sessions)
    ? plan.sessions.map((s) => String(s.date || "")).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    : [];
  if (!dates.length) return null;
  dates.sort();
  return dates[0];
}

function mapBusyWindows(events) {
  return events
    .map((event) => {
      const summary = String(event?.summary || "").trim();
      const start = event?.start?.dateTime || null;
      const end = event?.end?.dateTime || null;
      if (!start || !end) return null;
      return {
        event_id: event?.id || null,
        summary: summary || "(untitled)",
        is_training_event: summary.startsWith("Training:"),
        start,
        end,
      };
    })
    .filter(Boolean);
}

function inferSessionPriority(session) {
  const existing = String(session?.priority || "").toLowerCase();
  if (["key", "support", "optional"].includes(existing)) return existing;
  const type = String(session?.type || "").toLowerCase();
  if (type.includes("long") || type.includes("interval") || type.includes("vo2") || type.includes("tempo")) {
    return "key";
  }
  if (type.includes("easy") || type.includes("technique") || type.includes("durability")) return "support";
  return "optional";
}

function inferLoadClass(session) {
  const existing = String(session?.load_class || "").toLowerCase();
  if (["recovery", "easy", "moderate", "hard", "very_hard"].includes(existing)) return existing;

  const type = String(session?.type || "").toLowerCase();
  const intent = String(session?.intent || "").toLowerCase();
  if (type.includes("rest") || intent.includes("recovery")) return "recovery";
  if (type.includes("easy") || type.includes("technique")) return "easy";
  if (type.includes("tempo")) return "hard";
  if (type.includes("interval") || type.includes("vo2") || intent.includes("vo2")) return "very_hard";
  if (type.includes("long")) return "moderate";
  return "moderate";
}

function inferCanonicalTypeFromSession(session) {
  const existing = String(session?.canonical_type || "").toLowerCase();
  if (CANONICAL_SESSION_TYPES.includes(existing)) return existing;

  const fromType = canonicalTypeFromText(session?.type || "");
  if (fromType) return fromType;
  const fromIntent = canonicalTypeFromText(session?.intent || "");
  if (fromIntent) return fromIntent;

  const discipline = String(session?.discipline || "").toLowerCase();
  if (discipline === "swim") return "technique";
  if (discipline === "strength") return "strength";
  if (discipline === "run" || discipline === "bike") return "moderate";
  return "other";
}

function isoWeekday(isoDate) {
  const dt = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  const idx = (dt.getUTCDay() + 6) % 7;
  return ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][idx];
}

function anchorKey(parts) {
  return parts.map((part) => (part == null ? "*" : String(part))).join("|");
}

function buildAnchorIndex(habitAnchors) {
  const idx = {
    byDwt: new Map(),
    byDw: new Map(),
    byD: new Map(),
  };

  for (const item of habitAnchors?.by_discipline_weekday_type || []) {
    idx.byDwt.set(anchorKey([item.discipline, item.weekday, item.canonical_type]), item);
  }
  for (const item of habitAnchors?.by_discipline_weekday || []) {
    idx.byDw.set(anchorKey([item.discipline, item.weekday]), item);
  }
  for (const item of habitAnchors?.by_discipline || []) {
    idx.byD.set(anchorKey([item.discipline]), item);
  }
  return idx;
}

function selectAnchorCandidatesForSession(anchorIndex, session) {
  const discipline = String(session?.discipline || "").toLowerCase();
  const date = String(session?.date || "");
  const weekday = isoWeekday(date);
  const canonicalType = inferCanonicalTypeFromSession(session);

  const candidates = [];

  if (discipline && weekday && canonicalType) {
    const dwt = anchorIndex.byDwt.get(anchorKey([discipline, weekday, canonicalType]));
    if (dwt) {
      candidates.push({
        level: "discipline_weekday_type",
        anchor: dwt,
      });
    }
  }

  if (discipline && weekday) {
    const dw = anchorIndex.byDw.get(anchorKey([discipline, weekday]));
    if (dw) {
      candidates.push({
        level: "discipline_weekday",
        anchor: dw,
      });
    }
  }

  if (discipline) {
    const d = anchorIndex.byD.get(anchorKey([discipline]));
    if (d) {
      candidates.push({
        level: "discipline",
        anchor: d,
      });
    }
  }

  return {
    canonical_type: canonicalType,
    weekday,
    candidates,
    selected: candidates.length ? candidates[0] : null,
  };
}

function parseTimeToMin(value) {
  const match = String(value || "").match(/T(\d{2}):(\d{2})/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function minToLocalDateTime(dateIso, minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${dateIso}T${pad2(h)}:${pad2(m)}:00`;
}

function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];

  for (let i = 1; i < sorted.length; i += 1) {
    const prev = merged[merged.length - 1];
    const next = sorted[i];
    if (next.start <= prev.end) {
      prev.end = Math.max(prev.end, next.end);
    } else {
      merged.push(next);
    }
  }

  return merged;
}

function splitDayFreeWindows(dateIso, busyIntervals, dayStartMin = 5 * 60, dayEndMin = 22 * 60) {
  const windows = [];
  let cursor = dayStartMin;

  for (const interval of mergeIntervals(busyIntervals)) {
    const start = Math.max(dayStartMin, interval.start);
    const end = Math.min(dayEndMin, interval.end);
    if (end <= dayStartMin || start >= dayEndMin) continue;

    if (start > cursor) {
      windows.push({ start_min_local: cursor, end_min_local: start });
    }
    cursor = Math.max(cursor, end);
  }

  if (cursor < dayEndMin) {
    windows.push({ start_min_local: cursor, end_min_local: dayEndMin });
  }

  return windows
    .filter((window) => window.end_min_local - window.start_min_local >= 15)
    .map((window) => ({
      ...window,
      start_local: minToLocalDateTime(dateIso, window.start_min_local),
      end_local: minToLocalDateTime(dateIso, window.end_min_local),
    }));
}

function buildCalendarFreeWindows(weekStartIso, busyWindows) {
  const dates = [];
  for (let i = 0; i < 7; i += 1) {
    const date = addDaysIso(weekStartIso, i);
    if (date) dates.push(date);
  }

  const busyByDate = new Map(dates.map((date) => [date, []]));

  for (const busy of busyWindows || []) {
    const startDate = String(busy?.start || "").slice(0, 10);
    const endDate = String(busy?.end || "").slice(0, 10);
    const startMin = parseTimeToMin(busy?.start);
    const endMin = parseTimeToMin(busy?.end);

    if (!startDate || !endDate || startMin == null || endMin == null) continue;

    for (const date of dates) {
      if (date < startDate || date > endDate) continue;

      let intervalStart = 0;
      let intervalEnd = 24 * 60;

      if (date === startDate) intervalStart = startMin;
      if (date === endDate) intervalEnd = endMin;

      if (intervalEnd <= intervalStart) continue;
      busyByDate.get(date).push({ start: intervalStart, end: intervalEnd });
    }
  }

  const freeByDate = {};
  for (const date of dates) {
    freeByDate[date] = splitDayFreeWindows(date, busyByDate.get(date) || []);
  }

  return freeByDate;
}

function detectRaceTaperWeek(plan, strategy) {
  const strategyIntent = String(strategy?.phase_intent || "").toLowerCase();
  const planPhase = String(plan?.phase || "").toLowerCase();
  return /(race|taper|peak)/.test(`${strategyIntent} ${planPhase}`);
}

function buildSchedulingPolicy(inferredPolicyDefaults, isRaceTaperWeek) {
  const defaults = {
    ...BASE_POLICY_DEFAULTS,
    ...(inferredPolicyDefaults || {}),
    time_deviation_caps_min: {
      ...BASE_POLICY_DEFAULTS.time_deviation_caps_min,
      ...(inferredPolicyDefaults?.time_deviation_caps_min || {}),
    },
  };

  const multiplier = isRaceTaperWeek ? Number(defaults.race_taper_multiplier || 1.5) : 1;
  const weekdayBudgetRatio = isRaceTaperWeek
    ? Number(defaults.race_taper_weekday_change_budget_ratio || 0.35)
    : Number(defaults.weekday_change_budget_ratio || 0.2);

  return {
    same_day_shift_first: true,
    is_race_taper_week: isRaceTaperWeek,
    weekday_change_budget_ratio: weekdayBudgetRatio,
    time_deviation_caps_min: {
      key: Math.round(Number(defaults.time_deviation_caps_min.key || 90) * multiplier),
      support: Math.round(Number(defaults.time_deviation_caps_min.support || 150) * multiplier),
      optional: Math.round(Number(defaults.time_deviation_caps_min.optional || 240) * multiplier),
    },
    race_taper_multiplier: Number(defaults.race_taper_multiplier || 1.5),
    race_taper_weekday_change_budget_ratio: Number(
      defaults.race_taper_weekday_change_budget_ratio || 0.35
    ),
  };
}

async function loadCalendarWindow(startIso, endIso, calendarId) {
  try {
    const response = await listEvents({
      start: `${startIso}T00:00:00Z`,
      end: `${endIso}T00:00:00Z`,
      calendarId,
    });

    const windows = mapBusyWindows(response.items || []);
    return {
      ok: true,
      calendar_id: response.calendarId,
      busy_windows: windows.filter((event) => !event.is_training_event),
      existing_training_windows: windows.filter((event) => event.is_training_event),
      warnings: [],
    };
  } catch (error) {
    return {
      ok: false,
      calendar_id: calendarId || "primary",
      busy_windows: [],
      existing_training_windows: [],
      warnings: [
        `calendar_lookup_failed: ${String(error?.message || error)}`,
        "Proceed with habit-first model scheduling using Strava anchors only.",
      ],
    };
  }
}

async function main() {
  const options = parseArgs();
  if (!options.plan) {
    throw new Error("Missing --plan path.");
  }

  const plan = readJson(options.plan);
  const profile = readJson(options.profile);
  const goals = fs.existsSync(options.goals) ? readJson(options.goals) : {};
  const strategy = fs.existsSync(options.strategy) ? readJson(options.strategy) : {};
  const snapshot = readJson(options.snapshot);
  const inferred = fs.existsSync(options.inferred) ? readJson(options.inferred) : null;

  const weekStart = inferWeekStart(plan);
  if (!weekStart) {
    throw new Error("Unable to infer week_start from plan.");
  }
  const weekEndExclusive = addDaysIso(weekStart, 7);
  if (!weekEndExclusive) {
    throw new Error(`Invalid week_start: ${weekStart}`);
  }

  const calendarWindow = await loadCalendarWindow(weekStart, weekEndExclusive, options.calendarId);
  const calendarFreeWindows = buildCalendarFreeWindows(weekStart, calendarWindow.busy_windows);

  const isRaceTaperWeek = detectRaceTaperWeek(plan, strategy);
  const schedulingPolicy = buildSchedulingPolicy(inferred?.policy_defaults, isRaceTaperWeek);

  const anchorIndex = buildAnchorIndex(inferred?.habit_anchors || {});

  const sessionCandidates = Array.isArray(plan?.sessions)
    ? plan.sessions.map((session) => {
        const anchorInfo = selectAnchorCandidatesForSession(anchorIndex, session);
        const schedulable =
          String(session?.discipline || "").toLowerCase() !== "rest" &&
          Number.isFinite(Number(session?.duration_min || NaN)) &&
          Number(session?.duration_min) > 0;

        return {
          id: session?.id || null,
          date: session?.date || null,
          discipline: session?.discipline || null,
          type: session?.type || null,
          canonical_type: anchorInfo.canonical_type,
          duration_min: session?.duration_min || null,
          intent: session?.intent || "",
          priority: inferSessionPriority(session),
          load_class: inferLoadClass(session),
          schedulable,
          existing_schedule: {
            scheduled_start_local: session?.scheduled_start_local || null,
            scheduled_end_local: session?.scheduled_end_local || null,
          },
          calendar_free_windows: calendarFreeWindows[String(session?.date || "")] || [],
          anchor_candidates: anchorInfo.candidates,
          selected_anchor: anchorInfo.selected,
        };
      })
    : [];

  const schedulableCount = sessionCandidates.filter((session) => session.schedulable).length;
  const offWeekdayBudget = Math.max(
    1,
    Math.floor(schedulableCount * Number(schedulingPolicy.weekday_change_budget_ratio || 0.2))
  );

  const context = {
    generated_at: new Date().toISOString(),
    schema_version: 3,
    week_start: weekStart,
    week_end_exclusive: weekEndExclusive,
    timezone:
      options.timezone ||
      profile?.preferences?.timezone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      "UTC",
    athlete_constraints: {
      rest_day: profile?.preferences?.rest_day || null,
      fixed_sessions: profile?.preferences?.fixed_sessions || [],
      time_budget_hours: profile?.preferences?.time_budget_hours || {},
      session_type_preferences: profile?.preferences?.session_type_preferences || {},
      strength_preferences: profile?.preferences?.strength || {},
      health: profile?.health || {},
    },
    inferred_preferences: {
      schema_version: inferred?.schema_version || null,
      habit_anchors: inferred?.habit_anchors || {
        by_discipline_weekday_type: [],
        by_discipline_weekday: [],
        by_discipline: [],
      },
      policy_defaults: inferred?.policy_defaults || { ...BASE_POLICY_DEFAULTS },
    },
    calendar_context: {
      busy_windows: calendarWindow.busy_windows,
      free_windows_by_date: calendarFreeWindows,
      existing_training_windows: calendarWindow.existing_training_windows,
      calendar_id: calendarWindow.calendar_id,
      warnings: calendarWindow.warnings,
    },
    scheduling_policy: {
      ...schedulingPolicy,
      off_habit_weekday_budget: offWeekdayBudget,
      schedulable_session_count: schedulableCount,
    },
    session_candidates: sessionCandidates,
    strategy_context: {
      goals: goals?.primary_goal || goals?.goal || null,
      strategy_focus: strategy?.focus || strategy?.priority_blocks || null,
      phase_intent: strategy?.phase_intent || null,
      snapshot_as_of: snapshot?.as_of_date || null,
      bike_capabilities: profile?.preferences?.bike_capabilities?.resolved || null,
    },
    rules: {
      hard_constraints: [
        "respect_rest_day",
        "respect_fixed_sessions",
        "no_overlap_with_busy_windows",
      ],
      recovery_rules: [
        "avoid_hard_strength_within_24h_before_key_vo2",
        "avoid_multiple_very_hard_same_day_unless_brick",
      ],
      candidate_search: {
        grid_minutes: 15,
        same_day_shift_first: true,
        day_search_order: [0, 1, -1, 2, -2],
      },
      exception_policy: {
        allowed_codes: [
          "HARD_CONSTRAINT_COLLISION",
          "RECOVERY_SAFETY_BLOCK",
          "FIXED_SESSION_COLLISION",
          "REST_DAY_CONSTRAINT",
          "NO_FEASIBLE_SAME_DAY_SLOT",
          "RACE_TAPER_KEY_SESSION_ADJUSTMENT",
        ],
      },
    },
  };

  const defaultOut = path.join(PATHS.system.calendarDir, `scheduling_context_${weekStart}.json`);
  const outPath = options.out || defaultOut;
  writeJson(outPath, context);
  process.stdout.write(`${JSON.stringify({ ok: true, out: outPath, week_start: weekStart }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  });
}

module.exports = {
  buildAnchorIndex,
  selectAnchorCandidatesForSession,
  inferCanonicalTypeFromSession,
  buildSchedulingPolicy,
};
