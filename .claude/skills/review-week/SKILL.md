---
name: review-week
description: Reviews weekly adherence/progress with automatic timeframe inference and attached check-in capture.
allowed-tools:
  - Read
  - Write
  - Bash(bun .claude/skills/review-week/scripts/resolve_review_window.js*)
  - Bash(ls*)
  - Bash(cat*)
hooks:
  PreToolUse:
    - matcher: "Read|Write|Bash"
      hooks:
        - type: command
          command: "bun \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/review_week_precheck.js"
          once: true
context: fork
agent: general-purpose
---

# Review Week

## Instructions
1. Do not require the user to specify a week or as-of date.
2. Determine review window using this order:
   - If user says "last week": review previous full week.
   - If user says "this week": review current week so far.
   - If user asks for progress without explicit timeframe: default to current week so far.
   - If ambiguous between current and previous week, use AskUserQuestion:
     - A) This week so far
     - B) Last full week
3. Resolve the window with:
```bash
bun .claude/skills/review-week/scripts/resolve_review_window.js --mode <current|last>
```
4. Before analyzing, ensure today's check-in exists (hook enforces this). If missing, ask for check-in answers and write `data/coach/checkins/YYYY-MM-DD.json`.
5. Compare planned sessions vs actual activities from:
   - `data/coach/plans/<week_start>.json`
   - `data/external/strava/activities.json`
   - `data/coach/strava_snapshot.json`
6. Write `data/coach/reports/week_review_<week_start>_asof_<as_of>.md` including:
   - Adherence summary
   - Key wins and misses
   - Risk and recovery notes
   - Adjustments for next week
   - 2-4 follow-up questions

Ground all numeric claims in Strava evidence and state uncertainty clearly.
