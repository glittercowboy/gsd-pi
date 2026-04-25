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
- Git worktree health (worktree and branch modes only — skipped in none mode)
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

### `command not found: gsd` after install

**Symptoms:** `npm install -g gsd-pi` succeeds but `gsd` isn't found.

**Cause:** npm's global bin directory isn't in your shell's `$PATH`.

**Fix:**

```bash
# Find where npm installed the binary
npm prefix -g
# Output: /opt/homebrew (Apple Silicon) or /usr/local (Intel Mac)

# Add the bin directory to your PATH if missing
echo 'export PATH="$(npm prefix -g)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

**Workaround:** Run `npx gsd-pi` or `$(npm prefix -g)/bin/gsd` directly.

**Common causes:**
- **Homebrew Node** — `/opt/homebrew/bin` should be in PATH but sometimes isn't if Homebrew init is missing from your shell profile
- **Version manager (nvm, fnm, mise)** — global bin is version-specific; ensure your version manager initializes in your shell config
- **oh-my-zsh** — the `gitfast` plugin aliases `gsd` to `git svn dcommit`. Check with `alias gsd` and unalias if needed

### `npm install -g gsd-pi` fails

**Common causes:**
- Missing workspace packages — fixed in v2.10.4+
- `postinstall` hangs on Linux (Playwright `--with-deps` triggering sudo) — fixed in v2.3.6+
- Node.js version too old — requires ≥ 22.0.0

### Provider errors during auto mode

**Symptoms:** Auto mode pauses with a provider error (rate limit, server error, auth failure).

**How GSD handles it (v2.26):**

| Error type | Auto-resume? | Delay |
|-----------|-------------|-------|
| Rate limit (429, "too many requests") | ✅ Yes | retry-after header or 60s |
| Server error (500, 502, 503, "overloaded") | ✅ Yes | 30s |
| Auth/billing ("unauthorized", "invalid key") | ❌ No | Manual resume |

For transient errors, GSD pauses briefly and resumes automatically. For permanent errors, configure fallback models:

```yaml
models:
  execution:
    model: claude-sonnet-4-6
    fallbacks:
      - openrouter/minimax/minimax-m2.5
```

**Headless mode:** `gsd headless auto` auto-restarts the entire process on crash (default 3 attempts with exponential backoff). Combined with provider error auto-resume, this enables true overnight unattended execution.

For common provider setup issues (role errors, streaming errors, model ID mismatches), see the [Provider Setup Guide — Common Pitfalls](./providers.md#common-pitfalls).

### Budget ceiling reached

**Symptoms:** Auto mode pauses with "Budget ceiling reached."

**Fix:** Increase `budget_ceiling` in preferences, or switch to `budget` token profile to reduce per-unit cost, then resume with `/gsd auto`.

### Stale lock file

**Symptoms:** Auto mode won't start, says another session is running.

**Fix:** GSD automatically detects stale locks — if the owning PID is dead, the lock is cleaned up and re-acquired on the next `/gsd auto`. This includes stranded `.gsd.lock/` directories left by `proper-lockfile` after crashes. If automatic recovery fails, delete `.gsd/auto.lock` and the `.gsd.lock/` directory manually:

```bash
rm -f .gsd/auto.lock
rm -rf "$(dirname .gsd)/.gsd.lock"
```

### Git merge conflicts

**Symptoms:** Worktree merge fails on `.gsd/` files.

**Fix:** GSD auto-resolves conflicts on `.gsd/` runtime files. For content conflicts in code files, the LLM is given an opportunity to resolve them via a fix-merge session. If that fails, manual resolution is needed.

### Pre-dispatch says the milestone integration branch no longer exists

**Symptoms:** Auto mode or `/gsd doctor` reports that a milestone recorded an integration branch that no longer exists in git.

**What it means:** The milestone's `.gsd/milestones/<MID>/<MID>-META.json` still points at the branch that was active when the milestone started, but that branch has since been renamed or deleted.

**Current behavior:**
- If GSD can deterministically recover to a safe branch, it no longer hard-stops auto mode.
- Safe fallbacks are:
  - explicit `git.main_branch` when configured and present
  - the repo's detected default integration branch (for example `main` or `master`)
- In that case `/gsd doctor` reports a warning and `/gsd doctor fix` rewrites the stale metadata to the effective branch.
- GSD still blocks when no safe fallback branch can be determined.

**Fix:**
- Run `/gsd doctor fix` to rewrite the stale milestone metadata automatically when the fallback is obvious.
- If GSD still blocks, recreate the missing branch or update your git preferences so `git.main_branch` points at a real branch.

### Transient `EBUSY` / `EPERM` / `EACCES` while writing `.gsd/` files

**Symptoms:** On Windows, auto mode or doctor occasionally fails while updating `.gsd/` files with errors like `EBUSY`, `EPERM`, or `EACCES`.

**Cause:** Antivirus, indexers, editors, or filesystem watchers can briefly lock the destination or temp file just as GSD performs the atomic rename.

**Current behavior:** GSD now retries those transient rename failures with a short bounded backoff before surfacing an error. The retry is intentionally limited so genuine filesystem problems still fail loudly instead of hanging forever.

**Fix:**
- Re-run the operation; most transient lock races clear quickly.
- If the error persists, close tools that may be holding the file open and then retry.
- If repeated failures continue, run `/gsd doctor` to confirm the repo state is still healthy and report the exact path + error code.

### Node v24 web boot failure

**Symptoms:** `gsd --web` fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` on Node v24.

