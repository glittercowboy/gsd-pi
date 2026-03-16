# M003: Upstream Sync and Full Web Feature Parity

**Vision:** Merge 398 upstream commits (v2.12→v2.21) into the web-mode fork, build browser surfaces for every new feature, and achieve absolute 1:1 TUI-web parity with a green test suite.

## Success Criteria

- `npm run build` and `npm run build:web-host` succeed on the unified codebase
- Every `/gsd` subcommand typed in the browser terminal dispatches correctly
- Visualizer page renders real project data across all 7 tabs
- Forensics, doctor, and skill-health panels show real diagnostic data
- Knowledge and captures page shows real project context
- Settings surface covers model routing, providers, and budget
- Systematic parity audit finds no missing TUI features in web
- Full test suite (`test:unit`, `test:integration`) passes clean

## Key Risks / Unknowns

- **auto.ts decomposition** — Upstream split auto.ts into 6+ modules; our web hooks reference the old monolithic structure
- **git-service rewrite** — Upstream moved to Rust/libgit2 via native-git-bridge.ts; our web git service uses old APIs
- **types.ts changes** — Upstream added substantial new types that may break web store contracts
- **package.json conflict** — Both sides added dependencies; lockfile resolution may need manual work

## Proof Strategy

- auto.ts decomposition → retire in S01 by proving the merge compiles with hooks reconnected across decomposed modules
- git-service rewrite → retire in S01 by proving web git summary service works with native-git-bridge APIs
- types.ts changes → retire in S01 by proving web store types align with upstream interfaces
- package.json conflict → retire in S01 by proving `npm run build` succeeds after lockfile resolution

## Verification Classes

- Contract verification: `npm run build`, `npm run build:web-host`, `npm run test:unit`, `npm run test:integration`
- Integration verification: each web surface backed by real upstream data sources, verified by API route response + UI rendering
- Operational verification: none — local dev only
- UAT / human verification: parity audit (S08) requires human judgment on feature completeness

## Milestone Definition of Done

This milestone is complete only when all are true:

- All 398 upstream commits are merged with conflicts resolved
- Build succeeds: `npm run build` and `npm run build:web-host`
- Every `/gsd` subcommand has a browser dispatch entry
- All new upstream features have browser-native surfaces
- Parity audit confirms no TUI feature is missing from web
- Test suite passes: `npm run test:unit`, `npm run test:integration`
- Success criteria are checked against live behavior

## Requirement Coverage

- Covers: R100, R101, R102, R103, R104, R105, R106, R107, R108, R109, R110
- Partially covers: none
- Leaves for later: R020, R021, R022
- Orphan risks: none

## Slices

- [x] **S01: Upstream merge and build stabilization** `risk:high` `depends:[]`
  > After this: `npm run build` and `npm run build:web-host` succeed with all 415 upstream commits merged (v2.22.0). Codebase compiles.

- [ ] **S02: Browser slash-command dispatch for all upstream commands** `risk:high` `depends:[S01]`
  > After this: every `/gsd` subcommand typed in browser terminal dispatches to a surface, executes via RPC, or rejects with clear guidance — no silent fallthrough.

- [ ] **S03: Workflow visualizer page** `risk:medium` `depends:[S01]`
  > After this: dedicated visualizer page with 7 tabbed sections (Progress, Deps, Metrics, Timeline, Agent, Changes, Export) showing real project data via API route.

- [ ] **S04: Diagnostics panels — forensics, doctor, skill-health** `risk:medium` `depends:[S02]`
  > After this: three separate browser panels accessible via `/gsd forensics`, `/gsd doctor`, `/gsd skill-health` showing real diagnostic data with actions.

- [ ] **S05: Knowledge and captures/triage page** `risk:medium` `depends:[S02]`
  > After this: dedicated page showing KNOWLEDGE.md entries and CAPTURES.md with pending/triaged/resolved status and action controls.

- [ ] **S06: Extended settings and model management surface** `risk:medium` `depends:[S02]`
  > After this: settings command surface shows dynamic model routing config, provider fallback chain, budget allocation, and all preference fields.

- [ ] **S07: Remaining command surfaces** `risk:medium` `depends:[S02]`
  > After this: `/gsd quick`, `/gsd history`, `/gsd undo`, `/gsd steer`, `/gsd mode`, `/gsd hooks`, `/gsd config`, `/gsd inspect`, `/gsd export`, `/gsd cleanup` each open browser-native surfaces.

