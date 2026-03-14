# ci_monitor.cjs

Cross-platform GitHub Actions CI monitoring tool. Pure Node.js — no shell commands.

## Usage

```bash
node scripts/ci_monitor.cjs <command>
```

**Before using:** Run `--help` to discover available arguments.

## Routing Table

| When You Need | Command |
|---------------|---------|
| List recent runs | `runs [--branch <name>]` |
| Monitor running workflow | `watch <run-id>` |
| Fail fast in scripts | `fail-fast <run-id>` |
| See why run failed | `log-failed <run-id>` |
| Test pass/fail counts | `test-summary <run-id>` |
| Check action versions | `check-actions <workflow-file>` |
| Search logs | `grep <run-id> --pattern <regex>` |
| Wait for deployment | `wait-for <run-id> <job> --keyword <text>` |
| Compare runs | `compare <run-id-1> <run-id-2>` |

## Validation Principle

**"No errors" is not validation.** Use observable output:

```bash
# NOT just "success" - show specific output
node scripts/ci_monitor.cjs test-summary <run-id>
node scripts/ci_monitor.cjs grep <run-id> --pattern "TypeError"
```

## Why Not Just Use `gh run`?

- **Observable output** — test-summary extracts counts, grep shows context
- **fail-fast** — exits 1 on first failure (for scripts)
- **GraphQL batching** — check-actions queries all versions in one request
- **Cross-platform** — no shell interpolation, works on Windows
