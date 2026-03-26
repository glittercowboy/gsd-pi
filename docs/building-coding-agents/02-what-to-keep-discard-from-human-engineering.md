# What to Keep & Discard from Human Engineering

### KEEP & Amplify

| Practice | Why It Matters More for AI |
|----------|---------------------------|
| **Clear product intent & experience specs** | AI needs direction, not instructions. "How should it feel?" drives architecture. |
| **Acceptance criteria as the backbone** | Becomes TDD at its logical extreme — human writes tests in natural language, AI makes them true. |
| **Vertical slicing** | Even more critical — prevents AI from going deep down a wrong path fast and confidently. |
| **Interface-first approach** | Creates natural checkpoints, makes systems modular and replaceable. |
| **Explicit constraints & non-functional requirements** | Narrows the search space. Without them AI may produce technically correct but strategically wrong systems. |
| **Architecture Decision Records (ADRs)** | Prevents AI from "accidentally" undoing decisions made weeks ago. |
| **Feedback loops** | Build → test → observe → refine. Accelerated to machine speed. |

### DISCARD

| Practice | Why It's Dead Weight |
|----------|---------------------|
| **Estimation rituals** (story points, velocity, sprint planning) | AI doesn't get tired, doesn't context-switch, works at machine speed. |
| **Communication overhead** (standups, design reviews, PR reviews) | Only one communication channel matters: human ↔ agent. |
| **Manual code review for style** | Automated linting + formatting handles this deterministically. |
| **Step-by-step instructions** | Provide outcomes, not "how." |
| **Heavy upfront documentation** | AI can read the entire repo instantly. Document *intent* and *why*, not *how*. |
| **Gradual skill-building** | No ramp-up, no knowledge silos, no "only Sarah knows how that module works." |
| **Defensive architecture against human error** | Tests still needed, but for a different reason: verifying AI's interpretation of intent. |

### The New Human Role

| Responsibility | Description |
|---------------|-------------|
| **Defining "good"** | Vision, personas, experience specs, success metrics |
| **Taste & judgment** | Aesthetics, emotional experience, brand voice |
| **Strategic decisions** | Which problems matter, product pivots |
| **Gut checks at milestones** | Does this *feel* right? |

> **The core shift:** Human = intention + taste. AI = exploration + execution.

---
