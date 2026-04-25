---
name: grill-me
description: Relentless sequential interview that stress-tests a plan or design until every decision branch is resolved. Use when the user wants to "grill me", "stress-test the plan", "interrogate my design", "resolve the decision tree", or whenever a plan feels hand-wavy, under-specified, or carries hidden coupling that planning phases must surface before execution. Pairs with the discuss phase and blocks execution until alignment is reached.
---

<objective>
Interview the user one question at a time until every material branch of the decision tree is resolved and you both share one mental model of the plan. Output is not a document — it is alignment. Surface hidden assumptions, kill fuzzy language, and walk the dependencies between decisions instead of asking everything in parallel.
</objective>

<context>
Planning conversations in GSD ship to `M###-CONTEXT.md`, `S##-CONTEXT.md`, or `.gsd/DECISIONS.md`. Those artifacts are only as good as the interview that produced them. This skill is the interview. It runs during the `discuss` phase, after `research`, or any time a plan has open branches the user has not actually thought through.

Use this skill when:
- The user asks to be grilled, stress-tested, or interrogated
- A plan reads like a list of happy paths with no failure modes
- Two or more sections of a plan implicitly depend on one undecided choice
- The user says "I think" or "probably" about something that will bind the design
</context>

<core_principle>
**ONE QUESTION AT A TIME.** Parallel questions destroy dependency order — the answer to Q2 is often contingent on the answer to Q1, and asking both at once forces the user to reason about a combinatoric space instead of a single fork. Ask, wait, absorb, ask the next.

**RECOMMEND AN ANSWER.** Every question ships with your recommendation and a one-line reason. The user's job is to confirm, override, or redirect — not to generate answers from scratch.

**CODEBASE BEFORE QUESTION.** If the answer exists in the repo — a convention, an existing pattern, a prior decision — find it and cite it rather than asking.
</core_principle>

<process>

## Step 1: Map the decision tree silently

Before asking anything, read what the user has already said in this conversation plus any existing `M###-CONTEXT.md`, `S##-CONTEXT.md`, and `.gsd/DECISIONS.md`. Build a private list of every decision the plan depends on, in dependency order. Do not show this list — it is scaffolding.

If the plan touches unfamiliar code, spawn `Agent(subagent_type=Explore)` in parallel to map the relevant modules while you prepare Question 1. Do not wait for it to finish before starting the interview.

## Step 2: Ask Question 1

Pick the root decision — the one that the most other decisions depend on. Format:

```text
**Q1:** <precise question>.

**Recommendation:** <your pick>, because <one sentence>.

Alternatives worth considering: <A | B | C>.
```

Stop. Wait for the answer.

## Step 3: Absorb and branch

Take the answer. If it kills branches of the tree, cross them off your private map. If it opens new branches, add them. Do not move on to Q2 until the current answer has been integrated. If the answer is ambiguous, ask one clarifying follow-up — not three.

## Step 4: Continue until the tree is closed

Repeat Q2, Q3, … in dependency order. Each question follows the same format (question, recommendation, alternatives). Cap at the natural end of the decision tree, not a round number.

Stop the interview when:
- Every remaining open decision is either deferred by explicit user choice ("decide at execution time") or out of scope
- The user says to stop
- You have nothing left where the answer would materially change the plan

## Step 5: Offer to write it up

At the end, offer the user one of:

1. Append resolved decisions to `.gsd/DECISIONS.md` (one line each, dated).
2. Write or update `M###-CONTEXT.md` or `S##-CONTEXT.md` for the active milestone/slice.
3. Draft a GitHub issue via `mcp__github__issue_write` (only with explicit confirmation per the outward-action rule).
4. Leave it as conversation context if the work is ephemeral.

Default: ask which they want. Do not auto-write.

</process>

<anti_patterns>

- **Parallel questions:** "What's the schema? And the API? And the auth model?" — ask one.
- **Yes/no railroading:** "Should we use X?" instead of "Between X and Y, which fits — given Z constraint?"
- **Recommendation-free questions:** forces the user to generate from scratch; you have more context than you think.
- **Asking what the code already answers:** check the repo first.
- **Grilling past the useful horizon:** if the next question is about an implementation detail that will be decided during execution, stop.

</anti_patterns>

<success_criteria>

- [ ] Every decision with cross-cutting impact has an answer.
- [ ] No "probably", "I think", or "we'll figure it out" remains on load-bearing decisions.
- [ ] The user has confirmed the shape of the plan, not just each individual answer.
- [ ] Resolved decisions are captured in an enduring artifact or explicitly left ephemeral.

</success_criteria>
