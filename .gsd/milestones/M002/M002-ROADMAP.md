# M002: Web parity and hardening

**Vision:** `gsd --web` is a first-class everyday GSD workspace: browser users can reach the remaining daily-use TUI controls safely, keep workspace and recovery surfaces fresh during live work, and recover from common lifecycle failures without dropping back to the TUI.

## Success Criteria

- Known built-in slash commands entered in web mode either execute, open a browser-native surface, or reject with a clear browser-visible explanation; none are sent to the model as plain prompt text.
- A current-project browser user can change model/thinking settings, browse and resume/fork current-project sessions, manage auth, and use the remaining visible shell affordances without terminal-only escape hatches.
- Dashboard, sidebar, roadmap, status, and recovery surfaces stay fresh during live work and after refresh/reconnect without aggressive `/api/boot` polling.
- Validation failures, interrupted runs, bridge/auth refresh problems, and resumable recovery paths are visible in-browser with actionable diagnostics and retry/resume controls.
- A real `gsd --web` run survives refresh, reopen, and interrupted-run scenarios while remaining snappy under live activity.

## Key Risks / Unknowns

- Unsafe slash-command fallthrough in web mode — daily-use built-ins currently become model text, which is both incorrect and risky.
- Some parity gaps still lack browser-appropriate serializable contracts — current-project session tree/settings/auth/model-scope flows may need new bridge or view-model seams before they can be browser-native.
- Snapshot/live state split can leave panels stale — the boot snapshot is heavy and cached, so polling `/api/boot` harder would add cost without solving freshness cleanly.
- Recovery visibility is thinner in web than in TUI — doctor/forensics/validation detail already exists in the codebase but is not yet surfaced as actionable browser state.

## Proof Strategy

- Unsafe built-in command handling → retire in S01 by proving known slash commands route through authoritative browser dispatch and never hit the model as prompt text.
- Missing browser-native parity contracts → retire in S02 by proving current-project session/settings/auth surfaces work from real browser affordances and matching slash commands.
- Stale view state and thin failure visibility → retire in S03 by proving targeted live updates and authoritative diagnostics keep browser surfaces fresh and actionable without boot polling.
- Assembled browser-first usability under lifecycle stress → retire in S04 by proving a real `gsd --web` run covers command parity, refresh/reopen, interrupted-run recovery, and daily-use browser workflows end-to-end.

## Verification Classes

- Contract verification: extend browser parity coverage with targeted tests such as `src/tests/web-command-parity-contract.test.ts`, `src/tests/web-session-parity-contract.test.ts`, `src/tests/web-live-state-contract.test.ts`, and `src/tests/web-recovery-diagnostics-contract.test.ts`, while keeping `src/tests/web-state-surfaces-contract.test.ts` green.
- Integration verification: extend `src/tests/integration/web-mode-assembled.test.ts` and `src/tests/integration/web-mode-runtime.test.ts` to exercise command dispatch, current-project resume/fork/settings flows, refresh/reopen continuity, and interrupted-run recovery through the real web routes.
- Operational verification: packaged `gsd --web` startup plus browser/runtime checks for bridge auth refresh, targeted live updates, cache invalidation, reconnect, and recovery behavior against real project data.
- UAT / human verification: live browser confirmation that daily-use controls feel coherent, no visible control is inert, recovery guidance is understandable, and the workspace remains snappy under real activity.

## Milestone Definition of Done

This milestone is complete only when all are true:

- all M002 slices are complete and each slice’s demo outcome is re-verified
- known daily-use built-in commands no longer fall through to the model from the browser terminal
- current-project session/settings/auth/browser control surfaces are real, wired, and no visible affordance needed for daily use remains inert
- live workspace, auto, and recovery surfaces stay fresh without relying on aggressive boot polling
- refresh/reopen/interrupted-run/browser-recovery scenarios are exercised through the real `gsd --web` entrypoint and pass without opening the TUI
- success criteria are re-checked against live browser behavior, not just contract tests

## Requirement Coverage

- Covers: R011
- Partially covers: none
- Leaves for later: R020, R021, R022; convenience-only commands or views that are not needed for daily browser use remain explicitly deferred unless live usage proves otherwise
- Orphan risks: none
- Coverage summary: 1 active requirement mapped in this roadmap; 0 active requirements left unmapped

## Slices

- [x] **S01: Safe slash-command dispatch and RPC-backed daily controls** `risk:high` `depends:[]`
  > After this: A browser user can type or click daily-use built-ins like `/model`, `/thinking`, `/resume`, `/fork`, `/compact`, `/login`, and `/logout` and see real execution, a real browser surface, or a clear rejection instead of model fallthrough.
- [x] **S02: Browser-native session and settings parity surfaces** `risk:high` `depends:[S01]`
  > After this: Current-project session browsing/resume/fork/name flows, settings/auth management, and the remaining visible shell affordances have real browser surfaces aligned with TUI semantics rather than inert UI.
- [x] **S03: Live freshness and recovery diagnostics** `risk:medium` `depends:[S01,S02]`
  > After this: During live work, dashboard/sidebar/roadmap/status/recovery panels update through targeted live state and show actionable validation, doctor, and interrupted-run diagnostics without manual refresh loops.
- [ ] **S04: Final assembled browser hardening proof** `risk:low` `depends:[S02,S03]`
  > After this: The real `gsd --web` entrypoint is exercised through command parity, refresh/reopen, interrupted-run recovery, and daily-use browser workflows with passing integration/runtime/browser proof.

## Boundary Map

### S01 → S02

Produces:
- Authoritative browser built-in command registry/dispatcher derived from `packages/pi-coding-agent/src/core/slash-commands.ts`, with explicit outcomes for execute, open-surface, local-handle, and clear-reject paths
- Stable browser/store command result shapes for RPC-backed actions such as model selection, thinking level, compact, session stats/export, session switching, fork, and auth-management entrypoints

Consumes:
- nothing (first slice)

### S01 → S03

Produces:
- Browser-visible rejection/error semantics that distinguish unsupported or deferred built-ins from prompt text
- Stable store-side command lifecycle hooks that later live-state/recovery work can observe without guessing from transcript text

Consumes:
- nothing (first slice)

### S02 → S03

Produces:
- Serializable current-project selector/view-model contracts for session browsing, session metadata/actions, settings/auth surfaces, and any remaining visible shell affordance panels
- Named browser surfaces for current-project parity flows, giving S03 stable targets to keep fresh with narrow live updates

Consumes:
- S01 browser command registry and RPC-backed action surfaces

### S03 → S04

Produces:
- Targeted SSE or equivalent live view-model payloads for workspace, auto, validation, and recovery freshness plus explicit cache-invalidation rules for boot-derived state
- Browser-visible doctor/forensics/recovery diagnostics with retry/resume controls and inspectable failure state

Consumes:
- S01 dispatch/lifecycle semantics
- S02 parity surfaces and selector contracts
