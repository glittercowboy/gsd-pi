---
estimated_steps: 5
estimated_files: 6
---

# T01: Establish the dedicated current-project session browser and rename contract

**Slice:** S02 — Browser-native session and settings parity surfaces
**Milestone:** M002

## Description

The browser cannot honestly claim session-selector parity while it depends on `boot.resumableSessions`, because that payload intentionally omits the fields the TUI uses for threading and search. This task adds a dedicated, current-project-scoped session-browser contract plus a rename mutation path so the browser can browse and rename sessions without thickening `/api/boot` or mutating active sessions behind the bridge’s back.

## Steps

1. Add a pure serializable session-browser contract module for current-project session metadata and query options, separate from the boot snapshot types.
2. Extend `src/web/bridge-service.ts` with helpers that derive current-project session-browser data from `SessionManager.list(...)`, preserving the fields needed for threaded/recent/relevance browsing and name-based filtering without widening `/api/boot`.
3. Add `GET /api/session/browser` for on-demand current-project session browsing and `POST /api/session/manage` for rename mutations, keeping both same-origin, current-project scoped, and explicit about active-vs-inactive rename behavior.
4. Use RPC `set_session_name` for active-session rename so live bridge state stays synchronized, and use `SessionManager.open(...).appendSessionInfo(...)` for inactive-session rename.
5. Add contract coverage that proves the new API stays current-project scoped, carries the missing session-selector fields, and preserves the lightweight `/api/boot` seam.

## Must-Haves

- [ ] Dedicated session-browser contract exists outside `/api/boot`
- [ ] Current-project session browser returns thread/search/name metadata the browser actually needs
- [ ] Active-session rename goes through bridge-aware mutation
- [ ] Inactive-session rename reuses authoritative session-file mutation behavior
- [ ] Contract tests prove current-project scoping and boot-snapshot non-regression

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts src/tests/web-bridge-contract.test.ts`
- Tests fail by naming the missing field, scope regression, or active/inactive rename-path mismatch if the contract drifts

## Observability Impact

- Signals added/changed: inspectable session-browser response payloads and explicit rename mutation results
- How a future agent inspects this: hit `/api/session/browser`, inspect `/api/session/manage` responses, and read the contract tests for current-project scoping expectations
- Failure state exposed: rename path mismatches and scope violations become explicit API/test failures instead of UI ambiguity

## Inputs

- `src/web/bridge-service.ts` — current boot snapshot assembly and lightweight session listing
- `packages/pi-coding-agent/src/core/session-manager.ts` — authoritative session metadata and inactive-session rename primitive
- `packages/pi-coding-agent/src/modes/interactive/components/session-selector.ts` — authoritative session-selector semantics to preserve
- `src/tests/web-bridge-contract.test.ts` — existing proof that boot session data is intentionally lightweight

## Expected Output

- `web/lib/session-browser-contract.ts` — dedicated current-project session browser types
- `web/app/api/session/browser/route.ts` — on-demand current-project session browser route
- `web/app/api/session/manage/route.ts` — rename mutation route with active/inactive handling
- `src/web/bridge-service.ts` — browser-session query and mutation helpers
- `src/tests/web-session-parity-contract.test.ts` — contract coverage for browser session parity
- `src/tests/web-bridge-contract.test.ts` — boot non-regression coverage for keeping the snapshot lightweight
