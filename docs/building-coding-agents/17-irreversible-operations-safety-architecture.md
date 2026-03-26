# Irreversible Operations & Safety Architecture

**The core principle (universal agreement):** Irreversible operations should **never be executed by the agent.** The agent prepares them; the human executes them.

### Risk-Graded Action Classification

| Class | Examples | Policy |
|-------|----------|--------|
| **Reversible** | Code edits, UI changes, unit tests | Full autonomy + auto-revert on failure |
| **Semi-Reversible** | New files, dependencies | Auto-execute + git checkpoint |
| **Irreversible** | DB migrations, external API changes, data transformations | Human-in-the-loop required |
| **External Side-Effect** | Payment charges, third-party API calls with side effects | Human approval + dry-run + rollback plan |

### Per-Operation Protocols

| Operation | Agent Does | Human Does |
|-----------|-----------|-----------|
| **Database migrations** | Write migration + rollback + tests, run against test DB, produce review package | Review package, execute migration |
| **External APIs** | Build + test against sandbox/mock versions | Switch from sandbox to production |
| **Deployment** | Produce artifacts, verify in staging | Trigger production deployment |

### The Classification Must Be:
- **Static and deterministic** (not left to the agent's judgment)
- **Conservative** (if there's doubt, classify as irreversible)
- **Enforced by the orchestrator** (the agent never encounters an irreversible operation without interception)

### The Subtlety Most Miss

Data transformations that technically don't delete anything but **lose information through reformatting**. Converting a nullable column to non-nullable with a default value permanently destroys the distinction between rows that had real values and rows that got the default. These must be flagged with the same severity as deletions.

---
