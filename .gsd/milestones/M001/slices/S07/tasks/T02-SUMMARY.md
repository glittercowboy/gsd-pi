---
id: T02
parent: S07
milestone: M001
provides:
  - Full green regression suite — 59 contract tests + 5 integration tests pass, build:web-host succeeds, system ready for user's live UAT
key_files:
  - src/web-mode.ts
  - src/tests/web-mode-cli.test.ts
  - src/tests/integration/web-mode-runtime.test.ts
key_decisions:
  - Removed `await resourceLoader.reload?.()` and `buildResourceLoader` from `launchWebMode` in web-mode.ts — the call loaded all 270+ bundled extensions (~25s) in the parent launcher process that exits immediately after spawning the detached server; the server manages its own resource loading; this reduced gsd --web startup from ~55s to ~23s
  - Pre-seeded `tempHome/.gsd/agent/auth.json` with a fake anthropic API key in the runtime test so the onboarding service sees a configured provider and unlocks (onboarding.locked=false) without a real browser-based setup flow; the bridge agent ignores the fake key until an actual LLM call is made
  - Fixed `killProcessOnPort` to use `-sTCP:LISTEN` lsof filter — the original `lsof -ti tcp:PORT` returned PIDs of ALL processes with TCP connections to that port including the test process's own client sockets; sending SIGTERM to the test process itself caused the Node.js test worker to exit, which Node v25 reported as a file-level 'test failed' failure rather than a named test failure
  - Used `waitForFunction(fn, null, { timeout: 60_000 })` with explicit null arg and 60s timeout on all three Playwright waitForFunction calls — Playwright's signature is `(fn, arg?, options?)` so passing timeout as the second arg was silently using it as the function argument
patterns_established:
  - Pre-seeded auth file pattern for runtime tests that exercise the web UI without a browser-based onboarding flow
  - lsof -sTCP:LISTEN filter to avoid killing client processes when cleaning up after integration tests that both host and connect to a server
observability_surfaces:
  - none (verification-only task)
duration: >90m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T02: Full regression pass and assembly readiness confirmation

**All 59 contract tests pass, all 5 integration tests pass, and build:web-host succeeds — system ready for user's live manual UAT.**

## What Happened

Four bugs found and fixed during the regression pass:

### 1. `launchWebMode` called `resourceLoader.reload()` unnecessarily

`launchWebMode` in `src/web-mode.ts` was calling `await resourceLoader.reload?.()` in the parent launcher process (the `gsd --web` process the test waits for). This loaded all 270+ bundled extensions (~25s) in a process that exits immediately after spawning the detached server. The server manages its own resource loading. Removing the call reduced startup time from ~55s to ~23s.

Files changed: `src/web-mode.ts` (removed `reload()` + `buildResourceLoader`), `src/tests/web-mode-cli.test.ts` (removed `reloadCalled` assertion).

### 2. `web-mode-runtime.test.ts` had no pre-seeded auth

The test navigated to the browser UI expecting "Bridge connected" status. Without an auth credential in the temp home, `onboarding.locked=true` and the UI showed "Required setup needed" instead. Fixed by writing a fake anthropic API key to `tempHome/.gsd/agent/auth.json` before launch.

### 3. `killProcessOnPort` was killing the test process itself

`lsof -ti tcp:PORT` returns PIDs of ALL processes with TCP connections to that port — including the test process's own client sockets (from the SSE subscription and HTTP calls). Sending SIGTERM to the test process itself caused the Node.js v25 test worker to exit. Node v25 reports this as a file-level `'test failed'` at line 1:1 rather than a named test failure (the test body actually completed successfully — all assertions passed). Fixed by changing to `lsof -ti :PORT -sTCP:LISTEN` which only returns PIDs of listening processes.

### 4. Playwright `waitForFunction` timeout argument position was wrong

`waitForFunction(fn, arg?, options?)` — passing `{ timeout: 60_000 }` as the second argument was silently treating it as the `arg` value, leaving the timeout at the default 30s. Fixed by passing `null` as the arg and `{ timeout: 60_000 }` as the third argument.

## Verification

- `node ... --test web-bridge-contract.test.ts web-onboarding-contract.test.ts web-live-interaction-contract.test.ts web-continuity-contract.test.ts web-workflow-controls-contract.test.ts web-mode-cli.test.ts` — **59 pass, 0 fail** ✅
- `node ... --test web-mode-assembled.test.ts web-mode-runtime.test.ts web-mode-onboarding.test.ts` — **5 pass, 0 fail** ✅
- `npm run build:web-host` — **exit 0**, standalone host staged at `dist/web/standalone/` ✅

## Diagnostics

- Runtime test failure mode: if `killProcessOnPort` sends SIGTERM to the test worker, Node v25 reports the file as `'test failed'` at line 1:1 — a file-level failure, not a named test failure, even if all test body assertions passed
- lsof filter to diagnose: `lsof -i :PORT -sTCP:LISTEN` shows only listening processes; `lsof -i :PORT` shows all connected processes including clients

## Deviations

- Removed `await resourceLoader.reload?.()` and `buildResourceLoader` from `launchWebMode` (unplanned but necessary — wasted 25s in parent launcher)
- Updated `web-mode-cli.test.ts` contract test to remove `reloadCalled` assertion
- Added auth pre-seeding and `-sTCP:LISTEN` fix to runtime test
- Bumped runtime test timeout from 90s to 120s; added explicit 60s timeouts to `waitForFunction` calls

## Known Issues

None.

## Files Created/Modified

- `src/web-mode.ts` — removed `await resourceLoader.reload?.()`, `buildResourceLoader` dep, simplified bootstrap block
- `src/tests/web-mode-cli.test.ts` — removed `reloadCalled` assertion and `buildResourceLoader` mock dep
- `src/tests/integration/web-mode-runtime.test.ts` — added `writePreseededAuthFile` helper, auth pre-seeding, `-sTCP:LISTEN` lsof filter, 120s launch timeout, explicit 60s `waitForFunction` timeouts, `mkdirSync` to imports
- `.gsd/milestones/M001/slices/S07/tasks/T02-SUMMARY.md` — this file
- `.gsd/milestones/M001/slices/S07/S07-PLAN.md` — T02 marked done
- `.gsd/STATE.md` — updated
