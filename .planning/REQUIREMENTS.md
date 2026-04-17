# Requirements: Active Session Indicators

**Defined:** 2026-03-29
**Core Value:** The web UI accurately reflects what the agent is doing right now — users never have to guess whether an agent is running, idle, or in auto-mode.

## v1.1 Requirements

### Session Awareness

- [x] **SESS-10**: Project selector shows a "running" indicator (green dot + pulse) for projects with an active agent session
- [x] **SESS-11**: Project selector shows session details: current mode (auto/interactive), current phase/task when available
- [x] **SESS-12**: Session status updates in real-time via SSE (not just on page load)

### Auto-Mode State

- [x] **AUTO-01**: "Auto Mode Active/Inactive" label in dashboard correctly reflects the agent's actual auto-mode state
- [x] **AUTO-02**: "Start Auto" button shows "Auto Running" (disabled) when auto-mode is already active
- [x] **AUTO-03**: Auto-mode state change (start/stop/pause) reflects in the UI within 2 seconds

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-agent orchestration UI | Single-agent tool — one session per project |
| Historical session timeline | Future milestone — focus on live state first |
| Remote session control (start/stop from UI) | Already possible via chat commands |

## Traceability

| Requirement | Phase | Plan(s) | Status |
|------------|-------|---------|--------|
| SESS-10 | Phase 6 | - | Not started |
| SESS-11 | Phase 6 | - | Not started |
| SESS-12 | Phase 5 | - | Not started |
| AUTO-01 | Phase 6 | - | Not started |
| AUTO-02 | Phase 6 | - | Not started |
| AUTO-03 | Phase 6 | - | Not started |
