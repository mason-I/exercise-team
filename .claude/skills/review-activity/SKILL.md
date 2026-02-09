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
   - `data/coach/strava_snapshot.json` (for zones/context -- HR zones, power zones, FTP)
   - `data/coach/baseline.json` (for confidence rationale and load context)
   - `data/coach/profile.json` (for injury history, equipment context)
   - The current week's plan at `data/coach/plans/<week_start>.json` (to compare prescribed vs actual)

7. **Deep Stream Analysis** -- perform all applicable analyses below before writing the report. Not all will apply to every activity (e.g. no power analysis without power data). State clearly which data was available and which wasn't.

### Zone Distribution
- From HR and/or power streams, calculate approximate time-in-zone distribution.
- Compare against the session's **prescribed zones** from the plan (if a matching planned session exists). Was the athlete in the right zones?
- Flag significant zone drift: e.g., "Prescribed Z2 endurance but spent 35% of time in Z3 -- this was harder than intended."

### Cardiac/Power Drift Analysis
- Compare first-half vs. second-half of the main effort (exclude warmup/cooldown):
  - **HR drift at constant power**: If power was steady but HR rose >5% in the second half, flag cardiac drift (fatigue or dehydration signal).
  - **Power fade at constant HR**: If HR was steady but power dropped >5%, flag muscular fatigue.
  - **Pace drift (run)**: Compare first-half vs. second-half pace. Even splits = good execution. Positive split >5% = fading.
- For interval sessions, compare interval-to-interval consistency (did power/pace hold across reps?).

### Pacing Execution
- Was the session even-paced, negative-split, or positive-split?
- For long rides/runs: did the athlete start too fast? (common error -- first 20% significantly faster than last 20%)
- For interval sessions: were rest periods respected? Did the athlete go too hard on recovery intervals?
- Compare actual pacing strategy against what a coach would prescribe for this session type.

### Prescription Compliance (if planned session exists)
- Match this activity to the corresponding planned session by date + discipline + approximate start time.
- Compare **actual duration** vs. prescribed `duration_min`.
- Compare **actual blocks** (warmup/main/cooldown durations and intensities) against prescribed blocks.
- For bike: compare actual power ranges against prescribed `target_range` in each block.
- For run: compare actual pace against prescribed `target_range` in each block.
- For swim: compare actual pace/distance against prescribed sets.
- Score compliance: "Fully compliant", "Minor deviations" (within 10%), or "Significant deviation" (describe what differed and why it matters).

### RPE vs. Objective Data
- If the athlete logged perceived exertion (via Strava's "Perceived Exertion" field or suffer score), compare against objective HR/power data.
- Low HR + high RPE = potential overreaching, illness, or heat stress.
- High HR + low RPE = the athlete is fitter than they think, or data artifact.
- Flag mismatches and suggest what they might mean.

### Progression Signal
- Find the equivalent session from the previous week (same discipline + similar type + similar duration in the prior week's plan or activities).
- Compare: same power at lower HR = aerobic fitness improving. Same pace at lower HR = running economy improving. Higher power at same HR = threshold shifting.
- If no prior equivalent exists, note this and compare against baseline averages instead.

### Cadence & Technique Markers
- **Bike**: Average cadence, cadence variability. Low cadence on climbs vs. flats. Cadence during intervals vs. steady-state.
- **Run**: If cadence data exists, check against typical ranges (160-180 spm). Low cadence may correlate with overstriding.
- **Swim**: If stroke data exists, check stroke rate consistency and efficiency (distance per stroke).

8. Write `data/coach/reports/activity_<id>.md` with:
   - **Summary**: Activity type, duration, distance, key metrics (avg HR, avg power, avg pace as applicable).
   - **Zone Distribution**: Time-in-zone table with prescribed vs. actual comparison.
   - **Execution Analysis**: Pacing, drift, interval consistency findings.
   - **Prescription Compliance**: How closely the athlete followed the plan (if applicable).
   - **What Went Well**: Specific positives grounded in data (not generic praise).
   - **What to Improve**: Specific, actionable feedback with numeric targets.
   - **Progression Signal**: Comparison to prior equivalent session.
   - **Next Session Recommendations**: What to adjust in the next session of this type (intensity, pacing strategy, duration).
   - **Confidence & Data Notes**: What data was available, what was missing, and how that affects the analysis.

Always ground conclusions in fetched activity streams and Strava evidence. Never invent data -- if a stream is missing, say so and reduce confidence accordingly.
