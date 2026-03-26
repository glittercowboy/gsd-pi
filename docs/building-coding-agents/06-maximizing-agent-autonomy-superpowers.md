# Maximizing Agent Autonomy & Superpowers

### The Foundational Insight

> Autonomy comes from **self-correction**, not from getting it right the first time. The power isn't in the initial generation — it's in iteration speed and feedback signal quality.

### The Essential Tool Arsenal

| Category | Tools | Why |
|----------|-------|-----|
| **Execution Environment** | Terminal, filesystem, git, package manager | Closes the write → run → debug → verify loop |
| **Verification** | Test runner, linter, type checker, security scanner | Ground truth over self-assessment |
| **Observation** | Logs, browser/renderer, performance profiler | Sees what users would see |
| **Exploration** | Code search, documentation lookup, web research | Self-directed learning |
| **Recovery** | Git revert, branch management, checkpoints | Safety net that enables boldness |

### Self-Verification Architecture

Every task completion should self-evaluate against a checklist:
1. Does the code compile?
2. Do all existing tests still pass?
3. Do new tests pass?
4. Does the application actually start?
5. Can I exercise the feature and see expected behavior?
6. Does this match acceptance criteria point by point?

### Debugging Superpowers

- **Temporary instrumentation:** Add logging, remove after diagnosis
- **Bisection:** Walk back through changes to find where regression was introduced
- **Minimal reproduction:** Strip away everything except exact conditions that trigger failure
- **Exploratory tests:** Quick throwaway scripts to test hypotheses

### Meta-Cognitive Layer

- **Scratchpad:** External reasoning space to track hypotheses, attempts, and outcomes
- **Stuck detection:** After N failed attempts, trigger step-back with fresh context and explicitly different approach
- **Structured escalation:** "Here's what I'm trying, here's what I've tried, here's what I think the issue is, here's what I need from you"

### The Philosophy

> You're not trying to build an agent that doesn't make mistakes. You're building one that **catches and fixes its own mistakes faster than a human would notice them**. Not intelligence — **closed-loop execution with rich feedback**.

---
