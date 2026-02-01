---
name: compute-baseline
description: Computes deterministic baseline metrics from Strava activity data and writes baseline artifacts when a baseline needs to be created or refreshed.
allowed-tools:
  - Bash(node .claude/skills/compute-baseline/scripts/compute_baseline.js*)
  - Bash(mkdir -p data*)
  - Bash(ls*)
  - Bash(cat*)
---

# Computing Baseline

## Instructions
1. Confirm `data/strava_activities.json` exists for the requested window.
2. Run the deterministic script with the specified window days (default 56).
3. Verify `baseline.json` and `baseline.md` were updated.

## Command
```bash
node .claude/skills/compute-baseline/scripts/compute_baseline.js --input data/strava_activities.json --window-days 56
```
