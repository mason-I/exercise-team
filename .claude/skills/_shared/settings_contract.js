#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");

const REQUIRED_TOP_LEVEL = {
  model: "opus",
  enabledPlugins: {
    "swift-lsp@claude-plugins-official": true,
  },
  autoUpdatesChannel: "latest",
  spinnerTipsEnabled: false,
};

const RUNTIME_REQUIRED_PERMISSIONS_ALLOW = [
  "Bash(bun:*)",
  "Bash(cat:*)",
  "Bash(ls:*)",
  "Bash(echo:*)",
  "Skill(schedule)",
  "Bash(source:*)",
  "Bash(env:*)",
  "Bash(date:*)",
];

const INSTALLER_REQUIRED_PERMISSIONS_ALLOW = [
  "Edit(data/coach/**)",
  "Read(data/coach/**)",
  "Bash(cat:*)",
  "Bash(ls:*)",
  "Bash(bun:*)",
  "Bash(bun .claude/skills/setup/scripts/setup_orchestrator.js*)",
  "Bash(bun .claude/skills/plan-week/scripts/build_scheduling_context.js*)",
  "Bash(date *)",
  "mcp__web-reader__*",
  "WebFetch",
];

const REQUIRED_HOOKS = {
  PreToolUse: [
    {
      matcher: "Bash",
      hooks: [
        {
          type: "command",
          command: "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/bash_runtime_guard.js",
        },
        {
          type: "command",
          command: "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/calendar_training_write_guard.js",
        },
      ],
    },
  ],
  SessionStart: [
    {
      matcher: "startup|resume",
      hooks: [
        {
          type: "command",
          command: "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/sessionstart_coach_warmup.js",
          timeout: 300,
        },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher: "Write|Edit",
      hooks: [
        {
          type: "command",
          command: "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/post_write_coach_guard.js",
        },
      ],
    },
    {
      matcher: "Bash",
      hooks: [
        {
          type: "command",
          command: "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/post_schedule_sanity_check.js",
        },
      ],
    },
  ],
  SubagentStop: [
    {
      matcher: "run-coach",
      hooks: [
        {
          type: "prompt",
          prompt:
            "You are validating a run-coach subagent response. Input: $ARGUMENTS\n\nCheck that the output is strict JSON and matches the contract:\n- top-level keys: session_updates (array), swap_suggestions (array), risk_flags (array)\n- each session_updates item includes session_id and patch object\n- each patch includes run_prescription and progression_trace\nIf invalid, respond {\"ok\": false, \"reason\": \"...\"}. If valid, respond {\"ok\": true}.",
        },
      ],
    },
    {
      matcher: "bike-coach",
      hooks: [
        {
          type: "prompt",
          prompt:
            "You are validating a bike-coach subagent response. Input: $ARGUMENTS\n\nCheck that the output is strict JSON and matches the contract:\n- top-level keys: session_updates (array), swap_suggestions (array), risk_flags (array)\n- each session_updates item includes session_id and patch object\n- each patch includes bike_prescription\nIf invalid, respond {\"ok\": false, \"reason\": \"...\"}. If valid, respond {\"ok\": true}.",
        },
      ],
    },
    {
      matcher: "swim-coach",
      hooks: [
        {
          type: "prompt",
          prompt:
            "You are validating a swim-coach subagent response. Input: $ARGUMENTS\n\nCheck that the output is strict JSON and matches the contract:\n- top-level keys: session_updates (array), swap_suggestions (array), risk_flags (array)\n- each session_updates item includes session_id and patch object\n- each patch includes swim_prescription\nIf invalid, respond {\"ok\": false, \"reason\": \"...\"}. If valid, respond {\"ok\": true}.",
        },
      ],
    },
    {
      matcher: "nutrition-coach",
      hooks: [
        {
          type: "prompt",
          prompt:
            "You are validating a nutrition-coach subagent response. Input: $ARGUMENTS\n\nCheck that the output is strict JSON and matches the contract:\n- top-level keys: session_updates (array), swap_suggestions (array), risk_flags (array)\n- each session_updates item includes session_id and patch object\n- each patch includes nutrition_prescription\nIf invalid, respond {\"ok\": false, \"reason\": \"...\"}. If valid, respond {\"ok\": true}.",
        },
      ],
    },
    {
      matcher: "strength-coach",
      hooks: [
        {
          type: "prompt",
          prompt:
            "You are validating a strength-coach subagent response. Input: $ARGUMENTS\n\nCheck that the output is strict JSON and matches the contract:\n- top-level keys: session_updates (array), swap_suggestions (array), risk_flags (array)\n- each session_updates item includes session_id and patch object\n- each patch includes title, intent, main_set (array), coach_notes, fallbacks (array), strength_prescription, and progression_trace\n- strength_prescription includes phase_mode, progression_decision, progression_comparison, exercises (array)\n- every exercises[] item includes exercise_name, category, injury_target, sport_transfer_target, sets, reps, tempo, rest_sec, and load\n- load includes method=rpe_rir, target_rpe, target_rir, progression_axis, regression_rule\nIf invalid, respond {\"ok\": false, \"reason\": \"...\"}. If valid, respond {\"ok\": true}.",
        },
      ],
    },
  ],
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function hookIdentity(hook) {
  const type = String(hook?.type || "").trim();
  if (type === "command") return `${type}:${String(hook.command || "").trim()}`;
  if (type === "prompt") return `${type}:${String(hook.prompt || "").trim()}`;
  return `${type}:${JSON.stringify(hook || {})}`;
}

function normalizeHookEntries(entries) {
  return asArray(entries)
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      matcher: String(entry.matcher || "").trim(),
      hooks: asArray(entry.hooks).filter((hook) => hook && typeof hook === "object").map((hook) => ({ ...hook })),
    }))
    .filter((entry) => entry.matcher);
}

