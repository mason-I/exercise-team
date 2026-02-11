#!/usr/bin/env bun

const fs = require("fs");

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf-8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function main() {
  const input = readStdinJson();
  if (input?.hook_event_name !== "PreToolUse" || input?.tool_name !== "Bash") return;

  const command = String(input?.tool_input?.command || "").trim();
  if (!command) return;

  // Disallow Python runtime usage in this project so planning does not depend on Python availability.
  if (/\bpython(?:3)?\b/.test(command)) {
    process.stderr.write(
      "Blocked Bash command: Python is not allowed in this project.\n" +
        "Use JavaScript/Bun or existing coach env values (e.g. COACH_WEEK_START) instead.\n"
    );
    process.exit(2);
  }

  // Enforce Bun runtime for JavaScript execution.
  if (/\b(?:node|npx)\b/.test(command)) {
    process.stderr.write(
      "Blocked Bash command: node/npx are not allowed in this project.\n" +
        "Use Bun instead (bun, bun run, bun -e, bunx).\n"
    );
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}
