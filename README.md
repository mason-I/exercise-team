# Individual AI-Powered Triathlon Coaching System (Claude Code)

This repo implements the PRD in `PRD.md` using Claude Code project assets:

- Project skills under `.claude/skills/` (invocable via `/skill-name`)
- Specialist subagents under `.claude/agents/`
- Deterministic skills under `.claude/skills/`
- File-based artifacts under the repo root

## Quickstart (Claude Code)

1. Set your athlete profile in `profile.json`.
2. Fetch Strava activities to `data/strava_activities.json` via MCP.
3. Compute baseline: `/compute-baseline 56`
4. Set goal: `/set-goal 2026-10-10 half`
5. Build a week: `/build-week 2026-01-26`
6. Analyze adherence after the week: `/analyze-strava 2026-01-26`

## Data format for `data/strava_activities.json`

The deterministic scripts expect an array of activity objects with at least:

```json
[
  {
    "sport_type": "Run",
    "start_date_local": "2026-01-05T07:12:00",
    "distance_m": 10000,
    "moving_time_sec": 3000
  }
]
```

Accepted fields:

- `sport_type` or `type` (Run, Ride/Bike, Swim)
- `start_date_local` or `start_date` or `date` (ISO)
- `distance_m` or `distance` (meters)
- `moving_time_sec`, `elapsed_time_sec`, or `duration_sec` (seconds)

## Skills

- `.claude/skills/compute-baseline/scripts/compute_baseline.js` -> `baseline.json` + `baseline.md`
- `.claude/skills/set-goal/scripts/set_goal.js` -> `calendar.json`
- `.claude/skills/build-week/scripts/build_week.js` -> `plans/YYYY-MM-DD.json` + `.md`
- `.claude/skills/analyze-strava/scripts/analyze_strava.js` -> `reports/YYYY-MM-DD-week.md`
- `.claude/skills/validate-artifacts/scripts/validate_artifacts.js` -> schema and safety checks

## Templates

Templates live in `templates/` for baseline, calendar, profile, and plan files.
