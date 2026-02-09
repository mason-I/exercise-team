---
name: review-activity
description: Debriefs a specific Strava activity using natural-language selection (no activity ID required).
allowed-tools:
  - Bash(bun .claude/skills/review-activity/scripts/resolve_activity.js*)
  - Bash(bun .claude/skills/review-activity/scripts/fetch_strava_streams.js*)
  - Read
  - Write
  - Bash(ls*)
  - Bash(cat*)
context: fork
agent: general-purpose
---

# Review Activity

## Instructions
1. Do not require the user to provide an activity ID.
2. Resolve target activity from user text (examples: "my ride yesterday", "that long run last week"):
```bash
bun .claude/skills/review-activity/scripts/resolve_activity.js --query "<user text>" --activities data/external/strava/activities.json
```
3. If `selected_activity_id` is returned with high confidence, use it.
4. If ambiguous or unspecified, use AskUserQuestion and show the top candidates from resolver output.
5. Fetch streams for the chosen activity (cache or fetch) before analysis:
```bash
bun .claude/skills/review-activity/scripts/fetch_strava_streams.js --activity-id <id>
```
6. Read:
   - `data/external/strava/streams/<id>.json`
   - `data/external/strava/activities.json`
   - `data/coach/strava_snapshot.json` (for zones/context)
7. Write `data/coach/reports/activity_<id>.md` with:
   - Summary
   - What went well
   - What to improve
   - Specific next-session recommendations
   - Confidence + missing data notes

Always ground conclusions in fetched activity streams and Strava evidence.
