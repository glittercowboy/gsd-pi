---
estimated_steps: 4
estimated_files: 2
---

# T02: Enhance collectOneSecret with guidance and thread through execute

**Slice:** S02 — Enhanced Collection TUI
**Milestone:** M001

## Description

The `guidance` field exists in the `secure_env_collect` tool schema but is never passed to `collectOneSecret()` or rendered in the TUI. This task adds an optional `guidance: string[]` parameter to `collectOneSecret()`, renders numbered guidance steps as dim/muted lines above the editor (same page as input, per D004), and threads `item.guidance` through at the call site in `execute()`.

Guidance steps must use `wrapTextWithAnsi()` for line wrapping — not `truncateToWidth()` — because guidance often contains long URLs (80+ chars) that would lose critical information if truncated. Status: this delivers R003 (step-by-step guidance per key) and R010 (guidance display in secure_env_collect).

## Steps

1. Add `guidance?: string[]` as a sixth optional parameter to `collectOneSecret()` (after `hint`). This preserves backward compatibility — existing callers don't pass it.
2. In the `render()` function inside `collectOneSecret()`, after the hint line and before the "Preview:" line, render guidance steps. For each step, output a numbered line like `  1. Step text` styled with `theme.fg("dim", ...)`. Use `wrapTextWithAnsi(line, width - 4)` to wrap long guidance steps (the 4 accounts for the indent). Each wrapped line gets the same indent.
3. At the call site in `execute()` (~line 302), change `collectOneSecret(ctx, i, params.keys.length, item.key, item.hint)` to also pass `item.guidance`. The schema already accepts `guidance: string[]`.
4. Update the guidance-render test in `collect-from-manifest.test.ts` to verify that the render function output includes guidance lines when provided. Since `collectOneSecret` is a TUI function, the test should verify the render function directly by extracting or mocking the render logic, or by testing the function signature accepts guidance.

## Must-Haves

- [ ] `collectOneSecret()` accepts optional `guidance: string[]` parameter
- [ ] Guidance renders as numbered dim lines between hint and preview
- [ ] Long guidance lines wrap (not truncate) using `wrapTextWithAnsi()`
- [ ] `execute()` passes `item.guidance` to `collectOneSecret()`
- [ ] Existing callers without guidance see no visual change
- [ ] `npm run build` passes

## Verification

- `npm run build` exits 0
- `npm run test` — no regressions
- Grep for `item.guidance` in the execute function to confirm threading
- Test in `collect-from-manifest.test.ts` for guidance parameter acceptance passes

## Observability Impact

- Signals added/changed: None (TUI-only change)
- How a future agent inspects this: Read `collectOneSecret()` signature and render function to confirm guidance parameter is threaded
- Failure state exposed: None

## Inputs

- `src/resources/extensions/get-secrets-from-user.ts` — current `collectOneSecret()` at line ~149, call site at line ~302
- S02-RESEARCH.md — pitfall about `wrapTextWithAnsi` vs `truncateToWidth`, cache invalidation notes

## Expected Output

- `src/resources/extensions/get-secrets-from-user.ts` — `collectOneSecret()` enhanced with guidance rendering, `execute()` threading guidance through
- `src/resources/extensions/gsd/tests/collect-from-manifest.test.ts` — guidance-related test passing
