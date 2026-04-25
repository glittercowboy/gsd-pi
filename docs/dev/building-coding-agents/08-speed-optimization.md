# Speed Optimization

### The #1 Speed Principle

> The fastest possible operation is the one you don't perform. Before optimizing any step, ask: does this step need to exist at all?

### Speed Levers (Ranked by Impact)

#### 1. Minimize LLM Calls
- **Batch intent into single calls.** Don't generate code, then tests, then docs separately. One call: "implement, test, and document." TypeScript splits the output.
- **Deterministic fast paths.** Missing import? Syntax error? Fix without an LLM call if the fix is mechanical.
- Audit call chains ruthlessly — most systems have 50%+ unnecessary sequential calls.

#### 2. Make Feedback Loops Instantaneous
- Use test watch mode (no cold start)
- Run only relevant test subsets (track which files affect which tests)
- Incremental builds (hot module reloading)
- Async, non-blocking file writes

#### 3. Precompute Context
- Predict what the agent will need based on task definition
- Pre-load into the prompt — no tool calls needed mid-generation
- **Speculative pre-fetching** (like CPU cache prefetching)

#### 4. Parallelize Independent Work
- Minimize startup cost for new parallel agents (pre-built templates, warm connections)
- Use the dependency graph to identify independent work automatically

#### 5. Stream Everything, Block on Nothing
- Process tokens as they arrive
- Pipeline parallelism: start formatting code while commit message is still generating

#### 6. Cache Aggressively
- In-memory cache of everything agent might need
- Cross-task caching for unchanged files
- Cache LLM results for deterministic inputs (boilerplate, type definitions)

#### 7. Minimize Token Waste
- Dense context, not verbose context
- Structured formats for structured data
- Minify reference code that's informational, not for modification

### Anti-Patterns That Murder Speed

| Anti-Pattern | Fix |
|-------------|-----|
| Re-verifying things that can't have changed | Dependency-aware selective re-verification |
| Excessive self-reflection on simple tasks | Complexity-based workflow routing |
| Over-summarization between micro-steps | Only full context reset at task boundaries |
| Waiting for human approval on auto-verifiable work | Human checkpoints at milestones, not tasks |
| Quadratic history growth | Aggressive compression at every transition |
| Synchronous blocking tools | Async everything, pipeline parallelism |

### The Speed Multiplier Nobody Talks About

**Failure prediction.** Track patterns across tasks. If certain task types fail on first attempt, pre-load extra guidance. Preventing a failed iteration is faster than executing one.

> The magical feeling of speed comes from only doing things that matter, and then doing those things as fast as possible. The system should feel like the agent knew what to do and just did it.

---
