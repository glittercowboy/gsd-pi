**Working directory:** `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT `cd` to any other directory.

Run **project-level domain research** in 4 parallel dimensions. Read `.gsd/PROJECT.md` and `.gsd/REQUIREMENTS.md` first — they define the scope of what to research. Then spawn 4 parallel `Task` calls (one per dimension), each writing its findings to `.gsd/research/`. This stage runs ONCE per project, after `discuss-requirements` and the `research-decision` gate, before any milestone-level work.

**Structured questions available: {{structuredQuestionsAvailable}}**

---

## Stage Banner

Print this banner verbatim in chat as your first action:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► RESEARCHING (project)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Then say: "Spawning 4 research agents in parallel: stack, features, architecture, pitfalls."

---

## Pre-flight

1. Read `.gsd/PROJECT.md` end-to-end. Extract: domain, vision, current state, milestone sequence.
2. Read `.gsd/REQUIREMENTS.md` end-to-end. Extract: Active requirement classes (focus research on what the project must deliver).
3. `mkdir -p .gsd/research/`

If either file is missing, STOP and emit: `"PROJECT.md or REQUIREMENTS.md missing — research-project cannot run."`

---

## Fan-out

Issue **4 `Task` tool calls in a single assistant response** (one tool block containing four `Task` invocations). The tool runtime executes them concurrently — that is the parallelism mechanism here. Do not split them across multiple turns; do not chain them sequentially. After issuing the four calls, wait for ALL of their tool results to come back before doing anything in the "After fan-out completes" step below.

Each task gets its own focused prompt. Each task writes one file.

### Task 1 — Stack research → `.gsd/research/STACK.md`

Prompt:

> Research the standard stack for [domain] in 2026. Identify the dominant libraries, frameworks, runtimes, and infrastructure tools used by [domain] products. For each: current stable version, primary alternatives, why teams pick it, when to avoid it.
>
> Constraints from PROJECT.md: [list any tech constraints / required frameworks the user already specified].
>
> Deliverable: `.gsd/research/STACK.md` with sections:
> - **Recommended Stack** (with versions and rationale)
> - **Alternatives Considered** (and why not)
> - **What NOT to use** (and why)
> - **Open questions** (anything where the user's choice will materially shape the architecture)
>
> Use `resolve_library` / `get_library_docs` for library docs. Use web search sparingly (2–3 queries). Cite sources where versions matter. Mark confidence per recommendation: high / medium / low.

### Task 2 — Features research → `.gsd/research/FEATURES.md`

Prompt:

> Research what features [domain] products typically have. Categorize as **table stakes** (users expect this; missing it breaks the product) vs **differentiators** (compelling but optional).
>
> Active requirements from REQUIREMENTS.md to cross-check: [list R### IDs and titles].
>
> Deliverable: `.gsd/research/FEATURES.md` with sections per category (Authentication, Content, Notifications, etc.):
> - **Table stakes** — bullet list of expected capabilities, with one-sentence justification each
> - **Differentiators** — bullet list of optional capabilities
> - **Anti-features** — what successful [domain] products explicitly avoid
> - **Cross-check vs REQUIREMENTS.md** — which active requirements are covered, which features are missing from REQUIREMENTS, which REQUIREMENTS look excessive
>
> Use web search to surface 3–5 representative competitors / examples in the space. Don't go deep — aim for coverage breadth.

### Task 3 — Architecture research → `.gsd/research/ARCHITECTURE.md`

Prompt:

> Research the typical architecture for [domain] products at the project's scale. Surface common patterns, data models, integration points, and scaling considerations.
>
> Vision/scale signals from PROJECT.md: [extract scale-relevant phrases — solo / small team / enterprise / planned user count].
>
> Deliverable: `.gsd/research/ARCHITECTURE.md` with sections:
> - **Recommended Architecture** — diagram-friendly description (data flow, services, key boundaries)
> - **Data Model Sketch** — core entities, relationships, where state lives
> - **Integration Points** — external services typically required (auth, payments, email, etc.)
> - **Scaling Tier** — what works at this project's scale, what to defer
> - **Reversibility risk** — which architectural choices are hardest to walk back later
>
> Use `resolve_library` for library-specific architecture docs. Mark confidence per recommendation.

### Task 4 — Pitfalls research → `.gsd/research/PITFALLS.md`

Prompt:

> Research common failure modes, gotchas, and footguns for [domain] products. Things experienced builders wish they'd known earlier.
>
> Project type from PROJECT.md: [greenfield / brownfield / migration].
>
> Deliverable: `.gsd/research/PITFALLS.md` with sections:
> - **Domain Pitfalls** — failure modes specific to this domain (e.g., for auth: session fixation, password reset flows, token rotation)
> - **Stack Pitfalls** — known footguns of the recommended stack from STACK.md (or domain norm if STACK isn't ready)
> - **Scope Traps** — features that look small but are huge ("just add notifications", "just add search")
> - **Compliance / Security gotchas** — surfaces where regulators or attackers tend to bite
> - **Migration pitfalls** (only if brownfield) — common breakage when retrofitting [domain] capability into existing systems
>
> Web search for postmortems, incident reports, and "lessons learned" content. Sources matter — prefer specific writeups over generic listicles.

---

## After fan-out completes

Once all 4 tasks return:

1. Verify all 4 files exist: `STACK.md`, `FEATURES.md`, `ARCHITECTURE.md`, `PITFALLS.md` in `.gsd/research/`. If any are missing, retry that task once.
2. Print a concise summary in chat: one sentence per dimension, what each found.
3. Say exactly: `"Project research complete."` — nothing else.

---

## Critical rules

- **Issue all 4 `Task` calls in a single assistant response** (one block of four tool calls). The tool runtime parallelizes them; do NOT chain them across turns or await them individually.
- **Each task writes exactly one file** to `.gsd/research/`. No cross-writes.
- **Research is informational, not prescriptive** — it surfaces options; the user / requirements stage already chose what to build.
- **Stay within scope** — don't research milestones or slices. That's a different stage.
- **Budget:** ~3–5 web searches per dimension. Prefer `resolve_library` / `get_library_docs` for library questions.
- If any task fails twice, write a placeholder `.gsd/research/{DIMENSION}-BLOCKER.md` with the failure reason and continue. Do not block project progress on research failures.
