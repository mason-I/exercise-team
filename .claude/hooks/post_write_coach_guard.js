#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");

const POWER_TEXT_PATTERNS = [
  /\bftp\b/i,
  /\bwatts?\b/i,
  /\b\d{2,4}\s*w\b/i,
  /\b(?:if|intensity factor)\s*(?:target|range|=|:|at|around)?\s*\d(?:\.\d+)?\b/i,
  /\b\d(?:\.\d+)?\s*if\b/i,
];

const TRAINABLE_DISCIPLINES = ["run", "bike", "swim", "strength"];
const ALLOWED_PHASE_MODES = ["build", "maintain", "taper", "deload"];
const ALLOWED_PROGRESSION_COMPARISONS = ["prior_week_reference", "none"];
const ALLOWED_TARGET_SYSTEMS = ["aerobic_endurance", "threshold", "vo2", "neuromuscular", "race_specific"];
const ALLOWED_BIKE_TARGET_METRICS = ["power", "hr", "rpe"];
const ALLOWED_RUN_TARGET_METRICS = ["pace", "hr", "rpe"];
const ALLOWED_STRENGTH_CATEGORIES = ["injury_prevention", "overuse_buffer", "performance_transfer"];
const ALLOWED_STRENGTH_AXES = ["load", "reps", "sets", "tempo", "density"];

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf-8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function findFilePath(input) {
  return input?.tool_input?.file_path || input?.tool_response?.filePath || input?.tool_input?.path || "";
}

