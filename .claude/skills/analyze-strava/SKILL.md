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
3. Confirm the report in `reports/YYYY-MM-DD-week.md`.

## Command
```bash
node .claude/skills/analyze-strava/scripts/analyze_strava.js <week_start>
```
