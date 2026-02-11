#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");
const {
  listEvents,
  createTrainingEvent,
  updateTrainingEvent,
  deleteTrainingEvent,
} = require("../../_shared/google_calendar_api");

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next == null || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }

  return flags;
}

function requireFlag(flags, key) {
  const value = flags[key];
  if (value == null || value === true || String(value).trim() === "") {
    throw new Error(`Missing required --${key}`);
  }
  return String(value);
}

function parseDateOnly(isoDate) {
  if (!isoDate) return null;
  const m = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function toDayStartUtc(isoDate) {
  const d = parseDateOnly(isoDate);
  if (!d) return null;
  return new Date(Date.UTC(d.year, d.month - 1, d.day, 0, 0, 0));
}

function addDaysIso(isoDate, days) {
  const start = toDayStartUtc(isoDate);
  if (!start) return null;
  start.setUTCDate(start.getUTCDate() + days);
  return start.toISOString().slice(0, 10);
}

function parseDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function parseCalendarEventRange(event) {
  const startValue = event?.start?.dateTime || (event?.start?.date ? `${event.start.date}T00:00:00` : null);
  const endValue = event?.end?.dateTime || (event?.end?.date ? `${event.end.date}T00:00:00` : null);
  const start = parseDateTime(startValue);
  const end = parseDateTime(endValue);
  if (!start || !end) return null;
  return { start, end };
}

function parseSlotRange(slot) {
  const start = parseDateTime(slot.start);
  const end = parseDateTime(slot.end);
  if (!start || !end) return null;
  return { start, end };
}

function overlaps(rangeA, rangeB) {
  return rangeA.start < rangeB.end && rangeB.start < rangeA.end;
}

function isAllDayEvent(event) {
  // Google Calendar: all-day events use start.date/end.date (no dateTime).
  return Boolean(event?.start?.date && !event?.start?.dateTime);
}

function eventConflicts(slot, events, excludedEventId = null, options = {}) {
  const slotRange = parseSlotRange(slot);
  if (!slotRange) return options.collectIgnored ? { conflicts: [], ignored: [] } : [];
  const conflicts = [];
  const ignored = [];
  const allowAnyConflicts = Boolean(options.allowAnyConflicts);
  const allowAllDayConflicts = Boolean(options.allowAllDayConflicts);
  const collectIgnored = Boolean(options.collectIgnored);
  const ignoreTransparent = options.ignoreTransparent !== false;

  for (const event of events) {
    if (excludedEventId && String(event?.id || "") === String(excludedEventId)) continue;
    if (String(event?.status || "").toLowerCase() === "cancelled") continue;
    if (ignoreTransparent && String(event?.transparency || "").toLowerCase() === "transparent") continue;
    const eventRange = parseCalendarEventRange(event);
    if (!eventRange) continue;
    if (overlaps(slotRange, eventRange)) {
      const allDay = isAllDayEvent(event);
      if (allowAnyConflicts || (allowAllDayConflicts && allDay)) {
        if (collectIgnored) ignored.push(event);
        continue;
      }
      conflicts.push(event);
    }
  }
  return collectIgnored ? { conflicts, ignored } : conflicts;
}

function sessionDurationMin(session) {
  const value = Number(session?.duration_min || 0);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function isSchedulableSession(session) {
  const discipline = String(session?.discipline || "").toLowerCase();
  if (!discipline || discipline === "rest") return false;
  return sessionDurationMin(session) > 0;
}

function buildSessionName(session) {
  if (session?.name && String(session.name).trim()) return String(session.name).trim();
  const discipline = String(session?.discipline || "Session").trim();
  const type = String(session?.type || "Workout").trim();
  return `${discipline} ${type}`.replace(/\s+/g, " ").trim();
}

function buildTrainingSummary(session) {
  return `Training: ${buildSessionName(session)}`;
}

function flattenStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
}

function formatIntensityPrescriptions(session) {
  const intensity = session?.intensity_prescription;
  if (!intensity || typeof intensity !== "object") return [];

  const lines = [];
  if (intensity.primary_metric) lines.push(`Primary metric: ${intensity.primary_metric}`);
  if (Array.isArray(intensity.hr_zone_range) && intensity.hr_zone_range.length) {
    lines.push(`HR zones: ${intensity.hr_zone_range.join(", ")}`);
  }
  if (Array.isArray(intensity.hr_bpm_range) && intensity.hr_bpm_range.length === 2) {
    lines.push(`HR bpm range: ${intensity.hr_bpm_range[0]}-${intensity.hr_bpm_range[1]}`);
  }
  if (Array.isArray(intensity.rpe_range) && intensity.rpe_range.length === 2) {
    lines.push(`RPE range: ${intensity.rpe_range[0]}-${intensity.rpe_range[1]}`);
  }
  if (intensity.effort_hint) lines.push(`Effort hint: ${intensity.effort_hint}`);
  return lines;
}

function formatStrengthPrescription(session) {
  const prescription = session?.strength_prescription;
  if (!prescription || typeof prescription !== "object") return [];

  const lines = [];
  if (prescription.phase_mode) {
    lines.push(`Strength phase: ${prescription.phase_mode}`);
  }
  if (prescription.progression_decision) {
    lines.push(`Strength progression: ${prescription.progression_decision}`);
  }

  const exercises = Array.isArray(prescription.exercises) ? prescription.exercises : [];
  if (exercises.length) {
    const concise = exercises
      .map((exercise) => {
        const name = String(exercise?.exercise_name || "").trim();
        if (!name) return null;
        const sets = Number(exercise?.sets || 0);
        const reps = exercise?.reps == null ? "" : String(exercise.reps).trim();
        const tempo = String(exercise?.tempo || "").trim();
        const restSec = Number(exercise?.rest_sec || 0);
        const rpe = Number(exercise?.load?.target_rpe || NaN);
        const rir = Number(exercise?.load?.target_rir || NaN);

        const parts = [];
        if (sets > 0 && reps) parts.push(`${sets}x${reps}`);
        if (tempo) parts.push(`tempo ${tempo}`);
        if (restSec > 0) parts.push(`rest ${restSec}s`);
        if (Number.isFinite(rpe) || Number.isFinite(rir)) {
          const rpePart = Number.isFinite(rpe) ? `RPE ${rpe}` : null;
          const rirPart = Number.isFinite(rir) ? `RIR ${rir}` : null;
          const joined = [rpePart, rirPart].filter(Boolean).join(", ");
          if (joined) parts.push(joined);
        }
        if (!parts.length) return name;
        return `${name} (${parts.join(", ")})`;
      })
      .filter(Boolean);

    if (concise.length) {
      lines.push(`Strength detail: ${concise.join(" | ")}`);
    }
  }

  return lines;
}

function formatBikePrescription(session) {
  const prescription = session?.bike_prescription;
  if (!prescription || typeof prescription !== "object") return [];

  const lines = [];
  if (prescription.session_objective) {
    lines.push(`Bike objective: ${prescription.session_objective}`);
  }
  if (prescription.target_system) {
    lines.push(`Bike system: ${prescription.target_system}`);
  }

  const blocks = Array.isArray(prescription.blocks) ? prescription.blocks : [];
  if (blocks.length) {
    const summary = blocks
      .map((block) => {
        const label = String(block?.block_label || "").trim();
        const duration = Number(block?.duration_min || 0);
        const repetitions = Number(block?.repetitions || 0);
        const target = String(block?.target_range || "").trim();
        const cadence = String(block?.cadence_target || "").trim();
        const parts = [];
        if (duration > 0 && repetitions > 0) parts.push(`${duration}m x${repetitions}`);
        if (target) parts.push(target);
        if (cadence) parts.push(`cadence ${cadence}`);
        return label ? `${label} (${parts.join(", ")})` : parts.join(", ");
      })
      .filter(Boolean);

    if (summary.length) {
      lines.push(`Bike detail: ${summary.join(" | ")}`);
    }
  }

  return lines;
}

function formatRunPrescription(session) {
  const prescription = session?.run_prescription;
  if (!prescription || typeof prescription !== "object") return [];

  const lines = [];
  if (prescription.session_objective) {
    lines.push(`Run objective: ${prescription.session_objective}`);
  }
  if (prescription.target_system) {
    lines.push(`Run system: ${prescription.target_system}`);
  }

  const blocks = Array.isArray(prescription.blocks) ? prescription.blocks : [];
  if (blocks.length) {
    const summary = blocks
      .map((block) => {
        const label = String(block?.block_label || "").trim();
        const duration = Number(block?.duration_min || 0);
        const target = String(block?.target_range || "").trim();
        const terrain = String(block?.terrain_or_mode || "").trim();
        const parts = [];
        if (duration > 0) parts.push(`${duration}m`);
        if (target) parts.push(target);
        if (terrain) parts.push(terrain);
        return label ? `${label} (${parts.join(", ")})` : parts.join(", ");
      })
      .filter(Boolean);
    if (summary.length) {
      lines.push(`Run detail: ${summary.join(" | ")}`);
    }
  }

  if (prescription.impact_management && typeof prescription.impact_management === "object") {
    const impact = prescription.impact_management;
    const bits = [impact.surface, impact.cadence_cue, impact.stride_cue]
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim());
    if (bits.length) {
      lines.push(`Run impact cues: ${bits.join(" | ")}`);
    }
  }

  return lines;
}

