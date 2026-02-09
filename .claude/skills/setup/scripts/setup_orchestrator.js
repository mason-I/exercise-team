#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { weekStart, toIsoDate, parseDate } = require("../../_shared/lib");
const {
  resolveProjectDir,
  startSession,
  setStage,
  mutateState,
  recordError,
  markCompleted,
} = require("../../_shared/onboarding_state");
const { generateOnboardingQuestions } = require("../../_shared/onboarding_question_engine");
const { loadCredentialState: loadGoogleCredentialState } = require("../../_shared/google_calendar_auth_flow");
const { hydrateSessionEnv } = require("../../_shared/session_env");
const { PATHS, resolveProjectPath } = require("../../_shared/paths");

const CALENDAR_SYNC_MODES = new Set(["confirm_apply", "apply_immediately", "preview_only"]);
const CALENDAR_ACTIONS = new Set(["auto", "connect", "skip"]);
const CONFIRM_VALUES = new Set(["auto", "yes", "no"]);

function safeReadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function parseAnswerToken(token) {
  const raw = String(token || "");
  const idx = raw.indexOf("=");
  if (idx <= 0) {
    throw new Error(`Invalid --answer '${raw}'. Use --answer <question_id>=<value>.`);
  }
  const id = raw.slice(0, idx).trim();
  const value = raw.slice(idx + 1);
  if (!id) throw new Error(`Invalid --answer '${raw}'. Missing question_id.`);
  return { id, value };
}

function normalizeYesNo(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return null;
  if (v === "yes" || v.startsWith("yes,")) return "yes";
  if (v === "no" || v.startsWith("no,")) return "no";
  if (v.includes("apply now")) return "yes";
  if (v.includes("keep preview")) return "no";
  return null;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    projectDir: resolveProjectDir(),
    statePath: null,
    resume: false,
    autoOpenBrowser: true,
    calendarGate: "required_skippable",
    calendarAction: "auto",
    calendarSync: "confirm_apply",
    calendarSyncConfirm: "auto",
    calendarId: "primary",
    activitiesMode: "all",
    windowDays: 56,
    weekStart: null,
    skipPlanGeneration: false,
    dryRun: false,
    reportOnly: false,
    answers: {},
  };

  const unknown = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!String(arg || "").startsWith("--")) continue;

    switch (arg) {
      case "--project-dir":
        options.projectDir = path.resolve(argv[i + 1] || options.projectDir);
        i += 1;
        break;
      case "--state-path":
        options.statePath = String(argv[i + 1] || "").trim() || null;
        i += 1;
        break;
      case "--resume":
        options.resume = true;
        break;
      case "--auto-open-browser":
        options.autoOpenBrowser = true;
        break;
      case "--no-auto-open-browser":
        options.autoOpenBrowser = false;
        break;
      case "--calendar-gate":
        options.calendarGate = String(argv[i + 1] || options.calendarGate);
        i += 1;
        break;
      case "--calendar-action":
        options.calendarAction = String(argv[i + 1] || options.calendarAction);
        i += 1;
        break;
      case "--calendar-sync":
        options.calendarSync = String(argv[i + 1] || options.calendarSync);
        i += 1;
        break;
      case "--calendar-sync-confirm":
        options.calendarSyncConfirm = String(argv[i + 1] || options.calendarSyncConfirm);
        i += 1;
        break;
      case "--calendar-id":
        options.calendarId = String(argv[i + 1] || options.calendarId);
        i += 1;
        break;
      case "--activities-mode":
        options.activitiesMode = String(argv[i + 1] || options.activitiesMode);
        i += 1;
        break;
      case "--window-days":
        options.windowDays = Number(argv[i + 1] || options.windowDays);
        i += 1;
        break;
      case "--week-start":
        options.weekStart = String(argv[i + 1] || "").trim();
        i += 1;
        break;
      case "--skip-plan-generation":
        options.skipPlanGeneration = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--report-only":
        options.reportOnly = true;
        break;
      case "--answer": {
        const { id, value } = parseAnswerToken(argv[i + 1]);
        options.answers[id] = value;
        i += 1;

        // Convenience: allow answering the calendar confirmation prompt via the same --answer mechanism.
        if (id === "calendar_sync_confirmation") {
          const yn = normalizeYesNo(value);
          if (yn) options.calendarSyncConfirm = yn;
        }
        break;
      }
      case "--answers-json": {
        const rel = String(argv[i + 1] || "").trim();
        if (!rel) throw new Error("Missing value for --answers-json <path>.");
        const answersPath = path.resolve(options.projectDir, rel);
        const payload = safeReadJson(answersPath, null);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw new Error(`Invalid --answers-json payload at ${answersPath}. Expected a JSON object.`);
        }
        for (const [id, value] of Object.entries(payload)) {
          options.answers[String(id)] = value;
          if (String(id) === "calendar_sync_confirmation") {
            const yn = normalizeYesNo(value);
            if (yn) options.calendarSyncConfirm = yn;
          }
        }
        i += 1;
        break;
      }
      default: {
        // Common mistake: passing imaginary --answers-* flags. Error loudly with the correct mechanism.
        if (String(arg).startsWith("--answers-")) {
          throw new Error(
            `Unknown flag '${arg}'. This orchestrator does not support --answers-*. Use repeated --answer <id>=<value> instead.`
          );
        }
        unknown.push(arg);
        break;
      }
    }
  }

  if (unknown.length) {
    throw new Error(`Unknown flag(s): ${unknown.join(", ")}.`);
  }

  options.calendarAction = String(options.calendarAction || "auto").trim().toLowerCase();
  options.calendarSync = String(options.calendarSync || "confirm_apply").trim().toLowerCase();
  options.calendarSyncConfirm = String(options.calendarSyncConfirm || "auto").trim().toLowerCase();

  if (!CALENDAR_ACTIONS.has(options.calendarAction)) {
    throw new Error(`Invalid --calendar-action '${options.calendarAction}'. Use auto|connect|skip.`);
  }
  if (!CALENDAR_SYNC_MODES.has(options.calendarSync)) {
    throw new Error(
      `Invalid --calendar-sync '${options.calendarSync}'. Use confirm_apply|apply_immediately|preview_only.`
    );
  }
  if (!CONFIRM_VALUES.has(options.calendarSyncConfirm)) {
    throw new Error(`Invalid --calendar-sync-confirm '${options.calendarSyncConfirm}'. Use auto|yes|no.`);
  }
  if (![
    "required_skippable",
    "required",
    "optional",
  ].includes(String(options.calendarGate || "required_skippable").trim().toLowerCase())) {
    throw new Error(`Invalid --calendar-gate '${options.calendarGate}'. Use required_skippable|required|optional.`);
  }

  return options;
}

