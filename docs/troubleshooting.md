# Troubleshooting

## `/gsd doctor`

The built-in diagnostic tool validates `.gsd/` integrity:

```
/gsd doctor
```

It checks:
- File structure and naming conventions
- Roadmap ↔ slice ↔ task referential integrity
- Completion state consistency
- Git worktree health
- Stale lock files and orphaned runtime records

## Common Issues

### Auto mode loops on the same unit

**Symptoms:** The same unit (e.g., `research-slice` or `plan-slice`) dispatches repeatedly until hitting the dispatch limit.

**Causes:**
- Stale cache after a crash — the in-memory file listing doesn't reflect new artifacts
- The LLM didn't produce the expected artifact file

**Fix:** Run `/gsd doctor` to repair state, then resume with `/gsd auto`. If the issue persists, check that the expected artifact file exists on disk.

### Auto mode stops with "Loop detected"

**Cause:** A unit failed to produce its expected artifact twice in a row.

**Fix:** Check the task plan for clarity. If the plan is ambiguous, refine it manually, then `/gsd auto` to resume.

### Wrong files in worktree

**Symptoms:** Planning artifacts or code appear in the wrong directory.

**Cause:** The LLM wrote to the main repo instead of the worktree.

**Fix:** This was fixed in v2.14+. If you're on an older version, update. The dispatch prompt now includes explicit working directory instructions.

### `npm install -g gsd-pi` fails

**Common causes:**
- Missing workspace packages — fixed in v2.10.4+
- `postinstall` hangs on Linux (Playwright `--with-deps` triggering sudo) — fixed in v2.3.6+
- Node.js version too old — requires ≥ 20.6.0

### Provider errors during auto mode

**Symptoms:** Auto mode pauses with a provider error (rate limit, auth failure, etc.).

**Fix:** GSD automatically tries fallback models if configured. To add fallbacks:

```yaml
models:
  execution:
    model: claude-sonnet-4-6
    fallbacks:
      - openrouter/minimax/minimax-m2.5
```

### Budget ceiling reached

**Symptoms:** Auto mode pauses with "Budget ceiling reached."

**Fix:** Increase `budget_ceiling` in preferences, or switch to `budget` token profile to reduce per-unit cost, then resume with `/gsd auto`.

### Stale lock file

**Symptoms:** Auto mode won't start, says another session is running.

**Fix:** If no other session is actually running, delete `.gsd/auto.lock` manually. GSD includes stale lock detection (checks if the PID is still alive), but edge cases exist.

### Git merge conflicts

**Symptoms:** Worktree merge fails on `.gsd/` files.

**Fix:** GSD auto-resolves conflicts on `.gsd/` runtime files. For content conflicts in code files, the LLM is given an opportunity to resolve them via a fix-merge session. If that fails, manual resolution is needed.

## Recovery Procedures

### Reset auto mode state

```bash
rm .gsd/auto.lock
rm .gsd/completed-units.json
```

Then `/gsd auto` to restart from current disk state.

### Reset routing history

If adaptive model routing is producing bad results, clear the routing history:

```bash
rm .gsd/routing-history.json
```

### Full state rebuild

```
/gsd doctor
```

Doctor rebuilds `STATE.md` from plan and roadmap files on disk and fixes detected inconsistencies.

## Getting Help

- **GitHub Issues:** [github.com/gsd-build/GSD-2/issues](https://github.com/gsd-build/GSD-2/issues)
- **Dashboard:** `Ctrl+Alt+G` or `/gsd status` for real-time diagnostics
- **Session logs:** `.gsd/activity/` contains JSONL session dumps for crash forensics
