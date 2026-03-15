# S07: End-to-end web assembly proof

**Goal:** Prove the assembled web mode works as one connected system — launch, onboard, interact with the agent through streaming/tool/UI-request events, handle focused-panel interruptions, and accumulate transcript state — all through real route handlers.
**Demo:** The route-level assembled lifecycle test passes, the full S01–S06 regression suite is green, and the system is ready for the user's live manual UAT.

## Must-Haves

- Route-level test exercises the full connected lifecycle: boot → onboard → unlock → prompt → streaming events → tool events → blocking UI request → UI response → turn boundary → transcript accumulation — all through real `/api/boot`, `/api/onboarding`, `/api/session/command`, and `/api/session/events` route handlers
- The `FakeRpcChild` emits representative events (`message_update`, `tool_start`, `tool_end`, `extension_ui_request`, `agent_end`/`turn_end`) to prove SSE fanout → store routing → focused panel → response round-trip
- All existing contract tests (bridge, onboarding, live-interaction, continuity, workflow-controls, state-surfaces) pass without modification
- `npm run build:web-host` succeeds
- The two existing integration tests (runtime + onboarding) pass

## Proof Level

- This slice proves: final-assembly
- Real runtime required: no (route-level test uses `configureBridgeServiceForTests`; user does the live runtime proof)
- Human/UAT required: yes — user performs the live browser acceptance pass

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/integration/web-mode-assembled.test.ts`
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-bridge-contract.test.ts src/tests/web-onboarding-contract.test.ts src/tests/web-live-interaction-contract.test.ts src/tests/web-continuity-contract.test.ts src/tests/web-workflow-controls-contract.test.ts`
- `npm run build:web-host`
- Failure-path diagnostic: when the assembled test fails, assertion messages identify which pipeline stage broke (boot, onboarding, command, SSE delivery, UI request round-trip, or turn boundary) and which event types were/weren't received

## Observability / Diagnostics

- Runtime signals: The assembled test verifies SSE event flow (streaming text, tool execution, UI requests, turn boundaries) and transcript state accumulation through real route handlers — the same observable surfaces the browser would consume
- Inspection surfaces: `/api/boot`, `/api/session/events`, `/api/session/command` exercised with full event payloads
- Failure visibility: Test assertions pinpoint which stage of the assembled lifecycle fails (boot, onboarding, command, streaming, UI request, transcript)
- Redaction constraints: none (test uses fake credentials)

## Integration Closure

- Upstream surfaces consumed: All S01–S06 outputs — bridge service, onboarding service, boot/command/events routes, workspace store event routing contract, focused panel UI request lifecycle, workflow action derivation, continuity mechanisms
- New wiring introduced in this slice: none — this slice proves existing wiring, it does not add new wiring
- What remains before the milestone is truly usable end-to-end: User's live manual UAT confirming the visual/interactive browser experience

## Tasks

- [x] **T01: Write the route-level assembled lifecycle test** `est:45m`
  - Why: No existing test exercises the full connected lifecycle through real route handlers. The onboarding integration test stops at "first command succeeds." The live-interaction contract test uses an inline routing mirror. This test closes the gap by proving the SSE fanout → event routing → focused panel response → transcript accumulation chain works through real routes in one connected flow.
  - Files: `src/tests/integration/web-mode-assembled.test.ts`
  - Do: Create a route-level test using the existing `configureBridgeServiceForTests` + `FakeRpcChild` pattern. The test wires a `FakeRpcChild` that responds to `get_state` and `prompt` commands (like the onboarding test) but *also* emits streaming events through stdout: `message_update` with text deltas, `tool_start`/`tool_end`, a blocking `extension_ui_request` (e.g. `confirm`), and `agent_end`/`turn_end`. The test flow: (1) `GET /api/boot` — verify ready bridge; (2) onboard via `/api/onboarding` to unlock; (3) subscribe to `/api/session/events` SSE; (4) `POST /api/session/command` prompt; (5) fake child emits `message_update` events — verify they arrive on SSE; (6) fake child emits `tool_start`/`tool_end` — verify on SSE; (7) fake child emits blocking `extension_ui_request` — verify on SSE; (8) `POST /api/session/command` with `extension_ui_response` — verify the response reaches the fake child's stdin; (9) fake child emits `agent_end` — verify on SSE as turn boundary; (10) verify the complete event sequence proves the full pipe is wired. Must remain backward-compatible with existing `configureBridgeServiceForTests` usage. Must import and use the onboarding service test seam to skip real validation.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/integration/web-mode-assembled.test.ts`
  - Done when: Test passes and proves the full boot → onboard → prompt → streaming → tool → UI request → response → turn boundary lifecycle through real route handlers

- [x] **T02: Full regression pass and assembly readiness confirmation** `est:15m`
  - Why: The assembled test must not break any S01–S06 contract. All tests and the build must pass together before the user's live manual UAT.
  - Files: none (verification-only task)
  - Do: Run every contract test, every integration test, and `npm run build:web-host`. If any test fails, diagnose and fix without modifying the test's contract assertions — failures at this stage indicate a real regression, not a test gap.
  - Verify: All commands in the Verification section above pass. The full test suite is green. The build succeeds with standalone host staged.
  - Done when: All existing tests pass, the new assembled test passes, `build:web-host` succeeds, and the system is ready for the user's live UAT

## Files Likely Touched

- `src/tests/integration/web-mode-assembled.test.ts`
