# Web Remote Access — Password Auth, Persistent Sessions, Tailscale Integration

**Date:** 2026-03-28
**Status:** Draft

## Goal

Make `gsd --web` usable as the primary interaction method over Tailscale. Today it's localhost-only with ephemeral token auth. After this work: password-protected, cookie-based sessions that survive browser close, with full message replay on reconnect, served over HTTPS via Tailscale Serve.

## Non-Goals

- Multi-user auth / user accounts
- Public internet exposure (Tailscale Funnel)
- WebSocket migration (SSE stays)
- Mobile-specific UI adaptations

---

## 1. Password Authentication

### 1.1 Password Storage

- New setting `web.passwordHash` in GSD settings infrastructure (managed via `gsd --settings` or the web settings UI)
- Stored as a **bcrypt hash**, never plaintext
- When setting the password, the CLI/UI prompts for input and stores the hash

### 1.2 Login Flow

1. Unauthenticated request hits any route
2. App shell loads, detects no valid session cookie or bearer token
3. Renders login gate: GSD2 logo + password field (no username — single-user tool)
4. User submits password via `POST /api/auth/login`
5. Server bcrypt-compares against `web.passwordHash`
6. On success: sets an `HttpOnly; Secure; SameSite=Strict` cookie containing a signed session token
7. Redirects to the app

### 1.3 Session Token

- Cookie contains `{ createdAt, expiresAt }` signed with HMAC-SHA256
- Signing secret stored in `~/.gsd/web-session-secret`, auto-generated on first use
- Secret persists across server restarts so sessions survive restarts
- Cookie max-age: **30 days**
- Changing the password regenerates the signing secret, invalidating all sessions

### 1.4 Logout

- `POST /api/auth/logout` clears the cookie
- Accessible from a menu item in the UI

### 1.5 Backward Compatibility

- Existing token-in-URL mechanism stays for localhost access
- Proxy middleware checks: cookie first, then bearer token fallback
- Localhost without `--tailscale` works exactly as today
- The `Secure` cookie flag requires HTTPS, so cookie auth only works over Tailscale Serve. On plain HTTP localhost, the existing bearer token mechanism is the auth path. The login page only appears when accessed over HTTPS (i.e., via Tailscale).

---

## 2. Tailscale Serve Integration

### 2.1 CLI Flag

`gsd --web --tailscale` activates Tailscale mode:

1. Binds Next.js server to `127.0.0.1` (Tailscale Serve reverse-proxies to it)
2. Runs `tailscale serve --bg https+insecure://127.0.0.1:<port>`
3. Auto-detects Tailscale hostname via `tailscale status --json`
4. Auto-configures allowed origins from the Tailscale hostname
5. Prints the URL: `https://<hostname>.<tailnet>.ts.net`

### 2.2 HTTPS

`tailscale serve` terminates TLS with auto-provisioned Let's Encrypt certs. The Next.js server stays HTTP internally. The `Secure` cookie flag works because the browser sees HTTPS.

### 2.3 Daemon Mode

`--tailscale` implies `GSD_WEB_DAEMON_MODE=1` — the server does not shut down when the browser tab closes. Stays running until `gsd web stop` or process kill.

### 2.4 Cleanup

On graceful shutdown, runs `tailscale serve reset` to remove the serve configuration. Crashed processes leave a harmless entry pointing to a dead port.

### 2.5 Preflight Checks

Before starting, verifies:

- `tailscale` CLI is available on PATH
- Tailscale is connected (`tailscale status` succeeds)
- Password is configured (`web.passwordHash` exists)
- Prints clear error with next steps if any check fails

### 2.6 Tailscale Setup Assistant

A guided setup flow accessible from the "Remote Access" settings section. Steps:

1. **Detect installation:** Check if `tailscale` CLI exists
2. **Install if missing:**
   - macOS: `brew install tailscale`
   - Linux: official install script (`curl -fsSL https://tailscale.com/install.sh | sh`)
3. **Connect:** Run `tailscale up`. If browser auth is required, surface the auth URL in the UI
4. **Verify:** Run `tailscale status` to confirm connection, display hostname and tailnet name

Each step shows what command it will run, asks for confirmation, executes, and displays the result. Works on macOS and Linux (Debian, Ubuntu, Fedora, Arch via the official install script).

### 2.7 Free Plan Compatibility

Uses `tailscale serve` only (tailnet-internal). Does **not** use Tailscale Funnel (requires paid plan, exposes to public internet). The web UI is accessible only from devices on the user's tailnet.

---

## 3. Persistent Sessions — Full Replay on Reconnect

### 3.1 Event Log

The bridge service appends each `BridgeEvent` as a JSONL line to:

```
~/.gsd/web-events/<project-hash>/events.jsonl
```

