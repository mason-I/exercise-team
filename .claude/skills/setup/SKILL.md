---
name: setup
description: Onboards a new athlete by connecting Strava, collecting a goal, and computing a baseline from Strava activity data.
allowed-tools:
  - Bash(ls*)
  - Bash(cat*)
  - Bash(mkdir -p data*)
  - Bash(node .claude/skills/setup/scripts/fetch_strava_activities.js*)
---

# Setup (Onboarding)

## When to use
- The user runs `/setup` or asks for onboarding, Strava connection, or first-time baseline setup.

## Workflow
1. **Connect Strava**
   - Run the Strava MCP command: `connect my Strava`.
   - Tell the user to complete the browser flow.
   - If they have not entered API credentials, provide this link in code formatting and ask for the client ID + client secret (or to paste them into the opened page):
     - `https://www.strava.com/settings/api`

2. **Fetch Strava profile**
   - Run: `get my Strava profile`.
   - Populate `profile.json` from available fields (name, weight, age if present; otherwise ask the user for missing values).
   - Keep units in metric; convert if needed (weight_kg).

3. **Collect training goal**
   - Ask what they want to achieve and offer suggestions (e.g., triathlon race, sprint/olympic/half/iron distance, 5k/10k PB, long ride goal).
   - Accept a pasted event link or a plain description.
   - Ask a follow-up time-goal question tailored to the goal (e.g., overall finish time, pace target, or split times for swim/bike/run).
     - If they have no time goal, ask if they want help choosing a realistic target.
   - Store the response in `profile.json` under a new `goal` field with:
     - `summary` (user's own words)
     - `time_target` (optional; include units like hh:mm:ss or min/km)
     - `event` (object, optional)
   - If an event link is provided, open it and extract:
     - event name, location, date
     - distances for swim/bike/run
     - course/terrain details (open-water vs pool, elevation/hills, surface)
   - Summarize the extracted details back to the user and store them under `goal.event`.
   - If event date and race type are confirmed, run `/set-goal <event_date> <race_type>`.

4. **Pull Strava activities (all history)**
   - Export all available Strava activities and normalize fields.
   - The baseline script will weight the most recent 56 days more heavily but retain historical activity so we don't treat inactive periods as zero fitness.
   - Use the fetch script to export activities and normalize fields (omit `--window-days` to pull full history). Avoid MCP `get-all-activities` to prevent large tool outputs:
     ```bash
     node .claude/skills/setup/scripts/fetch_strava_activities.js --out data/strava_activities.json
     ```
   - Requires Strava API creds in env:
     - `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REFRESH_TOKEN`
     - or `STRAVA_ACCESS_TOKEN` for a one-off run
   - If you prefer a local env file, create `.env` in the repo root (or set `STRAVA_ENV_PATH`) with:
     ```
     STRAVA_CLIENT_ID=...
     STRAVA_CLIENT_SECRET=...
     STRAVA_REFRESH_TOKEN=...
     ```

5. **Compute baseline**
   - Run `/compute-baseline 56`.
   - Confirm `baseline.json` and `baseline.md` were updated.

## Output checklist
- `profile.json` updated (athlete + goal)
- `calendar.json` updated if `/set-goal` ran
- `data/strava_activities.json` written
- `baseline.json` + `baseline.md` written

## Notes
- If Strava connection fails, ask the user to retry the connect flow.
- Do not invent values; ask for missing profile or goal details.
