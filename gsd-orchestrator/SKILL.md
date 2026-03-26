---
name: gsd-orchestrator
description: >
  Orchestrate GSD (Get Shit Done) projects via subprocess execution.
  Use when an agent needs to create milestones from specs, execute software
  development workflows, monitor task progress, poll status, handle blockers,
  or track costs. Triggers on requests to "run gsd", "create milestone",
  "execute project", "check gsd status", "orchestrate development",
  "run headless workflow", or any programmatic interaction with the GSD
  project management system.
metadata:
  openclaw:
    requires:
      bins: [gsd]
    install:
      kind: node
      package: gsd-pi
      bins: [gsd]
---

# GSD Orchestrator

Run GSD commands as subprocesses via `gsd headless`. No SDK, no RPC — just shell exec, exit codes, and JSON on stdout.

## Quick Start

```bash
# Install GSD globally
npm install -g gsd-pi

# Verify installation
gsd --version

# Create a milestone from a spec and execute it
gsd headless --output-format json new-milestone --context spec.md --auto
```

## Command Syntax

```bash
gsd headless [flags] [command] [args...]
```

Default command is `auto` (run all queued units).

### Flags

| Flag | Description |
|------|-------------|
| `--output-format <fmt>` | Output format: `text` (default), `json` (structured result at exit), `stream-json` (JSONL events) |
| `--json` | Alias for `--output-format stream-json` — JSONL event stream to stdout |
| `--bare` | Minimal context: skip CLAUDE.md, AGENTS.md, user settings, user skills. Use for CI/ecosystem runs. |
| `--resume <id>` | Resume a prior headless session by its session ID |
| `--timeout N` | Overall timeout in ms (default: 300000) |
| `--model ID` | Override LLM model |
| `--supervised` | Forward interactive UI requests to orchestrator via stdout/stdin |
| `--response-timeout N` | Timeout (ms) for orchestrator response in supervised mode (default: 30000) |
| `--answers <path>` | Pre-supply answers and secrets from JSON file |
| `--events <types>` | Filter JSONL output to specific event types (comma-separated, implies `--json`) |
| `--verbose` | Show tool calls in progress output |

### Exit Codes

| Code | Meaning | Constant |
|------|---------|----------|
| `0` | Success — unit/milestone completed | `EXIT_SUCCESS` |
| `1` | Error or timeout | `EXIT_ERROR` |
| `10` | Blocked — needs human intervention | `EXIT_BLOCKED` |
| `11` | Cancelled by user or orchestrator | `EXIT_CANCELLED` |

These codes are stable and suitable for CI pipelines and orchestrator logic.

### Output Formats

| Format | Behavior |
|--------|----------|
| `text` | Human-readable progress on stderr. Default. |
| `json` | Collect events silently. Emit a single `HeadlessJsonResult` JSON object to stdout at exit. |
| `stream-json` | Stream JSONL events to stdout in real time (same as `--json`). |

Use `--output-format json` when you need a structured result for decision-making. See [references/json-result.md](references/json-result.md) for the full field reference.

## Core Workflows

### 1. Create + Execute a Milestone (end-to-end)

```bash
gsd headless --output-format json new-milestone --context spec.md --auto
```

Reads a spec file, bootstraps `.gsd/`, creates the milestone, then chains into auto-mode executing all phases (discuss → research → plan → execute → summarize → complete). The JSON result is emitted on stdout at exit.

Extra flags for `new-milestone`:
- `--context <path>` — path to spec/PRD file (use `-` for stdin)
- `--context-text <text>` — inline specification text
- `--auto` — start auto-mode after milestone creation
- `--verbose` — show tool calls in progress output

```bash
# From stdin
cat spec.md | gsd headless --output-format json new-milestone --context - --auto

# Inline text
gsd headless new-milestone --context-text "Build a REST API for user management" --auto
```

### 2. Run All Queued Work

```bash
gsd headless --output-format json auto
```

Loop through all pending units until milestone complete or blocked.

### 3. Run One Unit (step-by-step)

```bash
gsd headless --output-format json next
```

