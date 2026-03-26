# Top 10 Pitfalls to Avoid

### 1. Putting Workflow Logic in the Prompt
Control flow belongs in TypeScript with actual conditionals and state tracking. Prompts that describe workflows are fragile, inconsistently followed, and impossible to debug with a debugger.

### 2. Unbounded Context Accumulation
Each iteration adds noise. After 7 iterations, context is bloated with stale information from attempts 1–5. **Carry forward only current state and most recent error.** Summarize or discard everything else.

### 3. Trusting the Model's Self-Assessment of Completion
Models are biased toward completion. Never let the model be the sole judge. Use deterministic checks: tests pass, it builds, acceptance criteria have corresponding passing tests.

### 4. Over-Engineering Tools Before Understanding Workflows
Start with a small general-purpose set (file read/write, execute command, run tests). Watch where the agent struggles in real tasks. Then build specialized tools to solve observed problems.

### 5. Neglecting the Cold-Start Problem
The first task is fundamentally different from the twentieth. Use deterministic templates for project scaffolding, conventions, and test infrastructure before handing off to the agent.

### 6. Too Much Autonomy Too Early
An agent going slightly wrong for 2 hours produces a mountain of throwaway code. Start with more checkpoints than needed. Earn autonomy incrementally for proven task types.

### 7. Ignoring Compounding Inconsistency
Different naming, different patterns, different structures across files = technical debt that confuses the agent itself later. Enforce consistency through linting or by showing existing examples before new code.

### 8. Building for the Demo, Not the Recovery
The demo is the happy path. The product is what happens when tests fail, builds break, APIs change. **Spend 2x as much time on failure/recovery paths.** The agent spends more time recovering than succeeding first-attempt.

### 9. Treating All Tasks as Equally Complex
Simple utility functions and complex state management shouldn't go through the same workflow. Classify by complexity. Simple tasks get a fast path. Complex tasks get the full treatment.

### 10. Not Measuring What Actually Matters
Don't just track tokens and costs. Measure: first-attempt success rate, iterations to completion, human intervention frequency, code survival rate (does it survive the next 3 tasks?), stuck-detection accuracy. These guide real improvement.

---
