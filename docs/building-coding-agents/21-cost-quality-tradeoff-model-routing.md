# Cost-Quality Tradeoff & Model Routing

### The Key Insight

Quality requirements vary enormously across task types, but most systems use the same model for everything.

### The Optimal Model Routing Strategy (All 4 Agree)

| Task Type | Model Tier | Rationale |
|-----------|-----------|-----------|
| **Planning, architecture, critique** | Frontier (always) | Planning errors cascade through every downstream task |
| **Ambiguity resolution** | Frontier | Wrong interpretation = wasted execution |
| **Well-specified implementation** (CRUD, standard UI, utilities) | Mid-tier / capable but cheaper | Task is well-defined, patterns established |
| **Code review, test generation** | Mid-tier | Evaluating against known criteria, not generating novel solutions |
| **Summarization** (task records, manifest updates) | Lightest viable | Language competence, minimal reasoning depth |
| **Boilerplate** | Small/fast model | Predictable output, low reasoning requirements |

### The Non-Obvious Cost Optimization

> **Reducing wasted tokens is higher leverage than reducing token price.** A bloated context window costs money on every single call. Trimming 500 unnecessary tokens from context assembly saves more over a project than switching to a model that's 10% cheaper.

### Measurement

Track **cost-per-successful-task**, not cost-per-task. If the cheaper model requires twice as many iterations, it's not actually cheaper. Grok reports 60-70% cost reduction with zero quality loss when routing is done at the orchestrator level.

---
