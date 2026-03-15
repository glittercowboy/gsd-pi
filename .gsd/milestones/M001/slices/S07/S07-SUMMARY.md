---
id: S07
parent: M001
milestone: M001
provides:
  - Route-level assembled lifecycle proof covering boot, onboarding, prompt streaming, tool execution, focused-panel UI-request round-trip, and turn boundaries through the real web routes
  - Full green web-mode regression proof: state-surface contract, 59-test contract regression, 5-test integration regression, and `npm run build:web-host`
  - Launch-path hardening: faster parent web launcher, safe port cleanup, stable runtime waits, and auth-preseeded browser runtime coverage
requires:
  - slice: S01
    provides: Live web host, boot payload, bridge transport, and current-project launch path
  - slice: S02
    provides: Browser onboarding gate, credential validation, and bridge auth refresh
  - slice: S03
    provides: Live terminal streaming and focused-panel UI request/response contract
  - slice: S04
    provides: Real dashboard, roadmap, files, and activity surfaces without mock placeholders
  - slice: S05
    provides: Visible start/resume workflow controls backed by real commands
  - slice: S06
    provides: Continuity, failure visibility, and power-mode control surfaces across refresh/reopen
affects:
  - M002
key_files:
  - src/tests/integration/web-mode-assembled.test.ts
  - src/web-mode.ts
  - src/tests/web-mode-cli.test.ts
  - src/tests/integration/web-mode-runtime.test.ts
  - src/tests/web-state-surfaces-contract.test.ts
key_decisions:
  - Keep the parent `launchWebMode` process thin — run filesystem sync only and let the detached host own extension loading
  - Use `lsof -ti :PORT -sTCP:LISTEN` for integration-test cleanup so port cleanup cannot kill the test worker itself
  - Prove async lifecycle delivery with a two-phase SSE verification pattern so user responses can split the event stream without brittle long-lived readers
patterns_established:
  - Final-assembly proof pattern: route-level fake-RPC lifecycle test plus live runtime/integration regressions plus standalone host build
  - Graceful-timeout SSE reader pattern for variable-count bridge event streams in route-level tests
  - Pre-seeded auth file pattern for browser runtime tests that need unlocked onboarding without a manual setup flow
observability_surfaces:
  - `src/tests/integration/web-mode-assembled.test.ts` assertion messages name the broken stage and list received event types
  - `src/tests/integration/web-mode-runtime.test.ts` verifies live host launch + browser attach to boot/SSE state
  - `src/tests/web-state-surfaces-contract.test.ts` enforces the mock-free invariant for integrated views
drill_down_paths:
  - .gsd/milestones/M001/slices/S07/tasks/T01-SUMMARY.md
  - .gsd/milestones/M001/slices/S07/tasks/T02-SUMMARY.md
duration: >100m
verification_result: passed
completed_at: 2026-03-15
---

# S07: End-to-end web assembly proof

**Added the final assembled route/runtime proof for web mode, hardened the launch/runtime edge cases found in regression, and left M001 waiting only on live manual browser UAT**

## What Happened

Two tasks closed the automation gap between the earlier slice-by-slice contracts and the assembled browser-first workflow.

**T01 — Route-level assembled lifecycle proof.** Added `src/tests/integration/web-mode-assembled.test.ts`, a single route-level integration test that exercises the full connected lifecycle through the real web route handlers: boot returns a ready bridge but locked onboarding; onboarding unlocks and restarts the bridge onto the new auth view; `/api/session/events` fans out SSE events; `/api/session/command` accepts a prompt; the fake RPC child emits `message_update`, `tool_execution_start`, `tool_execution_end`, and a blocking `extension_ui_request`; the browser-side `extension_ui_response` is posted back through the same command route; only then do `agent_end` and `turn_end` arrive. The assertions are stage-specific and include received event types when the pipeline breaks, so failures point directly at boot, onboarding, streaming, UI request, or turn-boundary regressions.

**T02 — Full regression and assembly hardening.** Running the broader regression surfaced four real issues, all fixed in this slice: `launchWebMode` was doing an unnecessary in-memory extension reload in the short-lived parent launcher process; the live runtime test needed pre-seeded auth so the browser could start unlocked; port cleanup used an unsafe `lsof` filter that could kill the test worker itself; and Playwright `waitForFunction` calls were passing timeout options in the wrong argument position. Fixing those issues made the packaged launch path materially faster and stabilized the live runtime proof.

