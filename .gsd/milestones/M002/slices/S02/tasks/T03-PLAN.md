---
estimated_steps: 5
estimated_files: 7
---

# T03: Promote the remaining daily-use settings and auth parity on the shared surface

**Slice:** S02 — Browser-native session and settings parity surfaces
**Milestone:** M002

## Description

S01 proved that the browser can host the settings surface, but it only exposed model, thinking, and auth. This task promotes the remaining daily-use controls that already have authoritative transport — steering mode, follow-up mode, auto-compact, and retry controls — and makes their state inspectable instead of guessing from transcript text.

## Steps

1. Extend the bridge/session state contract if needed so the browser can inspect retry-enabled and retry-in-progress state rather than infer it indirectly.
2. Add store actions for `set_steering_mode`, `set_follow_up_mode`, `set_auto_compaction`, `set_auto_retry`, and `abort_retry`, keeping the shared command surface as the single browser control plane.
3. Expand the command-surface contract and UI to render these settings alongside the existing model/thinking/auth controls with explicit pending/result/error state.
4. Keep the UX honest about what is live-session state vs persisted behavior, and preserve S01 auth management semantics and failure visibility while expanding the settings surface.
5. Add parity and integration coverage for these settings, including failure paths and retry cancellation visibility.

## Must-Haves

- [ ] Browser can inspect and mutate steering mode, follow-up mode, auto-compact, and retry settings
- [ ] Shared command surface remains the only browser settings control plane
- [ ] Retry state is inspectable, not inferred from loose terminal text alone
- [ ] Auth behavior from S01 remains intact while settings scope grows
- [ ] Tests cover success and failure visibility for the new settings controls

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts src/tests/integration/web-mode-assembled.test.ts`
- Tests fail with the missing setting mutation or state field if the browser contract regresses

## Observability Impact

- Signals added/changed: bridge `get_state` fields for retry visibility plus command-surface pending/result/error state for queue and compaction settings
- How a future agent inspects this: inspect `boot.bridge.sessionState`, command-surface state, and integration assertions that drive the new settings mutations
- Failure state exposed: setting mutations and retry cancellation failures remain visible in structured browser state

## Inputs

- `packages/pi-coding-agent/src/modes/rpc/rpc-types.ts`, `packages/pi-coding-agent/src/modes/rpc/rpc-mode.ts` — authoritative transport for settings mutations
- `web/lib/command-surface-contract.ts`, `web/lib/gsd-workspace-store.tsx`, `web/components/gsd/command-surface.tsx` — shared browser surface seams
- S01 auth-management/browser-settings behavior — must remain intact while scope expands

## Expected Output

- `packages/pi-coding-agent/src/modes/rpc/rpc-types.ts`, `packages/pi-coding-agent/src/modes/rpc/rpc-mode.ts` — any missing inspectable state additions
- `web/lib/command-surface-contract.ts` — expanded settings sections and targets
- `web/lib/gsd-workspace-store.tsx` — new settings actions and state syncing
- `web/components/gsd/command-surface.tsx` — queue/auto-compact/retry settings UI
- `src/tests/web-session-parity-contract.test.ts`, `src/tests/integration/web-mode-assembled.test.ts` — verification for the promoted settings parity
