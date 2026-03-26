# Error Taxonomy & Routing

**The key insight:** Different errors have fundamentally different causes and optimal resolution strategies. Treating them uniformly is one of the biggest sources of wasted iterations.

### The Optimal Taxonomy

| Error Class | Context Needed | Optimal Handler | Escalation |
|-------------|---------------|-----------------|------------|
| **Syntax/Type** | Error message + offending file + types | Deterministic fast path (no LLM needed) | Only if fast path fails |
| **Logic** | Failing test (expected vs actual) + implementation + spec | LLM with medium, focused context | After 3 attempts |
| **Design** | Original spec + architecture + interface contracts + implementation | LLM with broad context | Often needs human input |
| **Performance** | Profiling data + benchmarks + code | Specialist optimization agent | If regression >2x |
| **Security** | Static analysis results + secure pattern reference | Conservative fix prompt | Always flag for review |
| **Environment** | Environment config + recent dep changes + error output | Specialized env context | If not auto-resolved |
| **Flaky Tests** | Run test multiple times to confirm flakiness | Quarantine, don't fix | Infrastructure agent |

### Critical Routing Rules

- **Flaky tests:** Detect by running failing tests multiple times. If inconsistent, **quarantine** — never trigger a fix cycle.
- **Environment errors:** Classify as potentially environmental when they appear in build/startup rather than tests.
- **Security:** Caught by static analysis in the deterministic layer, not by the LLM. Run security linting after every task.
- **Syntax/Type:** Hit a deterministic fast path first. Missing import? Search codebase for the export. Only escalate to LLM if mechanical fix fails.

### The Architecture

The orchestrator classifies every error → selects the appropriate context assembly strategy → optionally selects a different prompt framing. The agent experiences this as *"I got exactly the information I need"* rather than *"I got a dump of everything."*

---
