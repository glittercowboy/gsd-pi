# Monitor and Poll

Check status of a GSD project, handle blockers, track costs, and decide next actions.

## Checking Project State

The `query` command is your primary monitoring tool. It's instant (~50ms), costs nothing (no LLM), and returns the full project snapshot.

```bash
cd /path/to/project
gsd headless query
```

### Key fields to inspect

```bash
# Overall status
gsd headless query | jq '{
  phase: .state.phase,
  milestone: .state.activeMilestone.id,
  slice: .state.activeSlice.id,
  task: .state.activeTask.id,
  progress: .state.progress,
  cost: .cost.total
}'

# What should happen next
gsd headless query | jq '.next'
# Returns: { "action": "dispatch", "unitType": "execute-task", "unitId": "M001/S01/T01" }

# Is it done?
gsd headless query | jq '.state.phase'
# "complete" = done, "blocked" = needs you, anything else = in progress
```

### Phase meanings

| Phase | Meaning | Your action |
|-------|---------|-------------|
| `pre-planning` | Milestone exists, no slices planned yet | Run `auto` or `next` |
| `needs-discussion` | Ambiguities need resolution | Supply answers or run with defaults |
| `discussing` | Discussion in progress | Wait |
| `researching` | Codebase/library research | Wait |
| `planning` | Creating task plans | Wait |
| `executing` | Writing code | Wait |
| `verifying` | Checking must-haves | Wait |
| `summarizing` | Recording what happened | Wait |
| `advancing` | Moving to next task/slice | Wait |
| `evaluating-gates` | Quality checks before execution | Wait or run `next` |
| `validating-milestone` | Final milestone checks | Wait |
| `completing-milestone` | Archiving and cleanup | Wait |
| `complete` | Done | Verify deliverables |
| `blocked` | Needs human input | Handle blocker (see below) |
| `paused` | Explicitly paused | Resume with `auto` |

## Handling Blockers

When exit code is `10` or phase is `blocked`:

```bash
# 1. Understand the blocker
gsd headless query | jq '{phase: .state.phase, blockers: .state.blockers, nextAction: .state.nextAction}'

# 2. Option A: Steer around it
gsd headless steer "Skip the database dependency, use in-memory storage instead"

# 3. Option B: Supply pre-built answers
cat > fix.json << 'EOF'
{
  "questions": { "blocked_question_id": "workaround_option" },
  "defaults": { "strategy": "first_option" }
}
EOF
gsd headless --answers fix.json auto

# 4. Option C: Force a specific phase
gsd headless dispatch replan

# 5. Option D: Escalate to user
echo "GSD build blocked. Phase: $(gsd headless query | jq -r '.state.phase')"
echo "Manual intervention required."
```

## Cost Tracking

```bash
# Current cumulative cost
gsd headless query | jq '.cost.total'

# Per-worker breakdown
gsd headless query | jq '.cost.workers'

# After a step (from HeadlessJsonResult)
RESULT=$(gsd headless --output-format json next 2>/dev/null)
echo "$RESULT" | jq '.cost'
```

### Budget enforcement pattern

```bash
MAX_BUDGET=15.00

check_budget() {
  TOTAL=$(gsd headless query | jq -r '.cost.total')
  OVER=$(echo "$TOTAL > $MAX_BUDGET" | bc -l)
  if [ "$OVER" = "1" ]; then
    echo "Budget exceeded: \$$TOTAL > \$$MAX_BUDGET"
    gsd headless stop
    return 1
  fi
  return 0
}
```

## Poll-and-React Loop

For agents that need to periodically check on a build:

```bash
cd /path/to/project

poll_project() {
  STATE=$(gsd headless query 2>/dev/null)
  if [ -z "$STATE" ]; then
    echo "NO_PROJECT"
    return
  fi

  PHASE=$(echo "$STATE" | jq -r '.state.phase')
  COST=$(echo "$STATE" | jq -r '.cost.total')
  PROGRESS=$(echo "$STATE" | jq -r '"\(.state.progress.milestones.done)/\(.state.progress.milestones.total) milestones, \(.state.progress.tasks.done)/\(.state.progress.tasks.total) tasks"')

  case "$PHASE" in
    complete)
      echo "COMPLETE cost=\$$COST progress=$PROGRESS"
      ;;
    blocked)
      BLOCKER=$(echo "$STATE" | jq -r '.state.nextAction // "unknown"')
      echo "BLOCKED reason=$BLOCKER cost=\$$COST"
      ;;
    *)
      NEXT=$(echo "$STATE" | jq -r '.next.action // "none"')
      echo "IN_PROGRESS phase=$PHASE next=$NEXT cost=\$$COST progress=$PROGRESS"
      ;;
  esac
}
```

## Resuming Work

If a build was interrupted or you need to continue:

```bash
cd /path/to/project

# Check current state
gsd headless query | jq '.state.phase'

# Resume from where it left off
gsd headless --output-format json auto 2>/dev/null

# Or resume a specific session
gsd headless --resume "$SESSION_ID" --output-format json auto 2>/dev/null
```

## Reading Build Artifacts

After completion, inspect what GSD produced:

```bash
cd /path/to/project

# Project summary
cat .gsd/PROJECT.md

# What was decided
cat .gsd/DECISIONS.md

# Requirements and their validation status
cat .gsd/REQUIREMENTS.md

# Milestone summary
cat .gsd/milestones/M001-*/M001-*-SUMMARY.md 2>/dev/null

# Git history (GSD commits per-slice)
git log --oneline
```
