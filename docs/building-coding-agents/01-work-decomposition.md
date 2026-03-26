# Work Decomposition

**The universal consensus:** Elite engineers never jump from vision to code. They use **progressive decomposition** through layers of abstraction.

### The Compression Ladder

```
Vision → Capabilities → Systems/Architecture → Features → Tasks
```

Each layer answers a different question:

| Layer | Question |
|-------|----------|
| Vision | What world are we creating? |
| Capabilities | What must the product be able to do? |
| Systems | What infrastructure enables those capabilities? |
| Features | What does the user interact with? |
| Tasks | What exact code gets written? |

### Core Principles (All 4 Models Agree)

- **Start with outcomes, not features.** Define "done" before anything else. Not "build a login page" but "a user can securely access their dashboard using OAuth."
- **Vertical slices over horizontal layers.** Build thin end-to-end slices (UI → API → DB) rather than completing all backend before all frontend. Each slice is independently demoable and testable.
- **The 1-Day Rule.** If a task takes longer than a day, it's not a task — it's a milestone. Break it down further until each item is a single, clear action completable in one sitting.
- **Risk-first exploration.** Identify the hardest/most uncertain parts first. Spike on unknowns before committing to architecture. "Kill the biggest risks while they are still cheap to fix."
- **Interface-first design.** Define contracts between components before building them. This enables parallel work and creates natural verification checkpoints.
- **MECE decomposition.** Tasks should be Mutually Exclusive (no overlap) and Collectively Exhaustive (complete the vision when all are done).

### The Recursive Heuristic

> If something feels fuzzy, break it down one level deeper. Keep decomposing until a task is obvious how to start.

---