function dedupeHooks(hooks) {
  const out = [];
  const seen = new Set();
  for (const hook of hooks) {
    const key = hookIdentity(hook);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(hook);
  }
  return out;
}

function mergeHookEvent(currentEntries, requiredEntries) {
  const merged = normalizeHookEntries(currentEntries);
  for (const requiredEntry of normalizeHookEntries(requiredEntries)) {
    const index = merged.findIndex((entry) => entry.matcher === requiredEntry.matcher);
    if (index === -1) {
      merged.push(deepClone(requiredEntry));
      continue;
    }

    const existingHooks = merged[index].hooks;
    for (const requiredHook of requiredEntry.hooks) {
      const key = hookIdentity(requiredHook);
      const existingIndex = existingHooks.findIndex((hook) => hookIdentity(hook) === key);
      if (existingIndex === -1) {
        existingHooks.push({ ...requiredHook });
        continue;
      }
      // Preserve user-defined extra fields while forcing required defaults.
      existingHooks[existingIndex] = {
        ...existingHooks[existingIndex],
        ...requiredHook,
      };
    }

    merged[index].hooks = dedupeHooks(existingHooks);
  }
  return merged;
}

function mergeSettingsWithContract(current, options = {}) {
  const base = asObject(current);
  const envPatch = asObject(options.envPatch);
  const requiredTopLevel = asObject(options.requiredTopLevel);
  const requiredHooks = asObject(options.requiredHooks);
  const requiredPermissionsAllow = uniqStrings([
    ...RUNTIME_REQUIRED_PERMISSIONS_ALLOW,
    ...asArray(options.requiredPermissionsAllow),
  ]);

  const next = deepClone(base);

  for (const [key, value] of Object.entries(requiredTopLevel)) {
    if (next[key] == null) {
      next[key] = deepClone(value);
    }
  }

  next.env = {
    ...asObject(base.env),
    ...envPatch,
  };

  const currentPermissions = asObject(base.permissions);
  next.permissions = {
    ...currentPermissions,
    allow: uniqStrings([
      ...asArray(currentPermissions.allow),
      ...requiredPermissionsAllow,
    ]),
  };

  const currentHooks = asObject(base.hooks);
  const mergedHooks = {
    ...deepClone(currentHooks),
  };
  for (const [eventName, requiredEntries] of Object.entries(requiredHooks)) {
    mergedHooks[eventName] = mergeHookEvent(currentHooks[eventName], requiredEntries);
  }
  next.hooks = mergedHooks;

  return next;
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function upsertSettingsFile(settingsPath, options = {}) {
  const absolute = path.resolve(settingsPath);
  const current = readJson(absolute, {});
  const next = mergeSettingsWithContract(current, {
    envPatch: options.envPatch || {},
    requiredTopLevel: options.requiredTopLevel || REQUIRED_TOP_LEVEL,
    requiredHooks: options.requiredHooks || REQUIRED_HOOKS,
    requiredPermissionsAllow: options.requiredPermissionsAllow || [],
  });
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return { settingsPath: absolute, current, next };
}

module.exports = {
  REQUIRED_TOP_LEVEL,
  REQUIRED_HOOKS,
  RUNTIME_REQUIRED_PERMISSIONS_ALLOW,
  INSTALLER_REQUIRED_PERMISSIONS_ALLOW,
  mergeSettingsWithContract,
  upsertSettingsFile,
  uniqStrings,
};
