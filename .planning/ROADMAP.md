# Roadmap: GSD 2 — Pi 0.67.2 Upgrade (v1.1)

## Overview

Five sequential phases upgrade vendored pi-mono packages from 0.57.1 to 0.67.2, migrate all breaking API changes, eliminate the circular type dependency via a new shared package, enforce TypeScript strict across all GSD packages, and ship as gsd-pi@2.8.0. Each phase leaves the build in a verifiable state before the next begins. All work continues on branch `refactor/pi-clean-seam` (PR #4282).

**Continues from:** v1.0 Pi Clean Seam (Phases 01–06, complete)

## Phases

- [x] **Phase 07: Vendor Swap** - Replace all four pi-mono 0.57.1 source trees with 0.67.2 and achieve a compiling workspace (completed 2026-04-16)
- [x] **Phase 08: Breaking API Migrations** - Migrate session API, ModelRegistry, and edit tool callers to 0.67.2 contracts (completed 2026-04-16)
- [ ] **Phase 09: @gsd/agent-types Package** - Create shared type package to break the pi-coding-agent ↔ gsd-agent-core/gsd-agent-modes circular dep
- [x] **Phase 10: TypeScript Strict + Zero Any** - Enforce strict: true, eliminate all `any`, add exhaustive union checks, fix all test failures (gap closure in progress) (completed 2026-04-16)
- [ ] **Phase 11: Integration and Release** - Clean build exits 0, all tests pass, version bumped to 2.8.0, PR #4282 updated

## Phase Details

### Phase 07: Vendor Swap
**Goal**: All four vendored pi-mono packages (`pi-agent-core`, `pi-ai`, `pi-tui`, `pi-coding-agent`) contain 0.67.2 source and the workspace compiles at all — type errors from API shape changes are expected and acceptable at phase end.
**Depends on**: Phase 06 (v1.0 complete)
**Requirements**: VEND-01
**Success Criteria** (what must be TRUE):
  1. `packages/pi-agent-core`, `packages/pi-ai`, `packages/pi-tui`, `packages/pi-coding-agent` contain 0.67.2 source (verifiable via version field or changelog header in each package)
  2. `npm run build:pi` runs to completion without crashing the compiler process itself — type errors are acceptable, panics and missing-module errors are not
  3. The number of type errors is bounded and catalogued (stderr captured to a file) so Phase 08 has a known error list
  4. No 0.57.1 source files remain in any vendored package directory
**Plans**: TBD

### Phase 08: Breaking API Migrations
**Goal**: All GSD-owned code compiles against the 0.67.2 pi-mono API — `session_switch`/`session_fork` are gone, `ModelRegistry` uses factory methods, `edit` callers use `edits[]`, `session_directory` is removed, and `createAgentSessionRuntime` is adopted.
**Depends on**: Phase 07
**Requirements**: SESS-01, SESS-02, SESS-03, MREG-01, TOOL-01, TOOL-02
**Success Criteria** (what must be TRUE):
  1. `grep -r "session_switch\|session_fork" packages/pi-coding-agent/src/ packages/gsd-agent-core/src/ packages/gsd-agent-modes/src/` returns zero matches
  2. `grep -r "new ModelRegistry" packages/gsd-agent-core/src/ packages/gsd-agent-modes/src/` returns zero matches
  3. `grep -r "session_directory" packages/pi-coding-agent/src/ packages/gsd-agent-core/src/ packages/gsd-agent-modes/src/` returns zero matches
  4. `tsc --noEmit` on `gsd-agent-core` and `gsd-agent-modes` alone exits 0 (pi-coding-agent circular dep errors are acceptable until Phase 09)
  5. A rubber-duck trace document exists in `.planning/` capturing the `session_start` + `event.reason` migration decision
**Plans:** 7/7 plans complete

Plans:
- [x] 08-01a-PLAN.md — Fix gsd-agent-core smaller files (lifecycle-hooks, keybindings, fallback-resolver, compaction, bash-executor, export-html)
- [x] 08-01b-PLAN.md — Fix agent-session.ts + sdk.ts (Agent method renames, ModelRegistry, SettingsManager, ToolInfo.sourceInfo)
- [x] 08-01c-PLAN.md — Fix all gsd-agent-modes files (theme renames, KeybindingsManager, AgentSession public API, event types)
- [x] 08-02-PLAN.md — Rubber-duck trace doc, ModelRegistry factory migration, session_directory removal
- [x] 08-03-PLAN.md — Session event emission migration (session_switch/fork to session_start)
- [x] 08-04-PLAN.md — AgentSession to AgentSessionRuntime refactor with state preservation tests
- [x] 08-05-PLAN.md — TOOL-01/TOOL-02 completion and Phase 08 compile gate verification

### Phase 09: @gsd/agent-types Package
**Goal**: A new `@gsd/agent-types` workspace package holds all type-only definitions shared between `pi-coding-agent`, `gsd-agent-core`, and `gsd-agent-modes`; the circular import between those three packages is broken at the compiler level.
**Depends on**: Phase 08
**Requirements**: CIRC-01, CIRC-02
**Success Criteria** (what must be TRUE):
  1. `packages/gsd-agent-types/` exists with `package.json`, `tsconfig.json`, and `src/index.ts`; it has zero runtime dependencies and zero imports from any other GSD or pi package
  2. `grep -r "from.*pi-coding-agent" packages/gsd-agent-core/src/ packages/gsd-agent-modes/src/` returns zero matches that resolve to pi-coding-agent internals (public package imports are acceptable)
  3. `tsc --noEmit` exits 0 across all four GSD packages (`gsd-agent-types`, `gsd-agent-core`, `gsd-agent-modes`, `pi-coding-agent`) with no circular dep errors
  4. The build chain in `package.json` scripts is updated to include `gsd-agent-types` before `gsd-agent-core` and `gsd-agent-modes`
**Plans:** 3 plans

Plans:
- [ ] 09-01-PLAN.md — Scaffold @gsd/agent-types package, populate type inventory, wire build chain
- [ ] 09-02-PLAN.md — Migrate gsd-agent-core type imports to @gsd/agent-types
- [ ] 09-03-PLAN.md — Migrate gsd-agent-modes type imports to @gsd/agent-types

**UI hint**: no

### Phase 10: TypeScript Strict + Zero Any
**Goal**: Every GSD-owned package compiles under `strict: true` with zero `any`, explicit return types on all functions, exhaustive union checks via `never`, and the test suite passes with zero total failures.
**Depends on**: Phase 09
**Requirements**: TS-01, TS-02, TS-03, TS-04, INT-02, INT-03
**Success Criteria** (what must be TRUE):
  1. `tsc --noEmit` exits 0 from workspace root with `strict: true` active in all four GSD package tsconfigs
  2. `grep -r ": any\b\|as any\b\| any;" packages/gsd-agent-core/src/ packages/gsd-agent-modes/src/ packages/gsd-agent-types/src/` returns zero matches
  3. `npm run test:unit && npm run test:packages` exits 0 with zero failing tests (both pre-existing failures and new ones resolved)
  4. Every switch/if-else chain over a union type in GSD packages contains a `never` exhaustive check (verifiable via grep for union type names lacking a default branch)
**Plans:** 11/11 plans complete

Plans:
- [x] 10-01-PLAN.md — Vendor patches (isToolResultEventType, getEditorKeybindings) + assertNever + @gsd/agent-types type additions
- [x] 10-02-PLAN.md — Root src/ errors: cli.ts fixes + security-overrides ownership + getCredentialsForProvider migration
- [x] 10-03-PLAN.md — Root src/ errors: barrel imports + model-router removed symbols + partial-builder pi-ai fix
- [x] 10-04-PLAN.md — GSD any elimination: InteractiveModeStateHost typing + interactive-mode.ts cast removal
- [x] 10-05-PLAN.md — GSD any elimination: agent-session.ts casts + dual-module-path TS2345 fix + tsc gate
- [x] 10-06-PLAN.md — Test suite refactoring: security-overrides.test.ts + tui-running-and-success-box.test.ts
- [x] 10-07-PLAN.md — ESLint install + config + CI pi-* protection + final Phase 10 gates
- [x] 10-08-PLAN.md — Gap closure: vendor patches (editorKey, ProcessTerminal.isTTY, repairToolJson) to fix 244 test failures
- [x] 10-09-PLAN.md — Gap closure: any elimination in gsd-agent-modes components/controllers (49 occurrences)
- [x] 10-10-PLAN.md — Gap closure: ESLint green pass (unused-vars, return-types, switch-exhaustiveness, remaining any)
- [x] 10-11-PLAN.md — Gap closure: fix 174 test failures from removed @gsd/pi-coding-agent 0.67.2 API imports

### Phase 11: Integration and Release
**Goal**: A clean-state build from scratch exits 0, the installed binary reports version 2.8.0, and PR #4282 is updated with a description of all v1.1 changes.
**Depends on**: Phase 10
**Requirements**: INT-01, INT-04, REL-01
**Success Criteria** (what must be TRUE):
  1. `npm run clean && npm run build:pi && npm run build:core` exits 0 from a clean state (no cached dist artifacts)
  2. `gsd --version` outputs `2.8.0` from the compiled Bun binary
  3. `package.json` version field reads `2.8.0` in all workspace packages that carry a version
  4. PR #4282 body updated to include a v1.1 section describing the pi 0.67.2 upgrade, API migrations, circular dep fix, and TypeScript strict enforcement
**Plans**: TBD

## Requirement Coverage

| Requirement | Phase | Status |
|-------------|-------|--------|
| VEND-01 | Phase 07 | Pending |
| SESS-01 | Phase 08 | Pending |
| SESS-02 | Phase 08 | Pending |
| SESS-03 | Phase 08 | Pending |
| MREG-01 | Phase 08 | Pending |
| TOOL-01 | Phase 08 | Pending |
| TOOL-02 | Phase 08 | Pending |
| CIRC-01 | Phase 09 | Pending |
| CIRC-02 | Phase 09 | Pending |
| TS-01   | Phase 10 | Pending |
| TS-02   | Phase 10 | Pending |
| TS-03   | Phase 10 | Pending |
| TS-04   | Phase 10 | Pending |
| INT-02  | Phase 10 | Pending |
| INT-03  | Phase 10 | Pending |
| INT-01  | Phase 11 | Pending |
| INT-04  | Phase 11 | Pending |
| REL-01  | Phase 11 | Pending |

**Coverage:** 18/18 requirements mapped

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 7. Vendor Swap | 6/6 | Complete | 2026-04-16 |
| 8. Breaking API Migrations | 7/7 | Complete | 2026-04-16 |
| 9. @gsd/agent-types Package | 0/3 | Planning complete | - |
| 10. TypeScript Strict + Zero Any | 11/11 | Complete   | 2026-04-16 |
| 11. Integration and Release | 0/? | Not started | - |
