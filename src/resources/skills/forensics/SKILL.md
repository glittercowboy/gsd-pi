---
name: forensics
description: Post-mortem a failed GSD auto-mode run. Traces from symptom to root cause using `.gsd/activity/*.jsonl`, `.gsd/journal/YYYY-MM-DD.jsonl`, `.gsd/metrics.json`, and `.gsd/auto.lock`. Produces a filing-ready bug report with file:line references and a concrete fix suggestion. Use when asked to "forensics", "post-mortem", "why did auto-mode fail", "trace the stuck loop", "debug the crash", after `/gsd forensics` is invoked, or when a session ended in an unexpected terminal state. Reads existing artifacts — does NOT re-run anything.
---

<objective>
Turn scattered GSD runtime artifacts into one coherent cause chain. The deliverable is a GitHub-issue-ready report that names the file and line where the bug lives, cites the evidence, and proposes a fix. Forensics is archaeology, not re-run — no modifying state, no triggering commands, just reading the paper trail.
</objective>

<context>
GSD persists a lot of runtime evidence under `.gsd/`:

- `activity/{seq}-{unitType}-{unitId}.jsonl` — full tool-call and message stream per unit
- `journal/YYYY-MM-DD.jsonl` — iteration-level events (dispatch-match, stuck-detected, guard-block, unit-start/end, terminal)
- `metrics.json` — token/cost ledger; duplicate `type/id` entries indicate a stuck loop
- `auto.lock` — JSON snapshot of the currently-owning PID; stale lock = crash mid-unit
- `forensics/` — saved prior reports
- `debug/` — debug logs if enabled
- `runtime/paused-session.json` — serialized session when auto-mode paused
- `doctor-history.jsonl` — doctor check history

The `/gsd forensics` command pre-computes a forensic report with anomalies flagged. This skill is the manual investigation that goes deeper, or runs when the automated report isn't enough.

Invocation points:
- `/gsd forensics` has been run and user wants deeper analysis
- Auto-mode exited unexpectedly, no obvious cause
- Same unit dispatched multiple times (stuck loop suspected)
- A session crashed and `auto.lock` is stale
- User reports "it just stopped" or "it did the wrong thing"
</context>

<core_principle>
**READ-ONLY.** Forensics touches no live state. Non-mutating inspection commands (e.g., `ps`, `top -b`, `cat /proc/*`) are allowed for checking process status or reading system files. Strictly prohibited: `gsd_*` writes, commands that modify state, executing binaries that produce side effects, writing to files (outside the final report), or re-running the failed unit. The evidence must stay pristine for future investigations.

**SYMPTOM → ROOT CAUSE, WITH CITATIONS.** Every claim in the report is backed by an artifact path and either a line number or a JSONL field. "The loop got stuck because of a race" is not useful; "`.gsd/journal/2026-04-19.jsonl:142` shows `stuck-detected` with flowId X, caused by `dispatch-guard.ts:87` returning the same unit after `unit-end`" is.

**PRE-PARSED LEADS, NOT CONCLUSIONS.** If `/gsd forensics` has surfaced anomalies, treat them as hypotheses to verify, not answers.
</core_principle>

<process>

## Step 1: Locate the evidence

Read what's in `.gsd/`:

1. `auto.lock` — is it stale? Check PID against `ps` (read-only inspection, allowed). Stale = crash.
2. Most recent `.gsd/activity/*.jsonl` — sort by mtime, newest first. That's the last unit that ran.
3. Today's `.gsd/journal/YYYY-MM-DD.jsonl` — the iteration-level view.
4. `.gsd/metrics.json` — does any `type/id` appear more than once? (stuck loop signal)
5. `.gsd/runtime/paused-session.json` — if present, what was the pause reason?

## Step 2: Reconstruct the failure from the activity log

Activity JSONL format:
- Each line is `{type: "message", message: {...}}`.
- `message.role: "assistant"` → `content[]` with `type: "text"` reasoning and `type: "toolCall"` invocations.
- `message.role: "toolResult"` → `{toolCallId, toolName, isError, content}`.
- `usage` on assistant messages tracks tokens and cost.

