# S02: Enhanced Collection TUI — Research

**Date:** 2026-03-12

## Summary

S02 enhances the existing `secure_env_collect` tool in `get-secrets-from-user.ts` with three capabilities: (1) a read-only summary screen showing all manifest entries with their status before collection starts, (2) guidance step display above the masked editor in `collectOneSecret()`, and (3) auto-skip of keys already present in `.env`/`process.env`. All three changes are confined to a single file (`get-secrets-from-user.ts`) plus a new orchestrator function `collectSecretsFromManifest()` that ties manifest parsing to the enhanced TUI.

The existing codebase already provides nearly everything needed. The `guidance` field exists in the tool schema but is never passed to `collectOneSecret()` or rendered. `checkExistingEnvKeys()` and `detectDestination()` are already exported utilities with full test coverage. The `makeUI()` design system in `shared/ui.ts` provides `progressItem()`, `statusGlyph()`, `bar()`, `header()`, `hints()`, and other primitives that should be reused for the summary screen — do not hand-roll styled lines.

The primary risk is TUI layout at narrow terminal widths. Guidance steps rendered above the editor add 5-10 lines of content. At very narrow widths (< 60 cols) or with long guidance text, the page could feel cramped. `wrapTextWithAnsi()` from `@mariozechner/pi-tui` handles line wrapping, and the `render(width)` contract only receives width — height/scroll is handled by the framework. Still, the visual result at different widths should be verified during UAT.

## Recommendation

Make minimal, backward-compatible changes to `get-secrets-from-user.ts`:

1. **Extend `collectOneSecret()` signature** to accept an optional `guidance: string[]` parameter. Render guidance steps as numbered lines (dim/muted) between the key header and the editor. Existing callers that don't pass guidance see no change.

2. **Add `showSecretsSummary()` function** as a new `ctx.ui.custom` screen. It shows all keys with status indicators using `makeUI()` primitives (`progressItem` for each key, status mapped to `ProgressStatus`). Read-only — any key dismisses it.

3. **Add `collectSecretsFromManifest()` orchestrator** that: reads the manifest via `parseSecretsManifest()`, checks existing keys via `checkExistingEnvKeys()`, detects destination via `detectDestination()`, shows the summary screen, collects only pending keys (with guidance), updates manifest entry statuses, and writes the updated manifest back via `formatSecretsManifest()`.

4. **Thread `item.guidance` through** at the existing call site (line 302) so the tool's `execute()` method passes guidance to `collectOneSecret()`.

All new functions (`showSecretsSummary`, `collectSecretsFromManifest`) should be exported so S03 can call them from `auto.ts` and `guided-flow.ts`.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Styled status indicators | `makeUI()` → `progressItem()`, `statusGlyph()` in `shared/ui.ts` | Consistent theme colors, glyphs, and spacing across all TUI screens |
| Text wrapping at terminal edge | `wrapTextWithAnsi()`, `truncateToWidth()` from `@mariozechner/pi-tui` | Already handles ANSI codes correctly, width-aware |
| Env key detection | `checkExistingEnvKeys()` in `get-secrets-from-user.ts` | Already tested (7 test cases in `secure-env-collect.test.ts`) |
| Destination inference | `detectDestination()` in `get-secrets-from-user.ts` | Already tested (5 test cases) |
| Manifest parse/format | `parseSecretsManifest()` / `formatSecretsManifest()` in `gsd/files.ts` | Proven round-trip (S01/T02: 377 parser tests), handles LLM formatting quirks |
| Manifest status query | `getManifestStatus()` in `gsd/files.ts` (from S01) | 7 contract tests covering all categorization paths |
| Editor component | `Editor` from `@mariozechner/pi-tui` | Already used by `collectOneSecret()` — keep the same pattern |

## Existing Code and Patterns

- `src/resources/extensions/get-secrets-from-user.ts` — **The file being modified.** `collectOneSecret()` (line 149) accepts `(ctx, pageIndex, totalPages, keyName, hint)` and renders a masked editor page via `ctx.ui.custom`. The `guidance` field exists in the schema (line 271) but is never passed to the function — the call site at line 302 passes only `item.key` and `item.hint`. All new functions go in this same file.

- `src/resources/extensions/shared/ui.ts` — **Reuse for summary screen.** `makeUI(theme, width)` returns a `UI` object with `bar()`, `header()`, `progressItem(label, status)`, `statusGlyph()`, `hints()`, `blank()`, `meta()`. The summary screen should follow the same render pattern as `showConfirm()` and `showNextAction()`.

- `src/resources/extensions/shared/confirm-ui.ts` — **Pattern reference for read-only screens.** Shows how to build a `ctx.ui.custom` component that resolves on key press. The summary screen follows this pattern: render → wait for any key → `done()`.

- `src/resources/extensions/gsd/files.ts` — Contains `parseSecretsManifest()`, `formatSecretsManifest()`, and (after S01 merge) `getManifestStatus()`. The orchestrator will import parse/format from here. `getManifestStatus()` is useful for S03 but the orchestrator function needs more than just key lists — it needs full `SecretsManifestEntry` objects for guidance/hint data.

