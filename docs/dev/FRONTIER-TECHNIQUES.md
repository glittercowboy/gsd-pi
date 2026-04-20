# Frontier Techniques for GSD-2

Research into cutting-edge AI agent techniques that map directly to GSD-2's architecture, ranked by impact and feasibility.

**Date:** 2026-03-25
**Status:** Research / Pre-RFC

---

## Table of Contents

- [Executive Summary](#executive-summary)
- [1. Skill Library Evolution](#1-skill-library-evolution)
- [2. DAG-Based Parallel Tool Execution](#2-dag-based-parallel-tool-execution)
- [3. Speculative Tool Execution](#3-speculative-tool-execution)
- [4. Semantic Context Compression](#4-semantic-context-compression)
- [5. Cross-Session Learning Graph](#5-cross-session-learning-graph)
- [6. MCTS-Based Planning](#6-mcts-based-planning)
- [Priority Matrix](#priority-matrix)
- [Sources & References](#sources--references)

---

## Executive Summary

GSD-2 is a multi-layered, event-driven agent platform with strong extensibility primitives: a skill system, file-based memory, session branching, compaction, and 16+ extension lifecycle hooks. These existing primitives create natural integration points for six frontier techniques that could fundamentally change how GSD operates.

The techniques fall into three categories:

| Category | Techniques | Theme |
|----------|-----------|-------|
| **Self-Improvement** | Skill Library Evolution, Cross-Session Learning Graph | GSD gets better the more you use it |
| **Performance** | DAG Tool Execution, Speculative Tool Execution | GSD gets faster per turn |
| **Intelligence** | Semantic Context Compression, MCTS Planning | GSD reasons better with the same context budget |

---

## 1. Skill Library Evolution

**Category:** Self-Improvement
**Impact:** Massive | **Effort:** Medium | **Priority:** #1

### What It Is

Inspired by [SkillRL](https://arxiv.org/abs/2602.08234) (ICLR 2026), this technique transforms GSD's skill system from static instruction files into a self-improving knowledge base. Instead of skills being written once and updated manually, they evolve based on execution outcomes.

SkillRL demonstrates that agents with learned skill libraries outperform baselines by 15.3%+ across task benchmarks, with 10-20% token compression compared to raw trajectory storage.

### How It Works

```
┌─────────────────────────────────────────────────────────┐
│                    EXECUTION LOOP                       │
│                                                         │
│  1. Skill invoked → agent executes task                 │
│  2. Outcome captured (success/failure + trajectory)     │
│  3. Trajectory distilled:                               │
│     ├─ Success → strategic pattern extracted            │
│     └─ Failure → anti-pattern + lesson recorded         │
│  4. Skill file updated with versioned improvement       │
│  5. Next invocation benefits from accumulated learnings │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Two types of learned knowledge:**

| Type | Description | Example |
|------|-------------|---------|
| **General Skills** | Universal strategic guidance applicable across tasks | "When editing TypeScript files, always check for type errors via LSP before committing" |
| **Task-Specific Skills** | Category-level heuristics for specific skill domains | "The `fix-issue` skill should check CI status before opening a PR, not after" |

### Why It Fits GSD-2

GSD already has every primitive needed:

- **Skill files** (`~/.claude/skills/`, `.claude/skills/`) — the storage layer exists
- **Extension hooks** (`turn_end`, `agent_end`) — outcome capture points exist
- **Memory system** (MEMORY.md + individual files) — persistence exists
- **`/improve-skill` and `/heal-skill` commands** — manual versions of this loop already exist

The gap is automation: connecting execution outcomes back to skill files without human intervention.

### Integration Points

| GSD Component | Role in Integration |
|---------------|-------------------|
| `agent-session.ts` → `turn_end` event | Captures execution outcome (success/failure signals) |
| Extension hook: `agent_end` | Triggers trajectory distillation |
| Skill file system | Receives versioned updates with learned patterns |
| `compaction.ts` | Provides trajectory data from the session for distillation |

### Architecture

```
User invokes skill
        │
        ▼
┌──────────────┐     ┌──────────────────┐
│ AgentSession  │────▶│  Skill Executor   │
│ (turn_end)    │     │  (tracks outcome) │
└──────────────┘     └────────┬─────────┘
                              │
                    ┌─────────▼──────────┐
                    │ Outcome Classifier  │
                    │ (success/failure/   │
                    │  partial)           │
                    └─────────┬──────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
     ┌────────────┐  ┌──────────────┐  ┌───────────┐
     │  Success   │  │   Failure    │  │  Partial   │
     │  Distiller │  │  Distiller   │  │  Analyzer  │
     └─────┬──────┘  └──────┬───────┘  └─────┬─────┘
           │                │                 │
           ▼                ▼                 ▼
     ┌─────────────────────────────────────────────┐
     │           Skill File Updater                 │
     │  • Appends learned pattern to skill          │
     │  • Versions the update                       │
     │  • Preserves original skill intent           │
     └─────────────────────────────────────────────┘
```

### Open Questions

- **Drift prevention:** How to prevent accumulated learnings from overwhelming the original skill intent?
- **Conflict resolution:** What happens when a lesson from one session contradicts another?
- **Quality gate:** Should updates require a validation pass before being written?

---

## 2. DAG-Based Parallel Tool Execution

**Category:** Performance
**Impact:** High | **Effort:** Medium | **Priority:** #2

### What It Is

The [LLM Compiler pattern](https://arxiv.org/pdf/2312.04511) (ICML 2024) treats multi-tool workflows like a compiler optimization pass. When the model returns multiple tool calls in a single response, instead of executing them sequentially, the system:

1. Analyzes dependencies between tool calls
2. Constructs a Directed Acyclic Graph (DAG)
3. Executes independent tools in parallel
4. Blocks only on actual data dependencies

### How It Works

**Current GSD behavior (sequential):**
```
Read(auth.ts) ─── 150ms ───▶ result
                               │
Read(types.ts) ─── 120ms ──▶ result
                               │
Grep("login") ─── 80ms ────▶ result
                               │
Read(test.ts) ─── 130ms ───▶ result
                               │
Total: ~480ms sequential
```

**With DAG execution (parallel):**
```
Read(auth.ts)  ─── 150ms ──▶ result ─┐
Read(types.ts) ─── 120ms ──▶ result ─┤
Grep("login")  ─── 80ms ───▶ result ─┤── all complete at 150ms
Read(test.ts)  ─── 130ms ──▶ result ─┘
                                      │
Total: ~150ms (max of parallel set)
```

**Dependency analysis rules:**

| Tool A | Tool B | Dependency? | Reason |
|--------|--------|-------------|--------|
| Read(file) | Read(file) | No | Reads are idempotent |
| Read(file) | Grep(pattern) | No | Independent data sources |
| Read(file) | Edit(file) | Yes | Edit depends on Read content |
| Edit(file) | Edit(file) | Yes | Edits to same file must serialize |
| Bash(cmd) | Bash(cmd) | Maybe | Depends on side effects |
| Write(file) | Read(file) | Yes | Read after write needs write to complete |

### Why It Fits GSD-2

The model already emits multiple `tool_use` blocks in a single response. GSD processes them, but the execution path in `agent-loop.ts` handles them in sequence. The parallelism opportunity is sitting right there.

**Measured impact estimate:** A typical coding turn involves 3-5 tool calls. With 60% parallelizable (reads, greps, globs), per-turn latency drops by 40-60%. Over a 50-turn session, that's minutes saved.

### Integration Points

| GSD Component | Role in Integration |
|---------------|-------------------|
| `agent-loop.ts` tool execution path | Replace sequential execution with DAG scheduler |
| Tool definitions | Annotate tools with side-effect metadata (pure/impure) |
| Extension hooks (`tool_*`) | Must still fire in correct order per dependency chain |

### Architecture

```
Model response with N tool_use blocks
                │
                ▼
┌──────────────────────────────┐
│      Dependency Analyzer      │
│  • Parse tool calls           │
│  • Identify file overlaps     │
│  • Identify data dependencies │
│  • Classify: pure vs impure   │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│        DAG Constructor        │
│  • Nodes = tool calls         │
│  • Edges = dependencies       │
│  • Topological sort           │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│      Parallel Executor        │
│  • Execute roots immediately  │
│  • On completion, unlock      │
│    dependent nodes            │
│  • Collect all results        │
│  • Return in original order   │
└──────────────────────────────┘
```

### Open Questions

- **Bash side effects:** How to determine if two Bash commands conflict without executing them?
- **Extension hooks:** Should `tool_start`/`tool_end` events fire in execution order or original order?
- **Error propagation:** If a parallel tool fails, do dependent tools get cancelled or receive the error?

---

## 3. Speculative Tool Execution

**Category:** Performance
**Impact:** High | **Effort:** Low-Medium | **Priority:** #3

### What It Is

Based on [Speculative Tool Calls research](https://arxiv.org/pdf/2512.15834), this technique predicts which tools the model will request and pre-executes them before the model responds. Correct predictions eliminate the first tool-call round-trip entirely. Wrong predictions are discarded at zero cost beyond compute.

### How It Works

```
┌─────────────────────────────────────────────────────────────┐
│ User: "fix the bug in auth.ts"                              │
│                                                             │
│ BEFORE model responds:                                      │
│   Speculator predicts:                                      │
│     ├─ Read("auth.ts")           → pre-executed ✓           │
│     ├─ Grep("error|bug", "auth") → pre-executed ✓           │
│     ├─ LSP diagnostics(auth.ts)  → pre-executed ✓           │
│     └─ Read("auth.test.ts")      → pre-executed ✓           │
│                                                             │
│ Model responds with tool calls:                             │
│     ├─ Read("auth.ts")           → CACHE HIT (0ms)         │
│     ├─ Read("auth.test.ts")      → CACHE HIT (0ms)         │
│     └─ Grep("login", "src/")     → cache miss (execute)    │
│                                                             │
│ Hit rate: 2/3 = 67%                                         │
│ Latency saved: ~300ms on this turn                          │
└─────────────────────────────────────────────────────────────┘
```

**Prediction strategies (simplest to most sophisticated):**

| Strategy | Description | Expected Hit Rate |
|----------|-------------|-------------------|
| **Keyword extraction** | Parse user prompt for file paths, function names → Read those files | 40-60% |
| **Session history** | Track which tools follow which user prompt patterns | 50-70% |
| **Learned patterns** | Use the skill library evolution data to predict tool sequences | 60-80% |
| **Model pre-query** | Ask a fast/cheap model to predict tool calls | 70-85% |

### Why It Fits GSD-2

The #1 latency bottleneck in GSD is the round-trip: user prompt → model thinks → model requests tool → tool executes → result sent back → model thinks again. Speculative execution attacks the highest-latency step.

GSD's architecture makes this easy to add:
- `AgentSession.prompt()` already processes user input before sending to the model
- Tool results are already cached in the message array
- The extension system can intercept input and spawn pre-fetches

### Integration Points

| GSD Component | Role in Integration |
|---------------|-------------------|
| `AgentSession.prompt()` | Trigger speculation after user input, before model call |
| Tool result cache (new) | Store speculated results keyed by tool+args |
| `agent-loop.ts` tool execution | Check cache before executing; serve cached result on hit |
| Extension hook: `input` | Parse user intent for file paths, patterns |

### Architecture

```
User input arrives
        │
        ├──────────────────────────────────────┐
        │                                      │
        ▼                                      ▼
┌───────────────┐                    ┌──────────────────┐
│  Send to LLM  │                    │   Speculator      │
│  (normal path) │                    │  • Extract paths   │
│               │                    │  • Predict tools   │
│  ... waiting  │                    │  • Pre-execute     │
│  for response │                    │  • Cache results   │
│               │                    └──────────────────┘
│               │                              │
│               │◀─── model returns ──────────│
│               │     tool_use blocks         │
└───────┬───────┘                              │
        │                                      │
        ▼                                      │
┌───────────────┐                              │
│ Tool Executor  │◀──── check cache ───────────┘
│ • Cache hit?   │
│   → return     │
│ • Cache miss?  │
│   → execute    │
└───────────────┘
```

### Cost Analysis

| Scenario | Cost |
|----------|------|
| **Correct prediction** | ~0ms latency (result already available). Compute cost: the pre-execution itself (trivial for Read/Grep). |
| **Wrong prediction** | Wasted compute for the pre-executed tool. For Read/Grep/Glob, this is <10ms of I/O. |
| **Partial hit** | Net positive as long as hit rate > 20% (given how cheap misses are). |

### Open Questions

- **TTL for cached results:** How long are speculated results valid? File contents can change between speculation and model request.
- **Side effects:** Should only pure tools (Read, Grep, Glob, LSP) be speculatable?
- **Resource limits:** Cap on number of speculative executions per turn to prevent I/O storms?

---

## 4. Semantic Context Compression

**Category:** Intelligence
**Impact:** High | **Effort:** High | **Priority:** #4

### What It Is

GSD's compaction system uses a char/4 heuristic for token estimation and all-or-nothing LLM summarization for context reduction. Research from [Zylos](https://zylos.ai/research/2026-02-28-ai-agent-context-compression-strategies) and [context engineering literature](https://rlancemartin.github.io/2025/06/23/context_engineering/) shows that embedding-based compression achieves 80-90% token reduction while preserving the ability to selectively recall specific historical context.

### Current GSD Compaction (Weaknesses Highlighted)

```
Messages: [M1, M2, M3, M4, M5, M6, M7, M8, M9, M10]
                                                    ▲
Token budget exceeded                               │ recent
                                                    │
Current approach:
┌─────────────────────────┬─────────────────────────┐
│  M1-M6: LLM-summarized │  M7-M10: kept verbatim  │
│  into single blob       │  (last ~20k tokens)     │
│                         │                         │
│  ⚠ All detail lost      │  ✓ Full fidelity        │
│  ⚠ No selective recall  │                         │
│  ⚠ char/4 overestimates │                         │
└─────────────────────────┴─────────────────────────┘
```

**Three specific weaknesses:**

| Weakness | Impact | Current Code Location |
|----------|--------|-----------------------|
| char/4 token estimation | ~25% overestimate → compacts too early → wastes context | `compaction.ts:201-259` |
| All-or-nothing summarization | Loses specific details that may be relevant later | `compaction.ts:327-400` |
| No retrieval from compacted history | Once summarized, detail is gone forever | `compaction-orchestrator.ts` |

### Proposed: Tiered Memory Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    HOT TIER                              │
│  Recent turns (last ~20k tokens)                        │
│  Full text, full fidelity                               │
│  Storage: in-context messages                           │
│  Access: always in prompt                               │
├─────────────────────────────────────────────────────────┤
│                    WARM TIER                             │
│  Older turns (beyond context window)                    │
│  Stored as embeddings + compressed text                 │
│  Storage: session-local vector index                    │
│  Access: retrieved when semantically relevant to        │
│          current turn                                   │
│  Token cost: only retrieved segments count              │
├─────────────────────────────────────────────────────────┤
│                    COLD TIER                             │
│  Ancient turns / previous sessions                      │
│  Stored as summaries + metadata                         │
│  Storage: disk (existing session files)                 │
│  Access: retrieved only on explicit recall              │
│  Token cost: minimal summary headers                    │
└─────────────────────────────────────────────────────────┘
```

**How retrieval works per turn:**

```
New user prompt arrives
        │
        ▼
┌───────────────────┐
│  Embed the prompt  │ (compute embedding of user's question)
└────────┬──────────┘
         │
         ├──── query warm tier ──▶ top-K relevant historical turns
         │                         (cosine similarity > threshold)
         │
         ├──── always include ──▶ hot tier (recent turns, full text)
         │
         ▼
┌───────────────────┐
│  Compose context   │
│  = hot + retrieved │
│  + system prompt   │
└───────────────────┘
```

### Token Estimation Improvement

Replace char/4 with adaptive estimation:

| Approach | Accuracy | Cost |
|----------|----------|------|
| **char/4 (current)** | ~75% (overestimates) | Zero |
| **Provider-reported usage** | 100% (for last turn) | Zero (already tracked) |
| **tiktoken/provider tokenizer** | ~98% | ~5ms per message |
| **Hybrid: actual for recent, char/4 for old** | ~95% | Negligible |

The hybrid approach — use actual token counts from provider responses for recent messages, fall back to char/4 for older messages — is a quick win that requires no new dependencies.

### Integration Points

| GSD Component | Role in Integration |
|---------------|-------------------|
| `compaction.ts` | Replace cut-point algorithm with tiered approach |
| `compaction-orchestrator.ts` | Add warm-tier retrieval before model call |
| `agent-session.ts` message building | Inject retrieved warm-tier segments |
| Session persistence layer | Store embeddings alongside session entries |

### Open Questions

- **Embedding model:** Local (fast, private) or API (better quality, adds latency)?
- **Index format:** Simple cosine similarity on flat arrays vs. HNSW index?
- **Retrieval budget:** How many tokens to allocate to warm-tier retrievals per turn?
- **Coherence:** How to prevent retrieved historical context from confusing the model about the current state?

---

## 5. Cross-Session Learning Graph

**Category:** Self-Improvement
**Impact:** Transformative | **Effort:** High | **Priority:** #5

### What It Is

GSD's memory system (MEMORY.md + individual files) stores flat, file-based memories. A learning graph extends this into a structured knowledge base that captures relationships between codebases, files, errors, solutions, and patterns across all sessions.

This is informed by research on [agent memory architectures](https://github.com/Shichun-Liu/Agent-Memory-Paper-List) and the emerging discipline of [context engineering](https://thenewstack.io/memory-for-ai-agents-a-new-paradigm-of-context-engineering/).

### Current Memory vs Learning Graph

| Aspect | Current (MEMORY.md) | Learning Graph |
|--------|---------------------|----------------|
| **Structure** | Flat file list | Nodes + edges (graph) |
| **Relationships** | None | "file X often breaks when Y changes" |
| **Retrieval** | All loaded into context | Query-driven, only relevant nodes |
| **Learning** | Manual (user says "remember X") | Automatic from execution outcomes |
| **Scope** | Per-project directory | Per-project with cross-project patterns |
| **Staleness** | Manual cleanup | Confidence decay over time |

### Graph Schema

```
┌──────────┐     touches      ┌──────────┐
│  Session  │────────────────▶│   File    │
│           │                 │           │
│ • date    │                 │ • path    │
│ • outcome │                 │ • type    │
│ • tokens  │                 │ • churn   │
└────┬──────┘                 └─────┬─────┘
     │                              │
     │ encountered                  │ involved_in
     │                              │
     ▼                              ▼
┌──────────┐    resolved_by   ┌──────────┐
│  Error    │────────────────▶│ Solution  │
│           │                 │           │
│ • type    │                 │ • pattern │
│ • message │                 │ • success │
│ • freq    │                 │   rate    │
└──────────┘                 └──────────┘
     │                              │
     │ prevented_by                 │ uses
     │                              │
     ▼                              ▼
┌──────────┐                 ┌──────────┐
│  Pattern  │                │   Tool   │
│           │                │          │
│ • type    │                │ • name   │
│ • desc    │                │ • avg    │
│ • conf    │                │   time   │
└──────────┘                 └──────────┘
```

### Example Queries

| Query | Result |
|-------|--------|
| "What errors have occurred in `auth.ts`?" | List of error nodes connected to that file node |
| "What's the typical fix for `TypeError` in this codebase?" | Solution nodes with highest success rate for that error type |
| "Which files tend to break together?" | File clusters with high co-occurrence in error sessions |
| "What tools are slowest in this project?" | Tool nodes sorted by avg execution time |

### Integration Points

| GSD Component | Role in Integration |
|---------------|-------------------|
| `session-manager.ts` | Write graph nodes on session save |
| `agent-session.ts` prompt building | Query graph for relevant context before model call |
| Memory system (MEMORY.md) | Coexists — graph handles structured knowledge, memory handles preferences/feedback |
| Extension hook: `agent_end` | Trigger graph update with session outcome |

### Storage Options

| Option | Pros | Cons |
|--------|------|------|
| **SQLite + json columns** | Simple, no dependencies, fast queries | No native vector search |
| **SQLite + sqlite-vss** | Adds vector similarity to SQLite | Extra native dependency |
| **Flat JSON files** | Zero dependencies, git-friendly | Slow for large graphs |
| **LanceDB** | Embedded vector DB, no server | Additional dependency |

### Open Questions

- **Privacy:** Graph contains detailed codebase interaction history — should it be encrypted at rest?
- **Portability:** Should the graph travel with the project (`.claude/` dir) or stay user-local?
- **Garbage collection:** How to prune stale nodes (e.g., files that no longer exist)?

---

## 6. MCTS-Based Planning

**Category:** Intelligence
**Impact:** Transformative | **Effort:** Very High | **Priority:** #6

### What It Is

Inspired by [ToolTree](https://www.agentic-patterns.com/patterns/skill-library-evolution/) and Monte Carlo Tree Search, this technique replaces GSD's linear action selection with a tree-based planner that explores multiple solution paths simultaneously.

Instead of the model deciding one action at a time and hoping it works, the system:

1. Generates N candidate next-actions
2. Scores each based on estimated probability of reaching the goal
3. Explores promising branches in parallel
4. Backtracks when a path fails, without wasting the user's context on dead ends

### Current vs MCTS Approach

**Current (linear):**
```
User: "fix the auth bug"
  │
  ▼
Action 1: Read auth.ts ──▶ Action 2: Edit line 45 ──▶ Action 3: Run tests
                                                              │
                                                         Tests fail ✗
                                                              │
                                                         ▼
                                                    Action 4: Try different edit
                                                              │
                                                         Tests fail ✗
                                                              │
                                                         ▼
                                                    Action 5: Read error log...
                                                    (linear flailing)
```

**With MCTS (tree search):**
```
User: "fix the auth bug"
  │
  ▼
Read auth.ts
  │
  ├── Branch A: Edit line 45 (score: 0.6)
  │     └── Run tests → FAIL → prune
  │
  ├── Branch B: Check auth middleware (score: 0.7)  ◀── highest score
  │     └── Edit middleware.ts → Run tests → PASS ✓
  │
  └── Branch C: Check env config (score: 0.3)
        └── (not explored — lower score)

Result: Branch B succeeds after 2 actions, not 5+
```

### Why It Fits GSD-2

GSD already has session branching primitives:
- `fork()` creates a branch from any message
- Branch summaries compress history at fork points
- Tree navigation (`/tree`) lets users explore branches
- Session tree is already a first-class concept

The gap: these primitives are user-triggered. MCTS would make the agent trigger them automatically during problem-solving.

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    MCTS Planning Layer                   │
│                                                         │
│  ┌─────────────┐    ┌──────────────┐    ┌────────────┐ │
│  │   Proposer   │───▶│   Scorer     │───▶│  Selector  │ │
│  │ Generate N   │    │ Estimate P   │    │ Pick best  │ │
│  │ candidates   │    │ of success   │    │ to explore │ │
│  └─────────────┘    └──────────────┘    └─────┬──────┘ │
│                                               │        │
│  ┌─────────────┐    ┌──────────────┐          │        │
│  │  Pruner     │◀───│   Executor   │◀─────────┘        │
│  │ Kill dead   │    │ Run action   │                   │
│  │ branches    │    │ in worktree  │                   │
│  └─────────────┘    └──────────────┘                   │
└─────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────┐
│  Agent Session       │
│  (receives winning   │
│   branch as result)  │
└─────────────────────┘
```

### Scoring Approaches

| Approach | Speed | Quality | Cost |
|----------|-------|---------|------|
| **Heuristic** (file relevance, error proximity) | Fast | Low | Free |
| **Fast model** (haiku-class rates candidates) | Medium | Medium | Low |
| **Self-evaluation** (main model rates its own proposals) | Slow | High | High |
| **Learned scorer** (trained on past outcomes from learning graph) | Fast | High | Free at inference |

### Integration Points

| GSD Component | Role in Integration |
|---------------|-------------------|
| `agent-loop.ts` | New planning phase between user prompt and action execution |
| Session branching (`fork()`) | Used to create exploration branches |
| Git worktrees | Each branch explored in an isolated worktree |
| `agent-session.ts` | Receives the winning branch and presents it as the result |
| Skill Library Evolution (#1) | Provides learned patterns to improve the scorer over time |

### Cost-Benefit Analysis

| Factor | Value |
|--------|-------|
| **LLM calls per turn** | 2-5x more (proposal generation + scoring) |
| **Token usage** | 3-10x more per complex problem |
| **Success rate on hard problems** | Estimated 30-50% improvement |
| **Time to solution** | Fewer total turns despite more LLM calls per turn |
| **User experience** | Agent appears to "think harder" on hard problems |

### Open Questions

- **When to activate:** MCTS is expensive. Should it only activate when the agent detects a hard problem (repeated failures, high uncertainty)?
- **Branch isolation:** Git worktrees work for file changes, but how to isolate Bash side effects?
- **Budget control:** How many branches to explore before falling back to linear execution?
- **Transparency:** Should the user see the exploration tree or just the winning path?

---

## Priority Matrix

| # | Technique | Impact | Effort | Compounding | Dependencies |
|---|-----------|--------|--------|-------------|--------------|
| 1 | **Skill Library Evolution** | Massive | Medium | Yes — improves all other techniques | None |
| 2 | **DAG Tool Execution** | High | Medium | No — static speedup | None |
| 3 | **Speculative Tool Execution** | High | Low-Med | Yes — improves with learning | Benefits from #1 |
| 4 | **Semantic Context Compression** | High | High | No — static improvement | None |
| 5 | **Cross-Session Learning Graph** | Transformative | High | Yes — feeds #1, #3, #6 | Benefits from #1 |
| 6 | **MCTS Planning** | Transformative | Very High | Yes — improves with #1, #5 | Benefits from #1, #5 |

### Recommended Implementation Order

```
Phase 1 (Foundation)          Phase 2 (Performance)       Phase 3 (Intelligence)
─────────────────────         ─────────────────────       ─────────────────────
┌─────────────────┐          ┌─────────────────┐         ┌─────────────────┐
│ Skill Library    │          │ DAG Tool Exec   │         │ Semantic Context│
│ Evolution        │──feeds──▶│                 │         │ Compression     │
│                  │          │ Speculative     │         │                 │
│                  │──feeds──▶│ Tool Exec       │         │ MCTS Planning   │
└─────────────────┘          └─────────────────┘         └─────────────────┘
                                      │                          ▲
┌─────────────────┐                   │                          │
│ Cross-Session   │───────────────────┴──────────────────────────┘
│ Learning Graph  │         (feeds intelligence layer)
└─────────────────┘
```

**Phase 1** creates the feedback loop that makes everything else better over time.
**Phase 2** delivers immediate, measurable performance wins.
**Phase 3** requires the most architectural change but delivers the deepest capability gains.

---

## Sources & References

### Papers

- [SkillRL: Evolving Agents via Recursive Skill-Augmented RL](https://arxiv.org/abs/2602.08234) — ICLR 2026. Skill library evolution framework.
- [LLMCompiler: An LLM Compiler for Parallel Function Calling](https://arxiv.org/pdf/2312.04511) — ICML 2024. DAG-based tool execution.
- [Optimizing Agentic LLM Inference via Speculative Tool Calls](https://arxiv.org/pdf/2512.15834) — Speculative execution for agent tools.
- [RISE: Recursive Introspection for Self-Improvement](https://proceedings.neurips.cc/paper_files/paper/2024/file/639d992f819c2b40387d4d5170b8ffd7-Paper-Conference.pdf) — NeurIPS 2024. Self-improving LLM agents.
- [Don't Break the Cache: Prompt Caching for Agentic Tasks](https://arxiv.org/html/2601.06007v1) — Prompt caching evaluation.
- [Efficient LLM Serving for Agentic Workflows](https://arxiv.org/html/2603.16104v1) — Systems perspective on agent serving.

### Industry & Analysis

- [Context Engineering for Agents](https://rlancemartin.github.io/2025/06/23/context_engineering/) — Lance Martin's comprehensive guide.
- [AI Agent Context Compression Strategies](https://zylos.ai/research/2026-02-28-ai-agent-context-compression-strategies) — Zylos Research, Feb 2026.
- [Context Engineering for Coding Agents](https://martinfowler.com/articles/exploring-gen-ai/context-engineering-coding-agents.html) — Martin Fowler.
- [Memory for AI Agents: A New Paradigm](https://thenewstack.io/memory-for-ai-agents-a-new-paradigm-of-context-engineering/) — The New Stack.
- [LLM Compiler Agent Pattern](https://agent-patterns.readthedocs.io/en/stable/patterns/llm-compiler.html) — Agent Patterns documentation.
- [Skill Library Evolution Pattern](https://www.agentic-patterns.com/patterns/skill-library-evolution/) — Awesome Agentic Patterns.

### Workshops & Events

- [ICLR 2026 Workshop on AI with Recursive Self-Improvement](https://iclr.cc/virtual/2026/workshop/10000796)
- [Agent Memory Paper List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List) — Comprehensive survey.
- [Awesome Context Engineering](https://github.com/Meirtz/Awesome-Context-Engineering) — Papers, frameworks, guides.
