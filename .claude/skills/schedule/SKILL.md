---
name: schedule
description: "Synchronize model-scheduled weekly plan sessions to Google Calendar with Training-only event writes. This skill is execution-only and never invents schedule placement."
allowed-tools:
  - Read
  - Write
  - Bash(ls*)
  - Bash(cat*)
  - Bash(bun .claude/skills/schedule/scripts/calendar_events.js*)
  - Bash(bun .claude/skills/schedule/scripts/sync_plan_to_calendar.js*)
context: fork
agent: general-purpose
---

# Schedule

## Instructions
1. `/plan-week` owns day/time placement. `/schedule` does not schedule.
2. Plan must already include complete schedule + habit metadata for every schedulable session.
3. Run dry-run first:
```bash
bun .claude/skills/schedule/scripts/sync_plan_to_calendar.js --plan data/coach/plans/<week_start>.json --dry-run
```
4. Then apply:
```bash
bun .claude/skills/schedule/scripts/sync_plan_to_calendar.js --plan data/coach/plans/<week_start>.json --apply
```
5. Conflict handling:
- Default (`--conflict-policy strict`): any overlapping *busy* event blocks scheduling.
- `--conflict-policy allow_all_day`: bypasses conflicts with all-day events (still blocks timed overlaps).
- `--conflict-policy allow_any`: bypasses all conflicts (will schedule even if overlapping).
6. If any session is missing `scheduled_start_local` or `scheduled_end_local`, stop and re-run `/plan-week`.
7. All event titles must remain `Training: <session name>`.
8. Orphaned training events (no longer in the plan) are deleted by the sync script. No `[Canceled]` placeholder events should be created.
9. Persisted `session.calendar` metadata in plan files is the source of truth for future updates.

## Direct API Wrappers
- List events:
```bash
bun .claude/skills/schedule/scripts/calendar_events.js list --start <ISO> --end <ISO>
```
- Create training event:
```bash
bun .claude/skills/schedule/scripts/calendar_events.js create-training --start <ISO> --end <ISO> --summary "Training: ..." --description "..."
```
- Update training event:
```bash
bun .claude/skills/schedule/scripts/calendar_events.js update-training --event-id <id> --start <ISO> --end <ISO> --summary "Training: ..." --description "..."
```
- Cancel training event by update:
```bash
bun .claude/skills/schedule/scripts/calendar_events.js cancel-training --event-id <id> --reason "..."
```
- Delete training event:
```bash
bun .claude/skills/schedule/scripts/calendar_events.js delete-training --event-id <id>
```
