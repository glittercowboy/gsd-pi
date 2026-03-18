# Token Optimization Suite — Implementation Plan

## Overview
Comprehensive token optimization across the GSD dispatch pipeline. Six phases targeting
prompt caching, accurate token counting, structured data compression, prompt compression,
semantic context selection, and context distillation.

## Phase 1: Prompt Cache Optimization (P0)
**Goal:** Restructure dispatch prompt assembly for maximum cache hit rates.

### What
Anthropic prompt caching gives 90% savings on cached input tokens. Currently, GSD places
`cache_control` on system prompts and the last user message (in `packages/pi-ai/src/providers/anthropic.ts`).
But dispatch prompts in `auto-prompts.ts` mix static and dynamic content throughout,
reducing cache prefix reuse.

### Tasks
1. **Create `prompt-cache-optimizer.ts`** — module that separates prompt content into
   cacheable (static) and dynamic (per-task) sections.
   - Static: templates, plans, decisions, roadmap, project context
   - Dynamic: task-specific instructions, file contents, overrides
   - Export `splitForCaching(prompt: string, staticSections: string[]): { staticPrefix: string; dynamicSuffix: string }`

2. **Add `buildCacheablePrefix()` to auto-prompts.ts** — for each builder, extract the
   static portion that's reused across tasks in the same slice:
   - Slice plan (same across all tasks in slice)
   - Decisions register (same across all tasks)
   - Requirements (same within scope)
   - Templates (always the same)

3. **Metrics tracking** — extend `metrics.ts` to track `cacheHitRate` per unit.
   Already tracks `cacheRead` and `cacheWrite` tokens — add derived percentage.

### Files Modified
- `src/resources/extensions/gsd/prompt-cache-optimizer.ts` (NEW)
- `src/resources/extensions/gsd/auto-prompts.ts` (modify builders)
- `src/resources/extensions/gsd/metrics.ts` (add cache hit rate)
- `src/resources/extensions/gsd/tests/prompt-cache-optimizer.test.ts` (NEW)

---

## Phase 2: Accurate Multi-Provider Token Counting (P1)
**Goal:** Replace GPT-4o-only tiktoken with provider-aware counting.

### What
`token-counter.ts` uses `tiktoken` with `gpt-4o` encoder for ALL providers. Claude uses a
different tokenizer, so counts can be off by 15-25%. This causes budget under/over-allocation.

### Tasks
1. **Add provider-aware counting** — extend `countTokens()` to accept an optional
   `provider` parameter:
   - `anthropic`: Use `@anthropic-ai/sdk` `messages.countTokens()` for exact counts
   - `openai`: Keep tiktoken (already accurate)
   - `google`/`mistral`/others: Keep chars/4 heuristic (best available)

2. **Add `estimateTokensForProvider(text, provider)` function** — synchronous estimation
   that uses provider-specific char ratios:
   - Anthropic: ~3.5 chars/token (their tokenizer is slightly more efficient)
   - OpenAI: ~4 chars/token (tiktoken accurate)
   - Others: ~4 chars/token (conservative default)

3. **Update `context-budget.ts`** — use provider-aware `CHARS_PER_TOKEN` constant based
   on the configured execution model's provider.

### Files Modified
- `src/resources/extensions/gsd/token-counter.ts` (extend)
- `src/resources/extensions/gsd/context-budget.ts` (provider-aware ratio)
- `src/resources/extensions/gsd/tests/token-counter.test.ts` (NEW)
- `src/resources/extensions/gsd/tests/context-budget.test.ts` (extend)

---

## Phase 3: Structured Data Compression with TOON (P1)
**Goal:** Reduce token usage for structured data blocks in prompts by 30-60%.

### What
Decisions registers, requirements lists, task plans, and metrics are passed as verbose
markdown tables. TOON (Token-Oriented Object Notation) removes braces/brackets/quotes,
using indentation and tabular patterns instead.

### Tasks
1. **Add `@toon-format/toon` dependency** — install the npm package.

2. **Create `structured-data-formatter.ts`** — module that converts structured data to
   TOON format for prompt injection:
   - `formatDecisionsTOON(decisions: Decision[]): string`
   - `formatRequirementsTOON(requirements: Requirement[]): string`
   - `formatTaskPlanTOON(tasks: TaskPlanEntry[]): string`
   - Each includes a brief format header so the LLM knows how to parse it

3. **Integrate with `context-store.ts`** — add TOON variants of `formatDecisionsForPrompt()`
   and `formatRequirementsForPrompt()`.

4. **Gate behind inline level** — `minimal` and `standard` use TOON; `full` uses markdown
   (backward compatible).

### Files Modified
- `package.json` (add dependency)
- `src/resources/extensions/gsd/structured-data-formatter.ts` (NEW)
- `src/resources/extensions/gsd/context-store.ts` (add TOON variants)
- `src/resources/extensions/gsd/auto-prompts.ts` (use TOON when level != full)
- `src/resources/extensions/gsd/tests/structured-data-formatter.test.ts` (NEW)

---

## Phase 4: Prompt Compression via LLMLingua-2 (P2)
**Goal:** Compress large context blocks 3-5x while preserving semantic meaning.

