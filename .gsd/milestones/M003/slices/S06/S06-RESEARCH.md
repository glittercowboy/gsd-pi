# S06 — Extended settings and model management surface — Research

**Date:** 2026-03-16
**Depth:** Light-to-targeted — established patterns from S04/S05, straightforward data plumbing

## Summary

S06 extends the existing settings command surface with three new sections: **model routing** (dynamic routing config, tier model assignments, routing history), **provider/budget** (budget ceiling, enforcement mode, context budget allocations, token profile), and **preferences overview** (read-only view of effective merged preferences from global + project). The `/gsd prefs` and `/gsd mode` surfaces, currently rendering stubs, need real panel content.

The upstream code provides everything needed: `loadEffectiveGSDPreferences()` (preferences.ts), `resolveDynamicRoutingConfig()` (preferences.ts), `computeBudgets()` (context-budget.ts), `getRoutingHistory()` (routing-history.ts), `MODEL_CAPABILITY_TIER` / `MODEL_COST_PER_1K_INPUT` / `resolveModelForComplexity()` (model-router.ts). The browser cannot import these modules directly (Turbopack can't resolve `.js` extension imports — per KNOWLEDGE.md). A child-process service is needed, matching the established pattern from S04 (forensics-service.ts, doctor-service.ts, skill-health-service.ts).

The UI component follows the S04 diagnostics-panels.tsx extraction pattern: a new `settings-panels.tsx` file with `PrefsPanel`, `ModelRoutingPanel`, and `BudgetPanel` components, wired into `command-surface.tsx`'s `renderSection()` for the `gsd-prefs`, `gsd-mode`, and `gsd-config` surface sections. Store state uses the existing `CommandSurfaceDiagnosticsPhaseState<T>` generic for loading lifecycle.

## Recommendation

Follow the S04/S05 pattern exactly: API route → child-process service → browser-safe types → store state → panel component. One API route (`/api/settings-data`) returns a combined payload with preferences + routing config + budget + routing history. This avoids three separate API calls for data that always comes from the same place (the project's `.gsd/` directory). The `gsd-prefs`, `gsd-mode`, and `gsd-config` sections all render from the same data — just showing different facets.

## Implementation Landscape

### Key Files

- `src/resources/extensions/gsd/preferences.ts` — `loadEffectiveGSDPreferences()`, `resolveDynamicRoutingConfig()`, `GSDPreferences` interface, `ResolvedModelConfig`, `WorkflowMode`, `GSDModelConfigV2`, `GSDPhaseModelConfig`. 52K file, heavily used. The exported functions read preferences.md files, merge global+project, apply mode defaults.
- `src/resources/extensions/gsd/model-router.ts` — `DynamicRoutingConfig`, `RoutingDecision`, `resolveModelForComplexity()`, `defaultRoutingConfig()`, `MODEL_CAPABILITY_TIER`, `MODEL_COST_PER_1K_INPUT`. Pure logic, no I/O except imports.
- `src/resources/extensions/gsd/context-budget.ts` — `BudgetAllocation`, `computeBudgets()`, `resolveExecutorContextWindow()`. Pure functions, no I/O.
- `src/resources/extensions/gsd/routing-history.ts` — `getRoutingHistory()`, `RoutingHistoryData`, `PatternHistory`, `TierOutcome`, `FeedbackEntry`. Reads/writes `.gsd/routing-history.json`. Must be initialized with `initRoutingHistory(base)` before `getRoutingHistory()` returns data.
- `src/resources/extensions/gsd/complexity-classifier.ts` — `ComplexityTier`, `ClassificationResult`. Type-only dependency for model-router.
- `src/resources/extensions/gsd/metrics.ts` — `getLedger()`, `getProjectTotals()`, `UnitMetrics`, `ProjectTotals`. Provides cost/token aggregates for budget display.
- `web/lib/command-surface-contract.ts` — Add `CommandSurfaceSettingsDataState` using existing `CommandSurfaceDiagnosticsPhaseState<T>` generic. Wire into `WorkspaceCommandSurfaceState`.
- `web/lib/gsd-workspace-store.tsx` (4867 lines) — Add `loadSettingsData()` action following the forensics/doctor/knowledge pattern: `fetch("/api/settings-data")` → patch state.
- `web/components/gsd/command-surface.tsx` (2144 lines) — Replace `gsd-prefs`/`gsd-mode`/`gsd-config` stubs in `renderSection()` with panel component imports. Wire auto-load in the section-open `useEffect`.
- `web/components/gsd/diagnostics-panels.tsx` (525 lines) — Reference for component patterns: `DiagHeader`, `DiagLoading`, `DiagError`, `DiagEmpty`, `StatPill` helpers. Reuse or import shared helpers.

### New Files to Create

- `web/lib/settings-types.ts` — Browser-safe interfaces: `SettingsData { preferences, routingConfig, budgetAllocation, routingHistory, metrics }`. Mirrors upstream types but safe for Turbopack.
- `src/web/settings-service.ts` — Child-process service (like forensics-service.ts). Calls preferences.ts / context-budget.ts / routing-history.ts / metrics.ts via execFile + resolve-ts.mjs.
- `web/app/api/settings-data/route.ts` — GET route returning SettingsData payload.
- `web/components/gsd/settings-panels.tsx` — Three panel components: `PrefsPanel` (preferences overview), `ModelRoutingPanel` (routing config + tier models + history), `BudgetPanel` (ceiling, enforcement, allocations, cost totals).

### Build Order

1. **Types first** (`web/lib/settings-types.ts`) — Define browser-safe interfaces. Unblocks everything downstream.
2. **Service + API route** (`src/web/settings-service.ts` + `web/app/api/settings-data/route.ts`) — Child-process data provider. Verify with `curl localhost:3000/api/settings-data`.
3. **Store state + action** (`web/lib/command-surface-contract.ts` + `web/lib/gsd-workspace-store.tsx`) — Add `settingsData` state field and `loadSettingsData()` action.
4. **Panel components + wiring** (`web/components/gsd/settings-panels.tsx` + `web/components/gsd/command-surface.tsx`) — Build UI, wire into renderSection, add auto-load on section open.
5. **Verify** — `npm run build`, `npm run build:web-host`, existing parity test still passes.

### Verification Approach

- `npm run build` — TypeScript compiles with new types and imports
- `npm run build:web-host` — Next.js production build succeeds with new API route and components
- `npx tsx --test src/tests/web-command-parity-contract.test.ts` — 118 tests still pass (no dispatch regression)
- Runtime: `/gsd prefs` opens settings surface with preferences data loaded (not placeholder)
- Runtime: `/gsd mode` opens with workflow mode section focused
- API route: `GET /api/settings-data` returns JSON with preferences, routingConfig, budgetAllocation fields

## Constraints

- **Turbopack .js→.ts resolution** — Cannot directly import preferences.ts, model-router.ts, context-budget.ts, routing-history.ts from web code. Must use child-process pattern (execFile + resolve-ts.mjs). Per KNOWLEDGE.md entry.
- **preferences.ts uses `process.cwd()`** — `loadProjectGSDPreferences()` reads from `process.cwd()/.gsd/preferences.md`. The child process inherits cwd from the API route, which gets it from `resolveBridgeRuntimeConfig().projectCwd`. Must pass projectCwd as env var to child.
- **routing-history.ts requires initialization** — `getRoutingHistory()` returns null unless `initRoutingHistory(base)` was called. The child script must init before reading.
- **metrics.ts in-memory state** — `getLedger()` returns null unless `initMetrics(base)` was called. The child script must init, or use `loadLedgerFromDisk(base)` directly (which reads from `.gsd/metrics.json` without init).

## Common Pitfalls

- **preferences.ts is 52K** — Don't import the entire module graph in the child process unnecessarily. The child script should import only the specific functions needed and serialize the result to stdout.
- **`initRoutingHistory` / `initMetrics` side effects** — These init functions set module-level state. In the child process this is fine (fresh process per request), but the child script must call init before reading data.
- **homedir() in child process** — `loadGlobalGSDPreferences()` reads from `~/.gsd/preferences.md` using `homedir()`. This works in child processes since HOME is inherited. No action needed, but worth noting.
- **gsd-config surface** — Per upstream TUI, `/gsd config` handles tool API key management (Tavily, Brave, Context7, Jina, Groq). This is interactive in the TUI (prompts for keys). For the browser, a read-only status display (which tools have keys configured) is the appropriate equivalent. Actual key entry uses `secure_env_collect` or the existing auth flow.

## Open Risks

- **metrics.json may not exist** — If the project hasn't run any units, `loadLedgerFromDisk()` returns null. The API must handle this gracefully (return empty/zero budget metrics).
- **routing-history.json may not exist** — Same case. `getRoutingHistory()` returns null if no routing has occurred. UI must handle empty state.
