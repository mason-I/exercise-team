const fs = require("fs");
const path = require("path");
const { dumpJson, loadJson, parseDate, toIsoDate } = require("../../_shared/lib");

const LOAD_FACTORS = {
  sprint: 1.1,
  olympic: 1.2,
  half: 1.3,
  full: 1.4,
};

const TRI_SHARES = { bike: 0.55, run: 0.3, swim: 0.15 };

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    baseline: "baseline.json",
    calendar: "calendar.json",
    profile: "profile.json",
    output: "goal_analysis.json",
    outputMd: null,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--baseline") options.baseline = args[i + 1];
    if (arg === "--calendar") options.calendar = args[i + 1];
    if (arg === "--profile") options.profile = args[i + 1];
    if (arg === "--output") options.output = args[i + 1];
    if (arg === "--output-md") options.outputMd = args[i + 1];
  }
  return options;
}

function isTriGoal(profile) {
  const distances = profile?.goal?.event?.distances;
  if (!distances) return false;
  return (
    Number(distances.swim_km || 0) > 0 &&
    Number(distances.bike_km || 0) > 0 &&
    Number(distances.run_km || 0) > 0
  );
}

function currentLoadState(baseline) {
  const state = {};
  for (const discipline of ["run", "bike", "swim"]) {
    const load = baseline?.disciplines?.[discipline]?.load_points || {};
    state[discipline] = {
      weekly_load_points_median: load.weekly_median || 0,
      ctl_end: load.ctl_end || 0,
      atl_end: load.atl_end || 0,
      tsb_end: load.tsb_end || 0,
      confidence: baseline?.disciplines?.[discipline]?.confidence || "low",
      method_coverage: load.method_coverage || null,
    };
  }
  const totalWeekly =
    state.run.weekly_load_points_median +
    state.bike.weekly_load_points_median +
    state.swim.weekly_load_points_median;
  return {
    by_sport: state,
    overall: {
      weekly_load_points_median: Number(totalWeekly.toFixed(2)),
      ctl_end: Number((state.run.ctl_end + state.bike.ctl_end + state.swim.ctl_end).toFixed(2)),
      atl_end: Number((state.run.atl_end + state.bike.atl_end + state.swim.atl_end).toFixed(2)),
      tsb_end: Number((state.run.tsb_end + state.bike.tsb_end + state.swim.tsb_end).toFixed(2)),
    },
  };
}

function thresholdSummary(baseline) {
  return {
    ftp_w: baseline?.athlete_meta?.ftp_w || null,
    ftp_quality: baseline?.athlete_meta?.ftp_quality || "unknown",
    vthr_mps: baseline?.disciplines?.run?.threshold?.vthr_mps || null,
    vthr_quality: baseline?.disciplines?.run?.threshold?.quality || "unknown",
    lthr_bpm: baseline?.athlete_meta?.hr_lthr_bpm || null,
    lthr_quality: baseline?.athlete_meta?.hr_lthr_quality || "unknown",
    css_sec_per_100m: baseline?.disciplines?.swim?.threshold?.css_sec_per_100m || null,
    css_quality: baseline?.disciplines?.swim?.threshold?.quality || "unknown",
  };
}

function main() {
  const options = parseArgs();
  const baseline = loadJson(options.baseline);
  const calendar = loadJson(options.calendar);
  const profile = loadJson(options.profile);

  const raceType = calendar?.event?.race_type || profile?.goal?.event?.race_type || "full";
  const factor = LOAD_FACTORS[raceType] || 1.2;
  const triGoal = isTriGoal(profile);

  const currentState = currentLoadState(baseline);
  const targetTotalLoad = Number((currentState.overall.weekly_load_points_median * factor).toFixed(2));

  const targets = {
    total_load_points_peak: targetTotalLoad,
    bike_load_points_peak: triGoal ? Number((targetTotalLoad * TRI_SHARES.bike).toFixed(2)) : targetTotalLoad,
    run_load_points_peak: triGoal ? Number((targetTotalLoad * TRI_SHARES.run).toFixed(2)) : 0,
    swim_load_points_peak: triGoal ? Number((targetTotalLoad * TRI_SHARES.swim).toFixed(2)) : 0,
    total_endurance_hours_peak: baseline?.composite?.weekly?.total_endurance_hours_median || 0,
  };

  const rampRules = {
    run: baseline?.disciplines?.run?.confidence === "low" ? 0.05 : 0.1,
    bike: 0.1,
    swim: 0.15,
  };

  const analysis = {
    generated_at: toIsoDate(new Date()),
    race: {
      date: calendar?.event?.date || profile?.goal?.event?.date || null,
      race_type: raceType,
      distances: profile?.goal?.event?.distances || null,
    },
    baseline_snapshot: {
      run_weekly_km: baseline?.disciplines?.run?.weekly?.volume_median || 0,
      bike_weekly_hours: baseline?.disciplines?.bike?.weekly?.volume_median || 0,
      swim_weekly_km: baseline?.disciplines?.swim?.weekly?.volume_median || 0,
      run_long_km: baseline?.disciplines?.run?.long_session?.weekly_max_median || 0,
      bike_long_hours: baseline?.disciplines?.bike?.long_session?.weekly_max_median || 0,
      swim_long_km: baseline?.disciplines?.swim?.long_session?.weekly_max_median || 0,
      flags: baseline?.composite?.flags || {},
    },
    current_state: currentState,
    targets,
    ramp_rules: rampRules,
    thresholds_used: thresholdSummary(baseline),
  };

  dumpJson(options.output, analysis);

  if (options.outputMd) {
    const lines = [
      "# Goal Analysis",
      "",
      `Race: ${analysis.race.race_type}`,
      `Date: ${analysis.race.date || "unknown"}`,
      "",
      "## Current load",
      `- Total weekly load: ${analysis.current_state.overall.weekly_load_points_median}`,
      `- CTL/ATL/TSB: ${analysis.current_state.overall.ctl_end}/${analysis.current_state.overall.atl_end}/${analysis.current_state.overall.tsb_end}`,
      "",
      "## Targets",
      `- Total load peak: ${analysis.targets.total_load_points_peak}`,
      `- Bike load peak: ${analysis.targets.bike_load_points_peak}`,
      `- Run load peak: ${analysis.targets.run_load_points_peak}`,
      `- Swim load peak: ${analysis.targets.swim_load_points_peak}`,
      "",
      "## Ramp rules",
      `- Run: ${Math.round(rampRules.run * 100)}%`,
      `- Bike: ${Math.round(rampRules.bike * 100)}%`,
      `- Swim: ${Math.round(rampRules.swim * 100)}%`,
    ];
    fs.writeFileSync(options.outputMd, lines.join("\n").trim() + "\n", "utf-8");
  }
}

if (require.main === module) {
  main();
}
