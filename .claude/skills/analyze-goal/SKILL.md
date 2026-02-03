---
name: analyze-goal
description: Builds a deterministic goal analysis using baseline load metrics to inform planning targets and ramp rules.
allowed-tools:
  - Bash(node .claude/skills/analyze-goal/scripts/analyze_goal.js*)
  - Bash(cat*)
  - Bash(ls*)
---

# Analyze Goal

## Instructions
1. Confirm `baseline.json`, `calendar.json`, and `profile.json` exist.
2. Run the goal analysis script.

## Command
```bash
node .claude/skills/analyze-goal/scripts/analyze_goal.js
```
