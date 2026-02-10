---
name: plan-week
description: Builds a model-first weekly plan for the athlete with habit-preserving scheduling (discipline + weekday + canonical type + time).
allowed-tools:
  - Read
  - Write
  - Bash(bun .claude/skills/plan-week/scripts/resolve_week_start.js*)
  - Bash(bun .claude/skills/setup/scripts/derive_schedule_preferences.js*)
  - Bash(bun .claude/skills/plan-week/scripts/build_scheduling_context.js*)
  - Bash(ls*)
  - Bash(cat*)
hooks:
  PreToolUse:
    - matcher: "Read|Write|Bash"
      hooks:
        - type: command
          command: "bun \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/coach_plan_precheck.js"
          once: true
  PostToolUse:
    - matcher: "Write"
      hooks:
        - type: command
          command: "bun \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/coach_response_context.js"
  Stop:
    - hooks:
        - type: command
          command: "bun \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/coach_plan_precheck.js"
context: fork
agent: general-purpose
---

# Plan Week

## Instructions
1. Create `data/coach/plans/YYYY-MM-DD.json`, `data/coach/progression_state.json`, and `data/coach/reports/brief_<today>.md`.
2. Do not require the user to provide a date argument.
3. Determine target week:
   - "this week" -> current week (`COACH_WEEK_START`)
   - "next week" -> forthcoming week
   - no timeframe -> forthcoming week
4. Resolve week start:
```bash
bun .claude/skills/plan-week/scripts/resolve_week_start.js --mode <this|next>
```
4a. Ensure habit anchors exist before scheduling context (runs automatically if `schedule_preferences_inferred.json` is missing):
```bash
bun .claude/skills/setup/scripts/derive_schedule_preferences.js
```
5. Ground decisions in (read all before generating sessions):
   - `data/coach/strava_snapshot.json` -- after reading, interpret: What does the athlete's training actually look like? What's the session type mix (endurance/intensity/recovery)? Is volume building, stable, or declining? Any gaps or anomalies? What data quality constraints exist (power/HR coverage) that affect viable prescription types?
   - `data/coach/week_context.json` -- week-to-date grounding (today, day number, completed-to-date, expected-by-now). Use this to avoid calling early-week volume a “drop”.
   - `data/coach/profile.json`
   - `data/coach/goals.json`
   - `data/coach/baseline_raw.json` (raw deterministic aggregates)
   - `data/coach/baseline.json` (model-interpreted baseline -- see step 5a)
   - `data/coach/strategy.json`
   - `data/coach/training_load.json` (CTL/ATL/TSB fitness model, thresholds, injury risk -- see step 5c)
   - `data/coach/macrocycle.json` (periodization phases, current phase targets -- see step 5d)
   - `data/coach/outcomes.json` (adherence patterns, adaptation signals, recovery patterns -- see step 5e)
   - `data/system/strava/schedule_preferences_inferred.json` (statistical habit anchors)
