function finiteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueById(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || !item.id) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function inferGoalDisciplines(goals) {
  const list = asArray(goals && goals.goals);
  const primary = goals && goals.primary_goal ? goals.primary_goal : list[0] || {};
  return asArray(primary.disciplines)
    .map((x) => String(x || "").trim().toLowerCase())
    .filter(Boolean);
}

function hasTimeBudget(profile) {
  const budget = profile && profile.preferences ? profile.preferences.time_budget_hours : null;
  if (!budget || typeof budget !== "object") return false;
  return ["min", "typical", "max"].every((key) => finiteNumber(budget[key]) != null);
}

function hasStrengthConfig(profile) {
  const strength = profile && profile.preferences ? profile.preferences.strength : null;
  if (!strength || typeof strength !== "object") return false;
  if (typeof strength.enabled !== "boolean") return false;
  if (!finiteNumber(strength.sessions_per_week)) return false;
  return true;
}

function hasInjuryContext(profile) {
  const health = profile && profile.health ? profile.health : null;
  if (!health || typeof health !== "object") return false;
  // "No known issues" is still a completed answer; store it explicitly so onboarding doesn't re-ask forever.
  const status = String(health.injury_context_status || "").trim().toLowerCase();
  if (status === "none_reported" || status === "provided") return true;
  if (asArray(health.current_niggles).length > 0) return true;
  if (asArray(health.injury_history_12mo).length > 0) return true;
  return false;
}

function hasSessionPreferences(profile) {
  const prefs = profile && profile.preferences ? profile.preferences.session_type_preferences : null;
  if (!prefs || typeof prefs !== "object") return false;
  const keys = ["run", "bike", "swim", "strength"];
  return keys.every((key) => {
    const entry = prefs[key];
    return entry && Array.isArray(entry.prefer) && Array.isArray(entry.avoid);
  });
}

function buildQuestion(id, question, reason, options, required = true) {
  return { id, question, reason, options, required };
}

function generateOnboardingQuestions({
  profile = null,
  goals = null,
  snapshot = null,
  inferredSchedule = null,
} = {}) {
  const questions = [];
  const primaryGoal = goals && goals.primary_goal ? goals.primary_goal : null;

  if (!primaryGoal || !hasNonEmptyString(primaryGoal.name) || !hasNonEmptyString(primaryGoal.date)) {
    questions.push(
      buildQuestion(
        "primary_goal",
        "What is your primary target event (name + date + target distance)?",
        "Training phases and progression rules depend on a concrete event target.",
        ["Provide event + date", "I need help choosing a target"],
        true
      )
    );
  }

  if (!hasTimeBudget(profile)) {
    questions.push(
      buildQuestion(
        "time_budget",
        "What is your weekly training time budget (min / typical / max hours)?",
        "Session density and discipline distribution require explicit time constraints.",
        ["Provide min/typical/max", "Use my recent load as baseline"],
        true
      )
    );
  }

  const restDay = profile && profile.preferences ? profile.preferences.rest_day : null;
  if (!hasNonEmptyString(restDay)) {
    questions.push(
      buildQuestion(
        "rest_day",
        "Which day is your preferred rest day?",
        "Rest-day anchoring drives weekly placement and fatigue control.",
        ["Set one fixed rest day", "No fixed rest day"],
        true
      )
    );
  }

  if (!hasInjuryContext(profile)) {
    questions.push(
      buildQuestion(
        "injury_history",
        "Any injury history or current niggles that should constrain progression?",
        "Risk flags are required for safe run and load progression decisions.",
        ["Yes, I have constraints", "No known issues"],
        true
      )
    );
  }

  if (!hasStrengthConfig(profile)) {
    questions.push(
      buildQuestion(
        "strength_preferences",
        "Do you want strength training included, and if yes how many sessions per week?",
        "Strength enablement changes weekly session count and load allocation.",
        ["Include strength", "No strength for now"],
        true
      )
    );
  }

  if (!hasSessionPreferences(profile)) {
    questions.push(
      buildQuestion(
        "session_preferences",
        "Any session-type preferences or hard scheduling constraints (days/times to avoid)?",
        "Placement quality improves when discipline-specific preferences are explicit.",
        ["No extra constraints", "I have specific constraints"],
        true
      )
    );
  }

  const disciplines = inferGoalDisciplines(goals);
  const swimIsGoalDiscipline = disciplines.includes("swim");
  const swimRecent =
    snapshot && snapshot.activities_summary && snapshot.activities_summary.by_discipline
      ? snapshot.activities_summary.by_discipline.swim
      : null;
  const swimRecentSessions = finiteNumber(swimRecent && swimRecent.sessions_28d);

  if (swimIsGoalDiscipline && (swimRecentSessions == null || swimRecentSessions === 0)) {
    questions.push(
      buildQuestion(
        "swim_access",
        "Do you currently have reliable pool/open-water access and preferred swim days?",
        "Swim is a goal discipline but recent swim activity is low or absent.",
        ["Yes, access is available", "No, access is limited"],
        false
      )
    );
  }

  const anchors =
    inferredSchedule && inferredSchedule.habit_anchors && inferredSchedule.habit_anchors.by_discipline
      ? inferredSchedule.habit_anchors.by_discipline
      : [];

  if (!Array.isArray(anchors) || anchors.length === 0) {
    questions.push(
      buildQuestion(
        "habit_anchors",
        "What are your normal training windows (weekday/weekend and preferred times)?",
        "No strong historical habit anchors were inferred from recent activity.",
        ["Use simple early-morning defaults", "I will provide preferred windows"],
        false
      )
    );
  }

  const unique = uniqueById(questions);
  const required = unique.filter((item) => item.required);
  return {
    required_questions: required,
    optional_questions: unique.filter((item) => !item.required),
    missing_required_count: required.length,
    decision_complete: required.length === 0,
  };
}

module.exports = {
  generateOnboardingQuestions,
};
