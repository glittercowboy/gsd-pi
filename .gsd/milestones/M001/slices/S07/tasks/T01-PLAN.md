---
estimated_steps: 6
estimated_files: 1
---

# T01: Write the route-level assembled lifecycle test

**Slice:** S07 — End-to-end web assembly proof
**Milestone:** M001

## Description

Create a route-level integration test that exercises the full assembled web mode lifecycle through real route handlers in one connected flow. This is the missing proof that S01–S06 outputs work together as one system: boot → onboard → unlock → prompt → streaming text → tool execution → blocking UI request → UI response → turn boundary → transcript accumulation.

The test reuses the proven `configureBridgeServiceForTests` + `FakeRpcChild` pattern from the onboarding integration test but extends the `FakeRpcChild` to emit streaming events (not just command responses) through its stdout after a prompt is received. This exercises the bridge's `handleStdoutLine` → `emit()` → SSE fanout → real route handler delivery chain.

## Steps

1. Create `src/tests/integration/web-mode-assembled.test.ts`. Import the bridge service, onboarding service, boot route, onboarding route, command route, and events route — same import pattern as the existing `web-mode-onboarding.test.ts`. Reuse the `FakeRpcChild`, `serializeJsonLine`, `attachJsonLineReader`, `makeWorkspaceFixture`, `createSessionFile`, `readSseEvents`, and fixture helpers.

2. Write a `FakeRpcChild` command handler that: (a) responds to `get_state` with a valid session state; (b) on `prompt`, responds with success and then emits a sequence of events on stdout: `message_update` (text_delta), `tool_start`, `tool_end`, a blocking `extension_ui_request` (method: `confirm`, with id/message/title), and then waits for the UI response before emitting `agent_end`/`turn_end`. The "waits for UI response" part reads from stdin — when it sees an `extension_ui_response` command, it emits the final turn boundary events.

3. Write the assembled lifecycle test case. Flow:
   - Boot: `GET /api/boot` → assert bridge ready, onboarding locked
   - Onboard: `POST /api/onboarding` save_api_key → assert unlocked
   - Subscribe SSE: `GET /api/session/events` → start reading events
   - Prompt: `POST /api/session/command` prompt → assert success
   - Verify streaming: read SSE events, confirm `message_update`, `tool_start`, `tool_end`, and `extension_ui_request` arrive
   - Respond to UI request: `POST /api/session/command` with `extension_ui_response` → assert it reaches the fake child
   - Verify turn boundary: read SSE for `agent_end` event
   - Assert the complete event sequence proves the full pipe

4. Wire cleanup in `finally`: call `resetOnboardingServiceForTests()`, `resetBridgeServiceForTests()`, and `fixture.cleanup()` — same pattern as existing tests.

5. Configure the onboarding service test seam with `GSD_WEB_TEST_FAKE_API_KEY_VALIDATION`-equivalent in-memory auth + fake validation so onboarding passes without real provider calls.

6. Run the test and verify it passes.

## Must-Haves

- [ ] Test exercises boot → onboard → prompt → streaming → tool → UI request → response → turn boundary through real route handlers
- [ ] FakeRpcChild emits `message_update`, `tool_start`, `tool_end`, `extension_ui_request`, and `agent_end` events
- [ ] UI response round-trip is proven: browser-side POST → bridge stdin → fake child receives it
- [ ] SSE event delivery is proven: fake child stdout → bridge emit → SSE route → reader
- [ ] Existing test infrastructure (`configureBridgeServiceForTests`, `resetBridgeServiceForTests`) remains backward-compatible
- [ ] Test cleans up properly (no leaked processes, temp dirs, or dangling bridge state)

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/integration/web-mode-assembled.test.ts`
- Test passes, proving the full assembled lifecycle through real route handlers

## Inputs

- `src/tests/integration/web-mode-onboarding.test.ts` — template for test infrastructure (FakeRpcChild, fixture helpers, route imports, bridge/onboarding test seams, cleanup pattern)
- `src/tests/web-live-interaction-contract.test.ts` — reference for SSE event shapes, `readSseEvents` pattern, and the expected event routing contract
- `src/web/bridge-service.ts` — `handleStdoutLine` parses fake child stdout and broadcasts events; `configureBridgeServiceForTests` is the test seam
- `src/web/onboarding-service.ts` — `configureOnboardingServiceForTests` for fake validation
- S03 forward intelligence — event shapes: `message_update` uses `content[].text` with `text_delta` type, blocking UI requests use `extension_ui_request` with method/id/params

## Observability Impact

- **Signals:** The assembled test exercises every observable surface the browser consumes (`/api/boot`, `/api/session/events` SSE, `/api/session/command`) with explicit assertions at each stage. Each stage failure produces a descriptive assertion message identifying the broken pipeline segment.
- **Inspection:** On failure, the test reports which event types were received vs expected — making it immediately clear whether the breakage is in boot, onboarding, command routing, SSE fanout, UI request delivery, or turn boundary handling.
- **Failure state:** Timeout errors in SSE event reading report the full list of event types received before timeout, enabling diagnosis without re-running.

## Expected Output

- `src/tests/integration/web-mode-assembled.test.ts` — route-level integration test proving the full assembled web mode lifecycle
