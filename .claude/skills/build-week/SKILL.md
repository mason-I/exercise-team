---
name: build-week
description: Builds a weekly training plan from baseline, calendar, and profile data when a new week plan is requested.
allowed-tools:
  - Bash(node .claude/skills/build-week/scripts/build_week.js*)
  - Bash(node .claude/skills/validate-artifacts/scripts/validate_artifacts.js*)
  - Bash(mkdir -p plans*)
  - Bash(ls*)
  - Bash(cat*)
---

# Building Week

## Instructions
1. Confirm `baseline.json`, `calendar.json`, and `profile.json` exist.
2. Run the weekly plan generator for the requested week start.
3. Validate the plan artifacts.

## Command
```bash
node .claude/skills/build-week/scripts/build_week.js <week_start> --output-md
```