function applyAnswersToArtifacts(projectDir, answers) {
  if (!answers || typeof answers !== "object") return { applied: false, updated: [] };

  const updated = new Set();
  const goalsPath = resolveProjectPath(projectDir, PATHS.coach.goals);
  const profilePath = resolveProjectPath(projectDir, PATHS.coach.profile);
  const goals = safeReadJson(goalsPath, {});
  const profile = safeReadJson(profilePath, {});

  // Intake: primary_goal
  if (answers.primary_goal != null) {
    const raw = String(answers.primary_goal);
    const urlMatch = raw.match(/https?:\/\/\S+/);
    const url = urlMatch ? urlMatch[0] : null;
    const date = parseDate(raw);
    const dateIso = date ? toIsoDate(date) : null;

    // Best-effort name extraction from free-form input.
    let name = raw;
    if (url) name = name.replace(url, " ").trim();
    if (dateIso) name = name.replace(dateIso, " ").trim();
    name = name.replace(/\s{2,}/g, " ").replace(/^[-|:,]+\s*/, "").trim();
    if (!name) name = "Primary Event";

    goals.primary_goal = {
      ...(goals.primary_goal || {}),
      name,
      date: dateIso || (goals.primary_goal ? goals.primary_goal.date : null) || "",
      disciplines: Array.isArray(goals.primary_goal?.disciplines) && goals.primary_goal.disciplines.length
        ? goals.primary_goal.disciplines
        : ["swim", "bike", "run"],
      url: url || goals.primary_goal?.url || null,
      raw_input: raw,
    };
    updated.add(PATHS.coach.goals);
  }

  // Intake: injury_history
  if (answers.injury_history != null) {
    const raw = String(answers.injury_history);
    const normalized = raw.trim().toLowerCase();
    profile.health = profile.health && typeof profile.health === "object" ? profile.health : {};

    if (normalized === "no known issues" || normalized === "no") {
      profile.health.injury_context_status = "none_reported";
      profile.health.current_niggles = [];
      profile.health.injury_history_12mo = [];
    } else {
      profile.health.injury_context_status = "provided";
      profile.health.current_niggles = Array.isArray(profile.health.current_niggles)
        ? profile.health.current_niggles
        : [];
      // Store the raw response (even if it is just the option text) so onboarding can proceed deterministically.
      profile.health.current_niggles.push({
        area: "unspecified",
        description: raw,
        severity: "unspecified",
        impact: "unspecified",
        as_of_date: toIsoDate(new Date()),
      });
    }
    updated.add(PATHS.coach.profile);
  }

  if (updated.has(PATHS.coach.goals)) writeJson(goalsPath, goals);
  if (updated.has(PATHS.coach.profile)) writeJson(profilePath, profile);

  return { applied: updated.size > 0, updated: [...updated] };
}