function formatSwimPrescription(session) {
  const prescription = session?.swim_prescription;
  if (!prescription || typeof prescription !== "object") return [];

  const lines = [];
  if (prescription.session_objective) {
    lines.push(`Swim objective: ${prescription.session_objective}`);
  }
  if (prescription.target_system) {
    lines.push(`Swim system: ${prescription.target_system}`);
  }

  const blocks = Array.isArray(prescription.blocks) ? prescription.blocks : [];
  if (blocks.length) {
    const summary = blocks
      .map((block) => {
        const label = String(block?.block_label || "").trim();
        const distance = Number(block?.distance_m || 0);
        const reps = Number(block?.repetitions || 0);
        const rest = Number(block?.rest_sec || 0);
        const parts = [];
        if (distance > 0 && reps > 0) parts.push(`${reps}x${distance}m`);
        if (rest >= 0) parts.push(`rest ${rest}s`);
        return label ? `${label} (${parts.join(", ")})` : parts.join(", ");
      })
      .filter(Boolean);

    if (summary.length) {
      lines.push(`Swim detail: ${summary.join(" | ")}`);
    }
  }

  const techniqueFocus = flattenStringArray(prescription.technique_focus);
  if (techniqueFocus.length) {
    lines.push(`Swim technique: ${techniqueFocus.join(" | ")}`);
  }

  return lines;
}