Execute exactly one unit (task/slice/milestone step), then exit. This is the recommended pattern for orchestrators that need control between steps.

### 4. Instant State Snapshot (no LLM)

```bash
gsd headless query
```

Returns a single JSON object with the full project snapshot — no LLM session, instant (~50ms). **This is the recommended way for orchestrators to inspect state.**

```json
{
  "state": {
    "phase": "executing",
    "activeMilestone": { "id": "M001", "title": "..." },
    "activeSlice": { "id": "S01", "title": "..." },
    "progress": { "completed": 3, "total": 7 },
    "registry": [...]
  },
  "next": { "action": "dispatch", "unitType": "execute-task", "unitId": "M001/S01/T01" },
  "cost": { "workers": [{ "milestoneId": "M001", "cost": 1.50 }], "total": 1.50 }
}
```

### 5. Dispatch Specific Phase

```bash
gsd headless dispatch research|plan|execute|complete|reassess|uat|replan
```

Force-route to a specific phase, bypassing normal state-machine routing.

### 6. Resume a Session

```bash
gsd headless --resume <session-id> auto
```

Resume a prior headless session. The session ID is available in the `HeadlessJsonResult.sessionId` field from a previous `--output-format json` run.

## Orchestrator Patterns

### Parse the Structured JSON Result

When using `--output-format json`, the process emits a single `HeadlessJsonResult` on stdout at exit. Parse it for decision-making:

```bash
RESULT=$(gsd headless --output-format json next 2>/dev/null)
EXIT=$?

STATUS=$(echo "$RESULT" | jq -r '.status')
COST=$(echo "$RESULT" | jq -r '.cost.total')
PHASE=$(echo "$RESULT" | jq -r '.phase')
NEXT=$(echo "$RESULT" | jq -r '.nextAction')
SESSION_ID=$(echo "$RESULT" | jq -r '.sessionId')

echo "Status: $STATUS, Cost: \$${COST}, Phase: $PHASE, Next: $NEXT"
```

See [references/json-result.md](references/json-result.md) for the full field reference.

### Blocker Detection and Handling

Exit code `10` means the execution hit a blocker requiring human intervention:

```bash
gsd headless --output-format json next 2>/dev/null
EXIT=$?

if [ $EXIT -eq 10 ]; then
  # Inspect the blocker
  BLOCKER=$(gsd headless query | jq '.state.phase')
  echo "Blocked: $BLOCKER"

  # Option 1: Use --supervised mode to handle interactively
  gsd headless --supervised auto

  # Option 2: Pre-supply answers to resolve the blocker
  gsd headless --answers blocker-answers.json auto

  # Option 3: Steer the plan to work around it
  gsd headless steer "Skip the blocked dependency, use mock instead"
fi
```

### Cost Tracking and Budget Enforcement

```bash
MAX_BUDGET=10.00

RESULT=$(gsd headless --output-format json next 2>/dev/null)
COST=$(echo "$RESULT" | jq -r '.cost.total')

# Check cumulative cost via query (includes all workers)
TOTAL_COST=$(gsd headless query | jq -r '.cost.total')

if (( $(echo "$TOTAL_COST > $MAX_BUDGET" | bc -l) )); then
  echo "Budget exceeded: \$$TOTAL_COST > \$$MAX_BUDGET"
  gsd headless stop
  exit 1
fi
```

### Step-by-Step with Monitoring

The recommended pattern for full control. Run one unit at a time, inspect state between steps:

```bash
while true; do
  RESULT=$(gsd headless --output-format json next 2>/dev/null)
  EXIT=$?

  STATUS=$(echo "$RESULT" | jq -r '.status')
  COST=$(echo "$RESULT" | jq -r '.cost.total')

  echo "Exit: $EXIT, Status: $STATUS, Cost: \$$COST"

  # Handle terminal states
  [ $EXIT -eq 0 ] || break

  # Check if milestone is complete
  PHASE=$(gsd headless query | jq -r '.state.phase')
  [ "$PHASE" = "complete" ] && echo "Milestone complete" && break

  # Budget check
  TOTAL=$(gsd headless query | jq -r '.cost.total')
  if (( $(echo "$TOTAL > 20.00" | bc -l) )); then
    echo "Budget limit reached"
    break
  fi
done
```

