---
name: set-goal
description: Sets a target race date and type and derives calendar phases when a race goal is defined or updated.
allowed-tools:
  - Bash(node .claude/skills/set-goal/scripts/set_goal.js*)
  - Bash(ls*)
  - Bash(cat*)
---

# Setting Goal

## Instructions
1. Run the goal script with event date and race type.
2. Review `calendar.json` for phase dates and warnings.

## Command
```bash
node .claude/skills/set-goal/scripts/set_goal.js <event_date> <race_type>
```
