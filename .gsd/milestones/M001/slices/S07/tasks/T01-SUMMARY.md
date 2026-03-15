---
id: T01
parent: S07
milestone: M001
provides:
  - Route-level integration test proving the full assembled web mode lifecycle through real route handlers
key_files:
  - src/tests/integration/web-mode-assembled.test.ts
key_decisions:
  - Used graceful-timeout readSseEvents (returns partial results on timeout instead of throwing) to handle variable bridge_status event counts without brittle exact-count assertions
  - Used two-phase SSE subscription pattern (Phase 1 for streaming events, Phase 2 for turn boundary after UI response) to prove the full async lifecycle without a single long-lived stream reader
  - Used tool_execution_start/tool_execution_end (actual event types from codebase) rather than the shorthand tool_start/tool_end from the task plan
patterns_established:
  - Two-phase SSE verification pattern for testing async event sequences with intervening user actions
  - readSseEvents with per-read timeout that returns partial results instead of throwing, suitable for variable-count event streams
observability_surfaces:
  - Test assertion messages identify which pipeline stage failed (boot, onboarding, command, SSE delivery, UI request, turn boundary) and which event types were/weren't received
duration: 12m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T01: Write the route-level assembled lifecycle test

**Route-level integration test proving boot → onboard → prompt → streaming text → tool execution → blocking UI request → UI response → turn boundary through real route handlers**

## What Happened

Created `src/tests/integration/web-mode-assembled.test.ts` with a single comprehensive test case exercising the full assembled web mode lifecycle. The test uses the proven `configureBridgeServiceForTests` + `FakeRpcChild` pattern extended with a command handler that emits a realistic streaming event sequence: `message_update` (text_delta), `tool_execution_start`, `tool_execution_end`, a blocking `extension_ui_request` (confirm dialog), and then `agent_end`/`turn_end` only after receiving the `extension_ui_response` on stdin.

The test flow verifies 6 stages: (1) boot returns ready bridge with locked onboarding, (2) save_api_key unlocks the workspace and triggers bridge auth refresh, (3) SSE subscription delivers streaming events from the fake child through the real events route, (4) prompt command succeeds and fake child emits all streaming events, (5) extension_ui_response POST delivers the value to the fake child's stdin (round-trip proof), (6) turn boundary events (agent_end, turn_end) arrive via SSE only after the UI response.

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/integration/web-mode-assembled.test.ts` — **passed** (1 test, 0 failures)
- All 53 S01–S06 contract tests pass (bridge, onboarding, live-interaction, continuity, workflow-controls) — **passed**
- `npm run build:web-host` — **passed**, standalone host staged

## Diagnostics

- On failure, each assertion message identifies the specific pipeline stage and reports which event types were received vs expected
- readSseEvents timeout errors include the full list of collected event types before timeout for diagnosis
- The test exercises the same observable surfaces the browser consumes: `/api/boot`, `/api/session/events` (SSE), `/api/session/command`, `/api/onboarding`

## Deviations

- Used `tool_execution_start`/`tool_execution_end` event types (matching the actual codebase and store routing) instead of the shorthand `tool_start`/`tool_end` mentioned in the task plan
- readSseEvents uses graceful timeout (returns partial results) instead of the throwing version from the live-interaction test, to avoid fragility around exact bridge_status event counts

## Known Issues

None.

## Files Created/Modified

- `src/tests/integration/web-mode-assembled.test.ts` — route-level integration test proving the full assembled web mode lifecycle
- `.gsd/milestones/M001/slices/S07/S07-PLAN.md` — added failure-path diagnostic verification step; marked T01 done
- `.gsd/milestones/M001/slices/S07/tasks/T01-PLAN.md` — added Observability Impact section
