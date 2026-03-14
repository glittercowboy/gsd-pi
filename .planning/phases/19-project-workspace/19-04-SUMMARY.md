---
phase: 19-project-workspace
plan: 04
subsystem: ui
tags: [react, workspace, tabs, session-flow, routing]

# Dependency graph
requires:
  - phase: 19-02
    provides: workspace-api (create/switch/recent endpoints)
  - phase: 19-03
    provides: ProjectHomeScreen, ProjectCard, ProjectCardMenu, archiving components

provides:
  - ProjectTabBar component (multi-project tab navigation, hidden for <2 projects)
  - useSessionFlow "home" SessionMode and goHome() callback
  - AppShell home mode routing to ProjectHomeScreen
  - AppShell openProjects state + ProjectTabBar in dashboard
  - Sidebar onGoHome prop with Home icon button

affects: [phase-20-tauri-packaging, any future multi-project work]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - openProjects state in AppShell tracks multi-project tabs as local UI state
    - goHome() in useSessionFlow sets goHomeState=true; dismiss() clears it (nav symmetry)
    - Sidebar onGoHome optional prop pattern — Home button only shown when prop provided

key-files:
  created:
    - packages/mission-control/src/components/workspace/ProjectTabBar.tsx
  modified:
    - packages/mission-control/src/hooks/useSessionFlow.ts
    - packages/mission-control/src/components/layout/AppShell.tsx
    - packages/mission-control/src/components/layout/Sidebar.tsx

key-decisions:
  - "ProjectTabBar uses openProjects (not projects) prop — matches test contract from 19-01 RED stubs"
  - "ProjectTabBar exported as default — matches test import style from project-tab-bar.test.tsx"
  - "goHome state cleared by dismiss() so project open → dismiss() correctly exits home mode"
  - "Home button rendered at top of Sidebar above logo/label section when onGoHome prop provided"
  - "fetch /api/session/switch on project open and tab switch — avoids direct hook coupling per plan interface notes"

requirements-completed: [WORKSPACE-01, WORKSPACE-02, WORKSPACE-04]

# Metrics
duration: 12min
completed: 2026-03-14
---

# Phase 19 Plan 04: Project Workspace Assembly Summary

**ProjectTabBar with amber-dot processing indicator, useSessionFlow "home" mode with goHome() callback, AppShell home-screen routing and multi-project tab state, Sidebar Home button wired end-to-end**

## Performance

- **Duration:** 12 min
- **Started:** 2026-03-14T15:17:55Z
- **Completed:** 2026-03-14T15:30:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- ProjectTabBar renders null for 0/1 project, horizontal tabs for 2+, amber dot for isProcessing
- useSessionFlow extended with "home" SessionMode; goHome() callback exported, dismiss() clears it
- AppShell routes mode==="home" to ProjectHomeScreen with onOpenProject/onCreateProject handlers
- AppShell tracks openProjects state, renders ProjectTabBar in dashboard mode
- Sidebar accepts optional onGoHome prop, renders lucide-react Home icon button at top when provided
- All 15 Phase 19 tests GREEN (workspace-api, project-home-screen, project-tab-bar, project-archiving)
- Full suite: 763 tests pass (up from 748 baseline, added 15 new Phase 19 tests)

## Task Commits

Each task was committed atomically:

1. **Task 1: ProjectTabBar component** - `92770ac` (feat) — TDD GREEN phase
2. **Task 2: home mode + AppShell routing + Sidebar Home button** - `1d58be8` (feat)

**Plan metadata:** (docs commit pending)

## Files Created/Modified

- `packages/mission-control/src/components/workspace/ProjectTabBar.tsx` - Tab bar with openProjects prop; default export; hidden for <2 projects; amber dot for isProcessing
- `packages/mission-control/src/hooks/useSessionFlow.ts` - "home" added to SessionMode union; deriveSessionMode accepts goHome param; goHome() callback exported
- `packages/mission-control/src/components/layout/AppShell.tsx` - Imports ProjectHomeScreen/ProjectTabBar; goHome destructured; openProjects/activeProjectPath state; home mode branch; ProjectTabBar in dashboard; onGoHome passed to Sidebar
- `packages/mission-control/src/components/layout/Sidebar.tsx` - Optional onGoHome prop; Home icon (lucide-react) button rendered at top when prop present

## Decisions Made

- ProjectTabBar uses `openProjects` prop (not `projects`) to match the test contract established in 19-01 RED stubs; the plan spec used `projects` but the test used `openProjects`
- Default export for ProjectTabBar to match `import ProjectTabBar from ...` in test file
- goHome state cleared by `dismiss()` so that selecting a project from home returns to dashboard correctly
- Home button positioned above the logo/toggle section in Sidebar for prominence

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] ProjectTabBar prop name adjusted to match test contract**
- **Found during:** Task 1 (ProjectTabBar component)
- **Issue:** Plan specified `projects` prop but 19-01 RED stub test uses `openProjects` prop and default import
- **Fix:** Created component with `openProjects` prop and default export matching test contract
- **Files modified:** packages/mission-control/src/components/workspace/ProjectTabBar.tsx
- **Verification:** All 4 project-tab-bar.test.tsx cases GREEN
- **Committed in:** 92770ac (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (prop name alignment with test contract)
**Impact on plan:** Minor — same behavior, different prop name to honor the established RED test stub contract.

## Issues Encountered

- Pre-existing TypeScript errors in AppShell.tsx (`state?.state`, `state?.config`) are not introduced by this plan — they predate Phase 19 and are GSD2State migration remnants from Phase 12.

## Next Phase Readiness

- Phase 19 fully complete: all 5 plans done, all 15 Phase 19 tests GREEN
- All WORKSPACE requirements (01-04) satisfied
- Phase 20 (Tauri Packaging) unblocked: Phase 15 + Phase 19 both complete per dependency graph

---
*Phase: 19-project-workspace*
*Completed: 2026-03-14*
