---
id: T03
parent: S02
milestone: M002
provides:
  - A browser-native shared settings/auth surface that exposes steering, follow-up, auto-compaction, and retry controls with authoritative live retry visibility and structured per-control mutation state
key_files:
  - packages/pi-coding-agent/src/modes/rpc/rpc-types.ts
  - packages/pi-coding-agent/src/modes/rpc/rpc-mode.ts
  - src/web/bridge-service.ts
  - web/lib/command-surface-contract.ts
  - web/lib/gsd-workspace-store.tsx
  - web/components/gsd/command-surface.tsx
  - src/tests/web-session-parity-contract.test.ts
  - src/tests/integration/web-mode-assembled.test.ts
key_decisions:
  - Represent browser settings mutations as structured `commandSurface.settingsRequests` state while keeping live retry/compaction truth authoritative from bridge `get_state` plus event-triggered refresh
patterns_established:
  - The shared command surface now treats queue/compaction/retry controls like other browser-native parity surfaces: one store action per authoritative RPC mutation, one inspectable mutation-state object, and live-state rendering sourced from `boot.bridge.sessionState`
observability_surfaces:
  - `boot.bridge.sessionState.autoRetryEnabled`, `boot.bridge.sessionState.retryInProgress`, and `boot.bridge.sessionState.retryAttempt`
  - `commandSurface.settingsRequests` for steering/follow-up/auto-compaction/auto-retry/abort-retry pending/result/error state
  - command-surface `data-testid` markers for queue, auto-compaction, retry, and retry-state panels
  - browser-visible bridge refresh on `auto_retry_*` and `auto_compaction_*` lifecycle events
duration: 4h
verification_result: passed
completed_at: 2026-03-15T11:54:20Z
blocker_discovered: false
---

# T03: Promote the remaining daily-use settings and auth parity on the shared surface

**Shipped browser-native queue, auto-compaction, and retry settings on the shared command surface, with authoritative live retry visibility and structured per-control mutation state while preserving the existing auth surface.**

## What Happened

I extended the RPC `get_state` contract in `packages/pi-coding-agent/src/modes/rpc/rpc-types.ts` and `packages/pi-coding-agent/src/modes/rpc/rpc-mode.ts` so the browser can inspect `autoRetryEnabled`, `retryInProgress`, and `retryAttempt` directly instead of inferring retry status from terminal text.

In `src/web/bridge-service.ts` I kept that state live by refreshing the bridge snapshot after `agent_end` and on `auto_retry_start`, `auto_retry_end`, `auto_compaction_start`, and `auto_compaction_end`. That keeps the shared browser surface honest about live retry/compaction state instead of showing stale toggles.

In `web/lib/command-surface-contract.ts` I expanded the shared command-surface contract with:
- new settings sections: `queue`, `compaction`, and `retry`
- new pending actions for `set_steering_mode`, `set_follow_up_mode`, `set_auto_compaction`, `set_auto_retry`, and `abort_retry`
- structured `commandSurface.settingsRequests` state so each settings control exposes inspectable `pending` / `result` / `error` status instead of collapsing everything into generic terminal feedback

In `web/lib/gsd-workspace-store.tsx` I added the real browser actions for those settings mutations and patched live boot/session state after successful steering/follow-up/auto-compaction/auto-retry changes. For retry cancellation the store records structured success/error state immediately, while authoritative `retryInProgress` / `retryAttempt` continues to come from bridge state once the bridge confirms the abort.

In `web/components/gsd/command-surface.tsx` I expanded the shared settings sheet to render:
- a Queue section for steering mode and follow-up mode
- an Auto-compaction section distinct from the existing manual Compact section
- a Retry section that shows persisted auto-retry state separately from live retry-in-progress state and exposes abort visibility
- the existing Auth section unchanged in behavior

The new UI stays explicit about what is persisted behavior versus live session state, disables controls until live state is present, and exposes stable `data-testid` markers for later agent inspection.

I updated task-level and slice-level tests to pin the new bridge/session fields, shared store actions, command-surface request state, and assembled route behavior for both successful settings changes and a failed follow-up-mode mutation.

## Verification

Passed task-level verification:
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts src/tests/integration/web-mode-assembled.test.ts`

Passed slice-level verification currently in scope:
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts src/tests/web-command-parity-contract.test.ts`
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-bridge-contract.test.ts src/tests/web-state-surfaces-contract.test.ts src/tests/web-live-interaction-contract.test.ts src/tests/integration/web-mode-assembled.test.ts`
- `npm run build:web-host`

Passed real-browser verification against a live local app:
- started `next dev` with project-scoped `GSD_WEB_*` env vars
- opened the real browser shell at `http://127.0.0.1:3000`
- opened the shared command surface from the sidebar Settings affordance
- asserted visibility of the new Queue / Auto-compact / Retry sections plus their inspectable state markers
- asserted no browser console errors and no failed network requests during the smoke flow

## Diagnostics

- Inspect `boot.bridge.sessionState.autoRetryEnabled`, `boot.bridge.sessionState.retryInProgress`, and `boot.bridge.sessionState.retryAttempt`
- Inspect `commandSurface.settingsRequests` in the browser store for per-control pending/result/error state
- Inspect `web/components/gsd/command-surface.tsx` markers:
  - `command-surface-queue-settings`
  - `command-surface-steering-mode-state`
  - `command-surface-follow-up-mode-state`
  - `command-surface-auto-compaction-settings`
  - `command-surface-auto-compaction-state`
  - `command-surface-retry-settings`
  - `command-surface-auto-retry-state`
  - `command-surface-abort-retry-state`
- Retry/compaction bridge freshness now updates on `auto_retry_*` and `auto_compaction_*` lifecycle events, so stale live-state panels should be debuggable from bridge snapshots instead of transcript text

## Deviations

None.

## Known Issues

- Existing non-blocking `MODULE_TYPELESS_PACKAGE_JSON` warnings from the web test/runtime environment remain.

## Files Created/Modified

- `packages/pi-coding-agent/src/modes/rpc/rpc-types.ts` — added inspectable auto-retry fields to the authoritative session-state contract
- `packages/pi-coding-agent/src/modes/rpc/rpc-mode.ts` — populated the new retry/session-state fields in `get_state`
- `src/web/bridge-service.ts` — refreshed bridge session snapshots on retry/compaction lifecycle events so browser live state stays current
- `web/lib/command-surface-contract.ts` — added queue/compaction/retry sections, settings pending actions, and structured `settingsRequests` mutation state
- `web/lib/gsd-workspace-store.tsx` — added browser actions for steering/follow-up/auto-compaction/auto-retry/abort-retry plus optimistic boot-state patching where appropriate
- `web/components/gsd/command-surface.tsx` — rendered the new Queue / Auto-compaction / Retry settings panels and preserved auth parity semantics
- `src/tests/web-session-parity-contract.test.ts` — pinned the new bridge/settings contract and command-surface markers
- `src/tests/integration/web-mode-assembled.test.ts` — added assembled settings parity proof for success/failure and retry visibility
- `src/tests/web-bridge-contract.test.ts` — asserted the new retry fields survive the boot bridge snapshot
- `.gsd/DECISIONS.md` — recorded the structured settings-state + bridge-refresh decision for downstream slice work
