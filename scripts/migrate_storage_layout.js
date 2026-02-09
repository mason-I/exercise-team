#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { PATHS, resolveProjectPath } = require("../.claude/skills/_shared/paths");

function resolveProjectDir(explicitProjectDir = null) {
  if (explicitProjectDir) return path.resolve(explicitProjectDir);
  if (process.env.CLAUDE_PROJECT_DIR) return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  return path.resolve(__dirname, "..");
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    projectDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--project-dir") options.projectDir = String(argv[i + 1] || "").trim() || null;
  }
  return options;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function exists(target) {
  return fs.existsSync(target);
}

function removeIfExists(target) {
  if (!exists(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function moveFile(src, dst, result) {
  if (!exists(src)) {
    result.skipped.push({ type: "file", from: src, reason: "missing" });
    return;
  }
  ensureDir(path.dirname(dst));
  removeIfExists(dst);
  fs.renameSync(src, dst);
  result.moved.push({ type: "file", from: src, to: dst });
}

function moveDirContents(srcDir, dstDir, result) {
  if (!exists(srcDir)) {
    result.skipped.push({ type: "dir", from: srcDir, reason: "missing" });
    return;
  }
  ensureDir(dstDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      moveDirContents(src, dst, result);
      try {
        fs.rmdirSync(src);
      } catch {
        // ignore non-empty directories
      }
      continue;
    }
    removeIfExists(dst);
    fs.renameSync(src, dst);
    result.moved.push({ type: "entry", from: src, to: dst });
  }
  try {
    fs.rmdirSync(srcDir);
    result.removed.push(srcDir);
  } catch {
    // ignore non-empty directories
  }
}

function removeIfEmpty(dirPath, result) {
  if (!exists(dirPath)) return;
  try {
    if (fs.readdirSync(dirPath).length === 0) {
      fs.rmdirSync(dirPath);
      result.removed.push(dirPath);
    }
  } catch {
    // ignore
  }
}

function main() {
  const options = parseArgs();
  const projectDir = resolveProjectDir(options.projectDir);
  const result = {
    ok: true,
    project_dir: projectDir,
    moved: [],
    skipped: [],
    removed: [],
  };

  moveDirContents(path.join(projectDir, "coach"), resolveProjectPath(projectDir, PATHS.coachRoot), result);
  moveDirContents(path.join(projectDir, "state"), resolveProjectPath(projectDir, PATHS.systemRoot), result);
  moveFile(
    path.join(projectDir, "data", "strava_activities.json"),
    resolveProjectPath(projectDir, PATHS.external.stravaActivities),
    result
  );
  moveDirContents(
    path.join(projectDir, "data", "strava_streams"),
    resolveProjectPath(projectDir, PATHS.external.stravaStreamsDir),
    result
  );
  moveFile(
    path.join(projectDir, "data", "strava_sync_state.json"),
    resolveProjectPath(projectDir, PATHS.external.stravaSyncState),
    result
  );

  removeIfEmpty(path.join(projectDir, "coach"), result);
  removeIfEmpty(path.join(projectDir, "state"), result);
  removeIfEmpty(path.join(projectDir, "data"), result);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}