### What
When context exceeds budget, instead of dropping entire sections (current behavior),
compress them using LLMLingua-2. This preserves information density while reducing tokens.

### Tasks
1. **Create `prompt-compressor.ts`** — wrapper around compression logic:
   - `compressContext(text: string, targetRatio: number): Promise<string>`
   - Supports configurable compression ratios (2x for light, 5x for aggressive)
   - Falls back to section-boundary truncation if compression fails
   - Includes compression stats for metrics

2. **Integrate with `context-budget.ts`** — add `compressBeforeTruncate` option:
   - When content exceeds budget, try compression first
   - Only truncate if compressed content still exceeds budget
   - Track compression ratio in metrics

3. **Gate behind preference** — new `compression_strategy` preference:
   - `"truncate"` (default, backward-compatible): current section-boundary truncation
   - `"compress"`: use LLMLingua-2 before truncating
   - Budget profile auto-enables compress for `budget` and `balanced`

### Files Modified
- `src/resources/extensions/gsd/prompt-compressor.ts` (NEW)
- `src/resources/extensions/gsd/context-budget.ts` (integrate)
- `src/resources/extensions/gsd/preferences.ts` (add compression_strategy)
- `src/resources/extensions/gsd/types.ts` (add CompressionStrategy type)
- `src/resources/extensions/gsd/tests/prompt-compressor.test.ts` (NEW)

### Note
LLMLingua-2 JS port (`@atjsh/llmlingua-2`) is experimental. We'll implement the interface
with a fallback path so the feature degrades gracefully. If the JS port isn't stable enough,
we can use the Compresso REST API as an alternative, or implement a simpler heuristic
compression (remove redundant whitespace, deduplicate repeated patterns, abbreviate
common programming terms).

---

## Phase 5: Semantic Context Selection (P2)
**Goal:** Only include semantically relevant content in prompts instead of entire files.

### What
`diff-context.ts` currently selects recently-changed files. `auto-prompts.ts` inlines
entire files. For large files, this wastes tokens on irrelevant sections.

### Tasks
1. **Create `semantic-chunker.ts`** — wrapper for semantic text splitting:
   - `chunkByRelevance(content: string, query: string, maxChunks: number): string[]`
   - Splits content into semantic chunks (function boundaries, class boundaries, etc.)
   - Scores chunks by relevance to the task description
   - Returns top-N most relevant chunks
   - Uses simple TF-IDF scoring (no embeddings needed for v1)

2. **Integrate with `inlineFile()`** — when inlining large files (>2000 chars),
   chunk and select relevant portions:
   - Extract task description/plan as the "query"
   - Score file chunks against the query
   - Include only high-scoring chunks with `[...N chunks omitted]` markers

3. **Add `context_selection` preference**:
   - `"full"`: inline entire files (current behavior)
   - `"smart"`: use semantic chunking for files over threshold
   - Auto-enabled for `budget` and `balanced` profiles

### Files Modified
- `src/resources/extensions/gsd/semantic-chunker.ts` (NEW)
- `src/resources/extensions/gsd/auto-prompts.ts` (integrate with inlineFile)
- `src/resources/extensions/gsd/preferences.ts` (add context_selection)
- `src/resources/extensions/gsd/types.ts` (add ContextSelectionMode type)
- `src/resources/extensions/gsd/tests/semantic-chunker.test.ts` (NEW)

---

## Phase 6: Summary Distillation (P3)
**Goal:** Produce tighter dependency summaries when budget is constrained.

### What
`inlineDependencySummaries()` currently concatenates full summaries from prior slices.
When a slice has many dependencies, this consumes a large portion of the context budget.

### Tasks
1. **Create `summary-distiller.ts`** — reduces multiple summaries to a condensed form:
   - `distillSummaries(summaries: string[], budgetChars: number): string`
   - Extracts key facts: files modified, decisions made, patterns established
   - Removes verbose prose, keeps structured data
   - Preserves all `key_files`, `key_decisions`, `provides`, `requires` frontmatter
   - Falls back to section-boundary truncation for non-parseable summaries

2. **Integrate with `auto-prompts.ts`** — use distiller when:
   - Dependency count > 2 AND budget is constrained
   - InlineLevel is "minimal" or "standard"
   - Budget pressure is above 50%

### Files Modified
- `src/resources/extensions/gsd/summary-distiller.ts` (NEW)
- `src/resources/extensions/gsd/auto-prompts.ts` (integrate with inlineDependencySummaries)
- `src/resources/extensions/gsd/tests/summary-distiller.test.ts` (NEW)

---

## Implementation Order
1. Phase 2 (token counting) — foundation, needed by other phases
2. Phase 1 (cache optimization) — highest ROI
3. Phase 3 (TOON format) — quick win on structured data
4. Phase 6 (summary distillation) — pure logic, no 3rd party
5. Phase 5 (semantic chunking) — TF-IDF v1, no 3rd party
6. Phase 4 (prompt compression) — depends on 3rd party stability

## Testing Strategy
- Each phase adds dedicated unit tests
- Existing tests must continue to pass (no regressions)
- Token savings tests validate measurable reduction
- Run full test suite after each phase: `npm run test:unit`
