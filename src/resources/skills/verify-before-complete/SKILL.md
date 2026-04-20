---
name: verify-before-complete
description: >-
  Block completion claims until verification evidence has been produced in the current message. Use before marking a task/slice/milestone complete, before creating a commit or PR, before saying "it works" or "tests pass", and any time you are about to claim work is done. The rule is: evidence before claims, always — running the verification must happen now, not "earlier in the session". Fresh output or no claim.
---

<objective>
Enforce the GSD "work is not done when code compiles; work is done when verification passes" contract. A completion claim without verification output generated in the current message is a broken claim. This skill is the gate.
</objective>

<context>
GSD's system prompt sets the expectation; `guided-complete-slice.md` and `auto-verification.ts` enforce it at the slice boundary. But between slice boundaries — mid-task, mid-debug, mid-review — an agent can drift into "I think it works" mode and ship broken work. This skill is the ritual to break that pattern at any completion point.

Invocation points:
- About to toggle a checkbox from `[ ]` to `[x]` via a `gsd_*` tool
- About to commit, push, or open a PR
- About to summarize a task or slice as complete
- About to say "tests pass", "build works", "lint clean", "fixed", "done"
- Replying to a user question with "yes it works" or similar
</context>

<core_principle>
**EVIDENCE BEFORE CLAIMS, ALWAYS.** "I ran it earlier" is not evidence. A log from three tool calls ago is not evidence if code has changed since. The verification must have happened *after* the last code change, in this message, with fresh output.

**VIOLATING THE LETTER IS VIOLATING THE SPIRIT.** If the principle feels inconvenient, that is the signal it is load-bearing. Find the verification command. Run it. Read the output.
</core_principle>

<process>

## Step 1: Identify the claim

What are you about to claim? Name it precisely:

- "Tests pass" → which tests?
- "Build works" → for which target?
- "Bug is fixed" → which reproduction?
- "Task complete" → which acceptance criteria?

## Step 2: Identify the verification command

Match claim → command:

| Claim | Verification |
|---|---|
| Tests pass | The specific test command the project uses (`npm test`, `cargo test`, `pytest`, etc.) — scoped to changed code if large suite. |
| Build works | The project's build command, for real — not `tsc --noEmit` if the project needs a bundle. |
| Lint clean | `lsp diagnostics` on edited files, plus the project's linter if CI runs one. |
| Bug fixed | The reproduction steps from the bug report or test, freshly run. |
| UI works | Browser verification via `browser_snapshot_refs` + `browser_assert` in a running app — not "it looks right in the diff". |
| Slice complete | Every acceptance criterion in `S##-PLAN.md`, re-checked against live behavior. |

If no verification command exists, the task has not produced a falsifiable claim — it is not complete. Write the verification first (see the `tdd` or `test` skill).

## Step 3: Run it now

Use `async_bash` for one-shot commands, `bg_shell` for long-running servers/watchers. Wait for it to exit. Read the output. Not skim — read.

**If output indicates failure:** you do not have a completion claim. Loop back: inspect the error, fix, re-run until it passes or a real blocker requires user input. Do not partially claim ("tests mostly pass") — either pass or report failure honestly.

**If output indicates success:** quote the relevant line in your reply. "42 tests passing" or "Exit code 0" or "LSP reports 0 errors on the 3 edited files."

## Step 4: Check for staleness

If you ran the verification early in this message, then made further code changes, the output is stale. Re-run. Cancel in-flight `async_bash` jobs that predated the edit (see system prompt: "stale job hygiene").

## Step 5: Now claim

Only now, after fresh output, can you:

- Mark a task/slice/milestone complete via `gsd_*`
- Commit / push / open PR
- State "done", "fixed", "passes", "works"

Include the evidence in the claim: "Slice complete — `npm test` passed (84/84), `npm run build` exit 0, acceptance criterion 3 verified against live UI at /dashboard."

</process>

<anti_patterns>

- **"It should work"** — not verification. Run the command.
- **"Tests passed earlier"** — stale. Run them now.
- **"The code looks right"** — code review is not verification.
- **`tsc --noEmit` as the build check** when the project bundles — test what the user experiences.
- **Silent failures** — "the test was killed by a timeout so I assume it's fine." No.
- **Partial passes** — 80/84 is not "tests pass." Report the 4 failures.
- **Skipping because "I know why this works"** — your mental model is not evidence.

</anti_patterns>

<success_criteria>

- [ ] The claim is precise — not "it works" but "`npm test` passed with 84/84 tests."
- [ ] The verification command ran *after* the last code change, in this message.
- [ ] Output was read, not skimmed.
- [ ] Failures would have been caught — the verification actually tests what the claim asserts.
- [ ] Relevant evidence is quoted in the claim reply.

</success_criteria>
