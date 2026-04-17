# Roadmap: GSD Web Remote Access

## Milestones

- ✅ **v1.0 GSD Web Remote Access** - Phases 1-4 (shipped 2026-03-28)
- 🚧 **v1.1 Active Session Indicators** - Phases 5-6 (in progress)

## Phases

<details>
<summary>✅ v1.0 GSD Web Remote Access (Phases 1-4) - SHIPPED 2026-03-28</summary>

### Phase 1: Password Auth and Cookie Sessions
**Goal**: Users can authenticate to the web UI over Tailscale with a password and stay logged in
**Plans**: 3 plans

Plans:
- [x] 01-01: Password hashing, session tokens, storage (node:crypto)
- [x] 01-02: Auth API routes and Edge-compatible middleware
- [x] 01-03: LoginGate component with dual-mode authFetch

### Phase 2: Tailscale Serve Integration
**Goal**: `gsd --web --tailscale` provisions HTTPS access within the tailnet and cleans up on exit
**Plans**: 2 plans

Plans:
- [x] 02-01: Tailscale lifecycle (preflight, serve, cleanup)
- [x] 02-02: CLI flag wiring and web-mode integration

### Phase 3: SSE Cursor-Based Event Replay
**Goal**: Reconnecting browser replays missed events and resumes live stream seamlessly
**Plans**: 3 plans

Plans:
- [x] 03-01: JSONL event log with monotonic sequence numbers
- [x] 03-02: SSE endpoint with cursor replay and ceiling protocol
- [x] 03-03: Frontend cursor tracking and CatchingUpBanner

### Phase 4: Remote Access Settings UI
**Goal**: User can manage password and Tailscale configuration from the GSD settings panel
**Plans**: 4 plans (+ plan 00 stubs)

Plans:
- [x] 04-00: Test stubs
- [x] 04-01: Password change API endpoint
- [x] 04-02: Tailscale status and setup assistant API
- [x] 04-03: Remote Access settings section (password form, status badge, URL, setup assistant)
- [x] 04-04: Integration and cross-phase wiring

</details>

---

### 🚧 v1.1 Active Session Indicators (In Progress)

**Milestone Goal:** The web UI accurately reflects what the agent is doing right now — active sessions visible in the project selector, auto-mode state correct in the dashboard, all updated in real time.

## Phase Details

### Phase 5: Session State API
**Goal**: The backend exposes agent session state (mode, phase, task) so the frontend has something real to display
**Depends on**: Phase 4
**Requirements**: SESS-12
**Success Criteria** (what must be TRUE):
  1. GET /api/session/state returns the agent's current mode (auto/interactive/idle), current phase, and current task for the active project
  2. SSE stream emits a `session_state` event whenever agent mode, phase, or task changes
  3. Session state reflects actual BridgeService / RPC subprocess state, not the stale `auto?.active` workspace flag
**Plans**: 2 plans

Plans:
- [x] 05-01-PLAN.md — GET /api/session/state endpoint and test scaffold
- [x] 05-02-PLAN.md — SSE session_state events extension and full integration test

### Phase 6: Active Session UI
**Goal**: Project selector shows running sessions with details and dashboard controls accurately reflect auto-mode state
**Depends on**: Phase 5
**Requirements**: SESS-10, SESS-11, AUTO-01, AUTO-02, AUTO-03
**Success Criteria** (what must be TRUE):
  1. Project selector displays a green pulsing dot next to any project with an active agent session
  2. Hovering or viewing a running project shows its current mode and phase/task (when available)
  3. The "Auto Mode Active/Inactive" label in the dashboard matches actual agent auto-mode state
  4. "Start Auto" button reads "Auto Running" and is disabled while auto-mode is active
  5. Any auto-mode state change (start, stop, pause) is reflected in the UI within 2 seconds without a page reload
**Plans**: 3 plans

Plans:
- [x] 06-01-PLAN.md — SessionStatePayload type and session_state store handler
- [x] 06-02-PLAN.md — Three-state button (Start/Stop/Resume) with spinner in dashboard, sidebar, chat-mode
- [x] 06-03-PLAN.md — ProjectCard session badge (green/amber/gray dot) and session subtitle

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Password Auth and Cookie Sessions | v1.0 | 3/3 | Complete | 2026-03-28 |
| 2. Tailscale Serve Integration | v1.0 | 2/2 | Complete | 2026-03-28 |
| 3. SSE Cursor-Based Event Replay | v1.0 | 3/3 | Complete | 2026-03-28 |
| 4. Remote Access Settings UI | v1.0 | 4/4 | Complete | 2026-03-28 |
| 5. Session State API | v1.1 | 2/2 | Complete   | 2026-03-29 |
| 6. Active Session UI | v1.1 | 0/3 | Not started | - |
