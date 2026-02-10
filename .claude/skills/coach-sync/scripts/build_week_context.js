#!/usr/bin/env bun

/*
Build data/coach/week_context.json deterministically from Strava activities (+ optional plan).

Goal: Make the system "week aware" so early-week partial volume is not misclassified as a drop-off.

Outputs:
  - current week-to-date totals (through as_of_date)
  - previous full week totals
  - expected-by-now model (plan-based if plan exists, else historical weekday distribution)
  - ahead/behind/on_track classification
*/

const fs = require("fs");
const path = require("path");
const { parseDate, toIsoDate, dumpJson } = require("../../_shared/lib");
const { PATHS } = require("../../_shared/paths");

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    activities: PATHS.external.stravaActivities,
    profile: PATHS.coach.profile,
    plansDir: PATHS.coach.plansDir,
    out: PATHS.coach.weekContext,
    asOfDate: process.env.COACH_TODAY || null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--activities") options.activities = String(argv[i + 1] || options.activities);
    if (arg === "--profile") options.profile = String(argv[i + 1] || options.profile);
    if (arg === "--plans-dir") options.plansDir = String(argv[i + 1] || options.plansDir);
    if (arg === "--out") options.out = String(argv[i + 1] || options.out);
    if (arg === "--as-of-date") options.asOfDate = String(argv[i + 1] || "").trim() || null;
  }
  return options;
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function normalizeWeekStart(value) {
  const v = String(value || "monday").trim().toLowerCase();
  const allowed = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
  return allowed.has(v) ? v : "monday";
}

function isoDowIndex(date) {
  // Monday=0 ... Sunday=6
  return (date.getUTCDay() + 6) % 7;
}

function weekStartFor(date, weekStartName) {
  const startName = normalizeWeekStart(weekStartName);
  const startIdx = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].indexOf(startName);
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const diff = (isoDowIndex(d) - startIdx + 7) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

function addDaysIso(isoDate, days) {
  const dt = parseDate(isoDate);
  if (!dt) return null;
  const out = new Date(dt.getTime());
  out.setUTCDate(out.getUTCDate() + Number(days || 0));
  return toIsoDate(out);
}

function daysBetweenInclusive(startIso, endIso) {
  const start = parseDate(startIso);
  const end = parseDate(endIso);
  if (!start || !end) return null;
  return Math.floor((end.getTime() - start.getTime()) / (24 * 3600 * 1000)) + 1;
}

function activityDateIso(activity) {
  const raw = activity?.start_date_local || activity?.start_date || activity?.date || null;
  if (!raw) return null;
  // Strava start_date_local is typically ISO; slicing keeps it stable as date-only.
  return String(raw).slice(0, 10);
}

function activityDurationMin(activity) {
  const sec = Number(
    activity?.moving_time_sec ??
      activity?.moving_time ??
      activity?.elapsed_time_sec ??
      activity?.elapsed_time ??
      activity?.duration_sec ??
      0
  );
  return Math.max(0, Math.round(sec / 60));
}

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
  )
    return "strength";
  return null;
}

function buildTotals(activities, startIso, endIso) {
  const byDisciplineMin = { run: 0, bike: 0, swim: 0, strength: 0, other: 0 };
  let totalMin = 0;
  let count = 0;

  for (const act of activities) {
    const d = activityDateIso(act);
    if (!d) continue;
    if (d < startIso || d > endIso) continue;

    const mins = activityDurationMin(act);
    const disc = normalizeSport(act?.sport_type || act?.type) || "other";
    totalMin += mins;
    count += 1;
    byDisciplineMin[disc] = (byDisciplineMin[disc] || 0) + mins;
  }

  const byDisciplineHours = {};
  for (const [k, m] of Object.entries(byDisciplineMin)) {
    if (m <= 0) continue;
    byDisciplineHours[k] = Math.round((m / 60) * 100) / 100;
  }

  return {
    total_hours: Math.round((totalMin / 60) * 100) / 100,
    total_minutes: totalMin,
    session_count: count,
    by_discipline_hours: byDisciplineHours,
  };
}

