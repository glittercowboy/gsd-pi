---
phase: 17-permission-model
plan: 02
subsystem: permission-model
tags: [boundary-enforcement, trust-dialog, pipeline, tdd]
dependency_graph:
  requires: [17-01]
  provides: [PERM-02, PERM-03]
  affects: [pipeline.ts, App.tsx, AppShell.tsx, server.ts]
tech_stack:
  added: []
  patterns:
    - TDD red-green cycle for pure boundary detection function
    - Piggybacking on existing WebSocket connection for boundary_violation events
    - Fail-open trust check (network error => trusted, don't block user)
key_files:
  created:
    - packages/mission-control/src/server/boundary-enforcer.ts
    - packages/mission-control/tests/boundary-enforcer.test.ts
  modified:
    - packages/mission-control/src/server/pipeline.ts
    - packages/mission-control/src/hooks/useSessionManager.ts
    - packages/mission-control/src/components/layout/AppShell.tsx
    - packages/mission-control/src/App.tsx
    - packages/mission-control/src/server.ts
decisions:
  - boundary_violation piggybacked on existing useSessionManager WebSocket (no second connection)
  - boundaryViolation state and dismissBoundaryViolation added to useSessionManager hook result
  - TrustDialog onAdvanced advances to AppShell (settings view has permissions section)
  - detectBoundaryViolation regex uses negative lookbehind for dot/slash to prevent matching ./relative paths
metrics:
  duration_seconds: 286
  completed_date: "2026-03-14"
  tasks_completed: 3
  files_modified: 7
---

# Phase 17 Plan 02: Boundary Enforcement + Trust Dialog Wiring Summary

**One-liner:** Hard boundary enforcement via stdout path detection with session interrupt + TrustDialog shown on first project open via /api/trust-status route.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (TDD RED) | boundary-enforcer failing tests | fa9b25f | tests/boundary-enforcer.test.ts |
| 1 (TDD GREEN) | detectBoundaryViolation implementation | 71e219c | src/server/boundary-enforcer.ts |
| 2 | Wire boundary enforcement into pipeline + AppShell banner | 1c4bea4 | pipeline.ts, useSessionManager.ts, AppShell.tsx |
| 3 | App.tsx trust check + trust routes in server.ts | c15f8a4 | App.tsx, server.ts |

## What Was Built

### boundary-enforcer.ts (Task 1)
Pure function `detectBoundaryViolation(text, projectRoot)` that:
- Matches Unix absolute paths (`/word/...`) using negative lookbehind to avoid `./relative` matches
- Matches Windows absolute paths (`C:\...` or `C:/...`)
- Returns `{ violated: false }` for paths inside projectRoot or relative paths
- Returns `{ violated: true, path }` for the first out-of-project absolute path found
- 7 tests covering all behavioral cases, all passing

### pipeline.ts (Task 2)
Boundary check inserted in `wireSessionEvents` text_delta handler:
- Checks raw text BEFORE `parseStreamForModeEvents` strips mode tags
- On violation: calls `session.processManager.interrupt()` FIRST (blocks the gsd process)
- Then broadcasts `{ type: "boundary_violation", path, sessionId, timestamp }` via `wsServer.publishChat`
- Returns early to suppress the offending delta from reaching the client

### useSessionManager + AppShell (Task 2)
- `boundaryViolation: { path } | null` and `dismissBoundaryViolation` added to `UseSessionManagerResult`
- Handler for `boundary_violation` WebSocket messages in `handleMessage` — piggybacks on existing connection
- AppShell renders red dismissible banner at top of dashboard on violation
- Banner text: "The AI attempted to access a file outside your project: `{path}`. The operation was blocked."

### server.ts + App.tsx (Task 3)
- `GET /api/trust-status`: calls `pipeline.getPlanningDir()` then `isTrusted()`, returns `{ trusted, gsdDir }`
- `POST /api/trust`: reads `dir` from body (or falls back to `getPlanningDir()`), calls `writeTrustFlag()`
- App.tsx: `useEffect` fetches `/api/trust-status` when `state.status === "authenticated"`
- Renders `TrustDialog` when `trustStatus === "needs_trust"`, `AppShell` when `trusted`
- Fail-open: network error on trust-status → proceed to AppShell (don't block user)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Relative path regex false positive**
- **Found during:** Task 1 GREEN phase
- **Issue:** Unix path regex `/[a-zA-Z:]/` negative lookbehind missed `.` character, causing `./src/foo.ts` to match as `/src/foo.ts` (relative path flagged as violation)
- **Fix:** Extended negative lookbehind to `[a-zA-Z0-9.:/\\]` to exclude dot, digit, and path chars before `/`
- **Files modified:** boundary-enforcer.ts
- **Commit:** 71e219c

**2. [Rule 2 - Design] boundary_violation piggybacked on useSessionManager WS**
- **Found during:** Task 2 implementation
- **Issue:** Plan suggested adding separate WS listener in AppShell, but AppShell already uses `useSessionManager("ws://localhost:4001")` which has a live connection
- **Fix:** Added `boundaryViolation` state and handler to `useSessionManager` hook, exposed in return object; AppShell destructures from there (no second WS connection)
- **Files modified:** useSessionManager.ts, AppShell.tsx
- **Commit:** 1c4bea4

## Success Criteria Check

1. boundary-enforcer.test.ts: 7/7 tests pass (in-project paths pass, out-of-project paths fail)
2. pipeline.ts: `detectBoundaryViolation` called in `wireSessionEvents` text_delta block; `interrupt()` called on violation BEFORE `publishChat`
3. AppShell: dismissible red banner renders on `boundary_violation` ws event; text says "blocked"
4. App.tsx: TrustDialog shown when `/api/trust-status` returns `{ trusted: false }`
5. server.ts: GET `/api/trust-status` calls `pipeline.getPlanningDir()` + `isTrusted()`; POST `/api/trust` calls `writeTrustFlag()`
6. Frontend build succeeds with no TypeScript errors (241 modules bundled)

## Self-Check: PASSED

All created files exist on disk. All task commits verified in git log.
