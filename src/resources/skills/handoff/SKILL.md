---
name: handoff
description: Prepare a clean cross-session handoff so the next agent (or you tomorrow) can pick up exactly where you left off. Writes a focused `continue.md` in the active slice directory and ensures `STATE.md` + summary artifacts are current. Use when asked to "hand off", "prepare handoff", "pause work", "bookmark this", "I'll come back to this later", before running out of context budget, or at the end of a long session with unfinished work. Closes the v1 `/gsd-pause-work` parity gap.
---

<objective>
Leave the project in a state where a fresh agent with no memory of this session can read two or three files and be productive within one minute. The deliverable is `continue.md` in the active slice directory plus up-to-date summary artifacts — not a chat recap.
</objective>

<context>
GSD already writes `STATE.md` (rebuilt after each unit) and summary files (`M###-SUMMARY.md`, `S##-SUMMARY.md`, `T##-SUMMARY.md`). The gap is the *mid-task* handoff: you're partway through a task, context is getting long, and the next session shouldn't start by re-deriving your mental state.

`continue.md` exists for exactly this — see `auto-prompts.ts`, `guided-flow.ts`, `phase-anchor.ts`, `state.ts`. This skill is the deliberate authoring ritual.

Invocation points:
- User says "pause", "hand off", "I'll come back later", "this is a good stopping point"
- Context usage nearing budget — better to hand off cleanly than truncate mid-thought
- Before a risky operation (dependency upgrade, major refactor) where you want a known-good checkpoint
- End of a long session, multi-day work
</context>

<core_principle>
**WRITE FOR A STRANGER.** The next reader is not you. They do not have this conversation. They have `STATE.md`, `continue.md`, the last summary, and the code. That has to be enough.

**CURRENT STATE ONLY.** `continue.md` is ephemeral — it says "pick up HERE." It is not a log of what you did; that goes in summaries. It is not a plan for future work; that lives in the plan files.

**NO SECRETS, NO STALE PATHS.** Do not inline env values, tokens, or paths that only exist in your working directory. Cite artifacts by relative path from the project root.
</core_principle>

<process>

## Step 1: Identify what's in flight

Answer briefly:
1. What task (`T##`) am I on? What's its current plan file?
2. What have I completed since the last summary?
3. What's the next concrete action? (Not a goal — an action: "Run X. If Y, do Z.")
4. What, if anything, is blocking or uncertain?

## Step 2: Update the summaries, not the handoff

Before writing `continue.md`:

- **Any task that's actually done?** Use `gsd_task_complete` (or the equivalent tool) to toggle state. Do NOT edit checkboxes by hand. This triggers `STATE.md` rebuild and `T##-SUMMARY.md` generation.
- **Any slice-level decisions worth preserving?** Append to `S##-CONTEXT.md` if the slice has one, or `.gsd/DECISIONS.md` if the decision was project-wide.
- **Any patterns or traps future agents should know about?** Append a single line to `.gsd/KNOWLEDGE.md`.

This shrinks what `continue.md` has to carry.

## Step 3: Write continue.md

Create `.gsd/milestones/<MID>/slices/<SID>/continue.md` with the following shape. Keep it tight — one screenful max.

```markdown
# Continue — S02 / T03

## Last action

<one sentence — what you just did, with evidence>
Example: "Ran `npm test` after editing `src/auth/session.ts`; 2 failures in `session.test.ts` — both complain about a missing `expiresAt` field in the mock fixture."

## Next action

<one concrete action the next agent should take>
Example: "Update `fixtures/sessions.ts` to include `expiresAt: Date.now() + 3600_000` on every fixture, then re-run `npm test`."

## Why

<one or two sentences — why this next step, not something else>
Example: "The session refactor moved `expiresAt` from optional to required in `Session`; fixtures were never updated."

## Open threads

<list of things you noticed but deliberately didn't act on>
- Validator in `src/auth/validator.ts` still accepts unbounded session lengths — file as a separate issue after T03 lands.

## Do not

<traps and false paths the next agent might stumble into>
- Do NOT revert the `Session` interface change — it's required for T04.
- Do NOT run `npm run db:reset` in this branch; dev data is still needed for manual UAT.
```

## Step 4: Sanity check

Read `STATE.md` + `continue.md` + the most recent summary as if you were a fresh agent. Ask:
1. Do I know what to do next?
2. Do I know why?
3. Do I know what not to do?

If any answer is no, the handoff is incomplete. Fix it before stopping.

## Step 5: Stop cleanly

- Do not leave in-flight `async_bash` or `bg_shell` jobs. Cancel or wait for them.
- Do not leave uncommitted changes without flagging them in `continue.md` — note which files are modified and why.
- Do not push mid-task commits to remote unless that was the plan — they create noise for reviewers.

</process>

<anti_patterns>

- **Chat-log handoffs.** "First I did X, then Y, then Z…" The next agent doesn't need the journey.
- **`continue.md` that summarizes the whole slice.** That's what `S##-SUMMARY.md` is for, at slice completion.
- **No "Next action".** A handoff without a concrete next action is a journal entry.
- **Implicit assumptions.** "Obviously the next thing is…" — write it down.
- **Leaving background processes running.** They'll be orphaned when the session ends.
- **Handoff without updating summaries.** `continue.md` should be thin because the summaries carry the weight.

</anti_patterns>

<success_criteria>

- [ ] `continue.md` exists in the active slice directory.
- [ ] The "Next action" is concrete and executable without this session's context.
- [ ] Completed tasks were marked done via `gsd_*` tools, not by hand-edited checkboxes.
- [ ] `KNOWLEDGE.md` and `DECISIONS.md` have been updated if anything notable was learned.
- [ ] Background processes are not orphaned.
- [ ] A cold-read of `STATE.md` + `continue.md` + latest summary would produce the right next action.

</success_criteria>
