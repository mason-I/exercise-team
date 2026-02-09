#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");
const { weekStart, toIsoDate, parseDate } = require("../../_shared/lib");
const { PATHS, resolveProjectPath } = require("../../_shared/paths");

function resolveProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR
    ? path.resolve(process.env.CLAUDE_PROJECT_DIR)
    : path.resolve(__dirname, "../../../..");
}

function safeReadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    weekStart: null,
    timezone: null,
    out: null,
    profilePath: PATHS.coach.profile,
    goalsPath: PATHS.coach.goals,
    strategyPath: PATHS.coach.strategy,
    templatePath: "templates/plan.json",
    calendarId: "primary",
    overwrite: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--week-start") options.weekStart = String(argv[i + 1] || "").trim();
    if (arg === "--timezone") options.timezone = String(argv[i + 1] || "").trim();
    if (arg === "--out") options.out = String(argv[i + 1] || "").trim();
    if (arg === "--profile") options.profilePath = String(argv[i + 1] || options.profilePath);
    if (arg === "--goals") options.goalsPath = String(argv[i + 1] || options.goalsPath);
    if (arg === "--strategy") options.strategyPath = String(argv[i + 1] || options.strategyPath);
    if (arg === "--template") options.templatePath = String(argv[i + 1] || options.templatePath);
    if (arg === "--calendar-id") options.calendarId = String(argv[i + 1] || options.calendarId);
    if (arg === "--overwrite") options.overwrite = true;
    if (arg === "--dry-run") options.dryRun = true;
  }

  return options;
}

function toDayName(date) {
  return date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }).toLowerCase();
}

function addDaysIso(isoDate, days) {
  const dt = parseDate(isoDate);
  if (!dt) return isoDate;
  dt.setUTCDate(dt.getUTCDate() + days);
  return toIsoDate(dt);
}

function buildIsoLocal(dateIso, hour, minute) {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `${dateIso}T${hh}:${mm}:00`;
}

