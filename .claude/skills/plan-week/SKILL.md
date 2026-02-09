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
5. Ground decisions in:
   - `data/coach/strava_snapshot.json`
   - `data/coach/profile.json`
   - `data/coach/goals.json`
   - `data/coach/baseline.json`
   - `data/coach/strategy.json`
   - `data/system/strava/schedule_preferences_inferred.json`
6. Use `baseline.discipline_baselines` to set per-discipline volume targets. Each discipline's weekly hours should be within +/-15% of its `weekly_hours_avg` unless strategy/goals call for a deliberate shift. Use `baseline.recent_weekly_totals` to understand the athlete's actual training rhythm and session patterns. If `profile.preferences.time_budget_hours` has null values, use `baseline.derived_time_budget` instead.
7. Generate sessions first (discipline intent + duration), respecting the time budget from step 6.
8. Build scheduling context:
```bash
bun .claude/skills/plan-week/scripts/build_scheduling_context.js --plan data/coach/plans/<week_start>.json
```
9. Use model-first habit-preserving scheduling:
   - classify canonical session type first,
   - match discipline + weekday + canonical type anchors,
   - keep same-day shifts before changing days,
   - deviate only for hard constraints or safety.
10. Write required scheduling/session fields for every schedulable session:
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
11. Write required plan-level scheduling fields:
   - `scheduling_context`
   - `scheduling_decisions`
   - `scheduling_decisions.habit_adherence_summary`
   - `scheduling_risk_flags`
12. For each trainable session (`run|bike|swim|strength`) write:
   - discipline structured prescription object (`run_prescription|bike_prescription|swim_prescription|strength_prescription`)
   - `progression_trace` with explicit prior-week comparison and goal link
13. For every non-rest schedulable session, include `nutrition_prescription`.
14. Ask-before-downshift policy:
   - if fatigue/adherence signals imply overload risk, do not auto-downshift;
   - populate top-level `needs_user_input` options and defer the downshift until user selects an option.
15. Update `data/coach/progression_state.json` from latest plan, prior-week plan, goals, strategy, baseline, and latest check-in.
16. For bike sessions, obey `preferences.bike_capabilities.resolved` no-power guardrails.
17. AskUserQuestion only if no feasible placement satisfies hard constraints and weekday-change budget.
18. Final response style:
   - Start with all remaining sessions in the plan week from today onward.
   - Exclude already-past sessions for current week planning.
   - Add short rationale/risk note and one short check-in question.
   - Put artifact file paths last.

Output must be plan artifact + brief artifact only, not system analysis.