function isCoachJson(filePath) {
  const resolved = path.resolve(filePath);
  return resolved.includes(`${path.sep}coach${path.sep}`) && resolved.endsWith(".json");
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function hasValue(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) return false;
  if (nonEmpty && value.length === 0) return false;
  return value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isValidRepSpec(value) {
  if (isPositiveInteger(value)) return true;
  if (typeof value !== "string") return false;
  if (!value.trim()) return false;
  return /^[0-9]+(?:\s*-\s*[0-9]+)?$/.test(value.trim());
}

function requireKeys(obj, keys, label) {
  const missing = keys.filter((key) => !(key in obj));
  if (missing.length) {
    throw new Error(`${label} missing keys: ${missing.join(", ")}`);
  }
}

function validateSnapshot(data) {
  requireKeys(data, ["generated_at", "as_of_date", "activities_summary"], "strava_snapshot");
}

function validateProfile(data) {
  requireKeys(data, ["athlete", "preferences"], "profile");
}

function validateGoals(data) {
  requireKeys(data, ["primary_goal", "goals"], "goals");
}

function validateBaseline(data) {
  requireKeys(data, ["as_of_date", "confidence_by_discipline", "current_load_tolerance"], "baseline");
}

function validateStrategy(data) {
  requireKeys(data, ["primary_goal", "phase_intent", "discipline_focus", "weekly_priorities"], "strategy");
}

function validateProgressionTrace(session) {
  const discipline = String(session?.discipline || "").toLowerCase();
  if (!TRAINABLE_DISCIPLINES.includes(discipline)) return;

  const label = session?.id || "unknown-id";
  const trace = session?.progression_trace;
  if (!trace || typeof trace !== "object") {
    throw new Error(`${label}: trainable sessions must include progression_trace object`);
  }

  requireKeys(
    trace,
    [
      "phase_mode",
      "progression_comparison",
      "prior_week_session_id",
      "progression_decision",
      "progressed_fields",
      "load_delta_summary",
      "regression_rule",
      "goal_link",
    ],
    `${label}.progression_trace`
  );

  const phaseMode = String(trace.phase_mode || "").toLowerCase();
  if (!ALLOWED_PHASE_MODES.includes(phaseMode)) {
    throw new Error(`${label}: progression_trace.phase_mode must be one of ${ALLOWED_PHASE_MODES.join(", ")}`);
  }

  const comparison = String(trace.progression_comparison || "").toLowerCase();
  if (!ALLOWED_PROGRESSION_COMPARISONS.includes(comparison)) {
    throw new Error(
      `${label}: progression_trace.progression_comparison must be one of ${ALLOWED_PROGRESSION_COMPARISONS.join(", ")}`
    );
  }

  const priorWeekSessionId = trace.prior_week_session_id;
  if (priorWeekSessionId !== null && !isNonEmptyString(priorWeekSessionId)) {
    throw new Error(`${label}: progression_trace.prior_week_session_id must be string or null`);
  }

  if (!isNonEmptyString(trace.progression_decision)) {
    throw new Error(`${label}: progression_trace.progression_decision must be a non-empty string`);
  }

  if (!isStringArray(trace.progressed_fields)) {
    throw new Error(`${label}: progression_trace.progressed_fields must be an array of strings`);
  }

  if (!isNonEmptyString(trace.load_delta_summary)) {
    throw new Error(`${label}: progression_trace.load_delta_summary must be a non-empty string`);
  }

  if (!isNonEmptyString(trace.regression_rule)) {
    throw new Error(`${label}: progression_trace.regression_rule must be a non-empty string`);
  }

  if (!isNonEmptyString(trace.goal_link)) {
    throw new Error(`${label}: progression_trace.goal_link must be a non-empty string`);
  }
}

function validateBikePrescription(session) {
  if (String(session?.discipline || "").toLowerCase() !== "bike") return;
  const label = session?.id || "unknown-id";
  const prescription = session?.bike_prescription;
  if (!prescription || typeof prescription !== "object") {
    throw new Error(`${label}: bike sessions must include bike_prescription object`);
  }

  requireKeys(prescription, ["session_objective", "target_system", "blocks"], `${label}.bike_prescription`);

  if (!isNonEmptyString(prescription.session_objective)) {
    throw new Error(`${label}: bike_prescription.session_objective must be non-empty`);
  }

  const targetSystem = String(prescription.target_system || "").toLowerCase();
  if (!ALLOWED_TARGET_SYSTEMS.includes(targetSystem)) {
    throw new Error(`${label}: bike_prescription.target_system must be one of ${ALLOWED_TARGET_SYSTEMS.join(", ")}`);
  }

  if (!Array.isArray(prescription.blocks) || !prescription.blocks.length) {
    throw new Error(`${label}: bike_prescription.blocks must be a non-empty array`);
  }

  for (const [index, block] of prescription.blocks.entries()) {
    if (!block || typeof block !== "object") {
      throw new Error(`${label}: bike_prescription.blocks[${index}] must be an object`);
    }

    requireKeys(
      block,
      [
        "block_label",
        "duration_min",
        "work_interval",
        "recovery_interval",
        "repetitions",
        "target_metric",
        "target_range",
        "cadence_target",
        "terrain_or_mode",
        "execution_cues",
        "success_criteria",
        "failure_adjustment",
      ],
      `${label}.bike_prescription.blocks[${index}]`
    );

    if (!isNonEmptyString(block.block_label)) {
      throw new Error(`${label}: bike_prescription.blocks[${index}].block_label must be non-empty`);
    }
    if (!isPositiveInteger(block.duration_min)) {
      throw new Error(`${label}: bike_prescription.blocks[${index}].duration_min must be positive integer`);
    }
    if (!isNonEmptyString(block.work_interval)) {
      throw new Error(`${label}: bike_prescription.blocks[${index}].work_interval must be non-empty`);
    }
    if (!isNonEmptyString(block.recovery_interval)) {
      throw new Error(`${label}: bike_prescription.blocks[${index}].recovery_interval must be non-empty`);
    }
    if (!isPositiveInteger(block.repetitions)) {
      throw new Error(`${label}: bike_prescription.blocks[${index}].repetitions must be positive integer`);
    }

    const targetMetric = String(block.target_metric || "").toLowerCase();
    if (!ALLOWED_BIKE_TARGET_METRICS.includes(targetMetric)) {
      throw new Error(
        `${label}: bike_prescription.blocks[${index}].target_metric must be one of ${ALLOWED_BIKE_TARGET_METRICS.join(
          ", "
        )}`
      );
    }

    if (!isNonEmptyString(block.target_range)) {
      throw new Error(`${label}: bike_prescription.blocks[${index}].target_range must be non-empty`);
    }
    if (!isNonEmptyString(block.cadence_target)) {
      throw new Error(`${label}: bike_prescription.blocks[${index}].cadence_target must be non-empty`);
    }
    if (!isNonEmptyString(block.terrain_or_mode)) {
      throw new Error(`${label}: bike_prescription.blocks[${index}].terrain_or_mode must be non-empty`);
    }
    if (!isStringArray(block.execution_cues, { nonEmpty: true })) {
      throw new Error(`${label}: bike_prescription.blocks[${index}].execution_cues must be non-empty string array`);
    }
    if (!isStringArray(block.success_criteria, { nonEmpty: true })) {
      throw new Error(`${label}: bike_prescription.blocks[${index}].success_criteria must be non-empty string array`);
    }
    if (!isNonEmptyString(block.failure_adjustment)) {
      throw new Error(`${label}: bike_prescription.blocks[${index}].failure_adjustment must be non-empty`);
    }
  }
}

function validateRunPrescription(session) {
  if (String(session?.discipline || "").toLowerCase() !== "run") return;
  const label = session?.id || "unknown-id";
  const prescription = session?.run_prescription;
  if (!prescription || typeof prescription !== "object") {
    throw new Error(`${label}: run sessions must include run_prescription object`);
  }

  requireKeys(
    prescription,
    ["session_objective", "target_system", "blocks", "impact_management", "success_criteria", "failure_adjustment"],
    `${label}.run_prescription`
  );

  if (!isNonEmptyString(prescription.session_objective)) {
    throw new Error(`${label}: run_prescription.session_objective must be non-empty`);
  }

  const targetSystem = String(prescription.target_system || "").toLowerCase();
  if (!ALLOWED_TARGET_SYSTEMS.includes(targetSystem)) {
    throw new Error(`${label}: run_prescription.target_system must be one of ${ALLOWED_TARGET_SYSTEMS.join(", ")}`);
  }

  if (!Array.isArray(prescription.blocks) || !prescription.blocks.length) {
    throw new Error(`${label}: run_prescription.blocks must be a non-empty array`);
  }

  for (const [index, block] of prescription.blocks.entries()) {
    if (!block || typeof block !== "object") {
      throw new Error(`${label}: run_prescription.blocks[${index}] must be an object`);
    }

    requireKeys(
      block,
      [
        "block_label",
        "duration_min",
        "target_metric",
        "target_range",
        "terrain_or_mode",
        "execution_cues",
        "success_criteria",
        "failure_adjustment",
      ],
      `${label}.run_prescription.blocks[${index}]`
    );

    if (!isNonEmptyString(block.block_label)) {
      throw new Error(`${label}: run_prescription.blocks[${index}].block_label must be non-empty`);
    }
    if (!isPositiveInteger(block.duration_min)) {
      throw new Error(`${label}: run_prescription.blocks[${index}].duration_min must be positive integer`);
    }

    const targetMetric = String(block.target_metric || "").toLowerCase();
    if (!ALLOWED_RUN_TARGET_METRICS.includes(targetMetric)) {
      throw new Error(
        `${label}: run_prescription.blocks[${index}].target_metric must be one of ${ALLOWED_RUN_TARGET_METRICS.join(
          ", "
        )}`
      );
    }

    if (!isNonEmptyString(block.target_range)) {
      throw new Error(`${label}: run_prescription.blocks[${index}].target_range must be non-empty`);
    }
    if (!isNonEmptyString(block.terrain_or_mode)) {
      throw new Error(`${label}: run_prescription.blocks[${index}].terrain_or_mode must be non-empty`);
    }
    if (!isStringArray(block.execution_cues, { nonEmpty: true })) {
      throw new Error(`${label}: run_prescription.blocks[${index}].execution_cues must be non-empty string array`);
    }
    if (!isStringArray(block.success_criteria, { nonEmpty: true })) {
      throw new Error(`${label}: run_prescription.blocks[${index}].success_criteria must be non-empty string array`);
    }
    if (!isNonEmptyString(block.failure_adjustment)) {
      throw new Error(`${label}: run_prescription.blocks[${index}].failure_adjustment must be non-empty`);
    }
  }

  const impactManagement = prescription.impact_management;
  if (!impactManagement || typeof impactManagement !== "object") {
    throw new Error(`${label}: run_prescription.impact_management must be an object`);
  }

  requireKeys(impactManagement, ["surface", "cadence_cue", "stride_cue"], `${label}.run_prescription.impact_management`);
  if (!isNonEmptyString(impactManagement.surface)) {
    throw new Error(`${label}: run_prescription.impact_management.surface must be non-empty`);
  }
  if (!isNonEmptyString(impactManagement.cadence_cue)) {
    throw new Error(`${label}: run_prescription.impact_management.cadence_cue must be non-empty`);
  }
  if (!isNonEmptyString(impactManagement.stride_cue)) {
    throw new Error(`${label}: run_prescription.impact_management.stride_cue must be non-empty`);
  }

  if (!isStringArray(prescription.success_criteria, { nonEmpty: true })) {
    throw new Error(`${label}: run_prescription.success_criteria must be non-empty string array`);
  }
  if (!isNonEmptyString(prescription.failure_adjustment)) {
    throw new Error(`${label}: run_prescription.failure_adjustment must be non-empty`);
  }
}

function validateSwimPrescription(session) {
  if (String(session?.discipline || "").toLowerCase() !== "swim") return;
  const label = session?.id || "unknown-id";
  const prescription = session?.swim_prescription;
  if (!prescription || typeof prescription !== "object") {
    throw new Error(`${label}: swim sessions must include swim_prescription object`);
  }

  requireKeys(
    prescription,
    ["session_objective", "target_system", "blocks", "technique_focus", "success_criteria", "failure_adjustment"],
    `${label}.swim_prescription`
  );

  if (!isNonEmptyString(prescription.session_objective)) {
    throw new Error(`${label}: swim_prescription.session_objective must be non-empty`);
  }

  const targetSystem = String(prescription.target_system || "").toLowerCase();
  if (!ALLOWED_TARGET_SYSTEMS.includes(targetSystem)) {
    throw new Error(`${label}: swim_prescription.target_system must be one of ${ALLOWED_TARGET_SYSTEMS.join(", ")}`);
  }

  if (!Array.isArray(prescription.blocks) || !prescription.blocks.length) {
    throw new Error(`${label}: swim_prescription.blocks must be a non-empty array`);
  }

  for (const [index, block] of prescription.blocks.entries()) {
    if (!block || typeof block !== "object") {
      throw new Error(`${label}: swim_prescription.blocks[${index}] must be an object`);
    }

    requireKeys(
      block,
      [
        "block_label",
        "distance_m",
        "repetitions",
        "rest_sec",
        "sendoff",
        "target_rpe",
        "execution_cues",
        "success_criteria",
        "failure_adjustment",
      ],
      `${label}.swim_prescription.blocks[${index}]`
    );

    if (!isNonEmptyString(block.block_label)) {
      throw new Error(`${label}: swim_prescription.blocks[${index}].block_label must be non-empty`);
    }
    if (!isPositiveInteger(block.distance_m)) {
      throw new Error(`${label}: swim_prescription.blocks[${index}].distance_m must be positive integer`);
    }
    if (!isPositiveInteger(block.repetitions)) {
      throw new Error(`${label}: swim_prescription.blocks[${index}].repetitions must be positive integer`);
    }
    if (!isNonNegativeInteger(block.rest_sec)) {
      throw new Error(`${label}: swim_prescription.blocks[${index}].rest_sec must be non-negative integer`);
    }
    if (!isNonEmptyString(block.sendoff)) {
      throw new Error(`${label}: swim_prescription.blocks[${index}].sendoff must be non-empty`);
    }
    if (!isNonEmptyString(String(block.target_rpe))) {
      throw new Error(`${label}: swim_prescription.blocks[${index}].target_rpe must be non-empty`);
    }
    if (!isStringArray(block.execution_cues, { nonEmpty: true })) {
      throw new Error(`${label}: swim_prescription.blocks[${index}].execution_cues must be non-empty string array`);
    }
    if (!isStringArray(block.success_criteria, { nonEmpty: true })) {
      throw new Error(`${label}: swim_prescription.blocks[${index}].success_criteria must be non-empty string array`);
    }
    if (!isNonEmptyString(block.failure_adjustment)) {
      throw new Error(`${label}: swim_prescription.blocks[${index}].failure_adjustment must be non-empty`);
    }
  }

  if (!isStringArray(prescription.technique_focus, { nonEmpty: true })) {
    throw new Error(`${label}: swim_prescription.technique_focus must be non-empty string array`);
  }
  if (!isStringArray(prescription.success_criteria, { nonEmpty: true })) {
    throw new Error(`${label}: swim_prescription.success_criteria must be non-empty string array`);
  }
  if (!isNonEmptyString(prescription.failure_adjustment)) {
    throw new Error(`${label}: swim_prescription.failure_adjustment must be non-empty`);
  }
}

function validateStrengthPrescription(session) {
  if (String(session?.discipline || "").toLowerCase() !== "strength") return;
  const label = session?.id || "unknown-id";
  const prescription = session?.strength_prescription;
  if (!prescription || typeof prescription !== "object") {
    throw new Error(`${label}: strength sessions must include strength_prescription object`);
  }

  requireKeys(
    prescription,
    ["phase_mode", "progression_decision", "progression_comparison", "exercises"],
    `${label}.strength_prescription`
  );

  const phaseMode = String(prescription.phase_mode || "").toLowerCase();
  if (!ALLOWED_PHASE_MODES.includes(phaseMode)) {
    throw new Error(`${label}: strength_prescription.phase_mode must be one of ${ALLOWED_PHASE_MODES.join(", ")}`);
  }

  if (!isNonEmptyString(prescription.progression_decision)) {
    throw new Error(`${label}: strength_prescription.progression_decision must be a non-empty string`);
  }

  const progressionComparison = String(prescription.progression_comparison || "").toLowerCase();
  if (!ALLOWED_PROGRESSION_COMPARISONS.includes(progressionComparison)) {
    throw new Error(
      `${label}: strength_prescription.progression_comparison must be one of ${ALLOWED_PROGRESSION_COMPARISONS.join(", ")}`
    );
  }

  if (!Array.isArray(prescription.exercises) || !prescription.exercises.length) {
    throw new Error(`${label}: strength_prescription.exercises must be a non-empty array`);
  }

  for (const [index, exercise] of prescription.exercises.entries()) {
    if (!exercise || typeof exercise !== "object") {
      throw new Error(`${label}: strength_prescription.exercises[${index}] must be an object`);
    }

    requireKeys(
      exercise,
      [
        "exercise_name",
        "category",
        "injury_target",
        "sport_transfer_target",
        "sets",
        "reps",
        "tempo",
        "rest_sec",
        "load",
      ],
      `${label}.strength_prescription.exercises[${index}]`
    );

    if (!isNonEmptyString(exercise.exercise_name)) {
      throw new Error(`${label}: exercises[${index}].exercise_name must be a non-empty string`);
    }

    const category = String(exercise.category || "").toLowerCase();
    if (!ALLOWED_STRENGTH_CATEGORIES.includes(category)) {
      throw new Error(`${label}: exercises[${index}].category must be one of ${ALLOWED_STRENGTH_CATEGORIES.join(", ")}`);
    }

    if (!isNonEmptyString(exercise.injury_target)) {
      throw new Error(`${label}: exercises[${index}].injury_target must be a non-empty string`);
    }

    if (!isNonEmptyString(exercise.sport_transfer_target)) {
      throw new Error(`${label}: exercises[${index}].sport_transfer_target must be a non-empty string`);
    }

    if (!isPositiveInteger(exercise.sets)) {
      throw new Error(`${label}: exercises[${index}].sets must be a positive integer`);
    }

    if (!isValidRepSpec(exercise.reps)) {
      throw new Error(`${label}: exercises[${index}].reps must be a positive integer or rep-range string`);
    }

    if (!isNonEmptyString(exercise.tempo)) {
      throw new Error(`${label}: exercises[${index}].tempo must be a non-empty string`);
    }

    if (!isPositiveInteger(exercise.rest_sec)) {
      throw new Error(`${label}: exercises[${index}].rest_sec must be a positive integer`);
    }

    const load = exercise.load;
    if (!load || typeof load !== "object") {
      throw new Error(`${label}: exercises[${index}].load must be an object`);
    }

    requireKeys(
      load,
      ["method", "target_rpe", "target_rir", "progression_axis", "regression_rule"],
      `${label}.strength_prescription.exercises[${index}].load`
    );

    if (String(load.method || "").toLowerCase() !== "rpe_rir") {
      throw new Error(`${label}: exercises[${index}].load.method must be rpe_rir`);
    }

    if (!Number.isFinite(Number(load.target_rpe))) {
      throw new Error(`${label}: exercises[${index}].load.target_rpe must be numeric`);
    }

    if (!Number.isFinite(Number(load.target_rir))) {
      throw new Error(`${label}: exercises[${index}].load.target_rir must be numeric`);
    }

    const progressionAxis = String(load.progression_axis || "").toLowerCase();
    if (!ALLOWED_STRENGTH_AXES.includes(progressionAxis)) {
      throw new Error(`${label}: exercises[${index}].load.progression_axis must be one of ${ALLOWED_STRENGTH_AXES.join(", ")}`);
    }

    if (!isNonEmptyString(load.regression_rule)) {
      throw new Error(`${label}: exercises[${index}].load.regression_rule must be a non-empty string`);
    }
  }
}

function isSchedulableNonRestSession(session) {
  if (!session || typeof session !== "object") return false;
  const discipline = String(session.discipline || "").toLowerCase();
  if (!discipline || discipline === "rest") return false;
  const duration = Number(session.duration_min || 0);
  return Number.isFinite(duration) && duration > 0;
}

function validateNutritionPrescription(session) {
  if (!isSchedulableNonRestSession(session)) return;

  const label = session?.id || "unknown-id";
  const prescription = session?.nutrition_prescription;
  if (!prescription || typeof prescription !== "object") {
    throw new Error(`${label}: non-rest schedulable sessions must include nutrition_prescription object`);
  }

  requireKeys(
    prescription,
    [
      "pre_session",
      "during_session",
      "post_session",
      "daily_recovery_target",
      "session_specific_adjustment",
      "compliance_markers",
    ],
    `${label}.nutrition_prescription`
  );

  if (!isNonEmptyString(prescription.pre_session)) {
    throw new Error(`${label}: nutrition_prescription.pre_session must be non-empty`);
  }
  if (!isNonEmptyString(prescription.during_session)) {
    throw new Error(`${label}: nutrition_prescription.during_session must be non-empty`);
  }
  if (!isNonEmptyString(prescription.post_session)) {
    throw new Error(`${label}: nutrition_prescription.post_session must be non-empty`);
  }
  if (!isNonEmptyString(prescription.daily_recovery_target)) {
    throw new Error(`${label}: nutrition_prescription.daily_recovery_target must be non-empty`);
  }
  if (!isNonEmptyString(prescription.session_specific_adjustment)) {
    throw new Error(`${label}: nutrition_prescription.session_specific_adjustment must be non-empty`);
  }
  if (!isStringArray(prescription.compliance_markers, { nonEmpty: true })) {
    throw new Error(`${label}: nutrition_prescription.compliance_markers must be a non-empty string array`);
  }
}

function validateNeedsUserInputShape(plan) {
  const entries = plan?.needs_user_input;
  if (entries == null) return;
  if (!Array.isArray(entries)) {
    throw new Error("plan.needs_user_input must be an array when present");
  }

  for (const [index, item] of entries.entries()) {
    if (!item || typeof item !== "object") {
      throw new Error(`plan.needs_user_input[${index}] must be an object`);
    }
    requireKeys(item, ["question", "reason", "options"], `plan.needs_user_input[${index}]`);
    if (!isNonEmptyString(item.question)) {
      throw new Error(`plan.needs_user_input[${index}].question must be non-empty`);
    }
    if (!isNonEmptyString(item.reason)) {
      throw new Error(`plan.needs_user_input[${index}].reason must be non-empty`);
    }
    if (!isStringArray(item.options, { nonEmpty: true }) || item.options.length < 2) {
      throw new Error(`plan.needs_user_input[${index}].options must be a string array with at least 2 options`);
    }
  }
}

function validatePlan(data) {
  requireKeys(data, ["week_start", "time_budget_hours", "sessions"], "plan");
  if (!Array.isArray(data.sessions) || !data.sessions.length) {
    throw new Error("plan sessions must be a non-empty array");
  }

  validateNeedsUserInputShape(data);

  for (const session of data.sessions) {
    requireKeys(session, ["id", "date", "discipline", "type", "duration_min", "intent", "success_criteria"], "session");
    validateProgressionTrace(session);
    validateBikePrescription(session);
    validateRunPrescription(session);
    validateSwimPrescription(session);
    validateStrengthPrescription(session);
    validateNutritionPrescription(session);
  }
}

function containsPowerToken(text) {
  return POWER_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

function sessionTextFields(session) {
  const values = [];
  const simpleFields = ["title", "intent", "coach_notes", "fueling", "notes", "description", "summary"];
  for (const key of simpleFields) {
    if (typeof session[key] === "string") values.push(session[key]);
  }

  const arrayFields = ["success_criteria", "warmup", "main_set", "cooldown", "fallbacks", "rpe_targets"];
  for (const key of arrayFields) {
    if (Array.isArray(session[key])) {
      for (const item of session[key]) {
        if (typeof item === "string") values.push(item);
      }
    }
  }

  const intensity = session.intensity_prescription;
  if (intensity && typeof intensity === "object") {
    for (const value of Object.values(intensity)) {
      if (typeof value === "string") values.push(value);
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") values.push(item);
        }
      }
    }
  }

  return values;
}

