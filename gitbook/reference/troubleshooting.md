# Troubleshooting

## `/gsd doctor`

The built-in diagnostic tool validates `.gsd/` integrity:

```
/gsd doctor
```

It checks file structure, roadmap ↔ slice ↔ task consistency, completion state, git health, stale locks, and orphaned records.

## Common Issues

### Auto mode loops on the same unit

The same unit dispatches repeatedly.

**Fix:** Run `/gsd doctor` to repair state, then `/gsd auto`. If it persists, check that the expected artifact file exists on disk.

### Auto mode stops with "Loop detected"

A unit failed to produce its expected artifact twice.

**Fix:** Check the task plan for clarity. Refine it manually, then `/gsd auto`.

### `command not found: gsd` after install

npm's global bin directory isn't in `$PATH`.

**Fix:**
```bash
npm prefix -g
# Add the bin dir to PATH:
echo 'export PATH="$(npm prefix -g)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

**Common causes:**
- **Homebrew Node** — `/opt/homebrew/bin` missing from PATH
- **Version manager (nvm, fnm, mise)** — global bin is version-specific
- **oh-my-zsh** — `gitfast` plugin aliases `gsd` to `git svn dcommit`; check with `alias gsd`

### Provider errors during auto mode

| Error Type | Auto-Resume? | Delay |
|-----------|-------------|-------|
| Rate limit (429) | Yes | 60s or retry-after header |
| Server error (500, 502, 503) | Yes | 30s |
| Auth/billing ("unauthorized") | No | Manual resume required |

For permanent errors, configure fallback models:

```yaml
models:
  execution:
    model: claude-sonnet-4-6
    fallbacks:
      - openrouter/minimax/minimax-m2.5
```

### Budget ceiling reached

Auto mode pauses with "Budget ceiling reached."

**Fix:** Increase `budget_ceiling` in preferences, or switch to `budget` token profile, then `/gsd auto`.

### Stale lock file

Auto mode won't start, says another session is running.

**Fix:** GSD auto-detects stale locks (dead PID = auto cleanup). If automatic recovery fails:

```bash
rm -f .gsd/auto.lock
rm -rf "$(dirname .gsd)/.gsd.lock"
```

### Git merge conflicts

Worktree merge fails on `.gsd/` files.

**Fix:** `.gsd/` conflicts are auto-resolved. Code conflicts get an AI fix attempt; if that fails, resolve manually.

### Notifications not appearing on macOS

**Fix:** Install `terminal-notifier`:

```bash
brew install terminal-notifier
```

See [Notifications](../configuration/notifications.md) for details.

## MCP Issues

### No servers configured

**Fix:** Add server to `.mcp.json` or `.gsd/mcp.json`, verify JSON is valid, run `mcp_servers(refresh=true)`.

### Server discovery times out

**Fix:** Run the configured command outside GSD to confirm it starts. Check that backend services are reachable.

### Server connection closed immediately

**Fix:** Verify `command` and `args` paths are correct and absolute. Run the command manually to catch errors.

## Recovery Procedures

### Reset auto mode state

```bash
rm .gsd/auto.lock
rm .gsd/completed-units.json
```

Then `/gsd auto` to restart from current state.

### Reset routing history

```bash
rm .gsd/routing-history.json
```

### Full state rebuild

```
/gsd doctor
```

Rebuilds `STATE.md` from plan and roadmap files and fixes inconsistencies.

## Getting Help

- **GitHub Issues:** [github.com/gsd-build/GSD-2/issues](https://github.com/gsd-build/GSD-2/issues)
- **Dashboard:** `Ctrl+Alt+G` or `/gsd status`
- **Forensics:** `/gsd forensics` for post-mortem analysis
- **Session logs:** `.gsd/activity/` contains JSONL session dumps

## Platform-Specific Issues

### iTerm2

`Ctrl+Alt` shortcuts trigger wrong actions → Set **Profiles → Keys → General → Left Option Key** to **Esc+**.

### Windows

- LSP ENOENT on MSYS2/Git Bash → Fixed in v2.29+, upgrade
- EBUSY errors during builds → Close browser extension, or change output directory
- Transient EBUSY/EPERM on `.gsd/` files → Retry; close file-locking tools if persistent
