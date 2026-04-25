# Extension Loading: Dependency Sort + Unified Enable/Disable

## Context

GSD-2 has a well-structured extension system with three discovery paths (bundled, global/community, project-local) that are **already wired up** through pi's `DefaultPackageManager.addAutoDiscoveredResources()`. However, two critical gaps remain:

1. `sortExtensionPaths()` (topological dependency sort) is implemented but **never called** — `dependencies.extensions` in manifests is decorative
2. The GSD extension registry (enable/disable) only applies to **bundled** extensions — community extensions bypass it entirely

### Architecture (Current Flow)

```
GSD loader.ts
  → discoverExtensionEntryPaths(bundledExtDir)
  → filter by GSD registry (isExtensionEnabled)
  → set GSD_BUNDLED_EXTENSION_PATHS env var
      ↓
DefaultResourceLoader.reload()
  → packageManager.resolve()
    → addAutoDiscoveredResources()
      → project: cwd/.gsd/extensions/     (CONFIG_DIR_NAME = ".gsd")
      → global:  ~/.gsd/agent/extensions/  (includes synced bundled)
  → loadExtensions(mergedPaths)            ← NO sort, NO registry check on community
```

### Key Files

| File | Role |
|------|------|
| `src/loader.ts` (lines 146-161) | GSD startup — bundled discovery + registry filter |
| `src/extension-sort.ts` | Topological sort (Kahn's BFS) — EXISTS but NEVER CALLED |
| `src/extension-registry.ts` | Registry I/O, enable/disable, tier checks |
| `src/resource-loader.ts` (lines 589-607) | `buildResourceLoader()` — constructs DefaultResourceLoader |
| `packages/pi-coding-agent/src/core/resource-loader.ts` (lines 311-395) | `reload()` — merges paths, calls `loadExtensions()` |
| `packages/pi-coding-agent/src/core/package-manager.ts` (lines 1585-1700) | `addAutoDiscoveredResources()` — auto-discovers from .gsd/ dirs |
| `packages/pi-coding-agent/src/core/extensions/loader.ts` (lines 945-1002) | `discoverAndLoadExtensions()` — DEAD CODE, never invoked |

---

## Plan

### Task 1: Wire topological sort into extension loading

**What:** Call `sortExtensionPaths()` on the merged extension paths before passing them to `loadExtensions()`.

**Where:** `packages/pi-coding-agent/src/core/resource-loader.ts` ~line 381-385

**Before:**
```typescript
const extensionsResult = await loadExtensions(extensionPaths, this.cwd, this.eventBus);
```

**After:**
```typescript
import { sortExtensionPaths } from '../../../src/extension-sort.js';

const { sortedPaths, warnings } = sortExtensionPaths(extensionPaths);
for (const w of warnings) {
  // emit as diagnostic, not hard error
}
const extensionsResult = await loadExtensions(sortedPaths, this.cwd, this.eventBus);
```

**Consideration:** `sortExtensionPaths` lives in `src/` (GSD side), not in `packages/pi-coding-agent/`. Need to either:
- (a) Move it into pi-coding-agent as a shared utility, OR
- (b) Import it cross-package (already done for other GSD→pi imports), OR
- (c) Call it on the GSD side before paths reach pi — harder since auto-discovered paths are added inside pi's package manager

Option (a) is cleanest — the sort logic only depends on `readManifestFromEntryPath` which is also in `src/extension-registry.ts` but could be duplicated or shared.

### Task 2: Apply GSD registry to community extensions

**What:** When `buildResourceLoader()` in `src/resource-loader.ts` constructs the DefaultResourceLoader, also discover and filter community extensions from `~/.gsd/agent/extensions/` through the GSD registry — same as it already does for `~/.pi/agent/extensions/` paths.

**Where:** `src/resource-loader.ts` → `buildResourceLoader()` (lines 589-607)

**Current code already filters pi extensions:**
```typescript
const piExtensionPaths = discoverExtensionEntryPaths(piExtensionsDir)
  .filter((entryPath) => !bundledKeys.has(getExtensionKey(entryPath, piExtensionsDir)))
  .filter((entryPath) => {
    const manifest = readManifestFromEntryPath(entryPath)
    if (!manifest) return true
    return isExtensionEnabled(registry, manifest.id)
  })
```

**Add similar filtering for community extensions in agentDir:**
- Discover extensions in `~/.gsd/agent/extensions/` that are NOT bundled
- Filter through `isExtensionEnabled(registry, manifest.id)`
- Pass as disabled (via override patterns or pre-filtering) to the resource loader

**Alternative approach:** Hook into `addAutoDiscoveredResources` or the `addResource` call to check the GSD registry. This might be cleaner since the auto-discovery already happens inside pi's package manager.

### Task 3: Emit sort warnings as diagnostics

**What:** Surface dependency warnings (missing deps, cycles) through GSD's diagnostic system so users see them.

**Where:** Wherever the sort is invoked from Task 1.

**Format:**
```
⚠ Extension 'gsd-watch' declares dependency 'gsd' which is not installed — loading anyway
⚠ Extensions 'foo' and 'bar' form a dependency cycle — loading in alphabetical order
```

### Task 4: Clean up dead code

**What:** The `discoverAndLoadExtensions()` function in `packages/pi-coding-agent/src/core/extensions/loader.ts` (lines 945-1002) is exported but never invoked. The project-local trust model inside it (`getUntrustedExtensionPaths`) also never runs.

**Options:**
- (a) Remove it entirely — it's dead
- (b) Mark deprecated — in case upstream pi uses it
- (c) Leave it — lowest risk

Recommend (b) for now — add `@deprecated` JSDoc so it doesn't grow new callers.

### Task 5: Tests

- **Sort integration test:** Create two extensions where A depends on B. Verify B loads before A after sort.
- **Registry community test:** Drop a community extension in `~/.gsd/agent/extensions/`, run `gsd extensions disable <id>`, verify it doesn't load.
- **Conflict test:** Same extension ID in project-local and global — verify project-local wins.
- **Missing dep test:** Extension declares dependency on non-existent extension — verify warning emitted, extension still loads.
- **Cycle test:** Two extensions that depend on each other — verify warning, both load.

---

## Follow-up PR (separate)

**Subagent extension forwarding:** Update `src/resources/extensions/subagent/index.ts` to forward ALL extension paths (not just bundled) to child processes. May need a second env var like `GSD_COMMUNITY_EXTENSION_PATHS` or consolidate into `GSD_EXTENSION_PATHS`.

---

## Open Questions

1. **Where should `sortExtensionPaths` live?** Currently in `src/` (GSD side). Needs to be callable from pi's resource-loader. Options: move to pi, keep and import cross-package, or duplicate.
2. **Should community extensions respect the same registry as bundled?** Or should they have their own enable/disable mechanism? Current plan unifies them.
3. **Project-local trust:** The TOFU model in the dead `discoverAndLoadExtensions()` never runs. Should `addAutoDiscoveredResources` also gate project-local extensions behind trust? Or is `.gsd/extensions/` in your own project always trusted?
