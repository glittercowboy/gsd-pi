# GSD Startup Performance Analysis & Optimization Plan

## Measured Baseline (macOS, Node v25.6.1)

### `gsd --version` (simplest possible path): **2.2 seconds**

| Phase | Time | Notes |
|-------|------|-------|
| Node.js process startup | ~160ms | Unavoidable |
| loader.js top-level imports | ~13ms | fs, app-paths, logo |
| undici import + proxy setup | ~200ms | EnvHttpProxyAgent |
| **@gsd/pi-coding-agent barrel import** | **~970ms** | THE BOTTLENECK |
| cli.js other imports | ~3ms | resource-loader, wizard, etc. |
| Arg parsing + version print | ~0ms | |
| Measured wall time overhead | ~700ms | ESM resolution, gc, etc. |

### Full interactive startup: **~3.6 seconds** (post-node)

| Phase | Time | Notes |
|-------|------|-------|
| @gsd/pi-coding-agent import | ~750ms | (cached from loader measurement) |
| ensureManagedTools | ~0ms | No-op after first run |
| AuthStorage + env keys | ~3ms | |
| ModelRegistry | ~1ms | |
| SettingsManager | ~1ms | |
| **initResources (cpSync)** | **~128ms** | Copies all extensions/skills/agents on every launch |
| **resourceLoader.reload()** | **~2535ms** | jiti-compiles 17+ extensions from TypeScript |

### Inside @gsd/pi-coding-agent (barrel import breakdown)

| Sub-module | Time | Notes |
|------------|------|-------|
| Mistral SDK (@mistralai/mistralai) | 369ms | Loaded even if unused |
| Google GenAI SDK (@google/genai) | 186ms | Loaded even if unused |
| extensions/index.js (circular → index.js) | 497ms | Pulls in everything |
| tools/index.js | 124ms | Tool definitions |
| @sinclair/typebox | 64ms | Schema validation |
| OpenAI SDK | 52ms | |
| Anthropic SDK | 50ms | |

---

## Root Causes (Priority Order)

### 1. Extension JIT compilation via jiti (~2.5s)
Every launch compiles 17+ TypeScript extensions to JavaScript using jiti. No caching (`moduleCache: false` is explicitly set). This is the single largest cost.

### 2. Barrel import of @gsd/pi-coding-agent (~1s)
`cli.js` line 1 does a barrel import pulling in ALL exports including all LLM provider SDKs, TUI components, theme system, compaction, blob store, etc.

### 3. Eager LLM SDK loading (~660ms inside barrel)
All provider SDKs are imported at module evaluation time in `pi-ai/index.js`, even though only one provider is typically configured.

### 4. initResources copies files every launch (~128ms)
`cpSync` with `force: true` copies all bundled resources to `~/.gsd/agent/` on every startup, even when nothing changed.

### 5. undici import (~200ms)
Imported in loader.js for proxy support. Not needed for most users.

---

## Optimization Plan

### Phase 1: Quick Wins (est. save ~1-1.5s on --version, ~0.5s interactive)

#### 1A. Fast-path for `--version` and `--help`
Parse argv BEFORE importing cli.js. In loader.js, check for `--version`/`-v` and `--help`/`-h` and exit immediately without loading any dependencies.

**File**: `src/loader.ts`
**Change**: Add arg check before `await import('./cli.js')`
**Impact**: `gsd --version` goes from 2.2s → ~0.2s

#### 1B. Skip initResources when unchanged
Compare `managed-resources.json` version against current `GSD_VERSION`. If they match, skip the `cpSync` entirely.

**File**: `src/resource-loader.ts` → `initResources()`
**Change**: Early return if versions match
**Impact**: Save ~128ms per launch

#### 1C. Lazy-load undici
Only import undici when HTTP_PROXY/HTTPS_PROXY env vars are actually set.

**File**: `src/loader.ts`
**Change**: Wrap undici import in proxy env check
**Impact**: Save ~200ms for most users

### Phase 2: Lazy Provider Loading (est. save ~600ms interactive)

#### 2A. Lazy-load LLM provider SDKs
Instead of importing all providers at module level in `pi-ai/index.js`, use dynamic `import()` in the provider factory functions. Only load the SDK when a model from that provider is actually requested.

**Files**: `packages/pi-ai/src/providers/*.ts`
**Change**: Move `import { Anthropic } from '@anthropic-ai/sdk'` etc. to dynamic imports inside `complete()` / `stream()` functions
**Impact**: Save ~600ms (Mistral 369ms + Google 186ms + extras) for users who only use one provider

#### 2B. Selective re-exports in pi-ai barrel
Instead of `export * from "./providers/mistral.js"` etc., only export the registration function. Provider internals stay private.

**File**: `packages/pi-ai/src/index.ts`

### Phase 3: Extension Loading Optimization (est. save ~1.5-2s interactive)

#### 3A. Enable jiti module caching
Remove `moduleCache: false` from the jiti config, or use a persistent cache directory.

**File**: `packages/pi-coding-agent/src/core/extensions/loader.ts`
**Change**: Set `moduleCache: true` or configure `cacheDir`
**Impact**: Second+ launches save ~1-2s on extension loading

#### 3B. Pre-compile extensions at build time
Instead of JIT-compiling TypeScript extensions at runtime, compile them to JavaScript during `npm run build`. The runtime loader can then just `import()` the .js files directly without jiti.

**Files**: `package.json` build scripts, `src/resource-loader.ts`, extension loader
**Change**: Add build step to compile extensions; loader checks for .js first
**Impact**: Eliminate ~2.5s of jiti compilation entirely
**Complexity**: HIGH — requires careful handling of extension resolution paths

#### 3C. Parallel extension loading
Currently extensions load sequentially in a `for` loop. Load them in parallel with `Promise.all()`.

**File**: `packages/pi-coding-agent/src/core/extensions/loader.ts` → `loadExtensions()`
**Change**: `await Promise.all(paths.map(...))` instead of sequential for-loop
**Impact**: Wall time reduction depends on I/O overlap; est. 30-50% faster

### Phase 4: Bundle Optimization (est. save ~300-500ms)

#### 4A. Use esbuild/tsup for the main CLI bundle
Replace plain `tsc` with a bundler that does tree-shaking. A single-file bundle eliminates ESM resolution overhead and removes unused code.

**Impact**: Faster module resolution, smaller output, tree-shaking removes unused exports
**Complexity**: MEDIUM

#### 4B. Split pi-coding-agent into entry-point chunks
Instead of one barrel export, provide separate entry points for core, interactive, tools.

**Impact**: cli.js can import only what it needs for each code path
**Complexity**: HIGH — changes public API surface

---

## Recommended Implementation Order

1. **Phase 1A** — Fast-path --version/--help (trivial, huge UX impact)
2. **Phase 1C** — Lazy undici (easy, 200ms saved)
3. **Phase 1B** — Skip initResources (easy, 128ms saved)
4. **Phase 3C** — Parallel extension loading (moderate, ~1s saved)
5. **Phase 2A** — Lazy provider SDKs (moderate, ~600ms saved)
6. **Phase 3A** — jiti caching (easy, ~1s saved on repeat launches)
7. **Phase 3B** — Pre-compile extensions (hard, eliminates jiti entirely)
8. **Phase 4A** — Bundle with esbuild (medium, ~300-500ms)

### Expected Results

| Scenario | Before | After (Phase 1-3) | After (All) |
|----------|--------|-------------------|-------------|
| `gsd --version` | 2.2s | **~0.2s** | ~0.2s |
| Interactive startup | ~3.8s | **~1.5s** | **~0.8s** |
