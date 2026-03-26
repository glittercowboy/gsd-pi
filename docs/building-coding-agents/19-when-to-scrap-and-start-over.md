# When to Scrap and Start Over

### The Four Signals (Cross-Model Convergence)

| Signal | What It Looks Like |
|--------|-------------------|
| **Iteration count trending upward** | Task 1: 3 iterations. Task 2: 5. Task 3: 8. Complexity compounding, not resolving. |
| **Test flakiness increasing** | Previously passing tests intermittently fail — hidden coupling being strained |
| **Same files modified repeatedly** | Every task touches the same core module — god object absorbing too much responsibility |
| **Acceptance criteria requiring exceptions** | "Works except when X" / "Passes if you ignore test Y" — agent negotiating with criteria |

### The Reassessment Protocol

When thresholds are crossed, trigger a **focused LLM call** with: manifest + original spec + task summaries + signal data. Prompt: *"Is the current approach viable or would a different architecture serve better? If different, what and why?"*

### The Critical Architectural Enabler: Make Rewrites Cheap

- Clean interface contracts + good test suites → rewriting internals while preserving interfaces is low-risk
- Tests verify new implementation against same criteria
- Interface contracts ensure nothing downstream breaks
- **Every major approach on a branch** that can be discarded without affecting anything else

Gemini's **"Sunk-Cost Heuristic"**: Monitor "Task Re-entry Rate." If the same 3 tests have been attempted >5 times, or if the refactor-to-feature ratio exceeds 4:1, trigger a "Whiteboard Session."

Grok adds **parallel experimentation**: create a "Rewrite Branch" subgraph, run the same vision on a clean slate for one vertical slice, compare metrics. Only merge if superior. Cost is near-zero because it runs in parallel and is discarded on failure.

---
