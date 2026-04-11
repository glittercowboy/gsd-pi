# Evolution Across Project Scale

### Phase Transitions (All 4 Models Converge)

#### 0–1k LOC: The Monolithic Phase
- Everything fits in one context window
- Agent reads entire codebase, makes globally coherent decisions
- Orchestrator is simple, manifest barely needed
- **This is where most demos live**

#### 1k–10k LOC: The Modular Phase
- Codebase no longer fits in one context window
- **What breaks first: consistency** — agent sees fragments that gradually diverge
- Requirements: modular context assembly, manifest as essential map, interface contracts, convention enforcement (linting, formatting)

#### 10k–50k LOC: The Architectural Phase
- Relationships between components become non-obvious
- Changing one thing might affect ten others through indirect dependencies
- **What breaks:** planning quality — planner can't understand full system
- Requirements: dependency-aware context assembly, impact analysis before execution, more conservative/incremental plans

#### 50k–100k+ LOC: The Organizational Phase
- System of systems — no single agent context can reason about the whole thing
- **What breaks:** integration — interactions between components become so numerous that integration testing becomes the bottleneck
- Requirements: hierarchical planning (system-level planner → component-level agents), continuous integration verification, possibly distributed orchestrator, hierarchy of manifests

### The Meta-Insight

> The architecture of your agentic system should **mirror the architecture of the software it's building.** Microservices projects need a more distributed orchestrator. Monolithic projects can use a simpler one.

---
