# S01: Unified Rule Engine

**Goal:** All dispatch rules and hooks are entries in one flat registry with when/where/then shape; auto-mode runs identically to before; all existing tests pass.
**Demo:** `registry.listRules()` returns 20+ rules (dispatch + hook-derived), each with `name`, `when`, `where`, `then`, and `evaluation` fields. Running `npm run test:unit` passes all existing dispatch, hook, and auto-loop tests with zero behavioral regression.

## Must-Haves

- `UnifiedRule` type with `name`, `when` (phase tag), `where` (predicate), `then` (action builder), and `evaluation` strategy (`"first-match"` | `"all-matching"`)
- `RuleRegistry` class holding `UnifiedRule[]` with `listRules()`, `evaluateDispatch(ctx)`, `evaluatePostUnit(type, id, basePath)`, `evaluatePreDispatch(type, id, prompt, basePath)` methods
- All 20 dispatch rules expressed as `UnifiedRule` objects preserving evaluation order and first-match-wins semantics
- Post-unit hooks loaded from preferences at evaluation time (not cached) become `UnifiedRule` objects with `evaluation: "all-matching"` and lifecycle fields (`artifact`, `retry_on`, `max_cycles`)
- Pre-dispatch hooks loaded from preferences at evaluation time become `UnifiedRule` objects with `evaluation: "all-matching"`
- Existing `auto-dispatch.ts` and `post-unit-hooks.ts` remain as thin facades — all direct imports from tests continue to resolve
- Hook lifecycle preserved: idempotency, retry_on, max_cycles, cycle state persistence, hook-on-hook prevention
- Users still define `post_unit_hooks` and `pre_dispatch_hooks` in `.gsd/preferences.md` — loaded into the registry at runtime
- All existing tests pass: `dispatch-missing-task-plans`, `validate-milestone`, `post-unit-hooks`, `retry-state-reset`, `auto-loop`

## Proof Level

- This slice proves: contract + integration
- Real runtime required: no (test suites exercise dispatch and hook behavior via mocked LoopDeps and temp directories)
- Human/UAT required: no

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/rule-registry.test.ts` — new registry tests pass
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/dispatch-missing-task-plans.test.ts` — existing dispatch regression test passes
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/validate-milestone.test.ts` — existing milestone validation test passes
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/post-unit-hooks.test.ts` — existing hook tests pass
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/retry-state-reset.test.ts` — existing retry regression test passes
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-loop.test.ts` — existing auto-loop tests pass
- `npx tsc --noEmit` — TypeScript compilation succeeds with no errors

## Observability / Diagnostics

- Runtime signals: `listRules()` returns a structured array of all registered rules — an LLM agent can inspect the full dispatch/hook configuration at any time
- Inspection surfaces: `registry.listRules()` method; `getDispatchRuleNames()` still works as before
- Failure visibility: if a dispatch rule or hook is missing from the registry, `listRules().length` will be less than expected; test assertions catch this
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: `auto-dispatch.ts` (20 `DispatchRule` objects, `resolveDispatch`, `getDispatchRuleNames`), `post-unit-hooks.ts` (all exported functions), `types.ts` (hook config types), `preferences.ts` (`resolvePostUnitHooks`, `resolvePreDispatchHooks`), `auto/loop-deps.ts` (`LoopDeps` interface)
- New wiring introduced in this slice: `RuleRegistry` singleton instantiated in `auto.ts`, passed through `LoopDeps`; `auto-dispatch.ts` and `post-unit-hooks.ts` become thin facades delegating to the registry singleton
- What remains before the milestone is truly usable end-to-end: S02 (journal emission on rule fires), S03 (journal query tool), S04 (tool naming convention)

## Tasks

- [x] **T01: Define unified rule types and build RuleRegistry class** `est:45m`
  - Why: The unified type system and registry class are the foundation for everything else. Pure new code with no integration risk — can be written and tested in isolation before touching existing modules.
  - Files: `src/resources/extensions/gsd/rule-types.ts`, `src/resources/extensions/gsd/rule-registry.ts`, `src/resources/extensions/gsd/tests/rule-registry.test.ts`
  - Do: (1) Create `rule-types.ts` with `UnifiedRule`, `RuleWhen` (`"dispatch"` | `"post-unit"` | `"pre-dispatch"`), `RuleWhere` (async/sync predicate), `RuleThen` (action builder), `RuleEvaluation` (`"first-match"` | `"all-matching"`), and optional lifecycle fields (`artifact`, `retry_on`, `max_cycles`, `idempotency_key`). (2) Create `rule-registry.ts` with `RuleRegistry` class: constructor takes `UnifiedRule[]`, methods `listRules()`, `evaluateDispatch(ctx)`, `evaluatePostUnit(type, id, basePath)`, `evaluatePreDispatch(type, id, prompt, basePath)`. Dispatch evaluation is async first-match-wins; hook evaluation is sync all-matching. The registry encapsulates mutable state (activeHook, hookQueue, cycleCounts, retryPending, retryTrigger) as instance fields. Include singleton accessor `getRegistry()` / `setRegistry()`. (3) Write `tests/rule-registry.test.ts` with tests: construct a registry from mock rules, `listRules()` returns them all, dispatch evaluation returns first match, hook evaluation returns all matches, async where predicates work, lifecycle fields are preserved. Tests use `node:test`.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/rule-registry.test.ts`
  - Done when: `rule-types.ts` and `rule-registry.ts` compile cleanly, new tests pass, `listRules()` works on mock data

- [x] **T02: Convert dispatch rules to UnifiedRule format and facade auto-dispatch.ts** `est:45m`
  - Why: Makes the 20 dispatch rules the first entries in the unified registry while preserving backward compatibility for all test imports.
  - Files: `src/resources/extensions/gsd/auto-dispatch.ts`, `src/resources/extensions/gsd/rule-registry.ts`, `src/resources/extensions/gsd/tests/rule-registry.test.ts`
  - Do: (1) In `rule-registry.ts`, add a static method or factory function `buildDispatchRules()` that converts the 20 `DispatchRule` objects from the existing `DISPATCH_RULES` array into `UnifiedRule[]` with `when: "dispatch"`, `evaluation: "first-match"`, `where` wrapping the existing `match` function, `then` extracting the action. **Preserve rule order exactly** — dispatch is order-dependent. (2) Refactor `auto-dispatch.ts` to become a thin facade: keep `DISPATCH_RULES` as the source-of-truth array, keep all existing exports (`resolveDispatch`, `getDispatchRuleNames`, `DispatchAction`, `DispatchContext`), but have `resolveDispatch` delegate to `registry.evaluateDispatch(ctx)`. (3) Update `tests/rule-registry.test.ts` to add a test: construct the registry with `buildDispatchRules()`, verify `listRules().filter(r => r.when === "dispatch").length` equals 20, verify `evaluateDispatch()` returns the same result as the old `resolveDispatch()` for a basic test case. (4) Run the 3 dispatch-related test files to verify zero regression. **Critical constraint: do NOT reorder, rename, or modify any dispatch rule's `name` field (D005). Do NOT change the DispatchAction type or DispatchContext type.**
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/dispatch-missing-task-plans.test.ts src/resources/extensions/gsd/tests/validate-milestone.test.ts src/resources/extensions/gsd/tests/rule-registry.test.ts`
  - Done when: `resolveDispatch()` delegates to the registry, all dispatch-related tests pass, `listRules()` shows 20 dispatch rules

