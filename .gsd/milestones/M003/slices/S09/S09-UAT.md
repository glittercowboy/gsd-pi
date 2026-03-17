# S09: Test suite hardening — UAT

**Milestone:** M003
**Written:** 2026-03-17

## UAT Type

- UAT mode: live-runtime
- Why this mode is sufficient: Test suites and builds execute real code paths — green exit codes are the definitive proof.

## Preconditions

- All S01-S08 slice work is merged into the codebase
- Node.js v25+ with `--experimental-strip-types` support
- `packages/pi-coding-agent` built (dist/ exists) — `npm run build:pi` if needed
- Playwright browsers installed — `npx playwright install chromium` if needed

## Smoke Test

Run `npm run test:unit` from the repo root. Expect the summary line to show `pass 1197` and `fail 0`.

## Test Cases

### 1. Unit test suite passes clean

1. `cd /path/to/GSD-2`
2. `npm run test:unit`
3. **Expected:** Exit code 0. Summary shows `pass 1197`, `fail 0`, `cancelled 0`.

### 2. Integration test suite passes clean

1. `cd /path/to/GSD-2`
2. `npm run test:integration`
3. **Expected:** Exit code 0. All tests pass (21+ pass, 0 fail). No `waitForLaunchedHostReady` timeouts.

### 3. TypeScript build succeeds

1. `cd /path/to/GSD-2`
2. `npm run build`
3. **Expected:** Exit code 0. No compilation errors. `dist/` directory populated.

### 4. Web host build succeeds

1. `cd /path/to/GSD-2`
2. `npm run build:web-host`
3. **Expected:** Exit code 0. All API routes listed. `dist/web/standalone/server.js` exists. "Staged web standalone host" message appears.

### 5. dist-redirect resolver handles /dist/ imports correctly

1. `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-bridge-contract.test.ts`
2. **Expected:** All tests pass. No `ERR_MODULE_NOT_FOUND` for `dist/oauth.js` or `dist/oauth.ts`.

### 6. dist-redirect resolver handles .tsx files correctly

1. `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-diagnostics-contract.test.ts`
2. **Expected:** 28/28 pass. No `ERR_INVALID_TYPESCRIPT_SYNTAX` errors.

### 7. Assembled slash-command test reflects S02 dispatch

1. `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test --test-name-pattern "slash-command" src/tests/integration/web-mode-assembled.test.ts`
2. **Expected:** Test passes. `/gsd status` dispatches as `surface` (kind: "surface", surface: "gsd-status"). `/gsd auto` dispatches as `prompt` passthrough.

### 8. Terminal component present on default view

1. Launch `gsd --web`
2. Open browser to the launched URL
3. **Expected:** Bottom terminal panel shows the GSD agent terminal with command input field (has `data-testid="terminal-command-input"`), not the xterm PTY shell terminal.

## Edge Cases

### Timing-sensitive stop-auto-remote test

1. `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/stop-auto-remote.test.ts`
2. **Expected:** Passes. Has KNOWN FLAKE comment. If it fails intermittently under heavy load, re-run in isolation.

### derive-state-db aspirational test

1. `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/derive-state-db.test.ts`
2. **Expected:** All tests pass. Test 5 ("requirements from DB content") expects 0 requirements counts (documented as aspirational — DB loading path not implemented).

### github-client on different remotes

1. `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/github-client.test.ts`
2. **Expected:** Passes regardless of which GitHub remote (fork or upstream) is configured. Asserts non-null owner/repo with no slashes, not specific values.

## Failure Signals

- `npm run test:unit` exit code non-zero → unit test regression
- `npm run test:integration` exit code non-zero → integration regression
- `ERR_MODULE_NOT_FOUND` with `dist/oauth.ts` in stderr → dist-redirect /dist/ guard broken
- `ERR_INVALID_TYPESCRIPT_SYNTAX` in stderr → .tsx load hook broken
- `waitForLaunchedHostReady: Timeout` → packaged host not starting in time or terminal-command-input element missing from DOM
- `npm run build` or `npm run build:web-host` exit non-zero → compilation or bundling regression

## Requirements Proved By This UAT

- R110 — All four verification commands (test:unit, test:integration, build, build:web-host) pass clean after all M003 work

## Not Proven By This UAT

- Live browser UAT for individual feature surfaces (R101-R109) — those were verified in their respective slices (S02-S08)
- test:browser-tools — not part of S09 scope (R110 lists it but no failures were present)

## Notes for Tester

- Integration tests are slow (~5min total) because they launch real packaged web host processes with Playwright browsers. Run them with patience.
- If runtime integration tests timeout, check that `dist/web/standalone/server.js` exists and is current — run `npm run build:web-host` to refresh.
- The `stop-auto-remote` test is documented as a known flake. If it fails once, re-run in isolation before investigating.
- Unit test count baseline is 1197 — if it changes, verify whether tests were added or removed intentionally.