Each event gets a monotonic sequence number. Logging runs regardless of whether a browser is connected.

### 3.2 Cursor-Based Catch-Up

SSE endpoint gains an optional `since` parameter:

```
GET /api/session/events?since=<seqNo>
```

1. Browser stores last-seen sequence number in `localStorage`
2. On reconnect, sends its cursor
3. Server replays all events since that cursor, then switches to live streaming
4. If cursor is missing (fresh browser), gets current state only — same as today

### 3.3 What Gets Replayed

All events that produce visible UI changes:

- Message updates (chat messages, agent output)
- Bridge status changes
- Terminal output
- Live state invalidations

Internal bookkeeping events are excluded from replay.

### 3.4 Log Rotation

When the event log exceeds **50MB**, truncate to the most recent **10MB**. Clients whose cursor is older than the oldest retained event get a full state refresh instead of replay.

### 3.5 Reconnect UX

- Brief "Catching up..." indicator while replaying
- Chat log fills in with missed messages
- Scrolls to where the user left off
- Transitions to live streaming when caught up

---

## 4. Login Page UI

### 4.1 Design

- Centered card on dark background (matches GSD existing dark theme)
- GSD2 logo at the top
- Single password input field, "Enter" key submits
- "Log in" button below
- Error state: subtle shake animation + "Wrong password" text

### 4.2 Gate Order

Login gate sits **before** the onboarding gate. Flow:

```
Login gate ──▶ Onboarding gate ──▶ App shell
```

Two separate gates, not merged. The login gate is a new component.

---

## 5. Settings Integration

### 5.1 New "Remote Access" Section

In `gsd --settings` and the web settings UI:

| Setting | Description |
|---------|-------------|
| Password | "Set password" / "Change password" — prompts for input, stores bcrypt hash |
| Tailscale | Enable/disable toggle, shows connection status |
| Tailscale setup | "Set up Tailscale" button — launches guided install + connect assistant |
| Tailscale URL | Displays `https://<hostname>.<tailnet>.ts.net` (copyable) |

### 5.2 Storage

| Key | Location | Purpose |
|-----|----------|---------|
| `web.passwordHash` | GSD settings | bcrypt hash of the password |
| `web.tailscale` | GSD settings | Enable Tailscale mode |
| `~/.gsd/web-session-secret` | Separate file | HMAC signing key for session cookies |

### 5.3 Guard Rails

- `gsd --web --tailscale` refuses to start without a password set
- Directs user to `gsd --settings` or local web UI to configure

---

## 6. Data Flow

```
Browser (tailnet device)
  │
  │ HTTPS (TLS terminated by tailscale serve)
  ▼
tailscale serve (:443 ──▶ 127.0.0.1:<port>)
  │
  │ HTTP
  ▼
Next.js Server (proxy.ts middleware)
  │
  ├─ Cookie session? ──▶ valid HMAC? ──▶ pass
  ├─ Bearer token? ──▶ matches env? ──▶ pass
  └─ Neither ──▶ 401 ──▶ login page
  │
  ▼
/api/auth/login     ──▶ bcrypt verify ──▶ set cookie
/api/auth/logout    ──▶ clear cookie
/api/session/events ──▶ replay from cursor ──▶ live SSE
```

## 7. Changes by File

| Area | Change Type |
|------|-------------|
| `proxy.ts` | Modify — add cookie validation path before existing token check |
| `web/lib/auth.ts` | Modify — add cookie-aware auth detection |
| `web/app/api/auth/` | New — login, logout endpoints |
| `web/components/gsd/login-gate.tsx` | New — login gate component |
| `src/web/bridge-service.ts` | Modify — add event logging to disk |
| `web/app/api/session/events/route.ts` | Modify — add cursor-based replay |
| `src/web-mode.ts` | Modify — add `--tailscale` flag, `tailscale serve` lifecycle |
| `src/cli-web-branch.ts` | Modify — parse `--tailscale` flag |
| `src/web/settings-service.ts` | Modify — add password + tailscale settings |
| Settings UI components | Modify — add "Remote Access" section with setup assistant |
| `web/lib/gsd-workspace-store.tsx` | Modify — store/send last-seen sequence number |
| Existing localhost flow | Unchanged |

## 8. Security Considerations

- Password never stored in plaintext — bcrypt only
- Session cookie is `HttpOnly` (no JS access), `Secure` (HTTPS only), `SameSite=Strict` (no CSRF)
- HMAC signing secret is per-installation, auto-generated
- Tailscale provides network-layer encryption and device authentication
- No public internet exposure — `tailscale serve` is tailnet-only
- Password change invalidates all sessions (secret rotation)
- Rate limiting on `/api/auth/login` to prevent brute force (e.g., 5 attempts per minute)
