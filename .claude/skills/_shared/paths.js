const path = require("path");

const PATHS = {
  dataRoot: "data",
  coachRoot: "data/coach",
  systemRoot: "data/system",
  externalRoot: "data/external",
  stravaRoot: "data/external/strava",
  coach: {
    snapshot: "data/coach/strava_snapshot.json",
    weekContext: "data/coach/week_context.json",
    profile: "data/coach/profile.json",
    goals: "data/coach/goals.json",
    baseline: "data/coach/baseline.json",
    baselineRaw: "data/coach/baseline_raw.json",
    strategy: "data/coach/strategy.json",
    progressionState: "data/coach/progression_state.json",
    trainingLoad: "data/coach/training_load.json",
    macrocycle: "data/coach/macrocycle.json",
    outcomes: "data/coach/outcomes.json",
    plansDir: "data/coach/plans",
    checkinsDir: "data/coach/checkins",
    reportsDir: "data/coach/reports",
  },
  system: {
    installBootstrapState: "data/system/install/bootstrap_state.json",
    onboardingSession: "data/system/onboarding/session.json",
    sessionSyncState: "data/system/session_sync_state.json",
    userEnv: "data/system/user/env/user.env",
    stravaDir: "data/system/strava",
    stravaAthlete: "data/system/strava/athlete.json",
    stravaStats: "data/system/strava/stats.json",
    stravaZones: "data/system/strava/zones.json",
    stravaConfig: "data/system/strava/config.json",
    stravaInferredSchedule: "data/system/strava/schedule_preferences_inferred.json",
    calendarDir: "data/system/calendar",
    calendarConfig: "data/system/calendar/config.json",
    googleCalendarDir: "data/system/google_calendar",
    googleCalendarStartupAuth: "data/system/google_calendar/startup_auth_state.json",
  },
  external: {
    stravaActivities: "data/external/strava/activities.json",
    stravaStreamsDir: "data/external/strava/streams",
    stravaSyncState: "data/external/strava/sync_state.json",
    stravaRecentActivitiesTmp: "data/external/strava/.recent_activities.tmp.json",
  },
};

function resolveProjectPath(projectDir, relativePath) {
  return path.join(projectDir, ...String(relativePath).split("/"));
}

module.exports = {
  PATHS,
  resolveProjectPath,
};