- `src/resources/extensions/gsd/types.ts` — Contains `SecretsManifest`, `SecretsManifestEntry`, `SecretsManifestEntryStatus`, and (after S01 merge) `ManifestStatus`. The orchestrator works with `SecretsManifestEntry` directly.

- `src/resources/extensions/gsd/tests/secure-env-collect.test.ts` — 12 existing tests covering `checkExistingEnvKeys()` and `detectDestination()`. New unit tests for non-TUI logic (the orchestrator's categorization/skip logic) should go here or in a new test file.

## Constraints

- **Backward compatibility is mandatory.** Existing callers of `collectOneSecret()` must work unchanged. The new `guidance` parameter must be optional. The `execute()` method signature and return shape must not change.
- **S01 branch must be merged first.** `getManifestStatus()`, `ManifestStatus` type, and manifest-status tests exist on commit `05ff6c6` but not on the current `gsd/M001/S02` branch. Either merge S01 first, or duplicate the needed imports. The orchestrator can work with `parseSecretsManifest()` directly (already on this branch) and do its own env check — it doesn't strictly need `getManifestStatus()`.
- **`render(width)` receives only width.** Height/scrolling is handled by the TUI framework. Don't try to manage scroll manually.
- **`ctx.ui.custom` render function must return `string[]`.** Each element is one terminal line. Use `truncateToWidth()` for every line.
- **Summary screen is read-only (D003).** No interactive deselection. Any key press advances past it.
- **Guidance renders on same page as input (D004).** No separate info page.
- **File I/O from the tool execute function uses `ctx.cwd` for relative paths.** The orchestrator needs access to `ctx.cwd` and `ctx.ui` to function.

## Common Pitfalls

- **Forgetting to invalidate cached lines on guidance content.** The `collectOneSecret` `render()` function caches lines in `cachedLines`. If guidance is dynamic (it isn't, but future changes might make it so), the cache must be invalidated. For this work, guidance is static per key, so the initial render is fine — but add guidance to the cache key if it ever becomes mutable.

- **Long guidance steps at narrow widths.** A guidance step like "Navigate to https://platform.openai.com/api-keys and click 'Create new secret key'" is 80+ chars. Must use `wrapTextWithAnsi()` for guidance lines, not just `truncateToWidth()`. Truncation would hide critical info.

- **Status mapping mismatch.** `SecretsManifestEntryStatus` is `'pending' | 'collected' | 'skipped'`. The `ProgressStatus` type in `shared/ui.ts` includes `'pending' | 'done' | 'skipped'` among others. Map `collected → done` when calling `progressItem()`. Don't try to pass `'collected'` directly.

- **Import path from gsd/ to get-secrets-from-user.ts.** S01 discovered this: it's `../get-secrets-from-user.ts` from `gsd/files.ts`, not `../../`. For the reverse direction (if get-secrets-from-user.ts needs to import from gsd/), the path is `./gsd/files.ts`.

- **Manifest write-back requires the manifest file path.** The orchestrator needs to know where the manifest file is to write updated statuses. Use `resolveMilestoneFile(base, milestoneId, "SECRETS")` from `gsd/paths.ts`. This means the orchestrator needs `base` (project root / `.gsd` parent) and `milestoneId` as parameters.

## Open Risks

- **Visual quality at terminal widths < 60 columns.** Guidance steps, key names, and status indicators all compete for space. The framework handles wrapping, but the result may look crowded. This is the risk the roadmap explicitly identifies for S02 to retire — must be verified during UAT.
- **S01 branch state.** S01's commits exist but the slice summary is a doctor-generated placeholder. The code changes (types.ts, files.ts) look correct based on diff inspection, but the S01 branch was never properly closed. If S01 code has bugs, they'll surface here.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| pi-tui | `joelhooks/pi-tools@pi-tui-design` (22 installs) | available — could help with TUI layout patterns |

Note: The `pi-tui-design` skill may provide useful patterns for the summary screen layout but is not essential — the existing `makeUI()` design system and patterns in `confirm-ui.ts` / `next-action-ui.ts` are sufficient. The codebase already has strong TUI patterns to follow.

## Sources

- Codebase exploration: `get-secrets-from-user.ts` (full read), `shared/ui.ts` (full read), `shared/confirm-ui.ts` (full read), `shared/next-action-ui.ts` (full read), `gsd/files.ts` (parser/formatter sections), `gsd/types.ts` (full read)
- S01 task summaries: `T01-SUMMARY.md` (getManifestStatus implementation), `T02-SUMMARY.md` (contract tests)
- S01 branch diff: `git diff 6c8dd41..05ff6c6` (4 files, 525 insertions — types, files, and tests)
- Template: `gsd/templates/secrets-manifest.md` (manifest format reference)
- Test coverage: `secure-env-collect.test.ts` (12 tests for checkExistingEnvKeys/detectDestination), `manifest-status.test.ts` (7 tests on S01 branch), `parsers.test.ts` (377 tests on S01 branch)
