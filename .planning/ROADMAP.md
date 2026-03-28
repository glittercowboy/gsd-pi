# Roadmap: GSD Web Remote Access

## Overview

Four phases deliver secure remote access to the GSD web UI over a Tailscale tailnet. Password-based cookie authentication lands first because Tailscale's HTTPS context is what makes `Secure` cookies work — the auth primitives must exist before the HTTPS provider is wired up. Tailscale Serve integration follows, activating the `--tailscale` flag and exercising the full cookie auth path end-to-end. SSE cursor-based event replay is independent of auth and lands third, ensuring reconnecting browsers recover all missed agent output. The Remote Access settings UI and setup assistant close out v1 with discoverability and first-time Tailscale setup guidance.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Password Auth and Cookie Sessions** - Complete password-protected login flow with HMAC-signed session cookies
- [ ] **Phase 2: Tailscale Serve Integration** - `gsd --web --tailscale` exposes the app via HTTPS within the tailnet
- [ ] **Phase 3: SSE Cursor-Based Event Replay** - Reconnecting browsers recover all missed agent output from a persistent log
- [ ] **Phase 4: Remote Access Settings UI** - In-app Remote Access section with password management and Tailscale setup assistant

## Phase Details

### Phase 1: Password Auth and Cookie Sessions
**Goal**: Users can securely authenticate to the GSD web UI via a password prompt, maintain a 30-day session across browser restarts, and have their session immediately invalidated when the password changes — while localhost users experience no change to the existing bearer token flow
**Depends on**: Nothing (first phase)
**Requirements**: AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, AUTH-06, AUTH-07, AUTH-08, AUTH-09, AUTH-10
**Success Criteria** (what must be TRUE):
  1. User can set a password via GSD settings and it is stored as a scrypt hash (never plaintext)
  2. User visiting the web UI over HTTPS sees a login page with the GSD2 logo, enters the correct password, and is redirected to the main UI with an HttpOnly/Secure/SameSite=Strict cookie that persists across tab close and browser restart
  3. User submitting wrong passwords more than 5 times per minute receives a rate-limit error without triggering further verification overhead
  4. User can log out from the UI and immediately loses access (cookie cleared, subsequent requests redirected to login)
  5. After a password change, all existing sessions are invalid — previously authenticated browsers are redirected to the login page on their next request
**Plans**: 4 plans
Plans:
- [ ] 01-01-PLAN.md — Crypto module (password hashing, session tokens, secret management) + rate limiter
- [ ] 01-02-PLAN.md — Auth API routes (login/logout/status) + proxy.ts cookie auth extension
- [ ] 01-03-PLAN.md — Login gate UI component + page.tsx wiring
- [ ] 01-04-PLAN.md — Password storage service + session secret env injection
**UI hint**: yes

### Phase 2: Tailscale Serve Integration
**Goal**: `gsd --web --tailscale` starts the web server behind Tailscale Serve, prints the tailnet HTTPS URL to the terminal, enforces preflight checks, and cleans up Tailscale serve config on both graceful shutdown and crash recovery
**Depends on**: Phase 1
**Requirements**: TAIL-01, TAIL-02, TAIL-03, TAIL-04, TAIL-05, TAIL-06, TAIL-07, TAIL-08
**Success Criteria** (what must be TRUE):
  1. Running `gsd --web --tailscale` without Tailscale installed, without being connected, or without a password configured results in a clear preflight error message — the server does not start
  2. Running `gsd --web --tailscale` with all preflight checks passing prints `https://<hostname>.<tailnet>.ts.net` to the terminal and the URL is reachable from another device on the tailnet
  3. Pressing Ctrl+C or sending SIGTERM runs `tailscale serve reset` before the process exits — subsequent runs start clean without "background configuration already exists" errors
  4. Starting `gsd --web --tailscale` after a prior crash (orphaned serve config) recovers automatically via startup reset and reaches the running state without manual intervention
**Plans**: 2 plans
Plans:
- [ ] 02-01-PLAN.md — Tailscale CLI wrapper module (pure functions + I/O) with unit tests
- [ ] 02-02-PLAN.md — CLI flag parsing + web-mode.ts Tailscale lifecycle integration + tests

### Phase 3: SSE Cursor-Based Event Replay
**Goal**: Reconnecting browsers recover all agent output that occurred while the browser was closed, with a visible "Catching up..." indicator during replay, and stale cursors trigger a full state refresh rather than missed or duplicate events
**Depends on**: Phase 1
**Requirements**: SESS-01, SESS-02, SESS-03, SESS-04, SESS-05, SESS-06, SESS-07, SESS-08, SESS-09
**Success Criteria** (what must be TRUE):
  1. Closing the browser while an agent workflow is running, then reopening it, shows all agent output that occurred while the browser was closed — no events are missing
  2. The UI displays a "Catching up..." indicator from the moment of reconnect until live streaming resumes, then the indicator disappears
  3. Leaving the browser closed for an extended period (log rotation occurs) and then reconnecting triggers a full state refresh rather than an error or partial replay
  4. The JSONL event log on disk never exceeds ~60 MB in steady state — log rotation keeps the most recent 10 MB after exceeding 50 MB
**Plans**: 3 plans
Plans:
- [ ] 03-01-PLAN.md — EventLog module + bridge-service _seq wrapping and event persistence
- [ ] 03-02-PLAN.md — SSE endpoint cursor-based replay with live buffering and stale cursor handling
- [ ] 03-03-PLAN.md — Client cursor tracking in localStorage + catching-up banner UI

### Phase 4: Remote Access Settings UI
**Goal**: Users can manage their Remote Access configuration entirely within the GSD web UI — setting or changing their password, viewing Tailscale connection status and the tailnet URL, toggling Tailscale on/off, and following a guided assistant to install and connect Tailscale for the first time
**Depends on**: Phase 2, Phase 3
**Requirements**: SETT-01, SETT-02, SETT-03, SETT-04, SETT-05, TAIL-09, TAIL-10, TAIL-11
**Success Criteria** (what must be TRUE):
  1. GSD settings page contains a "Remote Access" section where the user can set or change their password without touching the CLI
  2. When Tailscale is connected, the Remote Access section displays the tailnet URL as a copyable link and shows an accurate connection status
  3. Clicking "Set up Tailscale" in settings launches a step-by-step assistant that detects the OS, provides the correct install command (brew on macOS, official script on Linux), runs `tailscale up`, surfaces the auth URL when browser login is required, and confirms successful connection with hostname and tailnet info
  4. Attempting to start `gsd --web --tailscale` without a password configured returns an error message that directs the user to set a password first
**Plans**: 3 plans
Plans:
- [ ] 04-01-PLAN.md — Password change API endpoint + Tailscale status API endpoint
- [ ] 04-02-PLAN.md — Tailscale setup assistant streaming API endpoint
- [ ] 04-03-PLAN.md — RemoteAccessPanel UI component + settings section registration
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Password Auth and Cookie Sessions | 0/4 | Planning complete | - |
| 2. Tailscale Serve Integration | 0/2 | Planning complete | - |
| 3. SSE Cursor-Based Event Replay | 0/3 | Planning complete | - |
| 4. Remote Access Settings UI | 0/3 | Planning complete | - |
