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
5. Read all relevant data:
   - `data/coach/plans/<week_start>.json` (the planned sessions)
   - `data/external/strava/activities.json` (actual activities)
   - `data/coach/strava_snapshot.json` (zones, FTP, context)
   - `data/coach/baseline.json` (load narrative, confidence rationale, recent weekly totals)
   - `data/coach/profile.json` (injury history, preferences)
   - `data/coach/strategy.json` (phase intent, discipline focus)
   - `data/coach/checkins/<date>.json` for this week (athlete subjective feedback)
   - Any prior check-ins from the last 2-4 weeks: `data/coach/checkins/` (for trend analysis -- see step 7)

6. **Structured Planned-vs-Actual Analysis** -- perform all of the following before writing the report.

### Session-by-Session Matching
For each planned session, find the corresponding actual Strava activity by matching:
- Date (same day)
- Discipline (same sport type)
- Approximate time (within a few hours of planned start)

Categorize every session into one of:
- **Matched**: Planned session has a corresponding actual activity.
- **Missed**: Planned session with no corresponding activity (athlete skipped it).
- **Substituted**: Activity exists on the planned day but is a different discipline or type (e.g., planned run, did a ride).
- **Unplanned**: Actual activity that has no corresponding planned session (athlete added extra training).

Present as a table: Date | Planned | Actual | Status | Notes.

### Volume Accuracy
- **Total hours**: Planned total vs. actual total (percentage). E.g., "Planned 12.5h, completed 11.2h (90%)."
- **Per-discipline hours**: Planned vs. actual for each discipline. Flag any discipline where actual differs by more than 20% from planned.
- **Trend context**: Compare this week's actual total to `baseline.recent_weekly_totals` for the last 4 weeks. Is this week higher, lower, or in line with the athlete's pattern?

### Intensity Compliance (for matched sessions)
For each matched session where stream data is available (check `data/external/strava/streams/<activity_id>.json` if the activity review fetched streams):
- Compare actual HR/power/pace against the prescribed targets in the plan's prescription blocks.
- Flag sessions where the athlete was significantly over or under prescribed intensity.
- Summarize: "3/5 sessions were intensity-compliant, 1 was too hard (Tuesday tempo), 1 had no data."

### Load Trajectory
- How does this week's total load compare to the previous 4 weeks from `baseline.recent_weekly_totals`?
- Is the athlete following the planned progression (build/maintain/deload) from `strategy.json`?
- Calculate week-over-week load change as a percentage. Flag if >10% increase (aggressive) or >20% decrease (unplanned deload or life event).

### Adherence Score
Quantify adherence with these metrics:
- **Session completion rate**: Completed / Planned (e.g., 5/7 = 71%).
- **Volume accuracy**: Actual hours / Planned hours as percentage.
- **Intensity compliance**: Sessions in prescribed zones / Total matched sessions with data.
- **Schedule accuracy**: Sessions done on the planned day / Total planned sessions.
- **Overall adherence**: Weighted average (session completion 40%, volume accuracy 30%, intensity compliance 20%, schedule accuracy 10%).

### Adaptation Signals
Look for positive and negative adaptation signals:
- **Positive**: HR at a given pace/power trending down over weeks (aerobic fitness improving). Session RPE decreasing at the same load. Completing sessions that previously felt hard more comfortably.
- **Negative**: HR at a given pace/power trending up (detraining or fatigue). RPE increasing at the same load (overreaching). Increasing frequency of missed sessions (motivation or recovery issue). Increasing injury complaints in check-ins.
- Reference specific numbers: "Tuesday's tempo run was 5:10/km at 155bpm avg, vs. 5:15/km at 158bpm two weeks ago -- pace is improving at lower cardiac cost."

### Next-Week Implications
Based on this week's adherence and adaptation signals, provide specific plan adjustments for next week:
- If sessions were missed, should that volume be redistributed or absorbed? (Generally: absorb if 1 session missed, redistribute key sessions only if possible.)
- If the athlete was consistently over-intensity, suggest a recovery-focused adjustment.
- If the athlete was consistently under-intensity, suggest a slight progression.
- If adherence was low (<70%), explore why before increasing load.
- Note any specific sessions that should change (e.g., "Move Wednesday's interval to Thursday since you consistently miss Wednesdays").

7. **Check-in Trend Analysis** (longitudinal)

Read check-ins from the last 2-4 weeks in `data/coach/checkins/`. For each check-in, extract:
- **Fatigue/energy**: Is the athlete reporting increasing fatigue or declining energy over weeks?
- **Sleep**: Is sleep quality or duration trending down?
- **Motivation**: Is the athlete more or less engaged? Are certain session types generating enthusiasm or dread?
- **Soreness/pain**: Are any body areas showing persistent or worsening soreness? Correlate with specific session types.
- **Life stress**: Is non-training stress increasing (work, travel, family)?
- **Recovery quality**: Is the athlete reporting good recovery between sessions?

Summarize trends (not just this week's snapshot): "Fatigue has been creeping up over 3 weeks while volume has been stable -- consider a deload. Motivation is high after bike sessions but low for swim -- explore why."

If fewer than 2 check-ins exist, note limited longitudinal data and rely on this week's check-in only.

8. Write `data/coach/reports/week_review_<week_start>_asof_<as_of>.md` including:
   - **Adherence Summary Table**: Session-by-session matching table.
   - **Adherence Score**: Quantified metrics from step 6.
   - **Volume Analysis**: Planned vs. actual, per-discipline, trend context.
   - **Intensity Compliance**: Per-session breakdown where data exists.
   - **Key Wins**: Specific positives grounded in data.
   - **Key Misses**: What was missed and why it matters (or doesn't).
   - **Adaptation Signals**: Positive and negative trends with evidence.
   - **Check-in Trends**: Longitudinal fatigue/motivation/recovery patterns.
   - **Next-Week Recommendations**: Specific, actionable adjustments.
   - **Risk Flags**: Anything that needs attention before next week.
   - **2-4 Follow-up Questions**: Targeted questions to fill gaps in understanding.

Ground all numeric claims in Strava evidence and state uncertainty clearly.
