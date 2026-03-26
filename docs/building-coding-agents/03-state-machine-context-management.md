# State Machine & Context Management

### The Fundamental Tension

The agent needs to understand the whole project to make good decisions, but any single context window degrades with too much information — not just from token limits but from **attention dilution**.

### Layered Memory Architecture (Universal Agreement)

```
Project Manifest (always loaded, <1000 tokens)
        ↓
Task Context (per-task, relevant files + specs)
        ↓
Retrieval Layer (pull-based, on-demand)
        ↓
Ground Truth (filesystem, git, actual code)
```

| Layer | Content | Access Pattern | Token Impact |
|-------|---------|---------------|--------------|
| **Working Context** (L1) | Current task + 3–5 relevant files | Dynamically assembled per LLM call | 8k–25k tokens |
| **Session/Episodic** (L2) | Compressed history + recent decisions | Auto-summarized at transitions | Summary only |
| **Project Semantic** (L3) | Full codebase summaries, dependency graph, ADRs | Vector + Graph retrieval | Pointers only |
| **Ground Truth** (L4) | Actual files, git history, test results | Agent reads via tools | Zero in prompt |

### The State Machine

The agent should always be in one explicit state:

```
PLAN → IMPLEMENT → TEST → DEBUG → VERIFY → DOCUMENT
```

**Critical transitions that matter:**
- **Task completion:** Defined by automated tests passing + acceptance criteria met
- **Stuck detection:** Triggered by repeated failed attempts or missing information
- **Plan revision:** Triggered when completed tasks reveal wrong assumptions

### Key Principles

- **Summarize aggressively between phases.** Don't carry full implementation context forward — carry compressed summaries: what was built, what decisions were made, what interfaces were created.
- **Pull-based, not push-based context.** Don't preload everything the agent might need. Let it ask for what it discovers it needs.
- **Use structured state for reliability.** Natural language summaries drift. Use JSON/typed configs for anything the system needs to track. Reserve natural language for reasoning.
- **The filesystem is external memory.** The codebase itself is the most detailed representation of current state. Hold *understanding* about code in context, not the code itself.

---