function formatNutritionPrescription(session) {
  const prescription = session?.nutrition_prescription;
  if (!prescription || typeof prescription !== "object") return [];

  const lines = [];
  if (prescription.pre_session) lines.push(`Nutrition pre: ${prescription.pre_session}`);
  if (prescription.during_session) lines.push(`Nutrition during: ${prescription.during_session}`);
  if (prescription.post_session) lines.push(`Nutrition post: ${prescription.post_session}`);
  if (prescription.daily_recovery_target) lines.push(`Recovery target: ${prescription.daily_recovery_target}`);
  if (prescription.session_specific_adjustment) {
    lines.push(`Nutrition adjustment: ${prescription.session_specific_adjustment}`);
  }
  return lines;
}

function formatProgressionTrace(session) {
  const trace = session?.progression_trace;
  if (!trace || typeof trace !== "object") return [];

  const lines = [];
  if (trace.phase_mode) lines.push(`Phase mode: ${trace.phase_mode}`);
  if (trace.progression_decision) lines.push(`Progression: ${trace.progression_decision}`);
  if (trace.load_delta_summary) lines.push(`Delta: ${trace.load_delta_summary}`);
  const progressed = flattenStringArray(trace.progressed_fields);
  if (progressed.length) lines.push(`Progressed fields: ${progressed.join(", ")}`);
  if (trace.goal_link) lines.push(`Goal link: ${trace.goal_link}`);
  return lines;
}

