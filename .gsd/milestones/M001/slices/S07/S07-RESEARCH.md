# M001/S07 — Research

**Date:** 2026-03-15

## Summary

The assembled web mode is in excellent shape. S01–S06 left a codebase with zero mock data in core views, 76 passing contract and state-surface tests (59 + 17), a clean `build:web-host`, and two existing integration tests that prove the launch→boot→shell and launch→onboard→unlock→first-command paths. The remaining S07 gap is narrow but critical: no test currently exercises the *assembled workflow loop* — the connected sequence of launch, onboard, start/resume work, agent interaction (streaming + tool execution), focused-panel interruption handling, and real transcript/state accumulation in a single running system.

The existing test infrastructure is more than sufficient. The `configureBridgeServiceForTests` + `FakeRpcChild` pattern already handles subprocess faking with line-level RPC injection, `GSD_WEB_TEST_FAKE_API_KEY_VALIDATION` covers packaged onboarding, and Playwright is installed and working. S07 extends these — it does not need new infrastructure from scratch. The main work is: (1) a route-level integration test that wires the full lifecycle (onboarding → workflow action → streaming/tool/UI-request events from the fake RPC child → focused-panel → transcript state → continuity mechanisms), (2) a packaged-launch browser test that visually proves the assembled happy path across views, and (3) a final regression pass of the complete test suite.

The user explicitly plans to perform the final manual UAT personally. S07 should leave the product ready for that validation — proving the assembly through connected code and tests, not replacing the human pass.

## Recommendation

Build the end-to-end proof in two layers:

**Layer 1: Route-level assembled lifecycle test.** Use the existing `configureBridgeServiceForTests` pattern with a `FakeRpcChild` that *also* emits `message_update`, `tool_start/tool_end`, `extension_ui_request` (blocking), and `agent_end/turn_end` events through its stdout — not just the `get_state`/`prompt` responses the onboarding test uses. This exercises the full SSE fanout → store routing → focused panel → UI response → transcript accumulation chain against real route handlers, proving the *wiring* between S01–S06 outputs in one connected test. This runs fast (no subprocess, no browser) and covers the contract.

**Layer 2: Packaged-launch browser acceptance test.** Extend the pattern from `web-mode-onboarding.test.ts` to cover the post-onboarding happy path: verify dashboard shows real workspace data (metrics, scope, action bar), use the workflow action button, verify the terminal shows streaming output, check that all major views (roadmap, activity, files) render real state instead of empty/placeholder. This is the visual proof that the assembled skin is alive.

Both layers use existing test infrastructure with targeted extensions, not new frameworks.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Subprocess RPC faking | `configureBridgeServiceForTests` + `FakeRpcChild` in `web-mode-onboarding.test.ts` | Already proven; handles spawn injection, stdin/stdout line protocol, and test-scoped cleanup |
| Packaged browser validation | `launchWebModeForBrowserOnboarding` + Playwright chromium in `web-mode-onboarding.test.ts` | Already handles temp-home isolation, browser-open stub, port allocation, and process cleanup |
| Fake API key validation | `GSD_WEB_TEST_FAKE_API_KEY_VALIDATION` env flag in `onboarding-service.ts` | Lets packaged tests skip real provider calls without faking the entire onboarding service |
| Route handler testing | Direct `import` of `web/app/api/*/route.ts` + `Request` construction | Used by all contract tests; works in Node with `--experimental-strip-types` |
| Event routing verification | `routeLiveInteractionEvent` contract in `web-live-interaction-contract.test.ts` | Already proves all 9 extension UI request variants plus streaming/transcript routing |
| Mock-free source invariant | Static grep-based tests in `web-state-surfaces-contract.test.ts` | Already asserts zero hardcoded data arrays across all five view files |
| Workflow action derivation | `deriveWorkflowAction` in `web/lib/workflow-actions.ts` (D018) | Pure function, 19 contract tests, used by dashboard + sidebar + power mode |

## Existing Code and Patterns

