# God-Tier Context Engineering

### The Core Principle

> God-tier context engineering treats the context window as a **designed experience for the model**, not as a bucket you throw information into. The context window is the UX of your agent. Design it accordingly.

### The 10 Commandments of Context Engineering

#### 1. The Pyramid of Relevance
- **Sharp focus:** Active files at full detail
- **Present but compressed:** Interface contracts, manifest, task definition
- **Summarized or absent:** Other components' internals, completed task histories

Each tier has a token budget. If full-resolution tier is large, outer tiers compress harder.

#### 2. Context Is a Cache, Not a History
Treat it like a CPU cache: holds exactly what's needed now, everything else evicted. The question isn't "what has happened" but "what does the model need to see right now?"

#### 3. Separate Reference from Instruction
- **Instruction context** (what to do) → beginning and end of prompt (highest attention)
- **Reference context** (helpful info) → middle, clearly delineated

Manage them independently. Compress reference aggressively while keeping instructions at full detail.

#### 4. Earn Every Token's Place
Implement a token budget system:

| Category | Budget |
|----------|--------|
| System prompt + behavioral instructions | ~15% |
| Manifest | ~5% |
| Task spec + acceptance criteria | ~20% |
| Active code files | ~40% |
| Interface contracts | ~10% |
| Reserve (tool results, errors) | ~10% |

When any category exceeds budget, intelligently summarize (not truncate).

#### 5. Write for the Model's Attention Pattern
- Critical info at the very beginning and reiterated at the end
- Structured blocks with clear headers and delimiters
- Consistent formatting conventions

```
TASK: Implement password reset flow
STATUS: New
DEPENDS ON: auth-module (complete), email-service (complete)
ACCEPTANCE CRITERIA:
- User can request reset via email
- Token expires after 30 minutes
- New password meets existing validation rules
- All existing auth tests pass
RELEVANT INTERFACES: [below]
ACTIVE FILES: [below]
```

#### 6. Compress at Every State Transition
- Task completion → 50–100 token completion record
- Use a **dedicated summarization call** with a tight prompt (not the working agent self-summarizing)
- **Cascading summarization:** Task summaries → milestone summaries → phase summaries (5:1 compression ratio at each level)

#### 7. Use the Filesystem as Your Infinite Context Window
- Organize files for retrieval, not human browsing
- Predictable naming conventions = instant lookup
- Essentially a custom database on top of the filesystem

#### 8. Profile Context Quality, Not Just Size
Track first-attempt success rate as a function of context composition. What was in context when it succeeded vs failed? Let data guide what constitutes high-quality context.

#### 9. Dynamic Context Based on Task Phase
Different phases need different context:

| Phase | Optimal Context |
|-------|----------------|
| Understanding | Spec, acceptance criteria, broad architectural context |
| Implementation | Active files, interface contracts, coding patterns |
| Debugging | Failing test output, relevant code, test code |
| Verification | Acceptance criteria prominently, ability to exercise feature |

#### 10. Design for Context Recovery
- **Checkpoint** context state at task starts and phase transitions
- On detected confusion (repeated failures, increasing iterations, off-task output): **roll back to checkpoint** and re-enter with fresh context + concise failure info + strategy hint
- Structured recovery ≠ naive retry. It rebuilds context from scratch with learned information.

### The God-Tier Strategy in One Sentence

> Orchestrator-assembled minimal slice + persistent hierarchical memory. Every single LLM call stays 8k–25k tokens while the agent has perfect knowledge of a 500k-line codebase and months of project history.

---

---

# Part II: The Hard Problems (Grey Area Synthesis)

> Synthesized from a second round of deep conversations with all four models, targeting the 13 hardest unsolved problems in autonomous coding agents — plus a critical question on accessibility for non-technical users.

---
