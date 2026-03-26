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
| **Auto-mode engine** | `auto.ts` `auto-loop.ts` `auto-dispatch.ts` `auto-start.ts` `auto-supervisor.ts` `auto-timers.ts` `auto-timeout-recovery.ts` `auto-unit-closeout.ts` `auto-post-unit.ts` `auto-verification.ts` `auto-recovery.ts` `auto-worktree.ts` `auto-model-selection.ts` `auto-budget.ts` `dispatch-guard.ts` |
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
├── journal/                     — structured event journal (JSONL per day)
│   └── YYYY-MM-DD.jsonl
├── runtime/
│   ├── paused-session.json      — serialized session when auto pauses
│   └── headless-context.md      — headless resume context
├── debug/                       — debug logs
├── forensics/                   — saved forensic reports
├── milestones/{ID}/             — milestone artifacts
│   ├── {ID}-ROADMAP.md, {ID}-RESEARCH.md, {ID}-CONTEXT.md, {ID}-SUMMARY.md
│   └── slices/{SID}/            — slice artifacts
│       ├── {SID}-PLAN.md, {SID}-RESEARCH.md, {SID}-UAT.md, {SID}-SUMMARY.md
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

### Journal Format (`.gsd/journal/`)

The journal is a structured event log for auto-mode iterations. Each daily file contains JSONL entries:

```
{ ts: "ISO-8601", flowId: "UUID", seq: 0, eventType: "iteration-start", rule?: "rule-name", causedBy?: { flowId, seq }, data?: { unitId, status, ... } }
```

**Key event types:**
- `iteration-start` / `iteration-end` — marks loop iteration boundaries
- `dispatch-match` / `dispatch-stop` — what the auto-mode decided to do (or not do)
- `unit-start` / `unit-end` — lifecycle of individual work units
- `terminal` — auto-mode reached a terminal state (all done, budget exceeded, etc.)
- `guard-block` — dispatch was blocked by a guard condition (e.g. needs user input)
- `stuck-detected` — the loop detected it was stuck (same unit repeatedly dispatched)
- `milestone-transition` — a milestone was promoted or completed
- `worktree-enter` / `worktree-create-failed` / `worktree-merge-start` / `worktree-merge-failed` — worktree operations

**Key concepts:**
- **flowId**: UUID grouping all events in one iteration. Use to reconstruct what happened in a single loop pass.
- **causedBy**: Cross-reference to a prior event (same or different flow). Enables causal chain tracing.
- **seq**: Monotonically increasing within a flow. Reconstruct event order within an iteration.

**To trace a stuck loop**: filter for `stuck-detected` events, then follow `flowId` to see the surrounding dispatch and unit events.
**To trace a guard block**: filter for `guard-block` events, check `data.reason` for why dispatch was blocked.

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

2. **Check the journal timeline** if present. The journal events show the auto-mode's decision sequence (dispatches, guards, stuck detection, worktree operations). Use flow IDs to group related events and trace causal chains.

3. **Cross-reference activity logs and journal**. Activity logs show *what the LLM did* (tool calls, reasoning, errors). Journal events show *what auto-mode decided* (dispatch rules, iteration boundaries, state transitions). Together they reveal the full picture.

4. **Form hypotheses** about which module and code path is responsible. Use the source map to identify candidate files.

5. **Read the actual GSD source code** at `{{gsdSourceDir}}` to confirm or deny each hypothesis. Do not guess what code does — read it.

6. **Trace the code path** from the entry point (usually `auto-loop.ts` dispatch or `auto-dispatch.ts`) through to the failure point. Follow function calls across files.

7. **Identify the specific file and line** where the bug lives. Determine what kind of defect it is:
   - Missing edge case / unhandled condition
   - Wrong boolean logic or comparison
   - Race condition or ordering issue
   - State corruption (e.g. completed-units.json out of sync with artifacts)
   - Timeout / recovery logic not triggering correctly

8. **Clarify if needed.** Use ask_user_questions (max 2 questions) only if the report is genuinely insufficient. Do not ask questions you can answer from the data or source code.

## Output

Explain your findings:
- **What happened** — the failure sequence reconstructed from activity logs and anomalies
- **Why it happened** — root cause traced to specific code in GSD source, with `file:line` references
- **Code snippet** — the problematic code and what it should do instead
- **Recovery** — what the user can do right now to get unstuck

{{dedupSection}}

Then **offer GitHub issue creation**: "Would you like me to create a GitHub issue for this on gsd-build/gsd-2?"

**CRITICAL: The `github_issues` tool ONLY targets the current user's repository — it has no `repo` parameter. You MUST use `gh issue create --repo gsd-build/gsd-2` via the `bash` tool to file on the correct repo. Do NOT use the `github_issues` tool for this.**

If yes, create using the `bash` tool:

```bash
# Step 1: Write issue body to a temp file to avoid escaping/truncation issues.
# Using --body-file bypasses shell quoting entirely — backticks, quotes, and
# content containing "EOF" all render correctly. (#2465)
cat > /tmp/gsd-forensic-issue.md << 'GSD_ISSUE_BODY'
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
GSD_ISSUE_BODY

ISSUE_URL=$(gh issue create --repo gsd-build/gsd-2 \
  --title "..." \
  --label "auto-generated" \
  --body-file /tmp/gsd-forensic-issue.md)
rm -f /tmp/gsd-forensic-issue.md

# Step 2: Set issue type via GraphQL (gh issue create has no --type flag)
ISSUE_NUM=$(echo "$ISSUE_URL" | grep -oE '[0-9]+$')
ISSUE_ID=$(gh api graphql -f query='{ repository(owner:"gsd-build",name:"gsd-2") { issue(number:'"$ISSUE_NUM"') { id } } }' --jq '.data.repository.issue.id')
TYPE_ID=$(gh api graphql -f query='{ repository(owner:"gsd-build",name:"gsd-2") { issueTypes(first:20) { nodes { id name } } } }' --jq '.data.repository.issueTypes.nodes[] | select(.name=="Bug") | .id')
gh api graphql -f query='mutation { updateIssue(input:{id:"'"$ISSUE_ID"'",issueTypeId:"'"$TYPE_ID"'"}) { issue { number } } }'
```

### Redaction Rules (CRITICAL)

Before creating the issue, you MUST:
- Replace all absolute paths with relative paths
- Remove any API keys, tokens, or credentials
- Remove any environment variable values
- Do not include user's project code — only GSD structural information (tool names, file names, error messages)

## Report Saved

Remind the user that the full forensic report was saved locally (the path will be in the notification).
