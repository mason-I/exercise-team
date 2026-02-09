#!/usr/bin/env bun

const path = require("path");
const { spawnSync } = require("child_process");

const targetScript = path.join(__dirname, "../../onboard/scripts/strava_auth.js");
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [targetScript, ...args], {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status == null ? 1 : result.status);
