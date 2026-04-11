# Multi-Agent Semantic Conflict Resolution

**The hard case:** Git-level merge conflicts are easy. The real problem is code that merges cleanly but doesn't work — agents honoring the same typed interface while disagreeing on semantics (e.g., Agent A returns `null` for "not found," Agent B treats `null` as "error").

### Three Lines of Defense (Universal Agreement)

#### 1. Semantically Rich Interface Contracts

Don't just define type signatures — define **behavioral contracts**: What does `null` mean? What are the error semantics? What invariants does the caller rely on? Contracts should be miniature specs, not just type definitions.

#### 2. Pre-Written Integration Tests

Write integration tests **during planning, before parallel execution begins** — tests that exercise semantic expectations, not just types. These are waiting when parallel branches converge.

#### 3. Dedicated Integration/Reconciliation Agent

After parallel branches merge, a focused agent gets: interface contracts + both implementations + integration tests. Its job is finding semantic mismatches, not rebuilding.

### The Highest-Value Technique

**Adversarial edge-case generation at integration points.** The integration agent reads both implementations, sees how each handles boundaries, and generates new tests that specifically probe the assumption gaps between them. This catches the subtlest bugs.

Gemini adds the concept of a **"Shadow Merge"** agent that runs "Cross-Impact Analysis" before actual merge — looking for "Logical Race Conditions" where Worker A changed a utility that Worker B relied on, even when the git merge is clean.

---