function addMinutesLocal(isoLocal, minutes) {
  const dt = new Date(isoLocal);
  if (Number.isNaN(dt.getTime())) return isoLocal;
  dt.setMinutes(dt.getMinutes() + minutes);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  const hh = String(dt.getHours()).padStart(2, "0");
  const mi = String(dt.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:00`;
}

function baseProgression(goalLink, summary, regressionRule, phaseMode = "build") {
  return {
    phase_mode: phaseMode,
    progression_comparison: "none",
    prior_week_session_id: null,
    progression_decision: "Initial onboarding week",
    progressed_fields: [],
    load_delta_summary: summary,
    regression_rule: regressionRule,
    goal_link: goalLink,
  };
}

function baseNutrition() {
  return {
    pre_session: "Hydrate and consume a light carbohydrate snack 30-60 minutes pre-session.",
    during_session: "Hydrate with water and electrolytes as needed.",
    post_session: "Consume protein plus carbohydrate within 60 minutes.",
    daily_recovery_target: "Meet hydration and protein targets for the day.",
    session_specific_adjustment: "Adjust fueling for heat and session duration.",
    compliance_markers: ["pre_fuel_complete", "post_recovery_complete"],
  };
}

function baseCalendar(calendarId) {
  return {
    provider: "google",
    calendar_id: calendarId || "primary",
    event_id: null,
    status: "unscheduled",
    last_synced_at: null,
    last_sync_action: null,
  };
}

function makeBikeSession({ date, id, durationMin, title, longRide = false, goalLink, calendarId }) {
  const start = buildIsoLocal(date, longRide ? 7 : 6, 0);
  const end = addMinutesLocal(start, durationMin);
  return {
    id,
    date,
    discipline: "bike",
    type: longRide ? "long" : "moderate",
    canonical_type: longRide ? "long" : "moderate",
    duration_min: durationMin,
    scheduled_start_local: start,
    scheduled_end_local: end,
    priority: longRide ? "key" : "support",
    load_class: longRide ? "moderate" : "easy",
    habit_anchor: {
      level_used: "discipline_weekday",
      target_start_local: start,
      confidence: "medium",
      weekday_match: true,
    },
    habit_match_score: 80,
    deviation_minutes: 0,
    deviation_reason: "",
    exception_code: null,
    scheduling_notes: longRide ? "Weekend endurance anchor" : "Midweek aerobic support",
    progression_trace: baseProgression(
      goalLink,
      longRide ? "Long bike endurance established for onboarding week." : "Bike aerobic support established.",
      "Reduce duration by 25% if fatigue persists >24h."
    ),
    intent: title,
    success_criteria: ["Complete planned duration", "Controlled effort", "No lingering fatigue"],
    bike_prescription: {
      session_objective: longRide ? "Long aerobic endurance" : "Aerobic maintenance",
      target_system: "aerobic_endurance",
      blocks: [
        {
          block_label: "warmup",
          duration_min: longRide ? 15 : 10,
          work_interval: "continuous",
          recovery_interval: "none",
          repetitions: 1,
          target_metric: "hr",
          target_range: "100-131 BPM (Z1 progressive build, RPE 2-3)",
          cadence_target: "85-95 rpm",
          terrain_or_mode: "flat",
          execution_cues: ["Gradually increase effort", "Find rhythm", "Relaxed upper body"],
          success_criteria: ["Smooth build to target zone", "No sudden spikes"],
          failure_adjustment: "Extend warmup by 5min if legs feel heavy.",
        },
        {
          block_label: "main_endurance",
          duration_min: longRide ? durationMin - 25 : durationMin - 20,
          work_interval: "continuous",
          recovery_interval: "none",
          repetitions: 1,
          target_metric: "hr",
          target_range: longRide ? "131-155 BPM (Z2, RPE 3-4)" : "131-164 BPM (Z2-Z3, RPE 3-5)",
          cadence_target: "85-95 rpm",
          terrain_or_mode: longRide ? "rolling terrain" : "flat to rolling",
          execution_cues: ["Smooth cadence", "Steady breathing", "Relaxed upper body"],
          success_criteria: ["Even pacing", "HR stays in range", "Sustainable effort"],
          failure_adjustment: "Drop to low Z2 (131-140 BPM) if HR drifts above target.",
        },
        {
          block_label: "cooldown",
          duration_min: 10,
          work_interval: "continuous",
          recovery_interval: "none",
          repetitions: 1,
          target_metric: "hr",
          target_range: "100-131 BPM (Z1, RPE 1-2)",
          cadence_target: "80-90 rpm",
          terrain_or_mode: "flat",
          execution_cues: ["Easy spin", "Let HR drop naturally", "Stretch on bike if needed"],
          success_criteria: ["HR below 131 by end", "Relaxed finish"],
          failure_adjustment: "Extend cooldown if HR stays elevated.",
        },
      ],
    },
    intensity_prescription: {
      primary_metric: "hr",
      power_w_range: [],
      if_range: [],
      hr_zone_range: longRide ? ["z2"] : ["z2", "z3"],
      hr_bpm_range: [131, longRide ? 164 : 180],
      rpe_range: longRide ? [3, 4] : [3, 5],
      effort_hint: longRide ? "Keep effort all-day sustainable." : "Steady aerobic with controlled tempo option.",
    },
    nutrition_prescription: baseNutrition(),
    calendar: baseCalendar(calendarId),
  };
}

function makeRunSession({ date, id, durationMin, title, goalLink, calendarId }) {
  const start = buildIsoLocal(date, 6, 15);
  const end = addMinutesLocal(start, durationMin);
  return {
    id,
    date,
    discipline: "run",
    type: "easy",
    canonical_type: "easy",
    duration_min: durationMin,
    scheduled_start_local: start,
    scheduled_end_local: end,
    priority: "support",
    load_class: "easy",
    habit_anchor: {
      level_used: "discipline_weekday",
      target_start_local: start,
      confidence: "medium",
      weekday_match: true,
    },
    habit_match_score: 78,
    deviation_minutes: 0,
    deviation_reason: "",
    exception_code: null,
    scheduling_notes: "Conservative progression due to injury risk",
    progression_trace: baseProgression(
      goalLink,
      "Run consistency session added with conservative load.",
      "Stop if pain exceeds 3/10; reduce next run duration by 50%."
    ),
    intent: title,
    success_criteria: ["Pain-free execution", "Conversational effort", "Clean mechanics"],
    run_prescription: {
      session_objective: "Easy aerobic base support",
      target_system: "aerobic_endurance",
      blocks: [
        {
          block_label: "warmup",
          duration_min: 5,
          target_metric: "rpe",
          target_range: "7:00-8:00/km walk-to-jog (RPE 1-2, HR below 131 BPM)",
          terrain_or_mode: "flat or soft surface",
          execution_cues: ["Start walking", "Transition to easy jog", "Find rhythm"],
          success_criteria: ["Smooth transition", "No sudden effort"],
          failure_adjustment: "Stay walking if anything feels off.",
        },
        {
          block_label: "main_easy",
          duration_min: durationMin - 10,
          target_metric: "rpe",
          target_range: "5:45-6:15/km (RPE 2-3, HR 131-155 BPM, conversational)",
          terrain_or_mode: "flat or soft surface",
          execution_cues: ["Short stride", "Quick cadence ~170-180 spm", "Relaxed shoulders"],
          success_criteria: ["No pain spike", "Steady breathing", "Good form throughout"],
          failure_adjustment: "Switch to run-walk immediately if discomfort appears.",
        },
        {
          block_label: "cooldown",
          duration_min: 5,
          target_metric: "rpe",
          target_range: "7:00+/km walk-to-jog (RPE 1-2, HR dropping below 131 BPM)",
          terrain_or_mode: "flat",
          execution_cues: ["Gradually slow pace", "Walk last 2 minutes", "Light stretching after"],
          success_criteria: ["HR dropping", "Relaxed finish"],
          failure_adjustment: "Walk the entire cooldown if needed.",
        },
      ],
      impact_management: {
        surface: "soft when possible",
        cadence_cue: "light quick steps",
        stride_cue: "avoid overstriding",
      },
      success_criteria: ["No pain escalation", "Smooth form", "Stable effort"],
      failure_adjustment: "Reduce next run load and substitute bike if symptoms persist.",
    },
    intensity_prescription: {
      primary_metric: "rpe",
      power_w_range: [],
      if_range: [],
      hr_zone_range: ["z2"],
      hr_bpm_range: [131, 164],
      rpe_range: [2, 3],
      effort_hint: "Keep the run conversational throughout.",
    },
    nutrition_prescription: baseNutrition(),
    calendar: baseCalendar(calendarId),
  };
}

function makeStrengthSession({ date, id, durationMin, title, goalLink, calendarId }) {
  const start = buildIsoLocal(date, 8, 0);
  const end = addMinutesLocal(start, durationMin);
  return {
    id,
    date,
    discipline: "strength",
    type: "strength",
    canonical_type: "strength",
    duration_min: durationMin,
    scheduled_start_local: start,
    scheduled_end_local: end,
    priority: "support",
    load_class: "moderate",
    habit_anchor: {
      level_used: "discipline",
      target_start_local: start,
      confidence: "low",
      weekday_match: true,
    },
    habit_match_score: 70,
    deviation_minutes: 0,
    deviation_reason: "",
    exception_code: null,
    scheduling_notes: "Resilience-focused strength",
    progression_trace: baseProgression(
      goalLink,
      "Strength resilience session established.",
      "Reduce total sets if soreness exceeds expected training response."
    ),
    intent: title,
    success_criteria: ["Complete all exercises", "Pain-free movement", "Technique quality maintained"],
    strength_prescription: {
      phase_mode: "build",
      progression_decision: "Initial onboarding baseline",
      progression_comparison: "none",
      exercises: [
        {
          exercise_name: "Goblet squat",
          category: "injury_prevention",
          injury_target: "knee_hip",
          sport_transfer_target: "run",
          sets: 3,
          reps: "8-10",
          tempo: "3-1-1",
          rest_sec: 90,
          load: {
            method: "rpe_rir",
            target_rpe: 7,
            target_rir: 3,
            progression_axis: "reps",
            regression_rule: "Reduce range or load if pain appears.",
          },
        },
        {
          exercise_name: "Single-leg calf raise",
          category: "injury_prevention",
          injury_target: "shin_calf",
          sport_transfer_target: "run",
          sets: 3,
          reps: "10-12",
          tempo: "2-0-2",
          rest_sec: 60,
          load: {
            method: "rpe_rir",
            target_rpe: 7,
            target_rir: 3,
            progression_axis: "reps",
            regression_rule: "Use assisted variation if symptomatic.",
          },
        },
      ],
    },
    intensity_prescription: {
      primary_metric: "rpe",
      power_w_range: [],
      if_range: [],
      hr_zone_range: [],
      hr_bpm_range: [],
      rpe_range: [5, 7],
      effort_hint: "Moderate effort with strict technique.",
    },
    nutrition_prescription: baseNutrition(),
    calendar: baseCalendar(calendarId),
  };
}

function makeRestSession({ date, id, intent }) {
  return {
    id,
    date,
    discipline: "rest",
    type: "recovery",
    canonical_type: "recovery",
    duration_min: 0,
    priority: "optional",
    load_class: "recovery",
    habit_anchor: null,
    habit_match_score: 0,
    deviation_minutes: 0,
    deviation_reason: "",
    exception_code: null,
    scheduling_notes: "",
    progression_trace: null,
    intent,
    success_criteria: [],
  };
}

function buildSessions({ weekStartIso, restDay, goalLink, calendarId }) {
  const weekDates = Array.from({ length: 7 }, (_, index) => addDaysIso(weekStartIso, index));
  const byDay = {};
  for (const iso of weekDates) {
    byDay[toDayName(parseDate(iso))] = iso;
  }

  const effectiveRestDay = typeof restDay === "string" && byDay[restDay.toLowerCase()] ? restDay.toLowerCase() : "monday";
  const sessions = [];

  for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]) {
    const date = byDay[day];
    if (!date) continue;
    if (day === effectiveRestDay) {
      sessions.push(
        makeRestSession({
          date,
          id: `rest_${day}_${date}`,
          intent: `Preferred recovery day (${day})`,
        })
      );
      continue;
    }

    if (day === "tuesday") {
      sessions.push(
        makeBikeSession({
          date,
          id: `bike_${day}_${date}`,
          durationMin: 75,
          title: "Aerobic bike support",
          goalLink,
          calendarId,
        })
      );
      continue;
    }

    if (day === "thursday") {
      sessions.push(
        makeRunSession({
          date,
          id: `run_${day}_${date}`,
          durationMin: 40,
          title: "Easy run durability",
          goalLink,
          calendarId,
        })
      );
      continue;
    }

    if (day === "saturday") {
      sessions.push(
        makeBikeSession({
          date,
          id: `bike_long_${day}_${date}`,
          durationMin: 180,
          title: "Long endurance ride",
          longRide: true,
          goalLink,
          calendarId,
        })
      );
      continue;
    }

    if (day === "sunday") {
      sessions.push(
        makeStrengthSession({
          date,
          id: `strength_${day}_${date}`,
          durationMin: 45,
          title: "Injury resilience strength",
          goalLink,
          calendarId,
        })
      );
      continue;
    }

    sessions.push(
      makeRestSession({
        date,
        id: `recovery_${day}_${date}`,
        intent: "Recovery and readiness",
      })
    );
  }

  return sessions;
}

function main() {
  const options = parseArgs();
  const projectDir = resolveProjectDir();
  const profile = safeReadJson(path.join(projectDir, options.profilePath), {});
  const goals = safeReadJson(path.join(projectDir, options.goalsPath), {});
  const strategy = safeReadJson(path.join(projectDir, options.strategyPath), {});
  const template = safeReadJson(path.join(projectDir, options.templatePath), {});

  const weekStartIso = (() => {
    if (options.weekStart) {
      const parsed = parseDate(options.weekStart);
      if (parsed) return toIsoDate(parsed);
      throw new Error(`Invalid --week-start '${options.weekStart}'. Use YYYY-MM-DD.`);
    }
    const envWeek = parseDate(process.env.COACH_WEEK_START || "");
    if (envWeek) return toIsoDate(envWeek);
    return toIsoDate(weekStart(new Date()));
  })();

  const weekEndIso = addDaysIso(weekStartIso, 6);
  const outPath = options.out
    ? path.resolve(projectDir, options.out)
    : path.join(resolveProjectPath(projectDir, PATHS.coach.plansDir), `${weekStartIso}.json`);

  if (!options.overwrite && fs.existsSync(outPath)) {
    throw new Error(`Plan already exists at ${outPath}. Re-run with --overwrite to replace it.`);
  }

  const budget =
    profile && profile.preferences && profile.preferences.time_budget_hours
      ? profile.preferences.time_budget_hours
      : { min: 8, typical: 10, max: 12 };

  const restDay =
    profile && profile.preferences && typeof profile.preferences.rest_day === "string"
      ? profile.preferences.rest_day.toLowerCase()
      : "monday";

  const goalLink =
    (Array.isArray(goals.goals) && goals.goals[0] && goals.goals[0].id) ||
    (goals.primary_goal && goals.primary_goal.name ? `primary_goal:${goals.primary_goal.name}` : "primary_goal");

  const timezone =
    options.timezone ||
    (template.scheduling_context && template.scheduling_context.timezone) ||
    "UTC";

  const sessions = buildSessions({
    weekStartIso,
    restDay,
    goalLink,
    calendarId: options.calendarId,
  });

  const plan = {
    week_start: weekStartIso,
    week_end: weekEndIso,
    time_budget_hours: {
      min: Number.isFinite(Number(budget.min)) ? Number(budget.min) : 8,
      typical: Number.isFinite(Number(budget.typical)) ? Number(budget.typical) : 10,
      max: Number.isFinite(Number(budget.max)) ? Number(budget.max) : 12,
    },
    scheduling_context: {
      timezone,
      generated_at: new Date().toISOString(),
      scheduling_policy:
        (template.scheduling_context && template.scheduling_context.scheduling_policy) || {
          same_day_shift_first: true,
          is_race_taper_week: false,
          weekday_change_budget_ratio: 0.2,
          time_deviation_caps_min: { key: 90, support: 150, optional: 240 },
          race_taper_multiplier: 1.5,
          race_taper_weekday_change_budget_ratio: 0.35,
          off_habit_weekday_budget: 1,
          schedulable_session_count: sessions.filter((s) => s.discipline !== "rest" && s.duration_min > 0).length,
        },
      notes:
        (strategy && strategy.phase_notes) ||
        "Onboarding baseline week generated from defaults and available athlete profile.",
    },
    scheduling_decisions: {
      placements: [],
      adjustments: [],
      habit_adherence_summary: {
        matched_weekday_count: sessions.filter((s) => s.habit_anchor && s.habit_anchor.weekday_match).length,
        matched_time_within_cap_count: sessions.filter((s) => Number(s.deviation_minutes || 0) <= 30).length,
        off_habit_weekday_count: 0,
        off_habit_weekday_budget: 1,
        overall_habit_adherence_score: 0.8,
      },
    },
    needs_user_input: [],
    scheduling_risk_flags: [],
    sessions,
  };

  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          dry_run: true,
          week_start: weekStartIso,
          week_end: weekEndIso,
          session_count: sessions.length,
          schedulable_count: sessions.filter((s) => s.discipline !== "rest" && s.duration_min > 0).length,
          out_path: outPath,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  writeJson(outPath, plan);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        week_start: weekStartIso,
        week_end: weekEndIso,
        plan_path: outPath,
        session_count: sessions.length,
        schedulable_count: sessions.filter((s) => s.discipline !== "rest" && s.duration_min > 0).length,
      },
      null,
      2
    )}\n`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}
