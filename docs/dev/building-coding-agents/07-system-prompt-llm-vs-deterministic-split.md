# System Prompt & LLM vs Deterministic Split

### The Core Separation Principle

> If you could write an if-else statement that handles it correctly every time, **it should not be in the LLM's context**. Every token the model spends reasoning about something deterministic is wasted and introduces hallucination risk.

### What the LLM Owns

| Capability | Why LLM |
|-----------|---------|
| Understanding intent | Interpretation, judgment |
| Architectural reasoning | Weighing tradeoffs |
| Code generation | Creative, context-dependent |
| Debugging & diagnosis | Abductive reasoning, hypothesis formation |
| Self-critique & quality assessment | Judgment calls |

### What TypeScript/Deterministic Code Owns

| Capability | Why Deterministic |
|-----------|-------------------|
| State machine transitions | Typed state object, no ambiguity |
| Context assembly | Predict + pre-load what agent needs |
| File operations | Validate paths, handle encoding, manage permissions |
| Test execution & result parsing | Structured results, not raw terminal output |
| Build & environment management | Install deps, start servers, manage ports |
| Code formatting | Run prettier automatically, never waste LLM tokens |
| Task scheduling & dependency resolution | Graph traversal, instant vs 5-second LLM call |
| Summarization triggers | Mechanical workflow, LLM provides content |

### Modular System Prompt Architecture

```
Base Layer (always present, ~500 tokens)
  → Identity, core behavioral rules, general approach
  
Phase-Specific Layer (swapped based on state)
  → Planning mode: decomposition, interfaces, risks
  → Execution mode: implementation, testing, iteration
  → Debugging mode: diagnosis, hypothesis testing, isolation

Task-Specific Layer (assembled fresh per task)
  → Current spec, acceptance criteria, relevant contracts, prior attempts

Tools Layer
  → Available tool definitions and parameters
```

### Tool Design Philosophy

> Each tool should do one thing, do it completely, and return structured results the LLM can immediately act on.

**Bad:** LLM calls `readFile` → `parseJSON` → `runCommand` (3 calls, 3 failure points)  
**Good:** LLM calls `runTests(filter)` → gets structured pass/fail with locations (1 call, clean result)

### Essential Tools

| Tool | Returns |
|------|---------|
| `runTests` | Structured results: pass count, fail count, per-failure details |
| `readFiles` | Batched file contents (array of paths, not one at a time) |
| `writeFile` | Auto-formats before writing |
| `searchCodebase` | Grep-like results with file paths and line numbers |
| `getProjectState` | Manifest + current task spec + related task statuses |
| `updateTaskStatus` | Handles downstream state updates automatically |
| `buildProject` | Structured errors with file paths and line numbers |
| `browserCheck` | Screenshot or structured description of rendered output |
| `commitChanges` | Enforces conventions, runs pre-commit hooks |
| `revertToCheckpoint` | Rolls back to last known good state |

### Prompt Patterns That Maximize Agency

1. **Tell it what it CAN do, not what it can't.** "Full authority as long as acceptance criteria and tests pass."
2. **Explicit permission to iterate.** "First attempt doesn't need to be perfect. Write, run, observe, improve."
3. **Clear exit conditions.** Concrete, measurable, unambiguous definition of "done."
4. **Built-in scratchpad.** "Write reasoning in thinking blocks. Track attempts and outcomes."
5. **Recovery protocol.** "After 3 failed approaches, produce structured escalation."

### The Meta-Principle

> Your TypeScript orchestrator is the deterministic skeleton — workflow, state, context, tools, coordination. The LLM is the reasoning muscle — understanding, creativity, judgment, problem-solving. **Neither should do the other's job.** When you get this right, the LLM becomes dramatically more capable because it's only doing what it's good at, with exactly the context it needs.

---
