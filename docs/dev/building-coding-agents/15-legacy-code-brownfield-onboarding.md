# Legacy Code & Brownfield Onboarding

**The fundamental difference:** Greenfield = design → implement. Brownfield = **observe → infer → validate → modify.**

### The Onboarding Pipeline (All 4 Models Agree)

#### Phase 1: Structural Analysis (Deterministic)
- Dependency graph mapping
- Module identification, LOC per component
- Test coverage analysis, entry point discovery
- Database schema mapping

#### Phase 2: Convention Extraction (LLM-Assisted)
- Sample representative files across modules
- Identify: error handling patterns, naming conventions, API structure, DB access patterns, testing patterns
- Output: a **conventions document** that becomes critical reference context

#### Phase 3: Pattern Mining
- Extract implicit "tribal knowledge" — workarounds for browser bugs, special customer cases, performance hacks that look like mistakes
- Generate decision records into project state

### The Cardinal Rules

| Rule | Why |
|------|-----|
| **Observe first, edit later** | Agents must never modify code they don't understand |
| **Preserve local consistency over global ideals** | Resist the "Junior Refactor" — don't "fix" legacy code to modern standards |
| **Add characterization tests before modifying** | Tests that document *current behavior*, not *correct behavior* |
| **Minimal, surgical modifications** | Refactoring is a separate task requiring explicit human approval |

### The Biggest Pitfall

The agent will try to refactor legacy code to match its sense of good patterns. Left unchecked, this produces massive diffs that change behavior in subtle ways. **Enforce strict rules:** modifications to legacy code should be minimal and surgical.

---
