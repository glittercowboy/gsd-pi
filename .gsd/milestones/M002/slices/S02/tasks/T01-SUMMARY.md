---
id: T01
parent: S02
milestone: M002
provides:
  - A dedicated current-project session-browser API and rename mutation contract that preserves TUI session semantics without widening `/api/boot`
key_files:
  - src/web/bridge-service.ts
  - web/lib/session-browser-contract.ts
  - web/app/api/session/browser/route.ts
  - web/app/api/session/manage/route.ts
  - src/tests/web-session-parity-contract.test.ts
  - src/tests/web-bridge-contract.test.ts
key_decisions:
  - Keep session search/threading server-side and call authoritative session-manager behavior through narrow child-process helpers so the web host stays build-safe while active/inactive rename semantics remain authoritative
patterns_established:
  - Rich browser session browsing now uses a dedicated on-demand contract (`/api/session/browser`) with flattened thread metadata, while active rename routes through bridge RPC and inactive rename routes through authoritative session-file mutation
observability_surfaces:
  - GET `/api/session/browser` payloads (`project`, `query`, `totalSessions`, `returnedSessions`, `sessions[]`)
  - POST `/api/session/manage` rename results (`success`, `sessionPath`, `name`, `isActiveSession`, `mutation`, `code` on failure)
  - contract coverage in `src/tests/web-session-parity-contract.test.ts` and boot non-regression coverage in `src/tests/web-bridge-contract.test.ts`
duration: 3h
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T01: Establish the dedicated current-project session browser and rename contract

**Shipped a dedicated current-project session-browser contract and rename API, with bridge-aware active renames, authoritative inactive renames, and boot-payload non-regression proof.**

## What Happened

I added `web/lib/session-browser-contract.ts` as the dedicated serializable contract for current-project session browsing and rename mutations. It defines the browser query options, flattened session view model, and explicit rename success/error result shapes separately from the boot snapshot types.

In `src/web/bridge-service.ts` I added new browser-session helpers that:
- derive current-project session-browser payloads without widening `/api/boot`
- preserve the TUI selector semantics the browser actually needs: threaded/recent/relevance behavior, named-only filtering, current-project search, `firstMessage`, `parentSessionPath`, and thread-depth metadata
- keep the search corpus server-side while returning only the visible fields the browser needs
- detect active vs inactive rename paths explicitly
- send active-session rename through bridge RPC `set_session_name`
- reuse authoritative inactive-session mutation behavior by calling `SessionManager.open(...).appendSessionInfo(...)` from a narrow subprocess helper

I added two same-origin routes:
- `web/app/api/session/browser/route.ts` — on-demand current-project browsing
- `web/app/api/session/manage/route.ts` — rename mutation with explicit active/inactive result metadata

For proof coverage, I created `src/tests/web-session-parity-contract.test.ts` to assert:
- `/api/session/browser` is current-project scoped
- the response carries the missing session-selector fields outside `/api/boot`
- search/name filtering work through the dedicated contract
- active rename uses RPC without direct file mutation
- inactive rename appends session info through authoritative file mutation
- out-of-scope rename attempts fail explicitly

I also tightened `src/tests/web-bridge-contract.test.ts` so `/api/boot` explicitly stays lightweight and does not leak `parentSessionPath` or thread metadata.

A nontrivial implementation detail: importing TUI/package runtime code directly into the Next host pulled native dependencies into the build. I avoided that by keeping the browser session contract server-side and calling the authoritative session-manager behavior through narrow child-process helpers instead of in-process package imports.

## Verification

Passed task-level verification:
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts src/tests/web-bridge-contract.test.ts`

Passed slice-level verification reruns after the final implementation:
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts src/tests/web-command-parity-contract.test.ts`
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-bridge-contract.test.ts src/tests/web-state-surfaces-contract.test.ts src/tests/web-live-interaction-contract.test.ts src/tests/integration/web-mode-assembled.test.ts`
- `npm run build:web-host`

The final `build:web-host` output included the new dynamic routes:
- `/api/session/browser`
- `/api/session/manage`

## Diagnostics

- Inspect current-project browse payloads directly with `GET /api/session/browser`
- Inspect rename mutation results directly with `POST /api/session/manage`
- Read `src/tests/web-session-parity-contract.test.ts` for the expected current-project scoping, search/name behavior, and active-vs-inactive rename split
- Read `src/tests/web-bridge-contract.test.ts` for the explicit proof that `/api/boot` stays lightweight

## Deviations

None.

## Known Issues

- Running the node-based contract tests emits non-blocking `MODULE_TYPELESS_PACKAGE_JSON` warnings for `web/lib/session-browser-contract.ts` because `web/package.json` is still not marked as an ES module package. This did not block any verification or the web-host build.

## Files Created/Modified

- `web/lib/session-browser-contract.ts` — new dedicated serializable contract for browser session browsing and rename mutation results
- `web/app/api/session/browser/route.ts` — same-origin on-demand current-project session browser route
- `web/app/api/session/manage/route.ts` — same-origin session rename route with explicit active/inactive handling
- `src/web/bridge-service.ts` — browser session query/mutation helpers, server-side search/thread derivation, and authoritative session-manager subprocess helpers
- `src/tests/web-session-parity-contract.test.ts` — contract coverage for browse/search/scope and active/inactive rename semantics
- `src/tests/web-bridge-contract.test.ts` — boot non-regression assertions that rich session-browser fields stay out of `/api/boot`
- `.gsd/DECISIONS.md` — recorded the server-side session-browser/subprocess decision for downstream work
