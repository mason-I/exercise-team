---
name: setup
description: "Model-driven onboarding completion: intake questions, initial plan generation, and optional calendar sync after install-time bootstrap."
allowed-tools:
  - Bash(ls*)
  - Bash(cat*)
  - Bash(mkdir -p coach*)
  - Bash(mkdir -p data*)
  - Bash(mkdir -p state*)
  - Bash(bun .claude/skills/setup/scripts/setup_orchestrator.js*)
  - Bash(bun .claude/skills/setup/scripts/install_bootstrap.js*)
  - Bash(bun .claude/skills/setup/scripts/init_workspace.js*)
  - Bash(bun .claude/skills/setup/scripts/strava_auth.js*)
  - Bash(bun .claude/skills/onboard/scripts/strava_auth.js*)
  - Bash(bun .claude/skills/setup/scripts/run_parallel_onboarding_phase.js*)
  - Bash(bun .claude/skills/setup/scripts/google_calendar_auth.js*)
  - Bash(bun .claude/skills/setup/scripts/generate_onboarding_plan.js*)
  - Bash(bun .claude/skills/onboard/scripts/fetch_strava_athlete.js*)
  - Bash(bun .claude/skills/onboard/scripts/fetch_strava_stats.js*)
  - Bash(bun .claude/skills/onboard/scripts/fetch_strava_zones.js*)
  - Bash(bun .claude/skills/setup/scripts/fetch_strava_activities.js*)
  - Bash(bun .claude/skills/setup/scripts/derive_schedule_preferences.js*)
  - Bash(bun .claude/skills/setup/scripts/sync_strava_activities.js*)
  - Bash(bun .claude/skills/coach-sync/scripts/build_strava_snapshot.js*)
  - Bash(bun .claude/skills/coach-sync/scripts/audit_bike_power_streams.js*)
  - Bash(bun .claude/skills/schedule/scripts/sync_plan_to_calendar.js*)
  - Read
  - Write
hooks:
  PostToolUse:
    - matcher: "Write"
      hooks:
        - type: command
          command: "bun \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/coach_response_context.js"
---

# Setup (Model-Driven Completion)

## When to use
- The user runs `/setup`.
- The user asks for first-time onboarding, Strava connection, Google Calendar connection, or full setup refresh.

## Primary path
Run a single orchestrator command:

```bash
bun .claude/skills/setup/scripts/setup_orchestrator.js \
  --auto-open-browser \
  --calendar-gate required_skippable \
  --calendar-sync confirm_apply
```

### What the orchestrator does
1. Verifies install bootstrap completed (`data/system/install/bootstrap_state.json` + required artifacts).
2. Generates adaptive required onboarding questions from artifact gaps.
3. Generates initial week plan when required inputs are complete.
4. Runs Google Calendar sync dry-run and requests confirmation before writes.
5. Stores resumable state in `data/system/onboarding/session.json`.

## Required behavior
- Do not perform OAuth or deterministic Strava bootstrap work inside `/setup`.
- Install-time bootstrap owns Strava/Google authentication and data preparation.
- For calendar events, use `confirm_apply` default:
  - produce dry-run preview,
  - only apply writes after explicit confirmation.

## Handling orchestrator outputs
The script returns JSON. Drive user prompts from `status`:

- `status: "needs_user_input"` + `stage: "bootstrap_check"` + `needs_user_input[].id = "install_bootstrap_required"`
  - Do not continue with `/setup` steps yet.
  - Run install bootstrap first:
    - preferred: `bash install.sh`
    - direct: `bun .claude/skills/setup/scripts/install_bootstrap.js --auto-open-browser`
  - Then rerun `/setup`.

- `status: "needs_user_input"` + `stage: "intake"`
  - Ask all `needs_user_input` questions returned by the script.
  - Update artifacts from answers, then rerun orchestrator with `--resume`.

- `status: "needs_user_input"` + `stage: "calendar_preview"`
  - Ask for calendar write confirmation.
  - Re-run with one of:
    - `--calendar-sync-confirm yes`
    - `--calendar-sync-confirm no`

- `status: "completed"`
  - Setup is complete.

## Recommended rerun command
When continuing from partial progress:

`/setup` can be rerun directly after answering prompts; `--resume` is optional.

## Manual fallback commands (only if orchestrator fails)
- Install bootstrap:
```bash
bun .claude/skills/setup/scripts/install_bootstrap.js --auto-open-browser
```

## Output checklist
- `data/system/onboarding/session.json` updated with stage/status.
- `data/system/install/bootstrap_state.json` must exist from install bootstrap.
- `data/coach/plans/YYYY-MM-DD.json` generated when required intake is complete.

## Final response contract
- Never start with artifact file list.
- First section: remaining sessions this week only.
- Then brief rationale/risk note.
- Then short check-in question.
- Artifact paths listed last.