- [ ] **S08: TUI-to-web 1:1 parity audit and gap closure** `risk:low` `depends:[S03,S04,S05,S06,S07]`
  > After this: systematic comparison proves every TUI feature has a working web equivalent — gaps found are fixed.

- [ ] **S09: Test suite hardening** `risk:low` `depends:[S08]`
  > After this: `npm run test:unit`, `npm run test:integration`, `npm run build`, `npm run build:web-host` all pass clean.

## Boundary Map

### S01 → S02

Produces:
- Unified codebase with all upstream modules available (auto-dispatch.ts, auto-recovery.ts, auto-dashboard.ts, auto-prompts.ts, auto-supervisor.ts, auto-worktree.ts, forensics.ts, captures.ts, context-store.ts, model-router.ts, complexity-classifier.ts, context-budget.ts, skill-health.ts, quick.ts, history.ts, undo.ts, visualizer-data.ts, visualizer-views.ts, etc.)
- Working `npm run build` and `npm run build:web-host`
- Updated web store types aligned with upstream interfaces
- Web bridge service compatible with upstream's decomposed module structure

Consumes:
- nothing (first slice)

### S01 → S03

Produces:
- `loadVisualizerData()` function available from merged upstream code
- `VisualizerData` interface with milestones, phase, totals, byPhase, bySlice, byModel, units, criticalPath, agentActivity, changelog

Consumes:
- nothing (first slice)

### S02 → S04, S05, S06, S07

Produces:
- Updated `browser-slash-command-dispatch.ts` with dispatch entries for all new commands
- New `BrowserSlashCommandSurface` union members for forensics, doctor, skill-health, knowledge, captures, quick, history, undo, steer, mode, hooks, config, inspect, export, cleanup, visualize
- Updated `command-surface-contract.ts` with state types for each new surface

Consumes from S01:
- Unified codebase with all upstream command definitions available

### S03 → S08

Produces:
- `/api/visualizer` route serving VisualizerData
- Visualizer page component with 7 tabbed sections
- Workspace store state for visualizer data

Consumes from S01:
- `loadVisualizerData()`, `VisualizerData` interface, `computeCriticalPath()`

### S04 → S08

Produces:
- `/api/forensics` route serving ForensicReport
- `/api/doctor` route serving DoctorReport with fix actions
- `/api/skill-health` route serving SkillHealthReport
- Forensics, doctor, skill-health panel components

Consumes from S01:
- `handleForensics()`, `runGSDDoctor()`, `generateSkillHealthReport()` from upstream
Consumes from S02:
- Dispatch entries routing `/gsd forensics`, `/gsd doctor`, `/gsd skill-health` to surfaces

### S05 → S08

Produces:
- `/api/knowledge` route serving parsed KNOWLEDGE.md entries
- `/api/captures` route serving CaptureEntry[] with triage state
- Knowledge/captures page component

Consumes from S01:
- `loadAllCaptures()`, `loadPendingCaptures()`, `markCaptureResolved()` from upstream captures.ts
- KNOWLEDGE.md file format from upstream
Consumes from S02:
- Dispatch entries routing `/gsd knowledge`, `/gsd capture`, `/gsd triage` to surfaces

### S06 → S08

Produces:
- Extended settings command surface sections for model routing, provider management, budget visibility
- Updated workspace store state for model/provider/budget data

Consumes from S01:
- `DynamicRoutingConfig`, `RoutingDecision` from model-router.ts
- `BudgetAllocation`, `computeBudgets()` from context-budget.ts
- `loadEffectiveGSDPreferences()`, preference schema from preferences.ts
Consumes from S02:
- Updated dispatch for `/gsd prefs`, `/gsd model`, `/gsd mode`

### S07 → S08

Produces:
- Command surface sections for quick, history, undo, steer, mode, hooks, config, inspect, export, cleanup
- API routes as needed for data-heavy surfaces (history metrics, quick task list)

Consumes from S01:
- `handleQuick()`, `handleHistory()`, `handleUndo()`, `handleExport()` from upstream
Consumes from S02:
- Dispatch entries for each command

### S08 → S09

Produces:
- Parity audit report documenting every TUI feature and its web equivalent
- Any gap-closure fixes applied to components, routes, or dispatch

Consumes from S03, S04, S05, S06, S07:
- All web surfaces for systematic comparison against TUI

### S09 (terminal)

Produces:
- Green test suite: `test:unit`, `test:integration`, `build`, `build:web-host`
- Test fixes for any breakage from merge or new code

Consumes from S08:
- Fully parity-audited codebase with all gap fixes applied
