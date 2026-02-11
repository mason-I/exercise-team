# AI Coaching for Athletes

This mvp gives you a personal AI coach for run, bike, swim and strength planning.

It is designed for weekly use:
- Build a realistic plan for your upcoming week
- Sync sessions to your calendar
- Review how the week actually went
- Debrief individual workouts

## What It Connects To

- **Strava**: activity history, trends, and workout evidence
- **Google Calendar**: optional session sync so your plan appears on your calendar

## Future functionality
Plans to migrate to iOS app, proactivity with activity reviews and check ins etc, integrations with recovery wearables e.g. Oura + Whoop

## Core Commands

Run these commands in Claude from this project:

### `/setup`
First-time onboarding and connection flow.
- Connects required accounts
- Collects your goals, constraints, and schedule context
- Prepares your coaching baseline

Use this first.

Note: `/setup` derives "missing questions" by reading canonical artifacts under `data/coach/` (for example `data/coach/goals.json` and `data/coach/profile.json`). Answering a question means updating those source-of-truth files (or running the underlying orchestrator with `--answer <question_id>=<value>`), then re-running `/setup`.

### `/plan-week`
Creates your weekly training plan.
- Defaults to the upcoming week
- Balances training load across disciplines
- Produces a practical schedule with session details

Use this whenever you need a new week plan.

### `/schedule`
Syncs an existing plan to Google Calendar.
- Uses the schedule already created by `/plan-week`
- Supports dry-run preview before applying calendar writes

Use this after planning if you want calendar events.

### `/review-week`
Reviews adherence and progress for your week.
- Defaults to current week-to-date unless you ask for last week
- Compares planned work vs completed Strava activities
- Surfaces wins, misses, and next-step adjustments

Use this near end-of-week or at the start of a new week.

### `/review-activity`
Debriefs one workout in detail.
- You can describe it naturally (example: "my run yesterday")
- Pulls activity context and streams when available
- Returns actionable feedback for the next sessions

Use this after key workouts or races.

## Recommended Athlete Workflow

1. Run `/setup` once.
2. Each week, run `/plan-week`.
3. Optionally run `/schedule` to push sessions to Google Calendar.
4. During/after workouts, run `/review-activity` when you want deeper feedback.
5. End of week, run `/review-week` and roll into next week planning.

## Outputs You’ll Get

- Weekly plans
- Activity debriefs
- Weekly review reports
- Updated coaching context over time based on your training evidence
