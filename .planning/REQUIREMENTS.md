# Requirements: GSD Web Remote Access

**Defined:** 2026-03-28
**Core Value:** Agent workflows run uninterrupted when the browser is closed — reconnect anytime from any device on the tailnet and pick up where you left off.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Authentication

- [x] **AUTH-01**: User can set a password via GSD settings (CLI or web UI), stored as scrypt hash
- [x] **AUTH-02**: User can log in via a password prompt page with GSD2 logo
- [x] **AUTH-03**: Successful login sets an HttpOnly/Secure/SameSite=Strict session cookie (30-day lifetime)
- [x] **AUTH-04**: Session cookie is HMAC-SHA256 signed with an auto-generated server secret
- [x] **AUTH-05**: Login endpoint is rate-limited (5 attempts per minute)
- [x] **AUTH-06**: User can log out (clears cookie) from the UI
- [x] **AUTH-07**: Changing password rotates signing secret, invalidating all existing sessions
- [x] **AUTH-08**: Proxy middleware checks cookie first, then bearer token — localhost flow unchanged
- [x] **AUTH-09**: Auth endpoints (`/api/auth/*`) are exempt from token/cookie auth checks
- [x] **AUTH-10**: HMAC comparison uses timing-safe equality to prevent timing attacks

### Tailscale Integration

- [x] **TAIL-01**: `gsd --web --tailscale` flag activates Tailscale Serve mode
- [x] **TAIL-02**: Preflight checks verify Tailscale CLI installed, connected, and password configured
- [x] **TAIL-03**: Auto-detects Tailscale hostname via `tailscale status --json` and configures allowed origins
- [x] **TAIL-04**: Runs `tailscale serve --bg` to expose the app via HTTPS within the tailnet
- [x] **TAIL-05**: Prints the Tailscale URL (`https://<hostname>.<tailnet>.ts.net`) on startup
- [x] **TAIL-06**: Runs `tailscale serve reset` on startup (clean orphaned config from prior crashes)
- [x] **TAIL-07**: Runs `tailscale serve reset` on graceful shutdown (SIGTERM/SIGINT)
- [x] **TAIL-08**: `--tailscale` implies daemon mode (server stays alive when browser closes)
- [ ] **TAIL-09**: Setup assistant detects Tailscale installation and guides install (brew on macOS, official script on Linux)
- [ ] **TAIL-10**: Setup assistant runs `tailscale up` and surfaces auth URL if browser login required
- [ ] **TAIL-11**: Setup assistant verifies connection and displays hostname/tailnet info

### Session Persistence

- [ ] **SESS-01**: Bridge service appends each BridgeEvent to a JSONL event log with monotonic sequence numbers
- [ ] **SESS-02**: Event logging runs regardless of whether a browser is connected
- [ ] **SESS-03**: SSE endpoint accepts optional `since` query parameter for cursor-based replay
- [ ] **SESS-04**: On reconnect, browser sends last-seen sequence number and receives missed events
- [ ] **SESS-05**: Live events include sequence number (`_seq`) for client-side cursor tracking
- [ ] **SESS-06**: Client stores last-seen sequence number in localStorage
- [ ] **SESS-07**: Event log rotates when exceeding 50MB (keeps most recent 10MB)
- [ ] **SESS-08**: Clients with expired cursors (older than oldest log entry) get full state refresh
- [ ] **SESS-09**: UI shows "Catching up..." indicator during replay, transitions to live when done

### Settings

- [ ] **SETT-01**: "Remote Access" section in GSD settings with password set/change
- [ ] **SETT-02**: Tailscale enable/disable toggle with connection status display
- [ ] **SETT-03**: "Set up Tailscale" button launches guided setup assistant
- [ ] **SETT-04**: Displays Tailscale URL (copyable) when connected
- [x] **SETT-05**: `gsd --web --tailscale` refuses to start without a password configured

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Security Enhancements

- **SECV2-01**: Session audit log (login timestamps, source IPs)
- **SECV2-02**: Configurable session lifetime (currently hardcoded to 30 days)
- **SECV2-03**: Active session list with remote logout capability

### UX Enhancements

- **UXV2-01**: Browser push notifications when agent needs input (while tab is backgrounded)
- **UXV2-02**: Telegram notifications when agent completes or needs input (while browser is closed)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-user accounts | Single-user tool — one password for the owner |
| Tailscale Funnel (public exposure) | Requires paid plan; security risk for a dev tool |
| WebSocket migration | SSE works well, auto-reconnects, simpler protocol |
| OAuth/SSO integration | Password behind Tailscale is sufficient auth |
| Mobile-specific UI | Web UI is responsive enough for occasional mobile use |
| Session sliding window | OWASP warns against — fixed 30-day expiry is safer |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 1 | Complete |
| AUTH-02 | Phase 1 | Complete |
| AUTH-03 | Phase 1 | Complete |
| AUTH-04 | Phase 1 | Complete |
| AUTH-05 | Phase 1 | Complete |
| AUTH-06 | Phase 1 | Complete |
| AUTH-07 | Phase 1 | Complete |
| AUTH-08 | Phase 1 | Complete |
| AUTH-09 | Phase 1 | Complete |
| AUTH-10 | Phase 1 | Complete |
| TAIL-01 | Phase 2 | Complete |
| TAIL-02 | Phase 2 | Complete |
| TAIL-03 | Phase 2 | Complete |
| TAIL-04 | Phase 2 | Complete |
| TAIL-05 | Phase 2 | Complete |
| TAIL-06 | Phase 2 | Complete |
| TAIL-07 | Phase 2 | Complete |
| TAIL-08 | Phase 2 | Complete |
| TAIL-09 | Phase 4 | Pending |
| TAIL-10 | Phase 4 | Pending |
| TAIL-11 | Phase 4 | Pending |
| SESS-01 | Phase 3 | Pending |
| SESS-02 | Phase 3 | Pending |
| SESS-03 | Phase 3 | Pending |
| SESS-04 | Phase 3 | Pending |
| SESS-05 | Phase 3 | Pending |
| SESS-06 | Phase 3 | Pending |
| SESS-07 | Phase 3 | Pending |
| SESS-08 | Phase 3 | Pending |
| SESS-09 | Phase 3 | Pending |
| SETT-01 | Phase 4 | Pending |
| SETT-02 | Phase 4 | Pending |
| SETT-03 | Phase 4 | Pending |
| SETT-04 | Phase 4 | Pending |
| SETT-05 | Phase 2 | Complete |

**Coverage:**
- v1 requirements: 35 total
- Mapped to phases: 35
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-28*
*Last updated: 2026-03-28 after roadmap creation*
