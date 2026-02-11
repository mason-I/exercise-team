#!/usr/bin/env bun

// Legacy shim: some flows call the training-load builder from setup/.
// Delegate to the canonical coach-sync implementation.

const path = require("path");
const { spawnSync } = require("child_process");

function main() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const target = path.join(projectDir, ".claude/skills/coach-sync/scripts/build_training_load.js");
  const args = process.argv.slice(2);

  const result = spawnSync(process.execPath, [target, ...args], {
    cwd: projectDir,
    env: process.env,
    stdio: "inherit",
  });

  const code = typeof result.status === "number" ? result.status : 1;
  process.exit(code);
}

if (require.main === module) {
  main();
}
