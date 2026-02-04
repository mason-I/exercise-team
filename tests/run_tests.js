const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function run(cmd) {
  execSync(cmd, { stdio: "inherit" });
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function testBaselineLoadPoints() {
  const activities = [
    {
      id: 1,
      sport_type: "Run",
      start_date_local: "2026-02-01T07:00:00Z",
      distance: 5000,
      moving_time: 1500,
      average_speed: 3.33,
      average_heartrate: 150,
      max_heartrate: 175,
    },
    {
      id: 2,
      sport_type: "Ride",
      start_date_local: "2026-02-02T07:00:00Z",
      distance: 20000,
      moving_time: 3600,
      average_speed: 5.55,
      average_watts: 180,
      average_heartrate: 140,
      max_heartrate: 165,
    },
    {
      id: 3,
      sport_type: "Swim",
      start_date_local: "2026-02-03T07:00:00Z",
      distance: 1000,
      moving_time: 1800,
    },
    {
      id: 4,
      sport_type: "Run",
      start_date_local: "2026-01-25T07:00:00Z",
      distance: 4000,
      moving_time: 1400,
      average_speed: 2.85,
      average_heartrate: 148,
      max_heartrate: 170,
    },
    {
      id: 5,
      sport_type: "Ride",
      start_date_local: "2026-01-26T07:00:00Z",
      distance: 15000,
      moving_time: 3000,
      average_watts: 170,
      average_speed: 5.0,
      average_heartrate: 138,
      max_heartrate: 162,
    },
    {
      id: 6,
      sport_type: "Swim",
      start_date_local: "2026-01-27T07:00:00Z",
      distance: 800,
      moving_time: 1600,
    },
  ];

  const athlete = { sex: "M", weight: 70, ftp: 250, summit: false };
  writeJson("tests/fixtures/activities_basic.json", activities);
  writeJson("tests/fixtures/athlete_basic.json", athlete);

  run(
    [
      "node .claude/skills/compute-baseline/scripts/compute_baseline.js",
      "--input tests/fixtures/activities_basic.json",
      "--athlete tests/fixtures/athlete_basic.json",
      "--output-json tests/out/baseline_basic.json",
      "--output-md tests/out/baseline_basic.md",
      "--fetch-streams false",
      "--fetch-activity-details false",
      "--window-days 56",
    ].join(" ")
  );

  const baseline = loadJson("tests/out/baseline_basic.json");
  assert(baseline.disciplines.run.load_points, "run load points missing");
  assert(baseline.disciplines.bike.load_points, "bike load points missing");
  assert(baseline.disciplines.swim.load_points, "swim load points missing");
  assert(baseline.disciplines.run.load_points.ctl_end >= 0, "run ctl missing");
  assert(baseline.disciplines.bike.load_points.ctl_end >= 0, "bike ctl missing");
  assert(baseline.disciplines.swim.load_points.ctl_end >= 0, "swim ctl missing");
  assert(baseline.athlete_meta.hr_max_bpm, "hr max missing");

  const calendar = {
    event: { date: "2026-10-10", race_type: "full" },
    phases: [{ name: "base", start: "2026-01-01", end: "2026-12-31" }],
  };
  const profile = {
    goal: { event: { distances: { swim_km: 3.8, bike_km: 180, run_km: 42.2 } } },
  };
  writeJson("tests/fixtures/calendar_basic.json", calendar);
  writeJson("tests/fixtures/profile_basic.json", profile);

  run(
    [
      "node .claude/skills/analyze-goal/scripts/analyze_goal.js",
      "--baseline tests/out/baseline_basic.json",
      "--calendar tests/fixtures/calendar_basic.json",
      "--profile tests/fixtures/profile_basic.json",
      "--output tests/out/goal_analysis.json",
    ].join(" ")
  );
  const goalAnalysis = loadJson("tests/out/goal_analysis.json");
  assert(
    Object.prototype.hasOwnProperty.call(goalAnalysis.targets, "total_load_points_peak"),
    "goal analysis missing load targets"
  );
}

function testFtpEstimationFromCache() {
  const activities = [
    {
      id: 99,
      sport_type: "Ride",
      start_date_local: "2026-02-01T07:00:00Z",
      distance: 20000,
      moving_time: 3600,
      average_watts: null,
    },
  ];
  const athlete = { sex: "M", weight: 80, summit: false };
  writeJson("tests/fixtures/activities_no_ftp.json", activities);
  writeJson("tests/fixtures/athlete_no_ftp.json", athlete);

  const time = [];
  const watts = [];
  for (let i = 0; i <= 1200; i += 1) {
    time.push(i);
    watts.push(200);
  }
  const cachePath = "tests/cache/streams/99__time_watts.json";
  writeJson(cachePath, {
    fetched_at: new Date().toISOString(),
    activity_id: 99,
    keys: ["time", "watts"],
    response: {
      time: { data: time },
      watts: { data: watts },
    },
  });

  run(
    [
      "node .claude/skills/compute-baseline/scripts/compute_baseline.js",
      "--input tests/fixtures/activities_no_ftp.json",
      "--athlete tests/fixtures/athlete_no_ftp.json",
      "--output-json tests/out/baseline_no_ftp.json",
      "--fetch-streams true",
      "--streams-cache-dir tests/cache",
      "--streams-limit 5",
      "--fetch-activity-details false",
      "--window-days 56",
    ].join(" ")
  );

  const baseline = loadJson("tests/out/baseline_no_ftp.json");
  assert(baseline.athlete_meta.ftp_w, "ftp not estimated");
  assert(baseline.athlete_meta.ftp_source === "estimated_mp20", "ftp source not set");
}

function testBuildWeekSafety() {
  const baseline = {
    disciplines: {
      run: {
        units: { volume: "km" },
        weekly: { sessions_median: 2, volume_median: 6.4 },
        session: { distance_median: 3, duration_median_min: 18 },
        long_session: { weekly_max_median: 4.2 },
        confidence: "low",
        pace: { median_sec_per_km: 360 },
        threshold: { vthr_mps: 3.5, quality: "medium" },
      },
      bike: {
        units: { volume: "hours" },
        weekly: { sessions_median: 3, volume_median: 7 },
        session: { distance_median: 30, duration_median_min: 90 },
        long_session: { weekly_max_median: 3.5 },
        confidence: "medium",
        threshold: { ftp_w_band: [200, 240], quality: "medium" },
      },
      swim: {
        units: { volume: "km" },
        weekly: { sessions_median: 0, volume_median: 0 },
        session: { distance_median: 0, duration_median_min: 0 },
        long_session: { weekly_max_median: 0 },
        confidence: "low",
        pace: { median_sec_per_100m: 180 },
        threshold: { css_sec_per_100m: null, quality: "unknown" },
      },
    },
    composite: { flags: { high_cardio_low_impact: true } },
    transfer: { run_intro_weekly_time_min_range: [45, 90], run_easy_pace_sec_per_km_range: [360, 420] },
    restart: { week1: { run: { volume_cap: 5, long_cap: 3 } } },
  };
  const profile = {
    preferences: { rest_day: "sunday" },
    goal: { event: { distances: { swim_km: 3.8, bike_km: 180, run_km: 42.2 } } },
    nutrition: { daily_calories_target: 0, notes: "" },
  };
  const calendar = {
    phases: [{ name: "base", start: "2026-01-01", end: "2026-12-31" }],
  };

  writeJson("tests/fixtures/baseline_plan.json", baseline);
  writeJson("tests/fixtures/profile_tri.json", profile);
  writeJson("tests/fixtures/calendar_base.json", calendar);

  run(
    [
      "node .claude/skills/build-week/scripts/build_week.js 2026-02-02",
      "--baseline tests/fixtures/baseline_plan.json",
      "--profile tests/fixtures/profile_tri.json",
      "--calendar tests/fixtures/calendar_base.json",
      "--output-dir tests/out/plans",
    ].join(" ")
  );

  const plan = loadJson("tests/out/plans/2026-02-02.json");
  const restDay = 0; // Sunday UTC in parseDate context
  const longCounts = { run: 0, bike: 0, swim: 0 };
  let swimDurationValid = true;
  let runCapValid = true;

  for (const session of plan.sessions) {
    const day = new Date(session.date).getUTCDay();
    assert(day !== restDay, "session on rest day");
    if (session.type === "long") longCounts[session.discipline] += 1;
    if (session.discipline === "swim" && (!session.duration_min || session.duration_min <= 0)) {
      swimDurationValid = false;
    }
    if (session.discipline === "run" && session.distance_km_cap == null) {
      runCapValid = false;
    }
  }
  assert(longCounts.run <= 1 && longCounts.bike <= 1 && longCounts.swim <= 1, "duplicate long sessions");
  assert(swimDurationValid, "swim duration invalid");
  assert(runCapValid, "run distance cap missing");
}

function testAnalyzeStravaAsOfAndSessionMatching() {
  const baseline = {
    athlete_meta: { ftp_w: 250, hr_lthr_bpm: 160 },
    disciplines: {
      run: { threshold: { vthr_mps: 3.5 } },
      bike: { threshold: {} },
      swim: { threshold: { css_sec_per_100m: 120 } },
    },
  };
  const plan = {
    week_start: "2026-02-02",
    targets: {
      run: { sessions: 2, volume_km: 10, volume_min: 60, load_points: 1.2 },
      bike: { sessions: 1, volume_hours: 2, load_points: 1.5 },
      swim: { sessions: 1, volume_km: 2, volume_min: 25, load_points: 0.8 },
    },
    sessions: [
      { date: "2026-02-02", discipline: "run", type: "easy", duration_min: 30, distance_km: 5 },
      { date: "2026-02-03", discipline: "bike", type: "easy", duration_min: 60 },
      { date: "2026-02-04", discipline: "swim", type: "easy", duration_min: 25, distance_km: 1.4 },
      { date: "2026-02-05", discipline: "run", type: "long", duration_min: 30, distance_km: 5 },
    ],
  };
  const activities = [
    {
      id: 201,
      name: "Morning Run",
      sport_type: "Run",
      start_date_local: "2026-02-02T07:00:00",
      distance_m: 5200,
      moving_time_sec: 1920,
      average_grade_adjusted_speed: 2.7,
    },
    {
      id: 202,
      name: "Lunch Ride",
      sport_type: "Ride",
      start_date_local: "2026-02-03T12:00:00",
      distance_m: 21000,
      moving_time_sec: 3300,
      average_watts: 175,
    },
    {
      id: 203,
      name: "Extra Shakeout",
      sport_type: "Run",
      start_date_local: "2026-02-04T16:00:00",
      distance_m: 3000,
      moving_time_sec: 1200,
    },
    {
      id: 204,
      name: "Pool Laps",
      sport_type: "Swim",
      start_date_local: "2026-02-04T06:00:00",
      distance_m: 1500,
      moving_time_sec: 1800,
      pace_sec_per_100m: 120,
    },
  ];

  writeJson("tests/fixtures/baseline_analyze.json", baseline);
  writeJson("tests/fixtures/plans/2026-02-02.json", plan);
  writeJson("tests/fixtures/activities_week.json", activities);

  run(
    [
      "node .claude/skills/analyze-strava/scripts/analyze_strava.js 2026-02-02",
      "--activities tests/fixtures/activities_week.json",
      "--baseline tests/fixtures/baseline_analyze.json",
      "--plan-dir tests/fixtures/plans",
      "--output-dir tests/out/reports_asof",
      "--as-of-date 2026-02-04",
      "--write-daily-report",
      "--daily-output-dir tests/out/reports_asof/daily",
      "--write-activity-reports",
      "--activity-report-dir tests/out/reports_asof/activities",
    ].join(" ")
  );

  const wtdPath = "tests/out/reports_asof/wtd/2026-02-02-asof-2026-02-04.md";
  assert(fs.existsSync(wtdPath), "wtd report missing");
  const wtdReport = fs.readFileSync(wtdPath, "utf-8");
  assert(wtdReport.includes("Mode: week-to-date"), "wtd mode missing");
  assert(wtdReport.includes("## Session Matching"), "session matching section missing");
  assert(wtdReport.includes("## Unplanned Activities"), "unplanned section missing");
  assert(wtdReport.includes("Extra Shakeout"), "unplanned activity not captured");

  const dailyPath = "tests/out/reports_asof/daily/2026-02-04.md";
  assert(fs.existsSync(dailyPath), "daily report missing");
  const activityDebriefPath = "tests/out/reports_asof/activities/201.md";
  assert(fs.existsSync(activityDebriefPath), "activity debrief missing");
}

function testSyncStravaActivitiesMerge() {
  writeJson("tests/out/sync/activities.json", [
    {
      id: 1,
      name: "Old Name",
      sport_type: "Run",
      start_date_local: "2026-02-01T07:00:00",
      distance_m: 5000,
      moving_time_sec: 1500,
    },
    {
      id: 2,
      name: "Ride Existing",
      sport_type: "Ride",
      start_date_local: "2026-02-02T07:00:00",
      distance_m: 20000,
      moving_time_sec: 3600,
    },
  ]);
  writeJson("tests/fixtures/recent_sync_batch.json", [
    {
      id: 1,
      name: "Updated Name",
      sport_type: "Run",
      start_date_local: "2026-02-01T07:00:00",
      distance_m: 5100,
      moving_time_sec: 1520,
    },
    {
      id: 3,
      name: "New Swim",
      sport_type: "Swim",
      start_date_local: "2026-02-03T07:00:00",
      distance_m: 1500,
      moving_time_sec: 2100,
    },
  ]);

  run(
    [
      "node .claude/skills/setup/scripts/sync_strava_activities.js",
      "--activities tests/out/sync/activities.json",
      "--state tests/out/sync/state.json",
      "--fetched-input tests/fixtures/recent_sync_batch.json",
      "--start-date 2026-01-31",
      "--end-date 2026-02-03",
    ].join(" ")
  );

  const merged = loadJson("tests/out/sync/activities.json");
  assert(merged.length === 3, "merged activity count incorrect");
  const updated = merged.find((act) => act.id === 1);
  assert(updated && updated.name === "Updated Name", "existing activity was not updated");

  const state = loadJson("tests/out/sync/state.json");
  assert(state.fetched_count === 2, "fetched count missing from state");
  assert(state.merged_count === 3, "merged count missing from state");
  assert(state.last_successful_sync_at, "state timestamp missing");
}

function main() {
  fs.rmSync("tests/out", { recursive: true, force: true });
  fs.mkdirSync("tests/out", { recursive: true });
  testBaselineLoadPoints();
  testFtpEstimationFromCache();
  testBuildWeekSafety();
  testAnalyzeStravaAsOfAndSessionMatching();
  testSyncStravaActivitiesMerge();
  console.log("All tests passed.");
}

if (require.main === module) {
  main();
}
