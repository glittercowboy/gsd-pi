# Cross-Project Learning & Reusable Intelligence

### What Transfers Well

| Type | Transferability | Example |
|------|----------------|---------|
| **Problem-solving patterns** (abstract) | ✅ High | "When implementing OAuth, these are the common pitfalls and the architecture that avoids them" |
| **Code templates & scaffolding** | ✅ With adaptation | Proven auth module structure, tested payment integration pattern |
| **Learned pitfalls** | ✅ High | "When integrating Stripe, these edge cases around webhooks most implementations miss" |
| **Project-specific conventions** | ❌ Does not transfer | Architectural decisions are contextual |
| **Domain logic** | ❌ Does not transfer | Business rules are project-specific |

### The Optimal Architecture: A Pattern Library

Each pattern includes:
- Description of the problem it solves
- The approach and tradeoffs
- Common pitfalls
- Verification tests
- Reference implementation

### Growth Through Extraction, Not Manual Curation

When a task completes with high quality (first-attempt success, no subsequent modifications, clean review), flag it as a **candidate for pattern extraction.** A dedicated pass determines whether the solution embodies a generalizable pattern.

### The Critical Constraint

Patterns should be **descriptive, not prescriptive** — "here's an approach that has worked well, with these tradeoffs" not "always do it this way." Grok adds an overfitting guard: require **3+ project examples** before promoting to reusable.

---
