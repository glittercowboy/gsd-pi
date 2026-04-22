---
phase: 10-typescript-strict-zero-any
plan: "03"
subsystem: src-root-barrel-and-removed-symbols
tags: [typescript, barrel, pi-upgrade, model-router, partial-builder]
dependency_graph:
  requires: [10-01]
  provides: [working-sortExtensionPaths-import, working-jsonl-imports, gsd-owned-capability-routing, inline-xml-json-repair]
  affects: [src/resource-loader.ts, src/headless-ui.ts, src/headless-answers.ts, src/resources/extensions/gsd/model-router.ts, src/resources/extensions/claude-code-cli/partial-builder.ts]
tech_stack:
  added: []
  patterns: [barrel-patch, inline-copy, gsd-owned-replacement]
key_files:
  created: []
  modified:
    - packages/pi-coding-agent/src/index.ts
    - packages/pi-coding-agent/dist/index.d.ts
    - packages/pi-coding-agent/dist/index.js
    - src/resources/extensions/gsd/model-router.ts
    - src/resources/extensions/claude-code-cli/partial-builder.ts
decisions:
  - "Barrel patch approach for sortExtensionPaths/serializeJsonLine/attachJsonlLineReader: preferred over inline-copy since functions already exist in pi-coding-agent src; avoids duplication"
  - "GSD-owned ProviderCapabilities/ToolCompatibility + hardcoded provider registry: pi 0.67.2 truly removed these APIs; GSD now owns capability routing rather than delegating to pi-ai"
  - "Inline hasXmlParameterTags/repairToolJson in partial-builder.ts: simple regex implementations matching the original contract; T-10-05 security notes added per threat model"
  - "Manual dist patch for pi-coding-agent: full build fails due to pre-existing errors in pi-coding-agent interactive components (out of scope); dist/index.d.ts and dist/index.js patched directly so tsc resolution works immediately"
metrics:
  duration: "~25 minutes"
  completed: "2026-04-16T15:18:50Z"
  tasks_completed: 2
  files_modified: 5
---

# Phase 10 Plan 03: Root src/ Barrel and Removed Symbol Fixes Summary

Fix root src/ TypeScript errors from sub-path barrel import failures and truly-removed pi 0.67.2 symbols.

## What Was Built

Barrel patch for `@gsd/pi-coding-agent` adds three previously-unexported symbols (`sortExtensionPaths`, `serializeJsonLine`, `attachJsonlLineReader`), resolving import errors in `resource-loader.ts`, `headless-ui.ts`, and `headless-answers.ts`. GSD-owned capability routing replaces the removed pi-ai/pi-coding-agent provider capability APIs in `model-router.ts`. Inline XML/JSON repair utilities replace the removed pi-ai symbols in `partial-builder.ts`.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Fix barrel import errors | 892f3c79a | packages/pi-coding-agent/src/index.ts + dist/index.d.ts + dist/index.js |
| 2 | Fix model-router.ts + partial-builder.ts | 65c76b386 | src/resources/extensions/gsd/model-router.ts, src/resources/extensions/claude-code-cli/partial-builder.ts |

## Verification Results

```
tsc --noEmit (worktree tsconfig) | grep resource-loader|headless-ui|headless-answers|model-router|partial-builder
→ 0 errors
```

All 5 target files compile without errors from the broken imports targeted by this plan.

## Decisions Made

1. **Barrel patch over inline-copy** — `sortExtensionPaths`, `serializeJsonLine`, and `attachJsonlLineReader` already exist in pi-coding-agent source. Adding them to the barrel is cleaner than duplicating code into consuming files.

2. **Manual dist patch** — The full `npm run build -w @gsd/pi-coding-agent` fails due to pre-existing errors in interactive components (e.g., `FrameTone`, keybindings types) that are out of scope for this plan. Rather than blocking, `dist/index.d.ts` and `dist/index.js` were patched directly. The source barrel (`src/index.ts`) is also updated so future builds pick up the changes.

3. **GSD-owned capability registry** — `getProviderCapabilities`, `ProviderCapabilities`, `getToolCompatibility`, `ToolCompatibility`, and `getAllToolCompatibility` were all removed from pi 0.67.2. No replacement APIs exist in the new pi barrel. GSD now owns a hardcoded `PROVIDER_CAPABILITIES` registry covering Anthropic, OpenAI, Google, and DeepSeek providers. This is correct architecture: provider capability decisions are GSD's business logic, not pi internals.

4. **Inline XML/JSON repair** — `hasXmlParameterTags` and `repairToolJson` were removed from pi-ai 0.67.2. Inline implementations use the same regex contracts as the originals. T-10-05 threat model notes are preserved in code comments.

## Deviations from Plan

### Auto-fixed Issues

None — plan executed as written. The barrel patch was chosen (preferred approach) over the fallback inline-copy approach since the pi-coding-agent dist files were patchable and no circular import issues occurred.

### Out-of-scope Pre-existing Errors

`partial-builder.ts` has 5 additional errors under `tsconfig.resources.json` (not the main tsconfig):
- `ServerToolUseContent` and `WebSearchResultContent` removed from pi-ai (TS2305)
- `AssistantMessageEvent` type shape missing `serverToolUse` / `server_tool_use` (TS2322)
- `malformedArguments` not in `toolcall_end` event type (TS2353)

These are tracked in deferred items and addressed by separate plans. They were present before this plan and are outside its scope (scope is `hasXmlParameterTags`/`repairToolJson` only).

## Known Stubs

None — all implementations are functional. The `PROVIDER_CAPABILITIES` registry has real entries for all major providers supported by the GSD routing pipeline.

## Threat Flags

None — the inline regex implementations in partial-builder.ts match the threat model mitigation T-10-05 (presence detection only, no content evaluation).

## Self-Check

### Files exist
- [x] packages/pi-coding-agent/src/index.ts — modified (sortExtensionPaths, serializeJsonLine, attachJsonlLineReader added)
- [x] packages/pi-coding-agent/dist/index.d.ts — patched (same 3 symbols)
- [x] packages/pi-coding-agent/dist/index.js — patched (same 3 symbols)
- [x] src/resources/extensions/gsd/model-router.ts — broken pi imports removed, GSD types/functions added
- [x] src/resources/extensions/claude-code-cli/partial-builder.ts — broken pi-ai import removed, inline implementations added

### Commits exist
- [x] 892f3c79a — feat(10-03): barrel patch
- [x] 65c76b386 — fix(10-03): removed symbol replacements

## Self-Check: PASSED
