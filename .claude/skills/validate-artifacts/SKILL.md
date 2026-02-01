---
name: validate-artifacts
description: Validates baseline, calendar, and plan artifacts against schema and safety rules after files change.
allowed-tools:
  - Bash(node .claude/skills/validate-artifacts/scripts/validate_artifacts.js*)
  - Bash(ls*)
  - Bash(cat*)
---

# Validating Artifacts

## Instructions
1. Run validation after plan or baseline updates.
2. Address any reported errors before proceeding.

## Command
```bash
node .claude/skills/validate-artifacts/scripts/validate_artifacts.js --latest-plan --skip-missing
```
