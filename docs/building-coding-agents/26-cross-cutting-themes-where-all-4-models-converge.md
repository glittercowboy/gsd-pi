# Cross-Cutting Themes (Where All 4 Models Converge)

### Original Themes (Reinforced)

These ideas appeared independently in all four conversations across both rounds, indicating the highest-confidence principles:

1. **The LLM should only do what requires judgment.** Everything deterministic belongs in code.
2. **Vertical slices are non-negotiable.** End-to-end working increments at every stage.
3. **Context leanness = quality.** Less (but more relevant) context produces better outputs than more context.
4. **Execution-based verification beats self-assessment.** Run the code. Trust test results over the model's opinion.
5. **The orchestrator is the product.** The model is a commodity; the system around it is the differentiator.
6. **State must be structured and deterministic.** Never let the LLM manage its own lifecycle or memory.
7. **Speed comes from removing unnecessary work.** Not from doing the same work faster.
8. **Failure recovery matters more than happy-path perfection.** Design the error paths first.
9. **Human involvement should be high-leverage.** Specific questions with context, not open-ended reviews.
10. **The system improves over time.** Track patterns, cache solutions, learn from failures.

### New Themes (From Grey Area Deep-Dives)

11. **Document assumptions, don't ask about every one.** Proceed with sensible defaults + transparent logging. Review at milestones, not in real-time.
12. **The codebase is the lossless source of truth.** Summaries are lossy caches that must be periodically reconciled against actual code. Never summarize summaries.
13. **Semantic conflicts are harder than syntactic ones.** Interface contracts must be behavioral specs, not just type signatures. Integration testing is a first-class concern, not an afterthought.
14. **Observe before modifying.** Especially in legacy codebases — the agent must understand existing patterns before changing them. Preserve local consistency over global ideals.
15. **Taste can be ~80-85% automated.** Convert subjective preferences to concrete, verifiable specs. Reserve human judgment for the remaining gestalt. The gap is closing fast with vision-capable models.
16. **Irreversible operations are categorically different.** The agent prepares; the human executes. No exceptions.
17. **"Boring" code is good code.** For handoff, enforce standard patterns, limit complexity, and write *why* comments. Automated readability testing catches problems before humans encounter them.
18. **Make rewrites cheap, not rare.** Clean interfaces + good tests + branch-based experimentation = rewriting is a safe, routine operation rather than a crisis.
19. **Route errors by type, not by severity.** Different error classes need different context, different handlers, and different escalation thresholds. Flaky tests should be quarantined, not fixed.
20. **The magic is the translation layer.** For non-technical users, the entire value proposition is the invisible bridge between human intent and technical execution. Every moment the user has to think like a developer is a failure.

---

*Generated March 2026. Updated with grey-area deep-dive synthesis. Source material: two rounds of parallel deep-dive conversations with Claude (Anthropic), Gemini (Google), GPT (OpenAI), and Grok (xAI) on optimal autonomous AI coding agent architecture — including the 13 hardest unsolved problems and designing for non-technical users.*
