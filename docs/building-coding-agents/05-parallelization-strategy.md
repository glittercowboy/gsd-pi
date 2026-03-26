# Parallelization Strategy

### Core Principle

> Parallelize across boundaries, serialize within them.

The quality of parallelization is directly determined by the quality of interface definitions.

### The Diamond Pattern

```
    Planning (narrow, serial)
         ↓
   Fan Out (parallel execution)
         ↓
  Convergence (integration verification)
         ↓
    Fan Out (next parallel set)
```

### Phase-by-Phase Strategy

#### Planning: Mostly Serial, with Parallel Spikes
- High-level decomposition must be serial (one coherent act of reasoning)
- **Parallelize uncertainty resolution:** Multiple spikes investigating different risks simultaneously
- Output: A dependency graph that explicitly identifies what can be parallelized

#### Execution: Massive Parallelization with Right Topology

| Work Type | Strategy |
|-----------|----------|
| **Independent leaf tasks** | Embarrassingly parallel — one agent per module |
| **Dependent chains** | Serial within chain, but chains run in parallel |
| **Convergence points** | Strictly serial — integration verification |

**Critical insight:** The frontend doesn't need the real API — it needs the API *contract*. Once contracts exist, both sides build in parallel.

#### Testing: The Most Interesting Story
- **Unit tests:** Same agent, same context, atomic with code
- **Cross-task tests:** All parallel by definition
- **Integration tests:** Parallel across different boundaries
- **E2E tests:** Serial (exercises whole system)

#### Verification: Deliberate Redundancy
- **Adversarial verification:** Separate reviewer agent with fresh context evaluates against spec
- **Red-team parallelism:** Agent tries to break the implementation

### Coordination Rules

- Agents communicate through the **filesystem**, never directly
- Each agent works on a **branch** — merge on success, discard on failure
- One agent per file at a time (file locking)
- Optimal concurrency: **3–8 simultaneous agents** for most projects

### Anti-Patterns

- ❌ Don't parallelize tasks that modify the same files
- ❌ Don't parallelize interacting decisions
- ❌ Don't skip convergence/integration verification
- ❌ Don't over-parallelize (coordination tax eats gains above ~8 agents)

---
