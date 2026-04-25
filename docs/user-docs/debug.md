# Debug Sessions

`/gsd debug` creates persistent debug sessions so you can investigate an issue across multiple turns without losing state.

## Quick Start

```bash
# Start a standard debug session (find + fix)
/gsd debug checkout returns 500 after login

# List all saved sessions
/gsd debug list

# Inspect one session
/gsd debug status checkout-returns-500-after-login

# Resume one session
/gsd debug continue checkout-returns-500-after-login

# Diagnose store health (all sessions)
/gsd debug --diagnose

# Diagnose one known session
/gsd debug --diagnose checkout-returns-500-after-login

# Start diagnose-only root-cause mode (no fix dispatch)
/gsd debug --diagnose checkout still returns 500 after oauth refresh
```

> **Note:** Debug artifacts are persisted at `.gsd/debug/sessions/<slug>.json`, so sessions survive across turns and can be resumed later.

## How It Works

`/gsd debug` parsing is strict for reserved subcommands (`list`, `status`, `continue`, `--diagnose`) and intentionally falls back to issue text when syntax is ambiguous.

- `list` is only treated as a subcommand when used exactly as `/gsd debug list`.
  - Example: `/gsd debug list flaky checkout retries` starts a new session with that full issue text.
- `status` and `continue` require exactly one valid `<slug>` argument.
  - Missing slug emits warnings:
    - `Missing slug. Usage: /gsd debug status <slug>`
    - `Missing slug. Usage: /gsd debug continue <slug>`
  - Any non-strict form (extra words, invalid slug shape) falls back to a normal issue-start session.
- `--diagnose` has dedicated modes:
  - `/gsd debug --diagnose` → store health diagnostics (malformed artifact counts + remediation hints)
  - `/gsd debug --diagnose <slug>` → targeted diagnostics for one session
  - `/gsd debug --diagnose <issue text>` (multi-token) → starts a new session in `mode=diagnose` with root-cause-only intent
- `/gsd debug --diagnose <single-non-slug-token>` is invalid and returns:
  - `Invalid diagnose target. Usage: /gsd debug --diagnose [<slug> | <issue text>]`

Unknown debug flags (for example `/gsd debug --wat`) return an explicit warning plus usage text.

## Subcommands

| Command | Behavior |
|---------|----------|
| `/gsd debug <issue-text>` | Start a new persistent debug session with `mode=debug` and actionable next steps (`status` / `continue`). |
| `/gsd debug list` | List healthy sessions plus malformed artifacts discovered under `.gsd/debug/sessions/`. |
| `/gsd debug status <slug>` | Show one session's mode, status, phase, issue, artifact path, log path, update time, and `lastError`. |
| `/gsd debug continue <slug>` | Resume an existing session and dispatch the next debug workflow turn unless the session is already resolved. |

## Flags

| Flag syntax | Behavior |
|-------------|----------|
| `/gsd debug --diagnose` | Run zero-argument health diagnostics over all debug session artifacts. |
| `/gsd debug --diagnose <slug>` | Diagnose one existing session and report targeted metadata. |
| `/gsd debug --diagnose <issue text>` | Start a new diagnose-only session (`mode=diagnose`) to find root cause without immediate fix dispatch. |

## Examples

### Start a session

```bash
/gsd debug auth token expires after refresh
```

### List sessions

```bash
/gsd debug list
```

### Check status

```bash
/gsd debug status auth-token-expires-after-refresh
```

### Continue

```bash
/gsd debug continue auth-token-expires-after-refresh
```

### Diagnose-only flows

```bash
# Global artifact health
/gsd debug --diagnose

# One existing session
/gsd debug --diagnose auth-token-expires-after-refresh

# New root-cause-only session (multi-word issue required)
/gsd debug --diagnose auth token still expires on safari
```

> **Note:** If a session slug is unknown, status/continue/targeted diagnose commands warn and recommend `/gsd debug list`.
