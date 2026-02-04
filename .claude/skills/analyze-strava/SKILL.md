---
name: analyze-strava
description: Compares planned training against Strava activity data and writes an adherence report for a specific week.
allowed-tools:
  - Bash(node .claude/skills/analyze-strava/scripts/analyze_strava.js*)
  - Bash(mkdir -p reports*)
  - Bash(ls*)
  - Bash(cat*)
---

# Analyzing Strava

## Instructions
1. Ensure `data/strava_activities.json` is current for the target week.
2. Run the analyzer for the requested week start.
3. Use `--as-of-date` for mid-week/anytime analysis and expected-to-date pacing.
4. Add optional `--write-daily-report` and `--write-activity-reports` when a day-level or post-session debrief is needed.
5. Confirm outputs in the appropriate report paths.

## Command
```bash
node .claude/skills/analyze-strava/scripts/analyze_strava.js <week_start>
```

## Common variants
```bash
# Mid-week pacing
node .claude/skills/analyze-strava/scripts/analyze_strava.js <week_start> --as-of-date YYYY-MM-DD

# Daily summary + per-activity debrief files
node .claude/skills/analyze-strava/scripts/analyze_strava.js <week_start> --as-of-date YYYY-MM-DD --write-daily-report --write-activity-reports
```