To trace a failure:
1. Search for `isError: true` tool results in the last activity log. That's usually the proximate symptom.
2. Walk backwards to the assistant message that made the call. Read the `text` content — that's the agent's reasoning at the moment of failure.
3. Keep walking back. Find where the agent's model of the state diverged from reality.

## Step 3: Cross-reference the journal

For each symptom from the activity log, find the matching journal events:
- `stuck-detected` + same `flowId` → the loop detected repetition. `data.reason` says why.
- `guard-block` → a dispatch guard refused to run a unit. Check `data.reason` and trace to `dispatch-guard.ts` logic.
- `unit-end` followed by another `unit-start` for the same `unitId` → re-dispatch. If tied to `stuck-detected`, the artifact verification failed after the unit succeeded.
- `terminal` → auto-mode decided to stop. `data.reason` tells you why.

Use `flowId` to reconstruct one iteration; use `causedBy` to follow causal chains across iterations.

## Step 4: Name the root cause

A good root cause is:
- Specific: a function, a state transition, a missing guard.
- Falsifiable: if we changed X, would the failure go away?
- Sourced: cites a file and (where applicable) a line number.

Bad root cause: "Auto-mode got stuck in a loop." Good root cause: "After slice completion, `auto-unit-closeout.ts` emits `unit-end` before `auto-post-unit.ts` updates the roadmap checkbox. The next `iteration-start` finds the same unit `[ ]` and re-dispatches — `dispatch-guard.ts:42` has no check against the freshly-ended `unitId`."

Consult the source map in `src/resources/extensions/gsd/prompts/forensics.md` to map symptoms to the likely domain files.

## Step 5: Propose a fix

For the root cause:
- Which file and function holds the bug?
- What minimal change would eliminate it?
- What test would have caught it? Can one be added?
- Is this a regression from a recent commit? (Run `git log -- path/to/file.ts` mentally; do NOT run git commands that could modify state.)

## Step 6: Write the report

Format the output as a GitHub-issue-ready report:

```markdown
## Symptom

<what the user saw — quote the error or describe the observed behavior>

## Evidence Trail

1. `.gsd/auto.lock` — <state: stale / fresh>
2. `.gsd/activity/042-slice-S02.jsonl:128` — <isError: true from `gsd_task_complete`>
3. `.gsd/journal/2026-04-19.jsonl:87` — <stuck-detected flowId 7a3c…>
4. `.gsd/metrics.json` — <unit type/id "slice/S02" appears 3 times>

## Root Cause

<specific named cause — file, function, state transition>

`src/resources/extensions/gsd/auto-unit-closeout.ts:<line>`: <exactly what goes wrong>

## Proposed Fix

<minimal change — file, function, what to change>

## Test

<what test would have caught this; whether one should be added>

## Confidence

<high / medium / low> — <what would change this confidence>
```

Offer to file this as a GitHub issue via `mcp__github__issue_write` — explicit confirmation required per the outward-action rule. Also save a copy to `.gsd/forensics/<slug>.md` for future reference.

</process>

<anti_patterns>

- **Running any `gsd_*` write tool during forensics.** Evidence stays pristine.
- **Re-running the auto-mode loop to "reproduce."** That overwrites the activity log. Read the existing one.
- **Vague root cause.** "There's a race" is not a root cause. Name the race.
- **No citations.** Every claim gets an artifact path.
- **Skipping the journal.** The journal is the only view that shows dispatch-level decisions.
- **Auto-filing the GitHub issue.** Outward actions need confirmation.

</anti_patterns>

<success_criteria>

- [ ] The symptom is quoted, not paraphrased.
- [ ] Every claim in the evidence trail cites a file and a line or field.
- [ ] The root cause names a specific file, function, or state transition.
- [ ] The proposed fix is minimal and falsifiable.
- [ ] Confidence is stated honestly.
- [ ] Report is saved under `.gsd/forensics/` even if not filed as an issue.

</success_criteria>