function addQuestionHints(question) {
  const id = String(question && question.id ? question.id : "");
  const hintById = {
    primary_goal: {
      source_of_truth: String(PATHS.coach.goals),
      edit: "data/coach/goals.json: primary_goal { name, date }",
      cli: "--answer primary_goal='Ironman Australia 2027-10-18'",
    },
    injury_history: {
      source_of_truth: String(PATHS.coach.profile),
      edit: "data/coach/profile.json: health { injury_context_status, current_niggles, injury_history_12mo }",
      cli: "--answer injury_history='No known issues' (or a description)",
    },
    time_budget: {
      source_of_truth: String(PATHS.coach.profile),
      edit: "data/coach/profile.json: preferences.time_budget_hours { min, typical, max }",
      cli: "--answer time_budget='min=.. typical=.. max=..' (manual edit recommended)",
    },
    rest_day: {
      source_of_truth: String(PATHS.coach.profile),
      edit: "data/coach/profile.json: preferences.rest_day",
      cli: "--answer rest_day='Monday' (manual edit recommended)",
    },
    strength_preferences: {
      source_of_truth: String(PATHS.coach.profile),
      edit: "data/coach/profile.json: preferences.strength { enabled, sessions_per_week }",
      cli: "--answer strength_preferences='Include strength' (manual edit recommended)",
    },
    session_preferences: {
      source_of_truth: String(PATHS.coach.profile),
      edit: "data/coach/profile.json: preferences.session_type_preferences",
      cli: "--answer session_preferences='No extra constraints' (manual edit recommended)",
    },
    swim_access: {
      source_of_truth: String(PATHS.coach.profile),
      edit: "data/coach/profile.json: (add) preferences.swim_access",
      cli: "--answer swim_access='Yes, access is available' (manual edit recommended)",
    },
  };

  const hint = hintById[id];
  if (!hint) return question;
  return { ...question, how_to_satisfy: hint };
}

function runBunScript(projectDir, relScriptPath, args = [], options = {}) {
  const scriptPath = path.join(projectDir, relScriptPath);
  const expectJson = options.expectJson !== false;
  const inheritStdout = options.inheritStdout === true;
  const cmd = [process.execPath, scriptPath, ...args];

  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    encoding: "utf-8",
    stdio: inheritStdout ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
  });

  if (!inheritStdout) {
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.stdout) process.stdout.write(options.echoStdout ? result.stdout : "");
  }

  if (result.status !== 0) {
    const error = new Error(
      `Script failed (${result.status}): ${relScriptPath}${result.stderr ? `\n${result.stderr.trim()}` : ""}`
    );
    error.status = result.status;
    error.script = relScriptPath;
    error.stderr = result.stderr || "";
    error.stdout = result.stdout || "";
    throw error;
  }

  if (!expectJson || inheritStdout) {
    return { ok: true, stdout: result.stdout || "" };
  }

  const raw = String(result.stdout || "").trim();
  if (!raw) return { ok: true };
  try {
    return JSON.parse(raw);
  } catch {
    const lines = raw.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const candidate = lines.slice(i).join("\n").trim();
      if (!candidate.startsWith("{")) continue;
      try {
        return JSON.parse(candidate);
      } catch {
        // continue
      }
    }
    throw new Error(`Expected JSON output from ${relScriptPath} but could not parse stdout.`);
  }
}