function buildTrainingDescription(session, weekStart) {
  const lines = [];
  lines.push(`Plan Week: ${weekStart}`);
  lines.push(`Session ID: ${session.id || "unknown"}`);
  lines.push(`Objective: ${session.intent || "Follow planned training objective."}`);
  lines.push(`Duration: ${sessionDurationMin(session)} min`);

  if (session.scheduling_notes) lines.push(`Scheduling notes: ${session.scheduling_notes}`);
  if (session.canonical_type) lines.push(`Canonical type: ${session.canonical_type}`);

  if (session.habit_anchor && typeof session.habit_anchor === "object") {
    lines.push(`Habit anchor level: ${session.habit_anchor.level_used || "unknown"}`);
    lines.push(`Habit anchor confidence: ${session.habit_anchor.confidence || "unknown"}`);
  }
  if (Number.isFinite(Number(session.habit_match_score))) {
    lines.push(`Habit match score: ${Number(session.habit_match_score)}`);
  }
  if (Number.isFinite(Number(session.deviation_minutes))) {
    lines.push(`Deviation minutes: ${Number(session.deviation_minutes)}`);
  }

  const warmup = flattenStringArray(session.warmup);
  if (warmup.length) lines.push(`Warmup: ${warmup.join(" | ")}`);

  const mainSet = flattenStringArray(session.main_set);
  if (mainSet.length) lines.push(`Main set: ${mainSet.join(" | ")}`);

  const strengthLines = formatStrengthPrescription(session);
  for (const line of strengthLines) {
    lines.push(line);
  }
  for (const line of formatBikePrescription(session)) lines.push(line);
  for (const line of formatRunPrescription(session)) lines.push(line);
  for (const line of formatSwimPrescription(session)) lines.push(line);
  for (const line of formatProgressionTrace(session)) lines.push(line);

  const cooldown = flattenStringArray(session.cooldown);
  if (cooldown.length) lines.push(`Cooldown: ${cooldown.join(" | ")}`);

  const intensityLines = formatIntensityPrescriptions(session);
  if (intensityLines.length) lines.push(`Targets: ${intensityLines.join("; ")}`);

  if (session.fueling) lines.push(`Fueling: ${session.fueling}`);
  for (const line of formatNutritionPrescription(session)) lines.push(line);
  if (session.notes) lines.push(`Notes: ${session.notes}`);

  const criteria = flattenStringArray(session.success_criteria);
  if (criteria.length) lines.push(`Session checks: ${criteria.join(" | ")}`);

  return lines.join("\n");
}

function parseCoachMetadata(description) {
  const text = String(description || "");
  const weekMatch = text.match(/^Plan Week:\s*(.+)$/im);
  const sessionMatch = text.match(/^Session ID:\s*(.+)$/im);
  return {
    planWeek: weekMatch ? weekMatch[1].trim() : null,
    sessionId: sessionMatch ? sessionMatch[1].trim() : null,
  };
}

function resolvePlannedSlot(session) {
  const start = String(session?.scheduled_start_local || "").trim();
  const end = String(session?.scheduled_end_local || "").trim();
  if (start && end) return { slot: { start, end }, source: "model" };
  return { slot: null, source: "missing" };
}

function ensureSchedulableSessionsHavePlannedSlots(plan) {
  const missing = [];
  for (const session of plan?.sessions || []) {
    if (!isSchedulableSession(session)) continue;
    if (!session?.scheduled_start_local || !session?.scheduled_end_local) {
      missing.push(session?.id || "unknown-id");
    }
  }
  return missing;
}

