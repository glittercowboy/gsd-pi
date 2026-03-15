# S03: Live freshness and recovery diagnostics — UAT

**Milestone:** M002
**Written:** 2026-03-15

## UAT Type

- UAT mode: mixed
- Why this mode is sufficient: S03 is mostly about truthfulness and recovery visibility, so the right acceptance check is a real local `gsd --web` launch plus targeted route and browser-surface inspection rather than a broad subjective UX pass.

## Preconditions

- `npm run build:web-host` has passed.
- A current-project `.gsd/` workspace exists in the repo root.
- Browser mode can unlock for the current project (either real auth is configured already or a test-only auth file is preseeded for local runtime validation).
- No other process is already bound to the chosen local web port.

## Smoke Test

Launch `gsd --web`, wait for the workspace shell to render, and verify that clicking the dashboard recovery entrypoint opens the dedicated recovery panel instead of a dead control or a fallback terminal-only path.

## Test Cases

### 1. Live workspace surfaces stay fresh from targeted live state

1. Launch `gsd --web` from the current project.
2. Wait for the shell to show a connected bridge state.
3. Confirm the dashboard, sidebar, roadmap, and status bar all render non-empty current-project state.
4. Trigger a short live lifecycle boundary that should refresh targeted state — for example, finish a short prompt/turn or exercise a retry/compaction boundary in an existing current-project session.
5. Watch these markers without manually reloading the page:
   - `data-testid="dashboard-current-unit"`
   - `data-testid="dashboard-retry-freshness"`
   - `data-testid="sidebar-validation-count"`
   - `data-testid="roadmap-workspace-freshness"`
   - `data-testid="status-bar-retry-compaction"`
6. **Expected:** The visible panels update from live state after the lifecycle boundary, stale markers clear after their targeted refresh, and the workspace does not need a full manual page reload.

### 2. Targeted live-state routes stay narrow and inspectable

1. With the local host running, request `GET /api/boot`.
2. Request `GET /api/live-state?domain=auto&domain=workspace`.
3. Compare the payload shapes.
4. **Expected:** `/api/boot` stays a broad startup snapshot, while `/api/live-state` returns only the narrow targeted payload needed for live browser freshness instead of re-sending the whole boot contract.

### 3. Recovery diagnostics are browser-native and actionable

1. In the running workspace, click `data-testid="dashboard-recovery-summary-entrypoint"` or `data-testid="sidebar-recovery-summary-entrypoint"`.
2. Wait for `data-testid="command-surface-recovery"` to appear.
3. Inspect the recovery surface state markers:
   - `data-testid="command-surface-recovery-state"`
   - `data-testid="command-surface-recovery-last-failure"`
   - `data-testid="command-surface-recovery-action-refresh_diagnostics"`
   - `data-testid="command-surface-recovery-action-open_retry_controls"`
   - `data-testid="command-surface-recovery-action-open_resume_controls"`
   - `data-testid="command-surface-recovery-action-open_auth_controls"`
4. Request `GET /api/recovery` directly.
5. **Expected:** The recovery panel shows a visible load/ready/stale/error state, exposes actionable browser controls, and the route returns structured counts/codes/phases/actions without raw transcript text, full doctor dumps, or secrets.

### 4. Live invalidation semantics remain inspectable over SSE

1. Open `GET /api/session/events` with an SSE-capable client while the workspace is running.
2. Trigger one agent lifecycle boundary and one auto lifecycle boundary.
3. Capture the resulting `live_state_invalidation` events.
4. **Expected:** The SSE payloads include explicit `reason`, `source`, `domains`, and `workspaceIndexCacheInvalidated` fields so the browser’s refresh behavior is explainable and testable.

## Edge Cases

### Recovery panel survives a refresh boundary cleanly

1. Open the recovery panel.
2. Refresh the browser tab or briefly disconnect/reconnect the page.
3. Re-open the recovery panel if needed.
4. **Expected:** The page performs at most one soft boot refresh to recover, the recovery surface shows an inspectable load or stale state while reloading, and the panel does not devolve into an inert control.

### Session mutation invalidation stays narrow

1. With the workspace open, perform a session mutation such as new session, switch session, fork, or rename.
2. Observe the visible session-related browser surfaces.
3. **Expected:** Resumable-session and related browser surfaces refresh, but the workspace does not appear to fall back to whole-page or whole-boot refresh behavior for every mutation.

## Failure Signals

- Dashboard/sidebar/roadmap/status values stop updating until a full manual reload.
- Recovery entrypoints do nothing or reopen an unrelated surface.
- `/api/live-state` returns the whole boot payload instead of narrow domain-specific data.
- `/api/recovery` leaks raw session transcript text, full doctor objects, tool-call internals, or secrets.
- `/api/session/events` omits `live_state_invalidation` metadata or only emits opaque text.
- Refresh/reconnect clears recovery state completely instead of showing load/stale/error state.

## Requirements Proved By This UAT

- R011 — Daily-use browser parity remains truthful during live work because workspace freshness and recovery diagnostics are visible and actionable in-browser instead of drifting behind the live session.

## Not Proven By This UAT

- Final milestone-close assembled proof for refresh/reopen/interrupted-run scenarios across the full browser-first workflow; S04 still owns that closure.
- Cross-project launching, deep analytics/history, or any deferred scope outside the current-project browser parity target.

## Notes for Tester

- The packaged host can cold-start more slowly than the lighter route-level tests; wait for the bridge-connected state before treating the launch as failed.
- Existing optional `@gsd/native` build warnings from `/api/git` bundling are not part of S03’s acceptance as long as `npm run build:web-host` still completes successfully.
- The important thing to verify here is truthfulness: the browser surfaces should reflect current live state and expose actionable recovery paths without terminal fallback or manual refresh loops.