function countScheduled(result) {
  if (!result) return 0;
  return Array.isArray(result.scheduled) ? result.scheduled.length : 0;
}

function countConflicts(result) {
  if (!result) return 0;
  return Array.isArray(result.conflicts) ? result.conflicts.length : 0;
}

function resolveWeekStartOption(options) {
  if (options.weekStart) {
    const parsed = parseDate(options.weekStart);
    if (!parsed) {
      throw new Error(`Invalid --week-start '${options.weekStart}'. Use YYYY-MM-DD.`);
    }
    return toIsoDate(parsed);
  }
  const envWeek = parseDate(process.env.COACH_WEEK_START || "");
  if (envWeek) return toIsoDate(envWeek);
  return toIsoDate(weekStart(new Date()));
}

function planPathForWeek(projectDir, weekStartIso) {
  return path.join(resolveProjectPath(projectDir, PATHS.coach.plansDir), `${weekStartIso}.json`);
}

function collectQuestionInputs(projectDir) {
  return {
    profile: safeReadJson(resolveProjectPath(projectDir, PATHS.coach.profile), null),
    goals: safeReadJson(resolveProjectPath(projectDir, PATHS.coach.goals), null),
    snapshot: safeReadJson(resolveProjectPath(projectDir, PATHS.coach.snapshot), null),
    inferredSchedule: safeReadJson(resolveProjectPath(projectDir, PATHS.system.stravaInferredSchedule), null),
  };
}

function requiredBootstrapArtifacts(projectDir) {
  return [
    resolveProjectPath(projectDir, PATHS.system.installBootstrapState),
    resolveProjectPath(projectDir, PATHS.system.userEnv),
    resolveProjectPath(projectDir, PATHS.external.stravaActivities),
    resolveProjectPath(projectDir, PATHS.system.stravaAthlete),
    resolveProjectPath(projectDir, PATHS.system.stravaStats),
    resolveProjectPath(projectDir, PATHS.coach.snapshot),
    resolveProjectPath(projectDir, PATHS.coach.profile),
    resolveProjectPath(projectDir, PATHS.coach.goals),
    resolveProjectPath(projectDir, PATHS.coach.baseline),
    resolveProjectPath(projectDir, PATHS.coach.strategy),
  ];
}

function evaluateBootstrap(projectDir) {
  const bootstrapPath = resolveProjectPath(projectDir, PATHS.system.installBootstrapState);
  const bootstrap = safeReadJson(bootstrapPath, null);
  const requiredArtifacts = requiredBootstrapArtifacts(projectDir);
  const missingArtifacts = requiredArtifacts.filter((filePath) => !fs.existsSync(filePath));
  const completed = Boolean(bootstrap && bootstrap.ok === true && bootstrap.status === "completed");

  return {
    bootstrapPath,
    bootstrap,
    completed,
    requiredArtifacts,
    missingArtifacts,
    ready: completed && missingArtifacts.length === 0,
  };
}

function buildBootstrapPrompt(projectDir, validation) {
  const missing = validation.missingArtifacts.map((item) => path.relative(projectDir, item));
  const reasonParts = [];
  if (!validation.completed) reasonParts.push("bootstrap_state is missing or not completed");
  if (missing.length) reasonParts.push(`missing artifacts: ${missing.join(", ")}`);

  return {
    id: "install_bootstrap_required",
    question:
      "Install-time deterministic bootstrap is required before /setup can continue. Run install bootstrap first, then run /setup again.",
    reason: reasonParts.join("; ") || "bootstrap is incomplete",
    instructions: [
      "From the project root, run: bash install.sh",
      "If install launch is skipped, run: claude \"/setup\" after bootstrap completes",
    ],
    expected_state_path: validation.bootstrapPath,
    options: ["Run install bootstrap now", "Stop for now"],
  };
}