**Cause:** Node v24 changed type-stripping behavior for `node_modules`, breaking the Next.js web build.

**Fix:** Fixed in v2.42.0+ (#1864). Upgrade to the latest version.

### Orphan web server process

**Symptoms:** `gsd --web` fails because port 3000 is already in use, even though no GSD session is running.

**Cause:** A previous web server process was not cleaned up on exit.

**Fix:** Fixed in v2.42.0+. GSD now cleans up stale web server processes automatically. If you're on an older version, kill the orphan process manually: `lsof -ti:3000 | xargs kill`.

### Non-JS project blocked by worktree health check

**Symptoms:** Worktree health check fails or blocks auto-mode in projects that don't use Node.js (e.g., Rust, Go, Python).

**Cause:** The worktree health check only recognized JavaScript ecosystems prior to v2.42.0.

**Fix:** Fixed in v2.42.0+ (#1860). The health check now supports 17+ ecosystems. Upgrade to the latest version.

### German/non-English locale git errors

**Symptoms:** Git commands fail or produce unexpected results when the system locale is non-English (e.g., German).

**Cause:** GSD parsed git output assuming English locale strings.

**Fix:** Fixed in v2.42.0+. All git commands now force `LC_ALL=C` to ensure consistent English output regardless of system locale.

## MCP Client Issues

### `mcp_servers` shows no configured servers

**Symptoms:** `mcp_servers` reports no servers configured.

**Common causes:**
- No `.mcp.json` or `.gsd/mcp.json` file exists in the current project
- The config file is malformed JSON
- The server is configured in a different project directory than the one where you launched GSD

**Fix:**
- Add the server to `.mcp.json` or `.gsd/mcp.json`
- Verify the file parses as JSON
- Re-run `mcp_servers(refresh=true)`

### `mcp_discover` times out

**Symptoms:** `mcp_discover` fails with a timeout.

**Common causes:**
- The server process starts but never completes the MCP handshake
- The configured command points to a script that hangs on startup
- The server is waiting on an unavailable dependency or backend service

**Fix:**
- Run the configured command directly outside GSD and confirm the server actually starts
- Check that any backend URLs or required services are reachable
- For local custom servers, verify the implementation is using an MCP SDK or a correct stdio protocol implementation

### `mcp_discover` reports connection closed

**Symptoms:** `mcp_discover` fails immediately with a connection-closed error.

**Common causes:**
- Wrong executable path
- Wrong script path
- Missing runtime dependency
- The server crashes before responding

**Fix:**
- Verify `command` and `args` paths are correct and absolute
- Run the command manually to catch import/runtime errors
- Check that the configured interpreter or runtime exists on the machine

### `mcp_call` fails because required arguments are missing

**Symptoms:** A discovered MCP tool exists, but calling it fails validation because required fields are missing.

**Common causes:**
- The call shape is wrong
- The target server's tool schema changed
- You're calling a stale server definition or stale branch build

**Fix:**
- Re-run `mcp_discover(server="name")` and confirm the exact required argument names
- Call the tool with `mcp_call(server="name", tool="tool_name", args={...})`
- If you're developing GSD itself, rebuild after schema changes with `npm run build`

### Local stdio server works manually but not in GSD

**Symptoms:** Running the server command manually seems fine, but GSD can't connect.

**Common causes:**
- The server depends on shell state that GSD doesn't inherit
- Relative paths only work from a different working directory
- Required environment variables exist in your shell but not in the MCP config

**Fix:**
- Use absolute paths for `command` and script arguments
- Set required environment variables in the MCP config's `env` block
- If needed, set `cwd` explicitly in the server definition

### Session lock stolen by `/gsd` in another terminal

**Symptoms:** Running `/gsd` (step mode) in a second terminal causes a running auto-mode session to lose its lock.

**Fix:** Fixed in v2.36.0. Bare `/gsd` no longer steals the session lock from a running auto-mode session. Upgrade to the latest version.

### Worktree commits landing on main instead of milestone branch

**Symptoms:** Auto-mode commits in a worktree end up on `main` instead of the `milestone/<MID>` branch.

**Fix:** Fixed in v2.37.1. CWD is now realigned before dispatch and stale merge state is cleaned on failure. Upgrade to the latest version.

### Extension loader fails with subpath export error

**Symptoms:** Extension fails to load with a `Cannot find module` error referencing npm subpath exports.

**Cause:** Dynamic imports in the extension loader didn't resolve npm subpath exports (e.g., `@pkg/foo/bar`).

**Fix:** Fixed in v2.38+. The extension loader now auto-resolves npm subpath exports and creates a `node_modules` symlink for dynamic import resolution. Upgrade to the latest version.

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
- **Forensics:** `/gsd forensics` for structured post-mortem analysis of auto-mode failures
- **Session logs:** `.gsd/activity/` contains JSONL session dumps for crash forensics

## iTerm2-Specific Issues

### Ctrl+Alt shortcuts trigger the wrong action (e.g., Ctrl+Alt+G opens external editor instead of GSD dashboard)

**Symptoms:** Pressing Ctrl+Alt+G opens the external editor prompt (Ctrl+G) instead of the GSD dashboard. Other Ctrl+Alt shortcuts behave as their Ctrl-only counterparts.

**Cause:** iTerm2's default Left Option Key setting is "Normal", which swallows the Alt modifier for Ctrl+Alt key combinations. The terminal receives only the Ctrl key, so Ctrl+Alt+G arrives as Ctrl+G.

**Fix:** In iTerm2, go to **Profiles → Keys → General** and set **Left Option Key** to **Esc+**. This makes Alt/Option send an escape prefix that terminal applications can detect, enabling Ctrl+Alt shortcuts to work correctly.

## Windows-Specific Issues

### LSP returns ENOENT on Windows (MSYS2/Git Bash)

**Symptoms:** LSP initialization fails with `ENOENT` or resolves POSIX-style paths like `/c/Users/...` instead of `C:\Users\...`.

**Cause:** The `which` command in MSYS2/Git Bash returns POSIX paths that Node.js `spawn()` can't resolve.

**Fix:** Updated in v2.29+ to use `where.exe` on Windows. Upgrade to the latest version.

### EBUSY errors during WXT/extension builds

**Symptoms:** `EBUSY: resource busy or locked, rmdir .output/chrome-mv3` when building browser extensions.

**Cause:** A Chromium browser has the extension loaded from the build output directory, preventing deletion.

**Fix:** Close the browser extension, or set a different `outDirTemplate` in your WXT config to avoid the locked directory.

## Database Issues

### "GSD database is not available"

**Symptoms:** `gsd_decision_save` (or its alias `gsd_save_decision`), `gsd_requirement_update` (or `gsd_update_requirement`), or `gsd_summary_save` (or `gsd_save_summary`) fail with this error.

**Cause:** The SQLite database wasn't initialized. This happens in manual `/gsd` sessions (non-auto mode) on versions before v2.29.

**Fix:** Updated in v2.29+ to auto-initialize the database on first tool call. Upgrade to the latest version.

## Verification Issues

### Verification gate fails with shell syntax error

**Symptoms:** `stderr: /bin/sh: 1: Syntax error: "(" unexpected` during verification checks.

**Cause:** A description-like string (e.g., `All 10 checks pass (build, lint)`) was treated as a shell command. This can happen when task plans have `verify:` fields with prose instead of actual commands.

**Fix:** Updated in v2.29+ to filter preference commands through `isLikelyCommand()`. Ensure `verification_commands` in preferences contains only valid shell commands, not descriptions.

## LSP (Language Server Protocol)

### "LSP isn't available in this workspace"

GSD auto-detects language servers based on project files (e.g. `package.json` → TypeScript, `Cargo.toml` → Rust, `go.mod` → Go). If no servers are detected, the agent skips LSP features.

**Check status:**
```
lsp status
```

This shows which servers are active and, if none are found, diagnoses why — including which project markers were detected but which server commands are missing.

**Common fixes:**

| Project type | Install command |
|-------------|-----------------|
| TypeScript/JavaScript | `npm install -g typescript-language-server typescript` |
| Python | `pip install pyright` or `pip install python-lsp-server` |
| Rust | `rustup component add rust-analyzer` |
| Go | `go install golang.org/x/tools/gopls@latest` |

After installing, run `lsp reload` to restart detection without restarting GSD.

## Notifications

### Notifications not appearing on macOS

**Symptoms:** `notifications.enabled: true` in preferences, but no desktop notifications appear during auto-mode (no milestone complete alerts, no budget warnings, no error notifications). No error messages logged.

**Cause:** GSD uses `osascript display notification` as a fallback on macOS. This command is attributed to your terminal app (Ghostty, iTerm2, Alacritty, Kitty, Warp, etc.). If that app doesn't have notification permissions in System Settings → Notifications, macOS silently drops the notification — `osascript` exits 0 with no error.

Most terminal apps don't appear in the Notifications settings panel until they've successfully delivered at least one notification, creating a chicken-and-egg problem.

**Fix (recommended):** Install `terminal-notifier`, which registers as its own Notification Center app:

```bash
brew install terminal-notifier
```

GSD automatically prefers `terminal-notifier` when available. On first use, macOS will prompt you to allow notifications — this is the expected behavior.

**Fix (alternative):** Go to **System Settings → Notifications** and enable notifications for your terminal app. If your terminal doesn't appear in the list, try sending a test notification from Terminal.app first to register "Script Editor":

```bash
osascript -e 'display notification "test" with title "GSD"'
```

**Verify:** After applying either fix, test with:

```bash
terminal-notifier -title "GSD" -message "working!" -sound Glass
```

### Telegram notifications not arriving

**Symptoms:** Auto-mode is running, Telegram is configured as the remote channel, but milestone completions, budget alerts, and other informational notifications are not appearing in the Telegram chat.

**Causes and fixes:**

- **`notifications.enabled` is not set** — ensure `notifications.enabled: true` is present in preferences alongside the `remote_questions` configuration. Informational notifications require both to be set.
- **Bot token is incorrect or expired** — run `/gsd remote status` to confirm the configuration is saved, then `/gsd remote telegram` to re-run setup and re-validate the token.
- **Bot is not a member of the target chat** — the bot must be added to the group chat (or the configured chat ID must match a private chat with the bot). Send `/help` directly to the bot in Telegram to confirm it is reachable.
- **Wrong `channel_id`** — verify the chat ID in `~/.gsd/PREFERENCES.md` matches the chat where you expect notifications. For group chats, the ID is typically a negative number (e.g., `-1001234567890`).
- **Network or firewall issue** — GSD must be able to reach `api.telegram.org`. Test with `curl https://api.telegram.org` from the machine running GSD.

### Telegram commands not responding

**Symptoms:** Sending `/status`, `/pause`, or other Telegram commands to the bot produces no response.

**Causes and fixes:**

- **Auto-mode is not running** — background polling only operates while auto-mode is active. Start auto-mode with `/gsd auto` and then retry the command.
- **Wrong chat** — commands are only processed from the chat configured in `remote_questions.channel_id`. Confirm you are sending from the correct chat.
- **Bot token mismatch** — the `TELEGRAM_BOT_TOKEN` environment variable or the token in `~/.gsd/PREFERENCES.md` may not match the bot you are messaging. Run `/gsd remote status` to confirm which bot token is active.
- **Polling not started** — if GSD was already running when the Telegram configuration was added, restart auto-mode (`/gsd stop`, then `/gsd auto`) so polling initializes with the new configuration.
- **Send `/help` first** — if the bot responds to `/help`, polling is working correctly. If a specific command like `/pause` does not respond, check for typos (commands are case-sensitive).
