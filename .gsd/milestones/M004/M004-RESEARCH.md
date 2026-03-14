# M004: Post-M003 Upstream Drift Reconciliation and CI Restoration — Research

**Date:** 2026-03-14

## Summary

The local `main` branch successfully merged upstream `origin/main` at commit `ac79547b` during M003, but the build was failing on the `@gsd/pi-agent-core` package with a TypeScript error: `Type 'Model<Api> | undefined' is not assignable to type 'Model<any>'` in `packages/pi-agent-core/src/agent.ts` line 105. This error surfaced because upstream reverted to using `models.generated.ts` for populating the model registry, while our M001 models.dev architecture deliberately removed that file in favor of runtime fetching from models.dev API.

The root cause is that `packages/pi-ai/src/models.ts` had an empty model registry that was never populated, since our architecture moves model loading to `pi-coding-agent`'s `ModelRegistry` class at runtime. Upstream's type signature change assumed the registry would be populated at module load time from `models.generated.ts`, which conflicts with our models.dev approach.

The fix reconciles this by: (1) populating the `pi-ai` model registry from the models.dev snapshot (`models-dev-snapshot.ts`) at module load time, preserving the runtime models.dev architecture; and (2) adding a non-null assertion in `agent.ts` for the default model since we know it exists in the snapshot. This maintains M001's models.dev design while satisfying the stricter upstream type requirements.

## Recommendation

**Apply the following changes to reconcile upstream drift:**

1. **Modify `packages/pi-ai/src/models.ts`**: Import from `models-dev-snapshot.ts` and `models-dev-mapper.ts` to populate the registry at module load time, keeping the return type as `Model<Api> | undefined` to preserve models.dev semantics.

2. **Modify `packages/pi-agent-core/src/agent.ts`**: Add a non-null assertion (`!`) to the default model assignment on line 105, since the model is guaranteed to exist in the snapshot.

3. **Preserve models.dev architecture**: Do NOT revert to `models.generated.ts` or change the runtime model loading behavior. The snapshot provides type-safe initialization while maintaining the ability to refresh from models.dev API at runtime.

**Why this approach:**
- Maintains M001's models.dev architecture (D001, D004, D006)
- Satisfies upstream TypeScript type requirements without regressing milestone behavior
- Uses existing models.dev infrastructure (snapshot + mapper) that's already in the codebase
- Minimal surface area change — only two files modified, no new dependencies

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Model registry initialization | `models-dev-snapshot.ts` + `models-dev-mapper.ts` | Already exists, tested, and provides offline-first fallback with 102 providers and 2311KB of model data |
| Default model type safety | Non-null assertion on known model | The model "gemini-2.5-flash-lite-preview-06-17" exists in snapshot; if missing at runtime, that's a real error that should surface |
| Runtime model refresh | `ModelRegistry` in `pi-coding-agent` | M001 architecture already handles cache → snapshot → live fetch chain; no need to duplicate in `pi-ai` |

## Existing Code and Patterns

- `packages/pi-ai/src/models-dev-snapshot.ts` — Bundled snapshot from models.dev API (2311KB, 102 providers), auto-generated via `npm run generate-snapshot`, provides offline-first fallback
- `packages/pi-ai/src/models-dev-mapper.ts` — Transforms models.dev API format to internal `Model<Api>` format, already used by `ModelRegistry` at runtime
- `packages/pi-coding-agent/src/core/model-registry.ts` — `ModelRegistry` class that manages models at runtime with cache, snapshot fallback, and user overrides
- `packages/pi-agent-core/src/agent.ts` — Agent class with default model assignment; line 105 needs non-null assertion
- `packages/pi-ai/src/models.ts` — Core model lookup functions; needs to initialize registry from snapshot

## Constraints

- **M001 architecture must be preserved**: The models.dev runtime fetching, caching, and override system cannot be replaced with static `models.generated.ts`
- **TypeScript strict mode**: The build must pass with `strict: true` in tsconfig, so type mismatches cannot be ignored
- **Snapshot must be current**: The bundled snapshot should be regenerated if models.dev data is stale (12h cache policy per D002)
- **No circular dependencies**: `pi-ai` cannot depend on `pi-coding-agent`; snapshot import must stay within `pi-ai` package boundaries

## Common Pitfalls

- **Reverting to models.generated.ts**: This would break M001's models.dev architecture and require code changes across multiple packages. Use the existing snapshot instead.
- **Changing return type to non-nullable**: The `getModel` function should still return `Model<Api> | undefined` because models.dev models can be unknown at runtime. Only use non-null assertions where the model is known to exist.
- **Importing from pi-coding-agent**: This would create a circular dependency. Keep the snapshot import within `pi-ai` package.
- **Ignoring the type error**: The strict TypeScript check is correct — the registry must be populated before use. The fix is to initialize it, not to suppress the error.

## Open Risks

- **Additional workflow failures**: The visible TypeScript error may be just the first blocker. Other upstream changes (hooks system, cache clearing, CI fixes) may reveal additional incompatibilities during full verification.
- **Snapshot staleness**: The bundled snapshot was last generated on 2026-03-14. If models.dev data has changed significantly, the snapshot may need regeneration before PR branch update.
- **Test pollution from global preferences**: One unrelated test failure (`auto-supervisor.test.mjs`) is caused by global preferences (`~/.gsd/preferences.md`) overriding defaults. This is a pre-existing test isolation issue, not caused by this milestone's changes.

## Skills Discovered

No additional skills needed — this is a codebase reconciliation task using existing models.dev infrastructure.

## Sources

- `packages/pi-ai/src/models.ts` — Current implementation with empty registry
- `packages/pi-agent-core/src/agent.ts` — Failing build surface with default model assignment
- `packages/pi-ai/src/models-dev-snapshot.ts` — Bundled models.dev data for offline-first fallback
- `packages/pi-coding-agent/src/core/model-registry.ts` — Runtime model loading with cache chain
- `.gsd/milestones/M001/` — Original models.dev architecture decisions and implementation
- `.gsd/DECISIONS.md` — D001 (models.dev as data source), D004 (commit snapshot), D006 (Zod schema exports), D017 (test imports)
