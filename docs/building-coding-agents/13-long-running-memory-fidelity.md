# Long-Running Memory Fidelity

**The core problem:** Every compression loses information. Over enough compressions, summaries drift from reality like a photocopy of a photocopy. The system can't easily tell it's happening because it only sees the current summary, not what was lost.

### Multi-Tier Memory with Different Decay Rates

| Tier | Decay Rate | Content | Update Strategy |
|------|-----------|---------|-----------------|
| **Manifest** | Fast (updates every task) | Current state only, <1000 tokens | Continuous overwrite — no history |
| **Decision Log** | Never decays (append-only) | Every significant architectural decision + rationale | Never summarized, grows linearly |
| **Task Archive** | Medium | Compressed task completion records | Available for retrieval, not routinely loaded |

### The Critical Mechanism: Periodic Reconciliation

All four models converge on some form of automated audit:

- **Claude:** Every milestone or N tasks — agent compares manifest against actual codebase
- **Gemini:** Every N commits, spawn a "History Auditor" agent whose sole job is manifest-vs-code comparison
- **GPT:** Self-healing summaries with checksums — when source files change, invalidate and regenerate
- **Grok:** Deterministic "Memory Fidelity Audit" node every 5 checkpoints — samples key invariants, scores drift 0-100, auto-rebuilds if drift >15%

### The Golden Rule

> **Never summarize summaries.** Each compression layer regenerates from the one below. The codebase is always the lossless source of truth.

### The Most Dangerous Form of Drift

Not factual inaccuracy — **the loss of "why."** The manifest says "auth uses JWT tokens." Three months ago there was a long discussion about why JWT was chosen over session-based auth. That context is exactly what gets compressed away. The **append-only decision log** solves this by preserving *why* indefinitely even as *what* gets continuously compressed.

### Phase Boundary Refresh

For very long projects (weeks/months), **rebuild the manifest from scratch** at phase boundaries by having the agent read the actual codebase + decision log — rather than carrying forward the old manifest with incremental updates. This is the equivalent of defragmenting a hard drive.

---
