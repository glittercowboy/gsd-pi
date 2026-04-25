---
name: design-an-interface
description: Produce 3+ radically different designs for a module, API, or interface, compare them in prose, and synthesize a recommendation. Use when asked to "design an interface", "shape this API", "design it twice", "explore module boundaries", or when planning a new deep module and the first idea is unlikely to be the best. Based on "Design It Twice" from A Philosophy of Software Design — the value is the contrast, not the first draft.
---

<objective>
Generate at least three radically different interface designs for a single module or API, present them sequentially, compare them honestly, and recommend one (or a hybrid). The goal is to surface the design space — not to pick fast. A small interface hiding significant complexity is a deep module; a large interface with thin implementation is a shallow one. Optimize for the former.
</objective>

<context>
This skill runs during planning — before `S##-PLAN.md` task decomposition, or mid-slice when a seam turns out to be more load-bearing than the roadmap assumed. It is not for picking between two libraries. It is for shaping the interface your own code will expose.

Typical invocation points:
- A slice plan says "add module X" and the shape of X is not obvious.
- Two callers are about to grow coupled to an interface that has not been designed on purpose.
- A refactor surfaces a seam that needs to be re-cut deliberately.
</context>

<core_principle>
**RADICALLY DIFFERENT, NOT VARIANTS.** Three designs with different method names are one design. Three designs that hide different things, expose different axes of control, or invert the caller/callee relationship are three designs. Enforce real divergence by assigning each sub-agent a constraint that would force a different shape.

**INTERFACE, NOT IMPLEMENTATION.** Do not estimate effort. Do not argue about how hard it is to build. Argue about how the interface behaves from the caller's side and what it hides internally.
</core_principle>

<process>

## Step 1: Gather requirements

Before spawning anything, answer in the conversation:

- What problem does the module solve?
- Who calls it? (other modules, external users, tests)
- What are the key operations?
- What constraints exist? (performance, compatibility, existing patterns)
- What should stay hidden inside vs be exposed?

If the user did not supply all of these, ask — one round, 1–3 questions max, per the ask-vs-infer rule.

## Step 2: Spawn parallel design agents

Use `Agent(subagent_type=general-purpose)` for 3–4 agents in one message so they run concurrently. Each agent gets the same requirements brief plus one divergent constraint:

- Agent 1: "Minimize method count — 1 to 3 entry points max."
- Agent 2: "Maximize flexibility — support many extension points and composition."
- Agent 3: "Optimize for the single most common caller — make the default case trivial and the advanced case possible."
- Agent 4 (optional): "Design around a ports-and-adapters boundary — interface is the port, concrete implementations are adapters."

Each agent returns:

1. Interface signature (types, methods, params)
2. One worked usage example showing a real caller
3. What complexity this design keeps internal
4. Trade-offs — what it's bad at

## Step 3: Present sequentially

Show the three designs one after another. Let the user read each before the next. Do not lead with the comparison — the value is in feeling the shape of each option first.

## Step 4: Compare in prose

After all three are on the page, compare them on:

- **Simplicity** — fewer methods and simpler params are easier to learn and harder to misuse
- **Depth** — small interface hiding significant complexity (good) vs large interface with thin implementation (bad)
- **Generality vs specialization** — does it cover the real use case without overfitting?
- **Efficiency of the shape** — does the interface let the implementation be efficient, or force awkward internals?
- **Misuse surface** — what can a caller do wrong?

Prose, not a table. Highlight where the designs diverge most sharply — that is where the interesting trade-off lives.

## Step 5: Recommend

Be opinionated. Pick one, or propose a hybrid that takes specific elements from multiple designs. State the reason in one paragraph. The user wants a strong read, not a menu.

## Step 6: Capture the decision

Once the user picks:

- Append to `.gsd/DECISIONS.md` with the chosen shape and the reason.
- If a slice is active, update `S##-CONTEXT.md` with the interface sketch.
- Do not write the implementation — that happens during execute.

</process>

<anti_patterns>

- **Three-variants-of-the-same-idea:** all three use a builder, all three return the same object, etc. Kill and re-spawn.
- **Implementation creep:** proposing file paths, call graphs, or internal data structures. Keep it at interface shape.
- **Skipping comparison:** presenting three designs and asking "which do you like?" The comparison is the whole skill.
- **Effort-based ranking:** "#2 is easiest to build" is not an interface argument. Rank by what the caller experiences.

</anti_patterns>

<success_criteria>

- [ ] 3+ genuinely different interface shapes were produced.
- [ ] Each design shows a real usage example, not a type signature in isolation.
- [ ] Trade-offs are named per design.
- [ ] A specific recommendation (or hybrid) is on the page with a reason.
- [ ] The decision is captured in `.gsd/DECISIONS.md` or the active `S##-CONTEXT.md`.

</success_criteria>