function loadPlanForWeek(plansDir, weekStartIso) {
  if (!plansDir || !weekStartIso) return null;
  const filePath = path.join(plansDir, `${weekStartIso}.json`);
  if (!fs.existsSync(filePath)) return null;
  const plan = safeReadJson(filePath, null);
  if (!plan || !Array.isArray(plan.sessions)) return null;
  return plan;
}

function plannedMinutesThrough(plan, weekStartIso, asOfIso) {
  if (!plan || !Array.isArray(plan.sessions)) return null;
  let total = 0;
  let schedulable = 0;

  for (const session of plan.sessions) {
    const disc = String(session?.discipline || "").toLowerCase();
    const d = String(session?.date || "");
    const dur = Number(session?.duration_min || 0);
    if (!d || !Number.isFinite(dur) || dur <= 0) continue;
    if (disc === "rest") continue;
    if (d < weekStartIso || d > asOfIso) continue;
    total += dur;
    schedulable += 1;
  }

  return { planned_minutes_to_date: total, planned_session_count_to_date: schedulable };
}

function computeHistoricalWeekdayDistribution(activities, weekStartName, currentWeekStartIso, weeksBack = 6) {
  // Use the last `weeksBack` full weeks before current week. Compute average fraction of weekly minutes by day index (0..6).
  const currentWeekStart = parseDate(currentWeekStartIso);
  if (!currentWeekStart) return null;

  const samples = [];
  for (let i = 1; i <= weeksBack; i += 1) {
    const ws = new Date(currentWeekStart.getTime());
    ws.setUTCDate(ws.getUTCDate() - i * 7);
    const weekStartIso = toIsoDate(ws);
    const weekEndIso = addDaysIso(weekStartIso, 6);
    if (!weekEndIso) continue;

    const dayMinutes = Array.from({ length: 7 }, () => 0);
    let weekTotal = 0;

    for (const act of activities) {
      const d = activityDateIso(act);
      if (!d) continue;
      if (d < weekStartIso || d > weekEndIso) continue;

      const mins = activityDurationMin(act);
      weekTotal += mins;

      const dt = parseDate(d);
      if (!dt) continue;
      const wsDt = weekStartFor(dt, weekStartName);
      const offset = Math.floor((dt.getTime() - wsDt.getTime()) / (24 * 3600 * 1000));
      if (offset >= 0 && offset < 7) dayMinutes[offset] += mins;
    }

    if (weekTotal <= 0) continue;
    samples.push({ week_start: weekStartIso, total_minutes: weekTotal, day_minutes: dayMinutes });
  }

  if (!samples.length) return null;

  const avgDay = Array.from({ length: 7 }, () => 0);
  const avgWeeklyMin = Math.round(samples.reduce((sum, s) => sum + s.total_minutes, 0) / samples.length);
  for (const s of samples) {
    for (let i = 0; i < 7; i += 1) avgDay[i] += s.day_minutes[i];
  }
  for (let i = 0; i < 7; i += 1) avgDay[i] /= samples.length;

  const sumAvg = avgDay.reduce((a, b) => a + b, 0);
  const fractions = sumAvg > 0 ? avgDay.map((m) => m / sumAvg) : Array.from({ length: 7 }, () => 1 / 7);

  return {
    sample_weeks: samples.map((s) => s.week_start),
    avg_weekly_minutes: avgWeeklyMin,
    weekday_fraction: fractions.map((x) => Math.round(x * 10000) / 10000),
  };
}

function classifyPace(actualMin, expectedMin) {
  if (!Number.isFinite(actualMin) || !Number.isFinite(expectedMin) || expectedMin <= 0) return "unknown";
  const ratio = actualMin / expectedMin;
  if (ratio < 0.85) return "behind";
  if (ratio > 1.15) return "ahead";
  return "on_track";
}