function validatePlanForNoPowerMode(plan, filePath, resolved) {
  if (!resolved?.no_power_mode) return;
  const violations = [];

  for (const session of plan.sessions || []) {
    if (String(session?.discipline || "").toLowerCase() !== "bike") continue;
    const sessionLabel = `${session.id || "unknown-id"} (${session.date || "unknown-date"})`;
    const intensity = session.intensity_prescription || {};

    if (hasValue(intensity.power_w_range)) {
      violations.push(`${sessionLabel}: intensity_prescription.power_w_range not allowed in no_power_mode`);
    }
    if (hasValue(intensity.if_range)) {
      violations.push(`${sessionLabel}: intensity_prescription.if_range not allowed in no_power_mode`);
    }

    const textWithPowerToken = sessionTextFields(session).find((text) => containsPowerToken(text));
    if (textWithPowerToken) {
      violations.push(`${sessionLabel}: detected power token text while no_power_mode=true`);
    }

    const hasHrTarget = hasValue(intensity.hr_zone_range) || hasValue(intensity.hr_bpm_range);
    const hasRpeTarget = hasValue(intensity.rpe_range);

    if (resolved.hr_available && !hasHrTarget) {
      violations.push(`${sessionLabel}: HR target required (hr_zone_range or hr_bpm_range)`);
    }
    if (!resolved.hr_available && !hasRpeTarget) {
      violations.push(`${sessionLabel}: RPE target required (rpe_range) when HR is unavailable`);
    }
    if (!hasRpeTarget) {
      violations.push(`${sessionLabel}: RPE fallback required (rpe_range)`);
    }
  }

  if (violations.length) {
    throw new Error(
      `Bike intensity guardrail failed for ${path.basename(filePath)}.\n${violations
        .map((item) => `- ${item}`)
        .join("\n")}\nRemediation: remove FTP/IF/watts targets and provide HR/RPE targets according to resolved bike capabilities.`
    );
  }
}

function validateCheckin(data) {
  requireKeys(data, ["date", "sleep", "soreness", "stress", "motivation", "pain", "constraints", "notes"], "checkin");
}

function main() {
  const input = readStdinJson();
  const filePath = findFilePath(input);
  if (!filePath || !isCoachJson(filePath)) return;

  const base = path.basename(filePath);
  const data = readJson(filePath);

  if (base === "strava_snapshot.json") return validateSnapshot(data);
  if (base === "profile.json") return validateProfile(data);
  if (base === "goals.json") return validateGoals(data);
  if (base === "baseline.json") return validateBaseline(data);
  if (base === "baseline_raw.json") return validateBaseline(data);
  if (base === "strategy.json") return validateStrategy(data);
  if (filePath.includes(`${path.sep}checkins${path.sep}`)) return validateCheckin(data);
  if (filePath.includes(`${path.sep}plans${path.sep}`)) {
    validatePlan(data);
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const profilePath = path.join(projectDir, "data", "coach", "profile.json");
    const profile = fs.existsSync(profilePath) ? readJson(profilePath) : null;
    const resolved = profile?.preferences?.bike_capabilities?.resolved || null;
    validatePlanForNoPowerMode(data, filePath, resolved);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exit(2);
  }
}
