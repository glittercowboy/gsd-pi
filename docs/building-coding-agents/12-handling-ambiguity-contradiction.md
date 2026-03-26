# Handling Ambiguity & Contradiction

**The universal consensus:** This is the highest-cost failure mode. An agent confidently building the wrong thing based on a reasonable-but-incorrect interpretation burns hours of work discovered only at milestone reviews.

### The Three-Layer Strategy (All 4 Models Agree)

#### Layer 1: Classification of Ambiguity Type

Every requirement should be classified during planning:

| Classification | Action |
|---------------|--------|
| **Clear and actionable** | Proceed autonomously |
| **Ambiguous but decidable with sensible defaults** | Proceed + document assumptions |
| **Genuinely unclear or contradictory** | Halt and escalate to human |

> The middle category is where most real work lives. "The user should be able to reset their password" has a hundred implied decisions. A good agent resolves these with sensible defaults and **documents the assumptions it made** — it doesn't ask about every one.

#### Layer 2: The Assumption Ledger

Every task completion includes an `assumptions.md` update listing every interpretive decision the agent made:

```json
{
  "assumptions": [
    "Password reset tokens expire after 30 minutes (common security practice)",
    "Email delivery, not SMS",
    "No password history check"
  ],
  "confidence": 0.82
}
```

The human reviews these at **milestones, not in real-time** — preserving speed while maintaining correctness.

#### Layer 3: Contradiction Detection Pass

Before execution begins, a **dedicated reasoning pass** (separate from planning) scans for conflicts:
- Do requirements contradict each other?
- Do acceptance criteria conflict with stated architecture?
- Are there implicit assumptions in one requirement that violate another?

### Escalation Threshold

- **Impact confined to current task** → decide and document
- **Impact touches interface contracts** → escalate (wrong interpretation cascades)

Grok adds a **"Multi-Hypothesis Planning"** approach: when underspecification is detected, generate three distinct "Intent Hypotheses" (The Minimalist Path, The Scalable Path, The Feature-Rich Path). If the semantic distance between them exceeds a threshold, hard-halt and present a decision matrix to the human.

### The Deepest Pitfall

Models don't naturally express uncertainty — they pick an interpretation and run with it as if it's obviously correct. The system prompt must explicitly instruct confidence-level flagging, and the orchestrator must treat low-confidence decisions differently from high-confidence ones.

> **Proven result:** Grok reports this pattern cuts wrong-path rework by ~65% in 2026 evaluations.

---
