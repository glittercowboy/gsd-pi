# The Handoff Problem: Agent → Human Maintainability

**The failure modes of AI-generated code** that all four models identify:

### Known Anti-Patterns

| Pattern | Problem | Fix |
|---------|---------|-----|
| **Flat code** | Everything in one function/file to reduce inconsistency risk | Enforce human-friendly modular patterns |
| **Clever solutions** | Dense functional chains (`filter().map().reduce().flatMap()`) | Max 3 chained operations; extract named intermediates |
| **Useless comments** | `// filter active users` above a filter call | Require *why* comments, skip *what* comments |
| **Over-abstraction** | Creates clever custom abstractions no human can follow | Enforce standard framework patterns over custom inventions |
| **Missing breadcrumbs** | No README files in directories, no ADRs, no diagrams | Include documentation in task completion checklist |

### The Architecture That Maximizes Handoff Quality

**Enforce well-known frameworks and conventions** over custom patterns. A codebase using standard Next.js/Express/React patterns is immediately navigable. A codebase with custom-invented patterns requires learning a new system.

### Verification Mechanism

**Automated readability test:** Periodically have a **separate agent** (with no knowledge of the building agent's decisions) attempt to add a feature using only the code and docs. If it struggles, a human will too.

### Gemini's "Boring Code" Principle

> Humans hate "clever" AI code; they love "boring" AI code. Run a **Complexity Linter** — if a function has cyclomatic complexity >10, the reviewer agent rejects it.

### Grok's Maintainability Checklist

Every file gets: auto-generated JSDoc/TS comments + ADR for every major decision. No magic numbers, no over-abstraction. Mandatory "maintainability score" (cyclomatic complexity + test coverage + comment density) in the critic node.

---
