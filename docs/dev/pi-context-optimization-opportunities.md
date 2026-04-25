# pi-coding-agent: Context Optimization Opportunities

> **Status**: Research only — not planned for implementation.
> Scope: `packages/pi-coding-agent` and `packages/pi-agent-core` infrastructure.
> These changes would benefit every consumer of the pi engine, not just GSD.

---

## 1. Prompt Caching (`cache_control`) — Highest Impact

**Current state**: Every LLM call re-pays full input token cost for the system prompt, tool definitions, and context files. No `cache_control` breakpoints are set anywhere in the API call path.

**Opportunity**: Anthropic's KV cache delivers 90% cost reduction on cached tokens (0.1x input rate). Claude Code achieves 92–98% cache hit rates by placing stable content before volatile content.

**Where to instrument** (`packages/pi-ai/src/providers/anthropic.ts`):
- Set `cache_control: { type: "ephemeral" }` on the last tool definition block
- Set `cache_control` after the static system prompt sections (base boilerplate + context files)
- Leave the per-turn user message uncached

**Critical constraint**: The cache breakpoint must be placed *after* all static content and *before* any dynamic content (timestamps, per-request variables). Moving a timestamp before a cache breakpoint defeats it on every call.

**Cache hierarchy**: Tools → system → messages. Changing a tool definition invalidates system and message caches. Tool definitions should be sorted deterministically (alphabetically) to prevent spurious cache misses.

**Expected savings**: 80–90% reduction in input token cost for multi-turn sessions (the dominant cost pattern in GSD auto-mode).

---

## 2. Observation Masking in the Message Pipeline

**Current state**: `agent-loop.ts` passes the full `context.messages` array to the LLM on every turn. Tool results from 50 turns ago are re-read in full on every subsequent call. The `transformContext` hook exists on `AgentContext` and fires before every LLM call, but has no default implementation — extensions are responsible for any pruning.

**Opportunity**: Replace old tool result content with lightweight placeholders after N turns. JetBrains Research tested this on SWE-bench Verified (500 tasks, up to 250-turn trajectories) and found:
- 50%+ cost reduction vs. unmanaged history
- Performance matched or slightly exceeded LLM summarization
- Zero overhead (no extra LLM call required)

**Proposed implementation** (default `transformContext` in `pi-agent-core`):
```typescript
// Keep last KEEP_RECENT_TURNS verbatim; mask older tool results
const KEEP_RECENT_TURNS = 8;

function defaultObservationMask(messages: AgentMessage[]): AgentMessage[] {
  const cutoff = findTurnBoundary(messages, KEEP_RECENT_TURNS);
  return messages.map((m, i) => {
    if (i >= cutoff) return m;
    if (m.type === "toolResult" || m.type === "bashExecution") {
      return { ...m, content: "[result masked — within summarized history]", excludeFromContext: false };
    }
    return m;
  });
}
```

**Compaction interaction**: Observation masking reduces the token accumulation rate, pushing the compaction threshold further out. The two mechanisms are complementary — masking handles the steady state, compaction handles the rare deep-session case.

---

## 3. Earlier Compaction Threshold

**Current state** (`packages/pi-coding-agent/src/core/constants.ts`):
```typescript
COMPACTION_RESERVE_TOKENS = 16_384   // triggers at contextWindow - 16K
COMPACTION_KEEP_RECENT_TOKENS = 20_000
```

For a 200K context window, compaction fires at ~183K tokens — 91.5% utilization.

**Problem**: Context drift (not raw exhaustion) causes ~65% of enterprise agent failures. Performance degrades measurably beyond ~30K tokens per Zylos production data. The current threshold lets sessions run degraded for a long stretch before compaction fires.

**Opportunity**: Lower the trigger to 70% utilization. For a 200K window, this means compacting at ~140K tokens — 43K tokens earlier.

```typescript
// Proposed
COMPACTION_THRESHOLD_PERCENT = 0.70   // fire at 70% of contextWindow
COMPACTION_RESERVE_TOKENS = contextWindow * (1 - COMPACTION_THRESHOLD_PERCENT)
```

**Trade-off**: More frequent compactions, each happening earlier when there's more "fresh" content to keep. Summary quality improves because less material needs to be discarded at each cut.

---

## 4. Tool Result Truncation at Write Time

**Current state**: `TOOL_RESULT_MAX_CHARS = 2_000` in `constants.ts`, but this limit is only applied *during compaction summarization*, not when the tool result enters the message store. A bash result returning 50KB of log output is stored and re-sent verbatim until compaction fires.

**Opportunity**: Truncate at write time in `messages.ts` → `convertToLlm()` or in the tool result handler. Two strategies:

- **Hard truncation**: Slice at N chars, append `"\n[truncated — {original_length} chars]"`. Simple, zero overhead.
- **Semantic head/tail**: Keep first 500 chars (context, command echo) + last 1000 chars (final output, errors). Better for bash results where the end contains the error.

**Recommendation**: Semantic head/tail as the default, configurable per tool type. File read results benefit from head; bash/test output benefits from head+tail.

---

## 5. Context File Deduplication and Trim

**Current state** (`packages/pi-coding-agent/src/core/resource-loader.ts`, lines 84–109):
- Searches from `~/.gsd/agent/` → ancestor dirs → cwd
- Deduplicates by *file path* but not by *content*
- Entire file content concatenated verbatim into system prompt — no trimming, no summarization

**Anti-pattern**: A project with AGENTS.md at 3 ancestor levels (repo root, workspace, home) injects all three in full. If they share common boilerplate, that content is re-injected multiple times.

