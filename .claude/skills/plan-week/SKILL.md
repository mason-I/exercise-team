---
name: plan-week
description: Builds a model-first weekly plan for the athlete with habit-preserving scheduling (discipline + weekday + canonical type + time).
allowed-tools:
  - Read
  - Write
  - Bash(bun .claude/skills/plan-week/scripts/resolve_week_start.js*)
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
5. Ground decisions in (read all before generating sessions):
   - `data/coach/strava_snapshot.json` -- after reading, interpret: What does the athlete's training actually look like? What's the session type mix (endurance/intensity/recovery)? Is volume building, stable, or declining? Any gaps or anomalies? What data quality constraints exist (power/HR coverage) that affect viable prescription types?
   - `data/coach/profile.json`
   - `data/coach/goals.json`
   - `data/coach/baseline_raw.json` (raw deterministic aggregates)
   - `data/coach/baseline.json` (model-interpreted baseline -- see step 5a)
   - `data/coach/strategy.json`
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
6. **Current-week and previous-week grounding (mandatory before generating sessions)**: After running `build_scheduling_context.js`, check `scheduling_context.week_status` and `scheduling_context.previous_week`. For the current week: `today_weekday` tells you what day it is, `days[].completed` shows actual Strava activities already done, `summary.total_hours_completed` is the real load so far, `summary.days_remaining` tells you how many days are left to schedule. For the previous week: `previous_week.days[].completed` shows what was actually done each day last week, and `previous_week.summary` gives total hours and per-discipline breakdown. Use previous-week day-level detail for load sequencing across the week boundary (e.g. if Sunday was hard, Monday should be easy) and session-level progression (e.g. last Saturday's long ride was 3h, build to 3:15h). **Never estimate current-week or previous-week load from baseline averages — use these actuals.** If planning for "this week" mid-week, only generate sessions for today and future days; do not overwrite past days.
6a. **Check-in awareness (if available)**: Read recent check-ins from `data/coach/checkins/` (last 1-2 weeks). If check-ins exist, look for:
   - Fatigue or energy trends (increasing fatigue = consider reducing volume or intensity this week).
   - Sleep quality signals (poor sleep = favor easier sessions, avoid early-morning intensity).
   - Persistent soreness in specific areas (correlate with session types -- if quads are sore, don't stack bike intervals).
   - Motivation signals (if the athlete is dreading a discipline, consider variety or swaps).
   - If no check-ins exist, proceed without -- do not fabricate subjective data.
7. Use `baseline.discipline_baselines` to set per-discipline volume targets. Each discipline's weekly hours should be within +/-15% of its `weekly_hours_avg` unless strategy/goals call for a deliberate shift. Use `baseline.recent_weekly_totals` to understand the athlete's actual training rhythm and session patterns. If `profile.preferences.time_budget_hours` has null values, use `baseline.derived_time_budget` instead.
8. Generate sessions (discipline intent + duration), respecting the time budget from step 7. For mid-week plans, account for `week_status.summary.total_hours_completed` already consumed. Session count, discipline mix, and durations are model decisions grounded in `baseline.discipline_baselines`. Do not use fewer sessions or lower volume than the athlete's baseline unless strategy, goals, or fatigue explicitly call for a reduction. The baseline reflects what the athlete has proven they can sustain.
9. Build scheduling context:
```bash
bun .claude/skills/plan-week/scripts/build_scheduling_context.js --plan data/coach/plans/<week_start>.json
```
10. Use model-first habit-preserving scheduling:
   - classify canonical session type first,
   - match discipline + weekday + canonical type anchors,
   - keep same-day shifts before changing days,
   - deviate only for hard constraints or safety.
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
   - `scheduling_risk_flags`
13. For each trainable session (`run|bike|swim|strength`) write:
   - discipline structured prescription object (`run_prescription|bike_prescription|swim_prescription|strength_prescription`)
   - `progression_trace` with explicit prior-week comparison and goal link
14. For every non-rest schedulable session, include `nutrition_prescription`.
15. Ask-before-downshift policy:
   - if fatigue/adherence signals imply overload risk, do not auto-downshift;
   - populate top-level `needs_user_input` options and defer the downshift until user selects an option.
16. Update `data/coach/progression_state.json` from latest plan, prior-week plan, goals, strategy, baseline, and latest check-in.
17. For bike sessions, obey `preferences.bike_capabilities.resolved` no-power guardrails.
18. AskUserQuestion only if no feasible placement satisfies hard constraints and weekday-change budget.
19. Final response style:
   - Start with all remaining sessions in the plan week from today onward.
   - Exclude already-past sessions for current week planning.
   - Add short rationale/risk note and one short check-in question.
   - Put artifact file paths last.

Output must be plan artifact + brief artifact only, not system analysis.
