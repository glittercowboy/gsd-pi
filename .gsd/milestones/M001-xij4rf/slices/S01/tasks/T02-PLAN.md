---
estimated_steps: 5
estimated_files: 3
skills_used:
  - test
  - review
---

# T02: Convert dispatch rules to UnifiedRule format and facade auto-dispatch.ts

**Slice:** S01 — Unified Rule Engine
**Milestone:** M001-xij4rf

## Description

Transform the 20 existing `DispatchRule` objects in `auto-dispatch.ts` into `UnifiedRule[]` format and make `auto-dispatch.ts` a thin facade that delegates `resolveDispatch()` to the `RuleRegistry`. All existing exports (`resolveDispatch`, `getDispatchRuleNames`, `DispatchAction`, `DispatchContext`, `DispatchRule`) must continue to work identically — tests import directly from `auto-dispatch.ts` and must not break.

The key design decision: each `DispatchRule` already has `name` and `match: (ctx) => Promise<DispatchAction | null>`. The unified shape wraps this as `when: "dispatch"`, `evaluation: "first-match"`, with `where` and `then` combined in the existing `match` function (since dispatch rules return the action from the match itself — they don't separate predicate from action). The `where` field on dispatch unified rules will be the existing `match` function. The `then` field can be a no-op or identity since the action is returned from `where`.

## Steps

1. **Add dispatch rule conversion to `rule-registry.ts`** — Add a function `convertDispatchRules(rules: DispatchRule[]): UnifiedRule[]` that maps each `DispatchRule` to a `UnifiedRule`:
   ```
   {
     name: rule.name,
     when: "dispatch",
     evaluation: "first-match",
     where: rule.match,   // the existing async (ctx) => DispatchAction | null
     then: (result) => result,  // identity — match already returns the action
   }
   ```
   **Critical: preserve array order exactly.** Dispatch is order-dependent (first-match-wins). Do NOT sort, filter, or reorder.

2. **Update `RuleRegistry.evaluateDispatch()`** — If not already done in T01 (it may have been implemented with mock data), ensure it iterates the dispatch-phase rules in order, calls `where(ctx)` (which is the original `match` function), and returns the first non-null result. On no match, return the "unhandled phase" stop action. This must produce byte-identical behavior to the current `resolveDispatch()` in `auto-dispatch.ts`.

3. **Refactor `auto-dispatch.ts` to a thin facade** — Keep `DISPATCH_RULES` as the internal source-of-truth array (still typed as `DispatchRule[]`). Keep all existing type exports (`DispatchAction`, `DispatchContext`, `DispatchRule`). Modify `resolveDispatch()` to:
   - Import `getRegistry` from `./rule-registry.ts`
   - Call `getRegistry().evaluateDispatch(ctx)` and return the result
   - If the registry is not initialized (during testing or direct import), fall back to the original inline loop over `DISPATCH_RULES` so tests that import `resolveDispatch` directly still work even without registry initialization
   Keep `getDispatchRuleNames()` as-is (reads from `DISPATCH_RULES`). **Also export `DISPATCH_RULES` (or a getter) so the registry initialization code in `auto.ts` (T03) can access the raw rules for conversion.**

4. **Expand `tests/rule-registry.test.ts`** — Add tests:
   - Import `DISPATCH_RULES` (or the getter) from `auto-dispatch.ts` and `convertDispatchRules` from `rule-registry.ts`
   - Test: `convertDispatchRules(DISPATCH_RULES)` produces exactly 20 `UnifiedRule` objects
   - Test: each converted rule has `when: "dispatch"`, `evaluation: "first-match"`, and the original `name`
   - Test: `listRules()` after construction with dispatch rules returns 20 rules
   - Test: the rule names from `listRules()` match `getDispatchRuleNames()` exactly (same order)

5. **Run dispatch-related existing tests** — Verify zero regression:
   - `dispatch-missing-task-plans.test.ts` — imports `resolveDispatch` from `../auto-dispatch.ts`
   - `validate-milestone.test.ts` — imports `resolveDispatch` from `../auto-dispatch.ts`
   - `rule-registry.test.ts` — new tests

## Must-Haves

- [ ] All 20 dispatch rules converted to `UnifiedRule[]` preserving exact order
- [ ] `resolveDispatch()` in `auto-dispatch.ts` delegates to registry when initialized, falls back to inline loop otherwise
- [ ] `getDispatchRuleNames()` still works and returns same names in same order
- [ ] `DispatchAction`, `DispatchContext`, `DispatchRule` types still exported from `auto-dispatch.ts`
- [ ] No dispatch rule name changed (D005)
- [ ] Dispatch-related tests pass: `dispatch-missing-task-plans.test.ts`, `validate-milestone.test.ts`

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/dispatch-missing-task-plans.test.ts` — passes
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/validate-milestone.test.ts` — passes
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/rule-registry.test.ts` — passes (including new dispatch conversion tests)
- `npx tsc --noEmit` — no type errors

## Inputs

- `src/resources/extensions/gsd/rule-types.ts` — unified rule type definitions from T01
- `src/resources/extensions/gsd/rule-registry.ts` — RuleRegistry class from T01
- `src/resources/extensions/gsd/auto-dispatch.ts` — existing 20 dispatch rules, `resolveDispatch`, `getDispatchRuleNames`
- `src/resources/extensions/gsd/tests/rule-registry.test.ts` — existing test file from T01 to expand

## Expected Output

- `src/resources/extensions/gsd/auto-dispatch.ts` — refactored to thin facade with fallback
- `src/resources/extensions/gsd/rule-registry.ts` — updated with `convertDispatchRules()` and refined `evaluateDispatch()`
- `src/resources/extensions/gsd/tests/rule-registry.test.ts` — expanded with dispatch conversion tests

## Observability Impact

- **New signal:** `convertDispatchRules(DISPATCH_RULES)` is the conversion function — a future agent can call it to inspect how dispatch rules map to the unified format.
- **Inspection surface:** `getRegistry().listRules().filter(r => r.when === "dispatch")` returns the converted dispatch rules in evaluation order. The count should match `getDispatchRuleNames().length`.
- **Failure shape:** If `resolveDispatch()` is called without registry initialization, it silently falls back to inline evaluation (no visible error). If the registry IS initialized and a rule is missing, `listRules()` returns fewer dispatch-phase rules than expected.
- **Existing surface preserved:** `getDispatchRuleNames()` still returns the same names in the same order, reading from the original `DISPATCH_RULES` array.