**Opportunities**:
1. **Content deduplication**: Hash paragraph-level chunks; skip any chunk already seen in a previously-loaded file
2. **Section-aware loading**: Parse `## ` headings in AGENTS.md; only include sections relevant to the current task type (e.g., `## Testing` section only when running tests)
3. **Token budget enforcement**: If total context files exceed N tokens, summarize oldest/most-distant file rather than including verbatim

---

## 6. Skill Content Lazy Loading and Summarization

**Current state**: When `/skill:name` is invoked, the full skill file content is injected inline as `<skill>...</skill>` in the user message. No chunking, no summarization. A 10KB skill file adds ~2,500 tokens to that turn.

**Opportunity**:
- **Cached skill injection**: If the same skill is used across multiple turns (rare but possible), it's re-injected each time. Cache with `cache_control` after first injection.
- **Skill digest mode**: Inject a 200-token summary of the skill on first reference; full content only if the model requests it via a `get_skill_detail` tool call. Reduces cost for skills that don't end up being followed.
- **Skill prefetching**: Before a known long session (e.g., auto-mode start), pre-inject all likely skills with `cache_control` so they're cached for the entire session.

---

## 7. Token Estimation Accuracy

**Current state** (`compaction.ts`, line 216): `chars / 4` heuristic. This overestimates token count for English prose (~3.5 chars/token) and underestimates for code with short identifiers or Unicode.

**Opportunity**: Use a proper tokenizer.
- `@anthropic-ai/tokenizer` (tiktoken-compatible, ships with the SDK) — accurate but ~5ms per call
- Tiered approach: use chars/4 for display; use proper tokenizer only for compaction threshold decisions (where accuracy matters)

**Impact**: More accurate compaction timing, fewer unnecessary compactions, slightly better `COMPACTION_KEEP_RECENT_TOKENS` boundary placement.

---

## 8. Format: Markdown over XML for Internal Context

**Current state**: The message pipeline uses `<skill>`, `<summary>`, `<compaction>` XML wrappers in several places. System prompt sections are largely prose Markdown.

**Findings**: XML tags carry 15–40% more tokens than equivalent Markdown for the same semantic content, due to paired open/close tags. However, Claude was optimized for XML and shows higher accuracy on tasks requiring precise section parsing.

**Recommendation**: Audit XML usage in the pipeline and convert to Markdown where the content is:
- Non-nested (flat instructions, status messages)
- Human-readable rather than machine-parsed by the model
- Not requiring precise boundary detection

Keep XML for: few-shot examples with ambiguous boundaries, skill content (requires precise isolation from surrounding text), compaction summaries that the model must treat as authoritative history.

**Estimated savings**: 5–15% reduction in system prompt token count.

---

## 9. Dynamic Tool Set Delivery

**Current state**: All tool definitions are included in every LLM request. Tool descriptions consume 60–80% of input tokens in static configurations. As new extensions register tools, the baseline grows linearly.

**Opportunity** (higher complexity): Implement the three-function Dynamic Toolset pattern:
1. `search_tools(query)` — semantic search over tool catalog
2. `describe_tools(ids[])` — fetch full schemas on demand
3. `execute_tool(id, params)` — unchanged execution

Speakeasy measured 91–97% token reduction with 100% task success rate. Trade-off: 2–3x more tool calls, ~50% longer wall time. Net cost dramatically lower.

**Feasibility for pi**: The tool registry (`packages/pi-coding-agent/src/core/tool-registry.ts`) already stores tool metadata separately from definitions. The primary engineering work is the semantic search index and the `describe_tools` / `search_tools` tool implementations.

---

## 10. Cost Attribution and Per-Phase Reporting

**Current state**: `SessionManager.getUsageTotals()` accumulates cost across the entire session. No per-phase or per-agent breakdown is stored. Cost visibility is limited to the footer total and `GSD_SHOW_TOKEN_COST=1` per-turn display.

**Opportunity**: Emit structured cost events that extensions can subscribe to:
```typescript
interface CostCheckpointEvent {
  type: "cost_checkpoint";
  label: string;          // "discuss-phase", "execute-slice-3"
  deltaTokens: Usage;     // tokens since last checkpoint
  cumulativeTokens: Usage;
  cumulativeCost: number;
}
```

GSD extension could consume these events to surface per-milestone cost in `/gsd stats` and flag milestones that are disproportionately expensive — enabling budget-aware planning.

---

## Implementation Ordering (if pursued)

| Priority | Item | Effort | Expected Impact |
|----------|------|--------|-----------------|
| 1 | Prompt caching (`cache_control`) | Low | 80–90% input cost reduction |
| 2 | Earlier compaction threshold (70%) | Trivial | Reduces drift in long sessions |
| 3 | Tool result truncation at write time | Low | Reduces context bloat between compactions |
| 4 | Context file deduplication | Medium | Variable — high for multi-level AGENTS.md setups |
| 5 | Observation masking (default `transformContext`) | Medium | 50%+ on long-running agents |
| 6 | Token estimation (proper tokenizer) | Low | Accuracy improvement, minor cost impact |
| 7 | Markdown over XML audit | Low | 5–15% system prompt reduction |
| 8 | Skill caching with `cache_control` | Low | Meaningful for skill-heavy sessions |
| 9 | Dynamic tool set delivery | High | 90%+ on large tool catalogs; major architecture change |
| 10 | Per-phase cost attribution events | Medium | Visibility only; enables future budget routing |