async function main() {
  const options = parseArgs();
  const projectDir = options.projectDir;

  const session = startSession({
    projectDir,
    statePath: options.statePath,
    resume: options.resume,
  });

  const statePath = session.statePath;

  const output = {
    ok: true,
    status: "running",
    stage: "bootstrap_check",
    state_path: statePath,
    summary: {},
    needs_user_input: [],
  };

  try {
    const moveToStage = (stage, extra = {}) => {
      output.stage = stage;
      setStage(statePath, stage, extra);
    };

    moveToStage("bootstrap_check", { status: "running" });
    const bootstrapValidation = evaluateBootstrap(projectDir);

    mutateState(statePath, (state) => ({
      ...state,
      artifacts: {
        status: bootstrapValidation.ready ? "ready" : "incomplete",
        files: bootstrapValidation.requiredArtifacts.map((item) => path.relative(projectDir, item)),
      },
      strava: {
        ...(state.strava || {}),
        status: bootstrapValidation.ready ? "connected" : "pending",
        method: bootstrapValidation.bootstrap?.strava_auth?.method || null,
        last_error: null,
      },
      google_calendar: {
        ...(state.google_calendar || {}),
        status: bootstrapValidation.bootstrap?.google_auth?.ok ? "connected" : "pending",
        method: bootstrapValidation.bootstrap?.google_auth?.method || null,
        last_error: null,
      },
    }));

    if (!bootstrapValidation.ready) {
      output.status = "needs_user_input";
      output.stage = "bootstrap_check";
      output.summary = {
        message: "Install bootstrap is incomplete. Run install bootstrap before continuing /setup.",
        bootstrap_state_path: bootstrapValidation.bootstrapPath,
        missing_artifacts: bootstrapValidation.missingArtifacts.map((item) => path.relative(projectDir, item)),
      };
      output.needs_user_input = [buildBootstrapPrompt(projectDir, bootstrapValidation)];
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return;
    }

    if (options.dryRun) {
      output.status = "dry_run";
      output.stage = "bootstrap_check";
      output.summary = {
        message: "Dry-run complete. Bootstrap is ready. No model-driven setup steps executed.",
        bootstrap_state_path: bootstrapValidation.bootstrapPath,
      };
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return;
    }

    if (options.reportOnly) {
      const questionInputs = collectQuestionInputs(projectDir);
      const questions = generateOnboardingQuestions(questionInputs);
      const gaps = questions.required_questions.map((q) => ({
        id: q.id,
        field: addQuestionHints(q).how_to_satisfy?.edit || q.id,
        reason: q.reason,
      }));
      output.status = "report";
      output.stage = "intake";
      output.summary = {
        message: "Shadow validation report. No state modified.",
        decision_complete: questions.decision_complete,
        missing_required_count: questions.missing_required_count,
        gaps,
      };
      if (questions.optional_questions.length > 0) {
        output.summary.optional_gaps = questions.optional_questions.map((q) => ({
          id: q.id,
          field: addQuestionHints(q).how_to_satisfy?.edit || q.id,
          reason: q.reason,
        }));
      }
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return;
    }

    // Apply any CLI-provided answers into the canonical artifacts before recomputing questions.
    const appliedAnswers = applyAnswersToArtifacts(projectDir, options.answers);
    if (appliedAnswers.applied) {
      mutateState(statePath, (state) => ({
        ...state,
        intake_answers: {
          ...(state.intake_answers || {}),
          applied_at: new Date().toISOString(),
          updated_files: appliedAnswers.updated,
          answers: { ...(state.intake_answers?.answers || {}), ...options.answers },
        },
      }));
    }

    moveToStage("intake");
    const questionInputs = collectQuestionInputs(projectDir);
    const questions = generateOnboardingQuestions(questionInputs);
    mutateState(statePath, (state) => ({
      ...state,
      intake: {
        status: questions.decision_complete ? "complete" : "needs_user_input",
        questions: [...questions.required_questions, ...questions.optional_questions],
        missing_required_count: questions.missing_required_count,
      },
    }));

    if (!questions.decision_complete) {
      output.status = "needs_user_input";
      output.stage = "intake";
      output.summary = {
        message: "Onboarding requires additional athlete inputs before artifacts can be finalized.",
        missing_required_count: questions.missing_required_count,
      };
      output.needs_user_input = questions.required_questions.map(addQuestionHints);
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return;
    }

    let planPath = null;
    if (!options.skipPlanGeneration) {
      moveToStage("week1_plan");
      const weekStartIso = resolveWeekStartOption(options);
      planPath = planPathForWeek(projectDir, weekStartIso);
      const planResult = runBunScript(
        projectDir,
        ".claude/skills/setup/scripts/generate_onboarding_plan.js",
        ["--week-start", weekStartIso, "--calendar-id", options.calendarId, "--out", path.relative(projectDir, planPath), "--overwrite"],
        { expectJson: true, inheritStdout: false }
      );

      mutateState(statePath, (state) => ({
        ...state,
        week1_plan: {
          status: "generated",
          file_path: planResult.plan_path || planPath,
          week_start: planResult.week_start || weekStartIso,
        },
      }));
      planPath = planResult.plan_path || planPath;
    }

    hydrateSessionEnv(projectDir);
    const gcal = loadGoogleCredentialState();
    const calendarConnected = Boolean(gcal.clientId && gcal.clientSecret && gcal.refreshToken);

    mutateState(statePath, (state) => ({
      ...state,
      google_calendar: {
        status: calendarConnected ? "connected" : "not_connected",
        method: calendarConnected ? "bootstrap" : null,
        skipped_reason: calendarConnected ? null : "bootstrap_not_connected",
        last_error: null,
      },
    }));

    if (calendarConnected && planPath) {
      moveToStage("calendar_preview");
      const preview = runBunScript(
        projectDir,
        ".claude/skills/schedule/scripts/sync_plan_to_calendar.js",
        ["--plan", path.relative(projectDir, planPath), "--dry-run", "--calendar-id", options.calendarId],
        { expectJson: true, inheritStdout: false }
      );

      mutateState(statePath, (state) => ({
        ...state,
        calendar_sync: {
          status: "preview_ready",
          mode: options.calendarSync,
          preview,
          applied: null,
        },
      }));

      if (options.calendarSync === "confirm_apply") {
        if (options.calendarSyncConfirm !== "yes") {
          output.status = "needs_user_input";
          output.stage = "calendar_preview";
          output.summary = {
            message: "Calendar sync preview ready. Confirmation required before applying writes.",
            scheduled: countScheduled(preview),
            conflicts: countConflicts(preview),
          };
          output.needs_user_input = [
            {
              id: "calendar_sync_confirmation",
              question: "Apply these calendar changes now?",
              reason: `Preview includes ${countScheduled(preview)} schedulable event action(s) and ${countConflicts(
                preview
              )} conflict(s).`,
              options: ["Yes, apply now", "No, keep preview only"],
            },
          ];
          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
          return;
        }
      }

      if (options.calendarSync === "apply_immediately" || options.calendarSyncConfirm === "yes") {
        moveToStage("calendar_apply");
        const applied = runBunScript(
          projectDir,
          ".claude/skills/schedule/scripts/sync_plan_to_calendar.js",
          ["--plan", path.relative(projectDir, planPath), "--apply", "--calendar-id", options.calendarId],
          { expectJson: true, inheritStdout: false }
        );

        mutateState(statePath, (state) => ({
          ...state,
          calendar_sync: {
            status: "applied",
            mode: options.calendarSync,
            preview,
            applied,
          },
        }));
      }
    }

    moveToStage("done");
    markCompleted(statePath);

    output.status = "completed";
    output.stage = "done";
    output.summary = {
      message: "Model-driven onboarding setup completed.",
      bootstrap_state_path: bootstrapValidation.bootstrapPath,
      strava: "bootstrapped",
      google_calendar: calendarConnected ? "connected" : "not_connected (bootstrap_not_connected)",
      generated_plan: planPath,
      calendar_sync_mode: options.calendarSync,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    recordError(statePath, {
      stage: output.stage,
      code: "SETUP_ORCHESTRATOR_ERROR",
      message: String(error && error.message ? error.message : error),
    });

    output.ok = false;
    output.status = "error";
    output.summary = {
      message: String(error && error.message ? error.message : error),
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    process.exit(1);
  });
}
