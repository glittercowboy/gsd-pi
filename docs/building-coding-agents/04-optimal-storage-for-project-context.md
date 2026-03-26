# Optimal Storage for Project Context

### The Universal Answer: Plain Text Files in the Repo + Structured State Store

All four models converge on a hybrid approach. The key insight: **don't over-engineer with databases and vector stores, but don't under-engineer with a single massive file either.**

### The Optimal Stack

| Storage | What Lives Here | Why |
|---------|----------------|-----|
| **Project Manifest** (`PROJECT.md`) | Vision, principles, architecture overview, component status | Always loaded, <1000 tokens, single source of truth |
| **Structured State** (JSON/SQLite/Postgres) | Task status, phase, dependencies, verification results | Machine-parseable, drives state machine transitions |
| **Context Directory** (`.context/` or `.ai/`) | Architecture docs, task specs, decision records | Organized for retrieval, not human browsing |
| **Git Repository** | Actual source code, test results | Ultimate ground truth, never duplicated |
| **Knowledge Graph** (optional at scale) | File → function → dependency relationships | Enables "what breaks if I change this?" queries |

### Why Plain Files Win

- AI reads files directly — no query language, no ORM, no API calls
- Version control comes free via git
- Human can read and edit with any text editor
- Survives tooling changes — not locked into any system

### Why NOT Vector Stores (as primary)

- Project context is **structured** — you know where things are
- Vector stores return **approximately relevant** results — approximate is often wrong in codebases
- They can't represent state, relationships, or task progress

### The Hybrid Format

Individual files use **YAML frontmatter + Markdown body**:
```yaml
---
status: in_progress
dependencies: [AUTH-01, DB-02]
acceptance_criteria:
  - User can reset password via email
  - Token expires after 30 minutes
---

## Task: Password Reset Flow
[Rich narrative description and context here]
```

### Size Discipline

| File | Target Size |
|------|------------|
| Project Manifest | <1,000 tokens |
| Individual task files (completed) | <500 tokens |
| Architecture doc | <2,000 tokens |

> The context system isn't just storage — it's a **compression engine**. Its job is to maintain maximum useful understanding in minimum token footprint.

---
