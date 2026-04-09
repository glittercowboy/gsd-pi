# HeadlessJsonResult Reference

When using `--output-format json`, GSD collects events silently and emits a single `HeadlessJsonResult` JSON object to stdout at process exit. This is the structured result for orchestrator decision-making.

## Obtaining the Result

```bash
# Capture the JSON result
RESULT=$(gsd headless --output-format json next 2>/dev/null)
EXIT=$?

# Parse fields with jq
echo "$RESULT" | jq '.status'
echo "$RESULT" | jq '.cost.total'
echo "$RESULT" | jq '.nextAction'
```

**Important:** Progress text goes to stderr. The JSON result goes to stdout. Redirect stderr to `/dev/null` when parsing stdout.

## Field Reference

### Top-Level Fields

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"success" \| "error" \| "blocked" \| "cancelled" \| "timeout"` | Final session status. Maps directly to exit codes. |
| `exitCode` | `number` | Process exit code: `0` (success), `1` (error/timeout), `10` (blocked), `11` (cancelled). |
| `sessionId` | `string \| undefined` | Session identifier. Pass to `--resume <id>` to continue this session. |
| `duration` | `number` | Session wall-clock duration in milliseconds. |
| `cost` | `CostObject` | Token usage and cost breakdown. See below. |
| `toolCalls` | `number` | Total number of tool calls made during the session. |
| `events` | `number` | Total number of events processed during the session. |
| `milestone` | `string \| undefined` | Active milestone ID (e.g. `"M001"`). |
| `phase` | `string \| undefined` | Current GSD phase at session end (e.g. `"executing"`, `"blocked"`, `"complete"`). |
| `nextAction` | `string \| undefined` | Recommended next action from the state machine (e.g. `"dispatch"`, `"complete"`). |
| `artifacts` | `string[] \| undefined` | Paths to artifacts created or modified during the session. |
| `commits` | `string[] \| undefined` | Git commit SHAs created during the session. |

### Status → Exit Code Mapping

| Status | Exit Code | Constant | Meaning |
|--------|-----------|----------|---------|
| `success` | `0` | `EXIT_SUCCESS` | Unit or milestone completed successfully |
| `error` | `1` | `EXIT_ERROR` | Runtime error or LLM failure |
| `timeout` | `1` | `EXIT_ERROR` | `--timeout` deadline exceeded |
| `blocked` | `10` | `EXIT_BLOCKED` | Execution blocked — needs human intervention |
| `cancelled` | `11` | `EXIT_CANCELLED` | Cancelled by user or orchestrator |

### Cost Object

| Field | Type | Description |
|-------|------|-------------|
| `cost.total` | `number` | Total cost in USD for the session. |
| `cost.input_tokens` | `number` | Number of input tokens consumed. |
| `cost.output_tokens` | `number` | Number of output tokens generated. |
| `cost.cache_read_tokens` | `number` | Number of tokens served from prompt cache. |
| `cost.cache_write_tokens` | `number` | Number of tokens written to prompt cache. |

## Parsing Patterns

### Decision-Making After Each Step

```bash
RESULT=$(gsd headless --output-format json next 2>/dev/null)
EXIT=$?

case $EXIT in
  0)
    PHASE=$(echo "$RESULT" | jq -r '.phase')
    NEXT=$(echo "$RESULT" | jq -r '.nextAction')
    echo "Success — phase: $PHASE, next: $NEXT"
    ;;
  1)
    STATUS=$(echo "$RESULT" | jq -r '.status')
    echo "Failed — status: $STATUS"
    ;;
  10)
    echo "Blocked — needs intervention"
    gsd headless query | jq '.state'
    ;;
  11)
    echo "Cancelled"
    ;;
esac
```

### Cost Tracking

```bash
RESULT=$(gsd headless --output-format json next 2>/dev/null)

COST=$(echo "$RESULT" | jq -r '.cost.total')
INPUT=$(echo "$RESULT" | jq -r '.cost.input_tokens')
OUTPUT=$(echo "$RESULT" | jq -r '.cost.output_tokens')

echo "Cost: \$$COST (${INPUT} in / ${OUTPUT} out)"
```

### Session Resumption

```bash
# First run — capture session ID
RESULT=$(gsd headless --output-format json next 2>/dev/null)
SESSION_ID=$(echo "$RESULT" | jq -r '.sessionId')

# Resume the same session later
gsd headless --resume "$SESSION_ID" --output-format json next 2>/dev/null
```

### Artifact Collection

```bash
RESULT=$(gsd headless --output-format json auto 2>/dev/null)

# List files created/modified
echo "$RESULT" | jq -r '.artifacts[]?'

# List commits made
echo "$RESULT" | jq -r '.commits[]?'
```

## Example Result

```json
{
  "status": "success",
  "exitCode": 0,
  "sessionId": "abc123def456",
  "duration": 45200,
  "cost": {
    "total": 0.42,
    "input_tokens": 15000,
    "output_tokens": 3500,
    "cache_read_tokens": 8000,
    "cache_write_tokens": 2000
  },
  "toolCalls": 12,
  "events": 87,
  "milestone": "M001",
  "phase": "executing",
  "nextAction": "dispatch",
  "artifacts": [
    ".gsd/milestones/M001/slices/S01/tasks/T01-SUMMARY.md"
  ],
  "commits": [
    "a1b2c3d"
  ]
}
```

## Combined with `query` for Full Picture

The `HeadlessJsonResult` captures what happened during a session. Use `query` for the current project state:

```bash
# What happened in this step?
RESULT=$(gsd headless --output-format json next 2>/dev/null)
echo "$RESULT" | jq '{status, cost: .cost.total, phase}'

# What's the overall project state now?
gsd headless query | jq '{phase: .state.phase, progress: .state.progress, totalCost: .cost.total}'
```