At slice close, the full verification set was rerun, including `src/tests/web-state-surfaces-contract.test.ts`, because the assembled proof is not credible if the preserved skin can still regress back toward mixed mock/live content.

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/integration/web-mode-assembled.test.ts` — 1/1 pass
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-bridge-contract.test.ts src/tests/web-onboarding-contract.test.ts src/tests/web-live-interaction-contract.test.ts src/tests/web-continuity-contract.test.ts src/tests/web-workflow-controls-contract.test.ts` — 53/53 pass
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-state-surfaces-contract.test.ts` — 17/17 pass
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-bridge-contract.test.ts src/tests/web-onboarding-contract.test.ts src/tests/web-live-interaction-contract.test.ts src/tests/web-continuity-contract.test.ts src/tests/web-workflow-controls-contract.test.ts src/tests/web-mode-cli.test.ts` — 59/59 pass
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/integration/web-mode-assembled.test.ts src/tests/integration/web-mode-runtime.test.ts src/tests/integration/web-mode-onboarding.test.ts` — 5/5 pass
- `npm run build:web-host` — pass; standalone host staged at `dist/web/standalone/`

## Requirements Advanced

- R004 — Automated assembly proof now spans launch, onboarding, prompt streaming, focused-panel response round-trips, and transcript turn boundaries. The remaining closure step is the live manual browser pass.
- R009 — The launch path is materially leaner after removing the parent-process extension reload, and the integrated runtime/build regressions stay green. Subjective “snappy and fast” still needs the live human pass.

## Requirements Validated

- R005 — `src/tests/web-state-surfaces-contract.test.ts`, `src/tests/web-live-interaction-contract.test.ts`, `src/tests/web-workflow-controls-contract.test.ts`, `src/tests/web-continuity-contract.test.ts`, `src/tests/integration/web-mode-runtime.test.ts`, and `npm run build:web-host` together prove that the preserved skin is now a live workspace rather than a mock shell.
- R008 — `src/tests/web-state-surfaces-contract.test.ts` now enforces the mock-free invariant directly, proving the integrated views do not mix static placeholder data with live GSD state.

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

- Removed `await resourceLoader.reload?.()` and its `buildResourceLoader` dependency from `src/web-mode.ts`; the server already owns extension loading, so doing it in the parent launcher only burned startup time.
- Updated the runtime integration harness to pre-seed auth, use `lsof -ti :PORT -sTCP:LISTEN` for cleanup, and pass Playwright `waitForFunction` timeouts in the correct argument position.
- Reran `src/tests/web-state-surfaces-contract.test.ts` during slice closure even though it was omitted from the written verification command list, because the roadmap and must-haves still depend on the mock-free state-surface proof.

## Known Limitations

- M001 still needs the live manual browser UAT in `S07-UAT.md` before the milestone can be closed. R004 and the subjective portion of R009 should not be marked validated from automation alone.
- Node test runs still emit `MODULE_TYPELESS_PACKAGE_JSON` warnings for `web/` route imports. They are noisy but non-blocking and were not addressed in M001.

## Follow-ups

- Run `.gsd/milestones/M001/slices/S07/S07-UAT.md` against a real project/browser session. If it passes, close M001 and reassess M002 scope from the remaining browser/TUI parity gaps.

## Files Created/Modified

- `src/tests/integration/web-mode-assembled.test.ts` — new route-level assembled lifecycle proof through real web route handlers
- `src/web-mode.ts` — removed unnecessary parent-process extension reload from the web launcher
- `src/tests/web-mode-cli.test.ts` — updated launcher contract coverage to match the thinner parent bootstrap
- `src/tests/integration/web-mode-runtime.test.ts` — hardened live runtime coverage with pre-seeded auth, safe port cleanup, and correct Playwright wait semantics
- `.gsd/REQUIREMENTS.md` — moved R005 and R008 to validated after final assembly proof

## Forward Intelligence

### What the next slice should know
- The automation gap is closed. Remaining milestone risk is now human-experience risk, not missing route/bridge wiring.
- `src/tests/web-state-surfaces-contract.test.ts` is the authoritative guardrail against mock/live drift in the preserved skin. Keep it in any future web regression suite.
- The live runtime browser test now depends on pre-seeded auth rather than a browser-driven setup path. That keeps the runtime proof focused on launch/attach behavior instead of onboarding.

### What's fragile
- `src/web-mode.ts` — reintroducing in-memory extension reload into the short-lived parent launcher will regress `gsd --web` startup time immediately.
- `src/tests/integration/web-mode-runtime.test.ts` cleanup — dropping `-sTCP:LISTEN` from the `lsof` filter can kill the client test worker instead of the server process.

### Authoritative diagnostics
- `src/tests/integration/web-mode-assembled.test.ts` — first place to look when boot/onboarding/SSE/UI-response turn flow breaks, because the assertions name the failing stage and list received event types.
- `src/tests/integration/web-mode-runtime.test.ts` — best signal for packaged `gsd --web` launch and browser attach regressions.
- `src/tests/web-state-surfaces-contract.test.ts` — best signal for mock-data regressions in dashboard/roadmap/files/activity/terminal surfaces.

### What assumptions changed
- The parent web launcher was assumed to need a full resource-loader reload before spawning the host, but the detached host is the process that actually needs in-memory extensions.
- `lsof -ti tcp:PORT` looked like a safe cleanup command, but in a test harness it also matches client sockets and can terminate the test worker itself.