function resolveTimeZone(plan, explicitTimeZone) {
  const explicit = String(explicitTimeZone || "").trim();
  if (explicit) return explicit;

  const fromPlan = String(plan?.scheduling_context?.timezone || "").trim();
  if (fromPlan) return fromPlan;

  throw new Error(
    "Missing timezone. Pass --timezone or set plan.scheduling_context.timezone before running /schedule."
  );
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function resolvePlanDateRange(plan, sessionDates) {
  const sessions = Array.isArray(plan?.sessions) ? plan.sessions : [];
  const hasSessions = sessions.length > 0;

  if (sessionDates.length) {
    const startDate = sessionDates[0];
    const endExclusive = addDaysIso(sessionDates[sessionDates.length - 1], 1);
    return { startDate, endExclusive };
  }

  if (hasSessions) {
    // If there are sessions but none have dates, this is a broken plan.
    throw new Error("Plan has sessions but no session dates.");
  }

  // Plan shell case: allow empty sessions by falling back to week_start/week_end.
  const weekStart = String(plan?.week_start || "").trim();
  const weekEnd = String(plan?.week_end || "").trim();

  if (parseDateOnly(weekStart)) {
    const endInclusive = parseDateOnly(weekEnd) ? weekEnd : addDaysIso(weekStart, 6);
    const endExclusive = addDaysIso(endInclusive, 1);
    return { startDate: weekStart, endExclusive };
  }

  throw new Error("Plan has no session dates and is missing week_start.");
}

async function syncPlan({
  planPath,
  apply,
  calendarId = null,
  timeZone = null,
  conflictPolicy = "strict",
}) {
  const absolutePlanPath = path.resolve(planPath);
  const plan = readJson(absolutePlanPath);
  if (!plan || !Array.isArray(plan.sessions)) {
    throw new Error("Invalid plan file. Expected sessions array.");
  }

  const missingSchedule = ensureSchedulableSessionsHavePlannedSlots(plan);
  if (missingSchedule.length) {
    throw new Error(
      `Missing planned schedule for session(s): ${missingSchedule.join(", ")}. Re-run /plan-week before syncing.`
    );
  }

  const resolvedTimeZone = resolveTimeZone(plan, timeZone);

  const sessionDates = plan.sessions.map((s) => String(s.date || "")).filter(Boolean).sort();
  const { startDate: rangeStartDate, endExclusive: rangeEndDate } = resolvePlanDateRange(plan, sessionDates);
  const rangeStart = `${rangeStartDate}T00:00:00Z`;
  const rangeEnd = `${rangeEndDate}T00:00:00Z`;

  const { calendarId: resolvedCalendarId, items } = await listEvents({
    start: rangeStart,
    end: rangeEnd,
    calendarId,
  });

  const nowIso = new Date().toISOString();
  const existingBySessionId = new Map();
  const existingByEventId = new Map();

  for (const event of items) {
    existingByEventId.set(String(event.id || ""), event);
    const summary = String(event?.summary || "");
    if (!summary.startsWith("Training:")) continue;
    const metadata = parseCoachMetadata(event?.description || "");
    if (!metadata.sessionId) continue;
    if (metadata.planWeek && String(metadata.planWeek) !== String(plan.week_start)) continue;
    existingBySessionId.set(metadata.sessionId, event);
  }

  const results = {
    plan: absolutePlanPath,
    calendar_id: resolvedCalendarId,
    timezone: resolvedTimeZone,
    apply,
    conflict_policy: String(conflictPolicy || "strict"),
    scheduled: [],
    conflicts: [],
    unscheduled: [],
    canceled: [],
    warnings: [],
  };

  const activeSessionIds = new Set();

  for (const session of plan.sessions) {
    if (!isSchedulableSession(session)) {
      if (apply) {
        session.calendar = {
          provider: "google",
          calendar_id: resolvedCalendarId,
          event_id: null,
          status: "unscheduled",
          last_synced_at: nowIso,
          last_sync_action: null,
        };
      }
      results.unscheduled.push({ session_id: session.id || null, reason: "not schedulable" });
      continue;
    }

    const sessionId = String(session.id || "").trim();
    if (sessionId) activeSessionIds.add(sessionId);

    const existingEventId = String(session?.calendar?.event_id || "").trim() || null;
    const existingEvent =
      (existingEventId && existingByEventId.get(existingEventId)) ||
      (sessionId ? existingBySessionId.get(sessionId) : null) ||
      null;

    const planned = resolvePlannedSlot(session);
    if (!planned.slot) {
      throw new Error(`Session ${session.id || "unknown-id"} is missing scheduled_start_local/end_local`);
    }

    const policy = String(conflictPolicy || "strict").trim().toLowerCase();
    const conflictEval = eventConflicts(planned.slot, items, existingEvent ? existingEvent.id : null, {
      allowAnyConflicts: policy === "allow_any" || policy === "allow-any" || policy === "allow",
      allowAllDayConflicts:
        policy === "allow_all_day" ||
        policy === "allow-all-day" ||
        policy === "allow_all_day_conflicts" ||
        policy === "allow-all-day-conflicts",
      collectIgnored: true,
    });
    const conflicts = conflictEval.conflicts || [];
    const ignored = conflictEval.ignored || [];

    if (ignored.length) {
      results.warnings.push({
        session_id: session.id || null,
        code: "conflicts_ignored_by_policy",
        conflict_policy: policy,
        ignored_with: ignored.map((event) => ({
          id: event.id || null,
          summary: event.summary || "(untitled)",
          all_day: isAllDayEvent(event),
          start: event?.start?.dateTime || event?.start?.date || null,
          end: event?.end?.dateTime || event?.end?.date || null,
        })),
      });
    }
    if (conflicts.length) {
      if (apply) {
        session.calendar = {
          provider: "google",
          calendar_id: resolvedCalendarId,
          event_id: existingEvent ? String(existingEvent.id) : null,
          status: "conflict",
          last_synced_at: nowIso,
          last_sync_action: "skipped_conflict",
        };
      }

      results.conflicts.push({
        session_id: session.id || null,
        planned_start: planned.slot.start,
        planned_end: planned.slot.end,
        conflicts_with: conflicts.map((event) => ({
          id: event.id || null,
          summary: event.summary || "(untitled)",
          start: event?.start?.dateTime || event?.start?.date || null,
          end: event?.end?.dateTime || event?.end?.date || null,
        })),
      });
      continue;
    }

    const summary = buildTrainingSummary(session);
    const description = buildTrainingDescription(session, String(plan.week_start || ""));

    if (!apply) {
      results.scheduled.push({
        session_id: session.id || null,
        action: existingEvent ? "would_update" : "would_create",
        start: planned.slot.start,
        end: planned.slot.end,
        summary,
      });
      items.push({
        id: `dryrun-${session.id || Math.random().toString(36).slice(2)}`,
        summary,
        start: { dateTime: planned.slot.start },
        end: { dateTime: planned.slot.end },
      });
      continue;
    }

    let event;
    let action;
    if (existingEvent) {
      const updated = await updateTrainingEvent({
        eventId: String(existingEvent.id),
        start: planned.slot.start,
        end: planned.slot.end,
        summary,
        description,
        calendarId: resolvedCalendarId,
        timeZone: resolvedTimeZone,
      });
      event = updated.event;
      action = "updated";
    } else {
      const created = await createTrainingEvent({
        start: planned.slot.start,
        end: planned.slot.end,
        summary,
        description,
        calendarId: resolvedCalendarId,
        timeZone: resolvedTimeZone,
      });
      event = created.event;
      items.push(event);
      action = "created";
    }

    session.calendar = {
      provider: "google",
      calendar_id: resolvedCalendarId,
      event_id: event?.id || null,
      status: "scheduled",
      last_synced_at: nowIso,
      last_sync_action: action,
    };

    results.scheduled.push({
      session_id: session.id || null,
      action,
      event_id: event?.id || null,
      start: planned.slot.start,
      end: planned.slot.end,
      summary,
    });
  }

  const orphanCandidates = items.filter((event) => {
    const summary = String(event?.summary || "").trim();
    if (!summary.startsWith("Training:")) return false;
    const metadata = parseCoachMetadata(event?.description || "");
    if (metadata.planWeek && String(metadata.planWeek) !== String(plan.week_start)) return false;
    if (!metadata.sessionId) return false;
    return !activeSessionIds.has(metadata.sessionId);
  });

  if (apply) {
    for (const event of orphanCandidates) {
      await deleteTrainingEvent({
        eventId: String(event.id),
        calendarId: resolvedCalendarId,
      });
      results.canceled.push({ event_id: event.id || null, action: "deleted" });
    }
    writeJson(absolutePlanPath, plan);
  } else {
    results.canceled = orphanCandidates.map((event) => ({
      event_id: event.id || null,
      action: "would_delete",
    }));
  }

  return results;
}

async function main() {
  const flags = parseArgs();
  const planPath = requireFlag(flags, "plan");
  const apply = Boolean(flags.apply);
  const dryRun = Boolean(flags["dry-run"]);
  const calendarId = flags["calendar-id"] ? String(flags["calendar-id"]) : null;
  const timeZone = flags.timezone ? String(flags.timezone) : undefined;
  const conflictPolicy = flags["conflict-policy"] ? String(flags["conflict-policy"]).trim() : "strict";

  if (apply === dryRun) {
    throw new Error("Specify exactly one mode: --dry-run or --apply");
  }

  const result = await syncPlan({
    planPath,
    apply,
    calendarId,
    timeZone,
    conflictPolicy,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  });
}

module.exports = {
  overlaps,
  eventConflicts,
  buildTrainingDescription,
  buildTrainingSummary,
  parseCoachMetadata,
  resolvePlannedSlot,
  ensureSchedulableSessionsHavePlannedSlots,
  resolveTimeZone,
  syncPlan,
  formatStrengthPrescription,
};