- `src/tests/integration/web-mode-onboarding.test.ts` — Best template for the S07 browser acceptance test. Covers packaged launch, fake RPC child with stdin/stdout protocol, Playwright browser interaction against `data-testid` surfaces, and full cleanup. The `FakeRpcChild` needs extension to emit streaming/UI-request events.
- `src/tests/integration/web-mode-runtime.test.ts` — Simpler launch-and-shell test. Proves boot + SSE + browser hydration. S07 can skip re-testing this path since it's already proven.
- `src/tests/web-live-interaction-contract.test.ts` — Proves the store's event routing for all UI request types, transcript accumulation, and steer/abort commands. The contract test mirrors `routeLiveInteractionEvent` inline. S07 should call through the real route handlers rather than inline mirrors.
- `src/web/bridge-service.ts` — `BridgeService.handleStdoutLine` parses JSON from the RPC child's stdout and either resolves pending request promises (for `type: "response"`) or broadcasts through `emit()` to SSE subscribers (for events like `message_update`, `extension_ui_request`, etc.). The `FakeRpcChild` just needs to write those events to its stdout PassThrough.
- `web/lib/gsd-workspace-store.tsx` — `routeLiveInteractionEvent` classifies SSE events into store state. `sendCommand` posts through `/api/session/command`. `refreshBoot` fetches `/api/boot`. All store behavior is already exercised by the contract tests; S07 proves it works through the real route layer.
- `web/components/gsd/` — All 11 components are mock-free and wired to the store or real API endpoints. The key `data-testid` surfaces (39 unique values across all components) are the browser test anchors.

## Constraints

- The `FakeRpcChild` stdout must emit valid JSON-per-line matching the RPC protocol's event shapes (`AgentSessionEvent`, `RpcExtensionUIRequest`, `RpcResponse`). The bridge service's `handleStdoutLine` parses and routes these; malformed lines are silently dropped.
- Packaged integration tests require `dist/web/standalone/server.js` and `packages/pi-coding-agent/dist/index.js` to exist. The `ensureRuntimeArtifacts()` helper handles building on-demand but adds ~60–90s on cold runs.
- The `MODULE_TYPELESS_PACKAGE_JSON` warning from `web/package.json` persists in all Node-based route tests. It is cosmetic and should not be "fixed" by S07 since it would change the web package contract.
- `web-live-interaction-contract.test.ts` has a pre-existing file-level hang after all tests pass (unresolved promise from bridge cleanup). Not introduced by S06, not an S07 blocker — the tests still pass and exit eventually.
- The S07 context explicitly says the user will do final manual testing themselves. S07 proves the assembly through connected tests, not a full scripted UAT.

## Common Pitfalls

- **Assuming existing integration tests already prove the assembled system** — They don't. `web-mode-runtime.test.ts` proves launch+shell, `web-mode-onboarding.test.ts` proves onboarding+unlock+first-command. Neither exercises the workflow action → agent streaming → focused panel → transcript loop. S07 exists to close exactly this gap.
- **Trying to write one enormous Playwright test that exercises every feature** — The browser test should be targeted at the happy-path assembly: "launch, onboard, see real data, use controls, verify liveness." Edge-case coverage (reconnect, timeouts, transcript caps) is already handled by the contract tests and does not need browser-level re-proving.
- **Extending the `FakeRpcChild` with too much simulation fidelity** — The fake child needs to emit a few representative events (`message_update` with text deltas, `tool_start/tool_end`, one blocking `extension_ui_request`, `agent_end/turn_end`) to prove the full pipe is wired. It does not need to simulate a realistic agent conversation.
- **Breaking existing tests by modifying bridge-service test seams** — The `configureBridgeServiceForTests` and `resetBridgeServiceForTests` pattern is shared. Any extensions must remain backward-compatible with the onboarding integration tests.
- **Adding new UI components or redesigning surfaces** — D002 is explicit: preserve the exact skin. S07 is assembly + proof, not polish or new features.

## Open Risks

- **Browser test timing sensitivity**: The packaged launch test spawns a real Next.js standalone server and waits for boot readiness. Under heavy load, this could hit the 90-second timeout. The existing tests mitigate this with `waitForHttpOk` polling, but S07's longer test flow increases the window.
- **Focused panel UI response round-trip in browser**: The focused panel opens when `pendingUiRequests` is non-empty. In the browser test, verifying the focused panel requires the fake RPC child to emit a blocking `extension_ui_request` through stdout, which then flows through bridge → SSE → store → React. This multi-hop path has not been exercised in a browser test before.
- **Test suite total execution time**: Adding S07 integration tests to the test suite increases CI time. The two existing integration tests already take ~60s combined. A thorough S07 browser test could add another 30–60s.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Playwright | `currents-dev/playwright-best-practices-skill@playwright-best-practices` | available (10K installs) — could improve test patterns but not required for S07 scope |
| Next.js | `wshobson/agents@nextjs-app-router-patterns` | available (8.4K installs) — not relevant; S07 does not modify Next.js routing |

Neither skill is required. The existing test infrastructure and patterns are sufficient for S07.

## Sources

- All findings from direct codebase exploration — no external sources needed. The entire web mode assembly (routes, store, components, bridge, onboarding, tests) was read and traced during this research.
