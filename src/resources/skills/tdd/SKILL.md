---
name: tdd
description: Test-driven development with red-green-refactor loops built around vertical slices (tracer bullets), not horizontal layers. Use when asked to "use TDD", "write test-first", "red-green-refactor", "build this with tests", or whenever a feature has a clear observable contract and would benefit from tests that outlive refactors. Complements the bundled test and add-tests skills — use this for the discipline, use those for the mechanics.
---

<objective>
Drive feature implementation through one red-green-refactor cycle per vertical slice. Each cycle produces a single failing test that pins one observable behavior, then the minimal code that makes it pass, then refactoring while GREEN. Never refactor while RED. Never write all tests up front.
</objective>

<context>
GSD already organizes work into slices (S##) and tasks (T##). This skill operates at the task level — inside a single T##-PLAN.md, it structures the execution as a sequence of tiny red-green-refactor cycles rather than write-all-then-test or write-all-without-tests.

Invocation points:
- Task plan calls out behavior with a clear external contract (pure function, API endpoint, module boundary)
- Bug fix — write the failing repro test first, then fix
- Refactor into a new module — write the tests against the new interface first

Do not use this skill for:
- Exploratory spikes (use `/gsd start spike` — no production code ships)
- Pure UI polish where visual verification beats unit tests
- Scripts that run once and are deleted
</context>

<core_principle>
**TESTS VERIFY BEHAVIOR THROUGH PUBLIC INTERFACES, NOT IMPLEMENTATION DETAILS.** A good test reads like a specification and survives refactors. A test that mocks internals or asserts private state fails every time you clean up the code — that is a bad test pretending to be a good one.

**VERTICAL SLICES, NOT HORIZONTAL LAYERS.** Writing all tests upfront ("horizontal slicing") produces tests for behavior you imagined, not behavior the code actually exhibits. One tracer bullet at a time: write one test, make it pass, learn, write the next.

**NEVER REFACTOR WHILE RED.** Refactoring without a passing test means you are guessing whether you broke something. Get to green first. Then clean up. Then go red again for the next slice.
</core_principle>

<process>

## Step 1: Confirm the interface

Before writing anything:

1. What is the public interface? (function signature, HTTP route, module exports)
2. Which behaviors matter most? List them in order of how badly you'd want to know if they broke.
3. What does a "caller" look like? Write one example call in prose.

If the user has not supplied these, ask — one round, 1–3 questions.

## Step 2: Tracer bullet

Pick the first behavior — usually the happy path for the most common input. Write one test that exercises it end-to-end through the public interface. Run it. It must fail (RED). If it passes, the test is not testing what you think it is — fix the test before writing any code.

Then write the minimum code to make it pass. "Minimum" means: if hard-coding `return 42` makes the test pass, hard-code `return 42`. You will generalize on the next cycle. Run the test. It must pass (GREEN).

This proves the end-to-end path works — test harness, imports, wiring, build. Everything from Step 3 onward is incremental.

## Step 3: Red-green loop

Pick the next behavior. Write one test that pins it. Run — RED. Write the minimum code that makes it pass without breaking prior tests. Run — GREEN.

Guidelines for picking the next behavior:

- Alternate happy-path-variant and edge-case tests — don't do all happy paths then all edges.
- Stop adding happy paths when they stop revealing new code. Move to errors.
- If the next test would require no new code, you have hit the end of this slice — skip to Step 4.

Guidelines for writing the test:

- One assertion per concept (multiple `expect` calls that describe one behavior are fine).
- No mocking of internals. Mock external I/O (network, filesystem, clock) only when necessary.
- The test name reads as a sentence: "rejects requests missing an auth header".

Guidelines for writing the code:

- Minimum to pass. If there are three cases and two are untested, write only the one that's under test.
- Copy-paste is fine on the first and second occurrence. Extract on the third.

## Step 4: Refactor while GREEN

Now that the behavior is pinned, clean up. Extract duplicated logic. Rename unclear variables. Deepen the module — move responsibilities behind the interface until the internals stop leaking into the test.

Rules:

- Every refactor keeps every test GREEN. Run tests after each small change.
- If a refactor would require changing a test, the test was coupled to implementation — either the test is wrong, or the interface you thought you were pinning is actually different. Fix the test first, then refactor.
- Don't refactor speculatively. Extract around real duplication and real seams, not imagined ones.

## Step 5: Close the slice

When the behavior the task plan specified is fully under test and the code is clean:

1. Run the full test suite — not just the tests you wrote. Verify no regressions.
2. Append a one-line summary of what is now pinned to `.gsd/KNOWLEDGE.md` if the behavior is non-obvious or the test surfaced a trap future agents should know about.
3. Use `gsd_*` tools to mark the task complete — do not edit checkboxes by hand.

</process>

<anti_patterns>

- **Writing all tests first.** Horizontal slicing. Produces imagined-behavior tests that decouple from reality.
- **Mocking internals.** `jest.mock("./internal-helper")` tells you the wiring matches your mental model, not that the behavior is correct.
- **Refactoring while RED.** You have no signal. Any change could be right or wrong.
- **"Just one more test" after GREEN without refactoring.** You accumulate duplication and the code rots in place.
- **Testing implementation detail.** "It calls `fetchUser` three times." Who cares? Test the observable result.
- **Skipping the failing run.** If you never saw RED, you don't know the test would have caught the bug.

</anti_patterns>

<success_criteria>

- [ ] Every behavior the task plan called out has a test that pins it through the public interface.
- [ ] Every test went RED before it went GREEN. No test was born passing.
- [ ] All refactoring happened on GREEN. The final code is not the first draft.
- [ ] Full test suite runs clean — no regressions.
- [ ] No test mocks an internal helper or asserts a private field.

</success_criteria>