- [ ] **T03: Convert hooks to UnifiedRule format, facade post-unit-hooks.ts, and wire registry into auto.ts** `est:1h`
  - Why: Completes the unification by bringing hooks into the registry and wiring the registry into the runtime. This is the highest-risk task because it touches mutable state, lifecycle semantics, and the runtime integration seam.
  - Files: `src/resources/extensions/gsd/post-unit-hooks.ts`, `src/resources/extensions/gsd/rule-registry.ts`, `src/resources/extensions/gsd/auto.ts`, `src/resources/extensions/gsd/auto-post-unit.ts`, `src/resources/extensions/gsd/tests/rule-registry.test.ts`
  - Do: (1) In `rule-registry.ts`, add methods that load hooks from preferences at evaluation time (call `resolvePostUnitHooks()` and `resolvePreDispatchHooks()` on each evaluation — do NOT cache, preferences can change mid-session). Post-unit hooks become `UnifiedRule` with `when: "post-unit"`, `evaluation: "all-matching"`, lifecycle fields (`artifact`, `retry_on`, `max_cycles`). Pre-dispatch hooks become `UnifiedRule` with `when: "pre-dispatch"`, `evaluation: "all-matching"`. (2) Refactor `post-unit-hooks.ts` to a thin facade: all 13 exported functions remain with identical signatures, but internally delegate to the singleton registry via `getRegistry()`. Module-level mutable state (`activeHook`, `hookQueue`, `cycleCounts`, `retryPending`, `retryTrigger`) moves to the `RuleRegistry` instance — the facade functions call through to instance methods. **Critical: `resetHookState()` must reset the registry's instance state. `getActiveHook()`, `isRetryPending()`, `consumeRetryTrigger()` must read from the registry instance. `persistHookState()` / `restoreHookState()` must serialize/deserialize the registry's cycle counts.** (3) In `auto.ts`, instantiate the `RuleRegistry` (with dispatch rules) and call `setRegistry()` so the singleton is available. The `resolveDispatch` and `runPreDispatchHooks` fields in the LoopDeps wiring (~line 909) should continue to work — they already call the facade functions which now delegate to the registry. (4) In `auto-post-unit.ts`, no import changes needed — it imports from `post-unit-hooks.ts` which is now a facade. (5) **Preserve these guards:** hook-on-hook prevention (`completedUnitType.startsWith("hook/")`), hook-state persistence key format (`"hookName/triggerUnitType/triggerUnitId"`), `triggerHookManually` force capability, sync evaluation for hooks (no accidental async). (6) Update `tests/rule-registry.test.ts`: add test that `listRules()` includes both dispatch and hook-derived rules when preferences are mocked with hooks configured. (7) Run ALL existing tests.
  - Verify: `npm run test:unit 2>&1 | tail -20` — all tests pass; specifically verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/post-unit-hooks.test.ts src/resources/extensions/gsd/tests/retry-state-reset.test.ts src/resources/extensions/gsd/tests/auto-loop.test.ts src/resources/extensions/gsd/tests/rule-registry.test.ts` and `npx tsc --noEmit`
  - Done when: All 5+ existing test files pass, new registry tests include hook-derived rules, `listRules()` returns dispatch + hook rules, `npx tsc --noEmit` succeeds, `post-unit-hooks.ts` exports are unchanged thin facades

## Files Likely Touched

- `src/resources/extensions/gsd/rule-types.ts` (new)
- `src/resources/extensions/gsd/rule-registry.ts` (new)
- `src/resources/extensions/gsd/auto-dispatch.ts` (refactor to facade)
- `src/resources/extensions/gsd/post-unit-hooks.ts` (refactor to facade)
- `src/resources/extensions/gsd/auto.ts` (registry instantiation wiring)
- `src/resources/extensions/gsd/auto-post-unit.ts` (possibly unchanged — imports facade)
- `src/resources/extensions/gsd/types.ts` (possibly unchanged — existing hook types stay)
- `src/resources/extensions/gsd/tests/rule-registry.test.ts` (new)
