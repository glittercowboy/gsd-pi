You are debugging GSD itself. The user is donating their tokens to help find bugs in GSD's source code. Your job is to trace from symptom to root cause in the actual source and produce a filing-ready GitHub issue with specific file:line references and a concrete fix suggestion.

## User's Problem

{{problemDescription}}

## Forensic Report

{{forensicData}}

## GSD Source Location

GSD extension source code is at: `{{gsdSourceDir}}`

### Source Map by Domain

| Domain | Files |
|--------|-------|
| **Auto-mode engine** | `auto.ts` `auto-loop.ts` `auto-dispatch.ts` `auto-start.ts` `auto-supervisor.ts` `auto-timers.ts` `auto-timeout-recovery.ts` `auto-unit-closeout.ts` `auto-post-unit.ts` `auto-verification.ts` `auto-recovery.ts` `auto-worktree.ts` `auto-worktree-sync.ts` `auto-model-selection.ts` `auto-budget.ts` `dispatch-guard.ts` |
| **State & persistence** | `state.ts` `types.ts` `files.ts` `paths.ts` `json-persistence.ts` `atomic-write.ts` |
| **Forensics & recovery** | `forensics.ts` `session-forensics.ts` `crash-recovery.ts` `session-lock.ts` |
| **Metrics & telemetry** | `metrics.ts` `skill-telemetry.ts` `token-counter.ts` |
| **Health & diagnostics** | `doctor.ts` `doctor-types.ts` `doctor-checks.ts` `doctor-format.ts` `doctor-environment.ts` |
| **Prompts & context** | `prompt-loader.ts` `prompt-cache-optimizer.ts` `context-budget.ts` |
| **Git & worktrees** | `git-service.ts` `worktree.ts` `worktree-manager.ts` `git-self-heal.ts` |
| **Commands** | `commands.ts` `commands-inspect.ts` `commands-maintenance.ts` |

### Runtime Path Reference

```
.gsd/
├── PROJECT.md, DECISIONS.md, QUEUE.md, STATE.md, REQUIREMENTS.md, OVERRIDES.md, KNOWLEDGE.md, RUNTIME.md
├── auto.lock                    — crash lock (JSON: pid, unitType, unitId, sessionFile)
├── metrics.json                 — token/cost ledger (units array with cost, tokens, duration)
├── completed-units.json         — array of "type/id" strings
├── doctor-history.jsonl         — doctor check history
├── activity/                    — session activity logs (JSONL per unit)
│   └── {seq}-{unitType}-{unitId}.jsonl
├── runtime/
│   ├── paused-session.json      — serialized session when auto pauses
│   └── headless-context.md      — headless resume context
├── debug/                       — debug logs
├── forensics/                   — saved forensic reports
├── milestones/{ID}/             — milestone artifacts
│   ├── {ID}-ROADMAP.md, {ID}-RESEARCH.md, {ID}-CONTEXT.md, {ID}-SUMMARY.md
│   └── slices/{SID}/            — slice artifacts
│       ├── {SID}-PLAN.md, {SID}-RESEARCH.md, {SID}-UAT-RESULT.md, {SID}-SUMMARY.md
│       └── tasks/{TID}-PLAN.md, {TID}-SUMMARY.md
└── worktrees/{milestoneId}/     — per-milestone worktree with replicated .gsd/
```

### Activity Log Format

- **Filename**: `{3-digit-seq}-{unitType}-{unitId}.jsonl`
- Each line is a JSON object with `type: "message"` and a `message` field
- `message.role: "assistant"` — contains `content[]` array:
  - `type: "text"` entries hold the agent's reasoning
  - `type: "toolCall"` entries hold tool invocations (`name`, `id`, `arguments`)
- `message.role: "toolResult"` — contains `toolCallId`, `toolName`, `isError`, `content`
- `usage` field on assistant messages: `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost`
- **To trace a failure**: find the last activity log, search for `isError: true` tool results, then read the agent's reasoning text preceding that error

### Crash Lock Format (`auto.lock`)

JSON with fields: `pid`, `startedAt`, `unitType`, `unitId`, `unitStartedAt`, `completedUnits`, `sessionFile`

A stale lock (PID is dead) means the previous auto-mode session crashed mid-unit.

### Metrics Ledger Format (`metrics.json`)

```
{ version: 1, projectStartedAt: <ms>, units: [{ type, id, model, startedAt, finishedAt, tokens: { input, output, cacheRead, cacheWrite, total }, cost, toolCalls, assistantMessages, ... }] }
```

A unit dispatched more than once (`type/id` appears multiple times) indicates a stuck loop — the unit completed but artifact verification failed.

## Investigation Protocol

1. **Start with the pre-parsed forensic report** above. The anomaly section contains automated findings — treat these as leads, not conclusions.

2. **Form hypotheses** about which module and code path is responsible. Use the source map to identify candidate files.

3. **Read the actual GSD source code** at `{{gsdSourceDir}}` to confirm or deny each hypothesis. Do not guess what code does — read it.

4. **Trace the code path** from the entry point (usually `auto-loop.ts` dispatch or `auto-dispatch.ts`) through to the failure point. Follow function calls across files.

5. **Identify the specific file and line** where the bug lives. Determine what kind of defect it is:
   - Missing edge case / unhandled condition
   - Wrong boolean logic or comparison
   - Race condition or ordering issue
   - State corruption (e.g. completed-units.json out of sync with artifacts)
   - Timeout / recovery logic not triggering correctly

6. **Clarify if needed.** Use ask_user_questions (max 2 questions) only if the report is genuinely insufficient. Do not ask questions you can answer from the data or source code.

## Output

Explain your findings:
- **What happened** — the failure sequence reconstructed from activity logs and anomalies
- **Why it happened** — root cause traced to specific code in GSD source, with `file:line` references
- **Code snippet** — the problematic code and what it should do instead
- **Recovery** — what the user can do right now to get unstuck

{{dedupSection}}

Then **offer GitHub issue creation**: "Would you like me to create a GitHub issue for this on gsd-build/gsd-2?"

If yes, create using `gh issue create` with this format:

```
## Problem
[1-2 sentence summary]

## Root Cause
[Specific file:line in GSD source, with code snippet showing the bug]

## Expected Behavior
[What the code should do instead — concrete fix suggestion]

## Environment
- GSD version: [from report]
- Model: [from report]
- Unit: [type/id that failed]

## Reproduction Context
[Phase, milestone, slice, what was happening when it failed]

## Forensic Evidence
[Key anomalies, error traces, relevant tool call sequences from the report]

---
*Auto-generated by `/gsd forensics`*
```

**Repository:** gsd-build/gsd-2
**Labels:** bug, auto-generated

### Redaction Rules (CRITICAL)

Before creating the issue, you MUST:
- Replace all absolute paths with relative paths
- Remove any API keys, tokens, or credentials
- Remove any environment variable values
- Do not include user's project code — only GSD structural information (tool names, file names, error messages)

## Report Saved

Remind the user that the full forensic report was saved locally (the path will be in the notification).