function main() {
  const options = parseArgs();
  const activities = safeReadJson(options.activities, []);
  const profile = safeReadJson(options.profile, {});

  const asOf = parseDate(options.asOfDate) || parseDate(new Date());
  if (!asOf) throw new Error("Invalid as-of date.");
  const asOfIso = toIsoDate(asOf);

  const weekStartName = normalizeWeekStart(profile?.preferences?.week_start || "monday");
  const currentWeekStartIso = toIsoDate(weekStartFor(asOf, weekStartName));
  const currentWeekEndIso = addDaysIso(currentWeekStartIso, 6);
  const prevWeekStartIso = addDaysIso(currentWeekStartIso, -7);
  const prevWeekEndIso = prevWeekStartIso ? addDaysIso(prevWeekStartIso, 6) : null;

  const currentTotals = buildTotals(Array.isArray(activities) ? activities : [], currentWeekStartIso, asOfIso);
  const prevTotals =
    prevWeekStartIso && prevWeekEndIso
      ? buildTotals(Array.isArray(activities) ? activities : [], prevWeekStartIso, prevWeekEndIso)
      : null;

  const daysElapsed = daysBetweenInclusive(currentWeekStartIso, asOfIso);
  const dayIndex = daysElapsed != null ? Math.max(1, Math.min(7, daysElapsed)) : null;

  const plan = loadPlanForWeek(options.plansDir, currentWeekStartIso);
  const planToDate = plan ? plannedMinutesThrough(plan, currentWeekStartIso, asOfIso) : null;

  let expectation = {
    basis: "unknown",
    expected_minutes_to_date: null,
    planned_minutes_to_date: planToDate?.planned_minutes_to_date ?? null,
    delta_minutes: null,
    pace: "unknown",
    ratio: null,
    notes: "",
  };

  if (planToDate && Number.isFinite(planToDate.planned_minutes_to_date)) {
    const expected = planToDate.planned_minutes_to_date;
    const actual = currentTotals.total_minutes;
    expectation = {
      basis: "plan_to_date",
      expected_minutes_to_date: expected,
      planned_minutes_to_date: expected,
      delta_minutes: actual - expected,
      pace: classifyPace(actual, expected),
      ratio: expected > 0 ? Math.round((actual / expected) * 1000) / 1000 : null,
      notes: "Expectation computed from the existing plan sessions through as_of_date (rest sessions excluded).",
    };
  } else {
    const dist = computeHistoricalWeekdayDistribution(
      Array.isArray(activities) ? activities : [],
      weekStartName,
      currentWeekStartIso,
      6
    );

    if (dist && Array.isArray(dist.weekday_fraction) && dist.weekday_fraction.length === 7 && dayIndex != null) {
      const typicalWeeklyMin = dist.avg_weekly_minutes;
      const cumFraction = dist.weekday_fraction.slice(0, dayIndex).reduce((a, b) => a + b, 0);
      const expected = Math.round(typicalWeeklyMin * cumFraction);
      const actual = currentTotals.total_minutes;
      expectation = {
        basis: "historical_weekday_distribution",
        expected_minutes_to_date: expected,
        planned_minutes_to_date: null,
        delta_minutes: actual - expected,
        pace: classifyPace(actual, expected),
        ratio: expected > 0 ? Math.round((actual / expected) * 1000) / 1000 : null,
        notes: `Expectation computed from avg weekday distribution across sample weeks (${dist.sample_weeks.length}) and avg weekly minutes (${typicalWeeklyMin}).`,
        historical: dist,
      };
    }
  }

  const payload = {
    generated_at: new Date().toISOString(),
    as_of_date: asOfIso,
    week_start_day: weekStartName,
    current_week: {
      week_start: currentWeekStartIso,
      week_end: currentWeekEndIso,
      as_of_date: asOfIso,
      day_number: dayIndex, // 1..7 within the week
      totals_to_date: currentTotals,
    },
    previous_week: prevTotals
      ? {
          week_start: prevWeekStartIso,
          week_end: prevWeekEndIso,
          totals_full_week: prevTotals,
        }
      : null,
    expectation,
    guidance: {
      phrasing_rule:
        "Treat current_week.totals_to_date as week-to-date. Do not describe it as a full-week drop unless as_of_date is the week_end or day_number is 7.",
      question_rule:
        "If pace is behind but day_number <= 2, ask a neutral question (travel/illness/planned recovery) rather than asserting a drop.",
    },
  };

  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  dumpJson(options.out, payload);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        out: options.out,
        as_of_date: asOfIso,
        current_week_start: currentWeekStartIso,
        day_number: dayIndex,
        totals_to_date_hours: currentTotals.total_hours,
        expectation_basis: payload.expectation.basis,
        pace: payload.expectation.pace,
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
    process.stderr.write(`${error?.message || error}\n`);
    process.exit(1);
  }
}