5a. **Schedule preference interpretation (model-driven)**: After reading `schedule_preferences_inferred.json`, apply coaching judgment before using for placement:
   - Re-classify `canonical_type` from activity names semantically (regex often gets this wrong -- "Hill sprints with the lads" = interval, "Coffee ride" = recovery/social).
   - Identify true anchor days (>75% weekly presence) vs. sporadic patterns. Prefer true anchors, be flexible with sporadic ones.
   - Check for recent pattern shifts (if an anchor hasn't been hit in 2+ weeks, it may be outdated -- flag to the athlete).
   - Identify day-pairing habits the statistics miss (e.g., always rides Wed + Sat, or strength always follows a hard ride day).
5b. **Baseline interpretation (model-driven)**: Read `data/coach/baseline_raw.json`. If `data/coach/baseline.json` does not exist, or its `as_of_date` is older than `baseline_raw.json`'s, synthesize a new `data/coach/baseline.json` by copying all raw fields and adding these model-generated fields:
   - `risk_assessment` (string): Contextual risk narrative. Don't just echo raw `risk_flags` -- reason about them using recent activity evidence. E.g., "Shin splints flagged but last 3 weeks show pain-free runs at increasing duration, so progression confidence is moderate."
   - `confidence_rationale` (object keyed by discipline): Explain why each discipline's confidence level is what it is, referencing session counts and consistency patterns.
   - `load_narrative` (string): Describe the training load trajectory in human terms, referencing `recent_weekly_totals` week-by-week.
   - `time_budget_rationale` (string): Explain what the derived time budget means in context -- flag any inflating factors (social rides, events) or genuine low weeks.
   Ground every claim in the raw numbers. Write result to `data/coach/baseline.json`.
5c. **Training load awareness (CTL/ATL/TSB)**: Read `data/coach/training_load.json`. Use the physiological model to inform planning:
   - **CTL (fitness)**: The athlete's current chronic training load. This is the baseline of what they can sustain.
   - **ATL (fatigue)**: Acute fatigue. If ATL >> CTL (high acute:chronic ratio), the athlete is accumulating fatigue faster than fitness -- reduce intensity or volume.
   - **TSB (form)**: Negative TSB means the athlete is fatigued. Very negative (< -20) means deep fatigue -- plan easier sessions. Positive TSB means the athlete is fresh -- good for key sessions.
   - **Injury risk**: If `injury_risk` is `high` or `critical` (acute:chronic ratio > 1.3), reduce this week's planned load. Do not increase volume or intensity. Note the risk in `scheduling_risk_flags`.
   - **Ramp rate**: If `ramp_rate` exceeds 7 TSS/week, the athlete is building too aggressively. Flatten the ramp.
   - **Zone update signals**: If thresholds may be outdated (pace/power improvements detected), note this for the athlete and consider using updated targets.
   - **Weekly TSS target**: Use `macrocycle.json` phase `ramp_rate_target` to compute: `target_weekly_tss = (ramp_rate_target * 7) + current_ctl`. Distribute across sessions proportionally.
   - If `training_load.json` is missing (first run before sync), proceed without it -- do not fabricate load data.
5d. **Macrocycle phase awareness**: Read `data/coach/macrocycle.json` if it exists. Determine the current phase:
   - Check `current_phase_id` and find the matching phase in `phases[]`.
   - Use the phase's `volume_target_pct` to scale total weekly volume relative to `derived_time_budget.typical`.
   - Use the phase's `intensity_distribution` to guide session type mix (e.g., base phase = 80% z1/z2 = mostly easy/long sessions, build phase = 10% z4+ = include intervals).
   - Use the phase's `discipline_emphasis` to weight discipline allocation.
   - Use the phase's `deload_pattern` to override the default mesocycle cycle in step 6b.
   - **Phase transition check**: If the current phase's `transition_criteria` are all met (check CTL from `training_load.json`, check adherence from `outcomes.json`, check injury flags), advance `current_phase_id` to the next phase in the array. Update `macrocycle.json` with the transition in `phase_history`. Inform the athlete: "You've met the criteria for advancing to the Build phase."
   - If `macrocycle.json` does not exist, proceed with `strategy.json` `phase_intent` as before.
5e. **Outcome-informed planning**: Read `data/coach/outcomes.json` if it exists. Use historical outcomes to improve this week's plan:
   - **Adherence patterns**: Check `adherence_summary.last_4_weeks.most_skipped_day` and `most_skipped_type`. If the athlete consistently skips Wednesday swim sessions, consider moving swim to a day with better adherence. Note scheduling friction in `scheduling_notes`.
   - **Recovery patterns**: Check `recovery_patterns`. If the athlete typically needs 2 days between hard run sessions, ensure hard run sessions are spaced accordingly. If no data exists, use conservative defaults (48h between hard sessions of the same discipline).
   - **Adaptation signals**: Check for `trend: "improving"` signals. If the athlete's run pace is improving at threshold HR, their zones may need updating -- use `training_load.zone_update_signals` to cross-reference.
   - If `outcomes.json` does not exist (no prior plans/reviews yet), proceed without -- outcomes build over time.
6. **Current-week and previous-week grounding (mandatory before generating sessions)**: After running `build_scheduling_context.js`, check `scheduling_context.week_status` and `scheduling_context.previous_week`. For the current week: `today_weekday` tells you what day it is, `days[].completed` shows actual Strava activities already done, `summary.total_hours_completed` is the real load so far, `summary.days_remaining` tells you how many days are left to schedule. For the previous week: `previous_week.days[].completed` shows what was actually done each day last week, and `previous_week.summary` gives total hours and per-discipline breakdown. Use previous-week day-level detail for load sequencing across the week boundary (e.g. if Sunday was hard, Monday should be easy) and session-level progression (e.g. last Saturday's long ride was 3h, build to 3:15h). **Never estimate current-week or previous-week load from baseline averages — use these actuals.** If planning for "this week" mid-week, only generate sessions for today and future days; do not overwrite past days.
6a. **Check-in awareness (if available)**: Read recent check-ins from `data/coach/checkins/` (last 1-2 weeks). If check-ins exist, look for:
   - Fatigue or energy trends (increasing fatigue = consider reducing volume or intensity this week).
   - Sleep quality signals (poor sleep = favor easier sessions, avoid early-morning intensity).
   - Persistent soreness in specific areas (correlate with session types -- if quads are sore, don't stack bike intervals).
   - Motivation signals (if the athlete is dreading a discipline, consider variety or swaps).
   - If no check-ins exist, proceed without -- do not fabricate subjective data.
6b. **Mesocycle deload check (mandatory before generating sessions)**: Read `data/coach/progression_state.json` and check `mesocycle.training_weeks_completed` against the training count from `mesocycle.cycle_pattern`. If `macrocycle.json` exists, use the current phase's `deload_pattern` instead of the default (e.g., phase with `"deload_pattern": "3:1"` means deload after 3 training weeks, not the default 4).
   - If `training_weeks_completed >= 4`: This week **must** be a deload week. Set `plan.phase = "deload"`. Apply deload session rules (see step 7a). Inform the athlete this is a scheduled deload week in the response.
   - If the previous week's actual volume was near-zero (e.g., illness/travel -- check `scheduling_context.previous_week.summary.total_hours_completed < 2`), the model may treat that missed week as incidental recovery and keep the counter unchanged rather than advancing it. Note this decision in `scheduling_notes`.
   - If `last_deload_week` was the previous week: Counter should already be reset to 0. Resume normal `build`/`maintain` phase from `strategy.phase_intent`.
   - Otherwise: Proceed with normal phase from `strategy.phase_intent`.
7. Use `baseline.discipline_baselines` to set per-discipline volume targets. Each discipline's weekly hours should be within +/-15% of its `weekly_hours_avg` unless strategy/goals call for a deliberate shift. Use `baseline.recent_weekly_totals` to understand the athlete's actual training rhythm and session patterns. If `profile.preferences.time_budget_hours` has null values, use `baseline.derived_time_budget` instead.
7a. **Deload session rules (apply only when `plan.phase = "deload"`)**: When the mesocycle check (step 6b) triggers a deload week:
   - **Volume**: Reduce total weekly volume to ~60% of baseline `derived_time_budget.typical`. Per-discipline hours scale proportionally.
   - **Load classes**: No `hard` or `very_hard` sessions. All sessions capped at `moderate` load class. Prefer `easy` and `recovery`.
   - **Session count**: Keep session count similar to a normal week (maintain routine/habit) but with shorter durations.
   - **Priority**: No `key` sessions. Reclassify all sessions as `support` or `optional`.
   - **Strength**: 25-40% reduction in hard sets, max RPE 7 (enforced by existing hooks). Focus on mobility and movement quality.
   - **Progression trace**: Every session must have `progression_trace.phase_mode = "deload"` and `load_delta_summary` must explicitly describe the reduction (e.g., "Deload week: volume reduced ~40% from baseline").
   - **Intent**: Sessions should emphasise recovery, technique, and movement quality over fitness gains.
8. Generate sessions (discipline intent + duration), respecting the time budget from step 7 (or the deload budget from step 7a if deload). For mid-week plans, account for `week_status.summary.total_hours_completed` already consumed. Session count, discipline mix, and durations are model decisions grounded in `baseline.discipline_baselines`. Do not use fewer sessions or lower volume than the athlete's baseline unless strategy, goals, or fatigue explicitly call for a reduction. The baseline reflects what the athlete has proven they can sustain.
9. Build scheduling context:
```bash
bun .claude/skills/plan-week/scripts/build_scheduling_context.js --plan data/coach/plans/<week_start>.json
```
10. Use model-first habit-preserving scheduling:
   - classify canonical session type first,
   - match discipline + weekday + canonical type anchors,
   - keep same-day shifts before changing days,
   - deviate only for hard constraints or safety.
   - **Mandatory (habit anchors)**: For any session where a high-confidence anchor exists for that discipline+weekday, use the anchor's preferred start time exactly (e.g. 07:36, not a rounded "nice" time like 8:00am or 5:30pm). Use `scheduling_context.inferred_preferences.routine_template` for glanceable habit reference.
   - **Mandatory (deviation check)**: Before placing a session at any time, check it against the routine template. If the proposed time deviates >30min from a high-confidence anchor for that discipline+weekday, flag it in `deviation_reason` and consider moving to match the habit.
   - **Calendar cross-check**: After placing all sessions using habit anchors, verify each placement against `scheduling_context.calendar_context.free_windows_by_date` for conflict avoidance. Reschedule or flag if a session overlaps a busy window.
11. Write required scheduling/session fields for every schedulable session:
   - `scheduled_start_local`
   - `scheduled_end_local`
   - `priority` (`key|support|optional`)
   - `load_class` (`recovery|easy|moderate|hard|very_hard`)
   - `canonical_type` (`recovery|easy|moderate|tempo|interval|vo2|long|technique|durability|strength|other`)
   - `habit_anchor.level_used` (`discipline_weekday_type|discipline_weekday|discipline`)
   - `habit_anchor.target_start_local`
   - `habit_anchor.confidence` (`low|medium|high`)
   - `habit_anchor.weekday_match` (`true|false`)
   - `habit_match_score` (0-100)
   - `deviation_minutes`
   - `deviation_reason`
   - `exception_code` (`null` or allowed code)
   - `scheduling_notes`
12. Write required plan-level scheduling fields:
   - `scheduling_context`
   - `scheduling_decisions`
   - `scheduling_decisions.habit_adherence_summary`
   - `scheduling_decisions.schedule_summary` (array of {day, time, session, habit_match, confidence} for proposed week table)
   - `scheduling_risk_flags`
13. For each trainable session (`run|bike|swim|strength`) write:
   - discipline structured prescription object (`run_prescription|bike_prescription|swim_prescription|strength_prescription`)
   - `progression_trace` with explicit prior-week comparison and goal link
14. For every non-rest schedulable session, include `nutrition_prescription`.
15. Ask-before-downshift policy:
   - if fatigue/adherence signals imply overload risk, do not auto-downshift;
   - populate top-level `needs_user_input` options and defer the downshift until user selects an option.
16. Update `data/coach/progression_state.json` from latest plan, prior-week plan, goals, strategy, baseline, and latest check-in. **Mesocycle counter update (mandatory)**:
   - If this week is a **deload** (`plan.phase = "deload"`): set `mesocycle.training_weeks_completed = 0`, set `mesocycle.last_deload_week` to this plan's `week_start`, and compute `mesocycle.next_deload_due` by adding `(training_count + 1) * 7` days to `week_start` (where `training_count` is the number before the colon in `cycle_pattern`, default 4).
   - If this week is a **normal training week**: increment `mesocycle.training_weeks_completed` by 1. Update `mesocycle.next_deload_due` if needed (= `last_deload_week` + `(training_count + 1) * 7` days, or if `last_deload_week` is null, compute from the current plan's `week_start` + remaining weeks until deload).
   - If the near-zero-volume override was applied in step 6b (previous week was incidental recovery), do **not** increment the counter -- note this in `weekly_change_log`.
17. For bike sessions, obey `preferences.bike_capabilities.resolved` no-power guardrails.
18. AskUserQuestion only if no feasible placement satisfies hard constraints and weekday-change budget.
19. Final response style:
   - Start with all remaining sessions in the plan week from today onward.
   - Exclude already-past sessions for current week planning.
   - Include a **schedule summary table** (day | time | session | habit match | confidence) for all schedulable sessions.
   - Add short rationale/risk note and one short check-in question.
   - **Confirmation step**: Ask the athlete to confirm or adjust the proposed schedule before running `/schedule`. Do not write to Google Calendar until the athlete confirms.
20. After the athlete confirms the schedule, they may run `/schedule` to sync sessions to Google Calendar.

Output must be plan artifact + brief artifact only, not system analysis.