### Poll-and-React Loop

Lightweight pattern using only the instant `query` command:

```bash
PHASE=$(gsd headless query | jq -r '.state.phase')
NEXT_ACTION=$(gsd headless query | jq -r '.next.action')

case "$PHASE" in
  complete) echo "Done" ;;
  blocked)  echo "Needs intervention — exit code 10" ;;
  *)        [ "$NEXT_ACTION" = "dispatch" ] && gsd headless next ;;
esac
```

### CI/Ecosystem Mode

Use `--bare` to skip user-specific configuration for deterministic CI runs:

```bash
gsd headless --bare --output-format json auto 2>/dev/null
```

This skips CLAUDE.md, AGENTS.md, user settings, and user skills. Bundled GSD extensions and `.gsd/` state are still loaded (they're required for GSD to function).

### JSONL Event Stream

Use `--json` (or `--output-format stream-json`) for real-time events:

```bash
gsd headless --json auto 2>/dev/null | while read -r line; do
  TYPE=$(echo "$line" | jq -r '.type')
  case "$TYPE" in
    tool_execution_start) echo "Tool: $(echo "$line" | jq -r '.toolName')" ;;
    extension_ui_request) echo "GSD: $(echo "$line" | jq -r '.message // .title // empty')" ;;
    agent_end) echo "Session ended" ;;
  esac
done
```

### Filtered Event Stream

Use `--events` to receive only specific event types:

```bash
# Only phase-relevant events
gsd headless --events agent_end,extension_ui_request auto 2>/dev/null

# Only tool execution events
gsd headless --events tool_execution_start,tool_execution_end auto
```

Available event types: `agent_start`, `agent_end`, `tool_execution_start`, `tool_execution_end`, `tool_execution_update`, `extension_ui_request`, `message_start`, `message_end`, `message_update`, `turn_start`, `turn_end`.

## Answer Injection

Pre-supply answers and secrets for fully autonomous headless runs:

```bash
gsd headless --answers answers.json auto
```

Answer file schema:
```json
{
  "questions": { "question_id": "selected_option" },
  "secrets": { "API_KEY": "sk-..." },
  "defaults": { "strategy": "first_option" }
}
```

- **questions** — question ID → answer (string for single-select, string[] for multi-select)
- **secrets** — env var → value, injected into child process environment
- **defaults.strategy** — `"first_option"` (default) or `"cancel"` for unmatched questions

See [references/answer-injection.md](references/answer-injection.md) for the full mechanism.

## GSD Project Structure

All state lives in `.gsd/` as markdown files (version-controllable):

```
.gsd/
  PROJECT.md
  REQUIREMENTS.md
  DECISIONS.md
  KNOWLEDGE.md
  STATE.md
  milestones/
    M001/
      M001-CONTEXT.md      # Requirements, scope, decisions
      M001-ROADMAP.md      # Slices with tasks, dependencies, checkboxes
      M001-SUMMARY.md      # Completion summary
      slices/
        S01/
          S01-PLAN.md      # Task list
          S01-SUMMARY.md   # Slice summary
          tasks/
            T01-PLAN.md    # Individual task spec
            T01-SUMMARY.md # Task completion summary
```

State is derived from files on disk — checkboxes in ROADMAP.md and PLAN.md are the source of truth for completion.

## All Commands

See [references/commands.md](references/commands.md) for the complete reference.

| Command | Purpose |
|---------|---------|
| `auto` | Run all queued units (default) |
| `next` | Run one unit |
| `query` | Instant JSON snapshot — state, next dispatch, costs (no LLM) |
| `new-milestone` | Create milestone from spec |
| `dispatch <phase>` | Force specific phase |
| `stop` / `pause` | Control auto-mode |
| `steer <desc>` | Hard-steer plan mid-execution |
| `skip` / `undo` | Unit control |
| `queue` | Queue/reorder milestones |
| `history` | View execution history |
| `doctor` | Health check + auto-fix |
