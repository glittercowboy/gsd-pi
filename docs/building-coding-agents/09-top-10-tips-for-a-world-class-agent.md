# Top 10 Tips for a World-Class Agent

### 1. The Orchestrator Is the Product, Not the Model
The model is a commodity. Two teams using the same model produce wildly different results based on orchestration quality. Invest 70% of effort in the orchestrator, 30% in prompt engineering.

### 2. Context Assembly Is a Craft
Profile your context like you'd profile code. Measure which context elements correlate with first-attempt success. Prune relentlessly. The right files, in the right order, with the right framing, at the right level of detail.

### 3. Make the Feedback Loop the Fastest Thing
Treat feedback loop latency like a game engine treats frame rate. Incremental builds, targeted tests, pre-warmed servers, cached deps. Put it on a dashboard you look at every day.

### 4. Build First-Class Error Recovery Into Every Layer
Retry with variation (never the same way twice), automatic rollback, structured escalation, ability to park blocked tasks. **Design failure paths first** — they'll get more use than you expect.

### 5. Verify Through Execution, Not Self-Assessment
An agent that asks itself "is this correct?" says yes 90% of the time regardless. Run the code, observe results, get ground truth. Self-assessment supplements execution-based verification, never replaces it.

### 6. Return Structured, Actionable Data from Every Tool
Don't return raw terminal output. Return structured objects: what passed, what failed, where, why. Remove cognitive load from the model — it directly translates to better decisions.

### 7. Use a DAG, Not a Flat List
Explicit inputs, outputs, dependencies, acceptance criteria per task. Maximizes parallelism, identifies critical path, enables smart impact tracing when things change.

### 8. Keep the Manifest Small and Always Current
One file, <1000 tokens, always included. Updated automatically after every task completion. If it drifts from reality, everything downstream suffers.

### 9. Build Observability From Day One
Log every LLM call. Track iterations per task type, token usage, failure rates, first-attempt success rates. This is your training data for improving the orchestrator. Teams that instrument well improve 10x faster.

### 10. Make Human Touchpoints High-Leverage and Low-Friction
Present specific questions with context, not walls of text. "The API could return nested or flat fields — which fits your vision?" is a 5-second decision. "Please review everything" takes 20 minutes.

---
