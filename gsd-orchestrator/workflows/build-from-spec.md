# Build From Spec

End-to-end workflow: take a product idea or specification, produce working software.

## Prerequisites

- `gsd` CLI installed (`npm install -g gsd-pi`)
- A directory for the project (can be empty)
- Git initialized in the directory

## Process

### Step 1: Prepare the project directory

```bash
PROJECT_DIR="/tmp/my-project-name"
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"
git init 2>/dev/null  # GSD needs a git repo
```

### Step 2: Write the spec file

Write a spec file that describes what to build. More detail = better results.

```bash
cat > spec.md << 'SPEC'
# Product Name

## What
[Concrete description of what to build]

## Requirements
- [Specific, testable requirement 1]
- [Specific, testable requirement 2]
- [Specific, testable requirement 3]

## Technical Constraints
- [Language, framework, or platform requirements]
- [External services or APIs involved]
- [Performance or security requirements]

## Out of Scope
- [Things explicitly NOT included]
SPEC
```

**Spec quality matters.** Vague specs produce vague results. Include:
- What the user can DO when it's done (not what code to write)
- Technical constraints (language, framework, Node version)
- What's out of scope (prevents scope creep)

### Step 3: Launch the build

**Fire-and-forget (simplest — GSD does everything):**
```bash
cd "$PROJECT_DIR"
RESULT=$(gsd headless --output-format json --timeout 0 --context spec.md new-milestone --auto 2>/dev/null)
EXIT=$?
```

`--timeout 0` disables the timeout for long builds. `--auto` chains milestone creation into execution.

**With budget limit:**
```bash
# Use step-by-step mode with budget checks instead of auto
# See workflows/step-by-step.md
```

**For CI or ecosystem runs (no user config):**
```bash
RESULT=$(gsd headless --bare --output-format json --timeout 0 --context spec.md new-milestone --auto 2>/dev/null)
EXIT=$?
```

### Step 4: Handle the result

```bash
case $EXIT in
  0)
    # Success — verify deliverables
    STATUS=$(echo "$RESULT" | jq -r '.status')
    COST=$(echo "$RESULT" | jq -r '.cost.total')
    COMMITS=$(echo "$RESULT" | jq -r '.commits | length')
    echo "Build complete: $STATUS, cost: \$$COST, commits: $COMMITS"

    # Inspect what was built
    gsd headless query | jq '.state.progress'

    # Check the actual files
    ls -la "$PROJECT_DIR"
    ;;
  1)
    # Error — inspect and decide
    echo "Build failed"
    echo "$RESULT" | jq '{status: .status, phase: .phase}'

    # Check state for details
    gsd headless query | jq '.state'
    ;;
  10)
    # Blocked — needs intervention
    echo "Build blocked — needs human input"
    gsd headless query | jq '{phase: .state.phase, blockers: .state.blockers}'

    # Options: steer, supply answers, or escalate
    # See workflows/monitor-and-poll.md for blocker handling
    ;;
  11)
    echo "Build was cancelled"
    ;;
esac
```

### Step 5: Verify deliverables

After a successful build, verify the output:

```bash
cd "$PROJECT_DIR"

# Check project state
gsd headless query | jq '{
  phase: .state.phase,
  progress: .state.progress,
  cost: .cost.total
}'

# Check git log for what was built
git log --oneline

# Run the project's own tests if they exist
[ -f package.json ] && npm test 2>/dev/null
[ -f Makefile ] && make test 2>/dev/null
```

## Complete Example

```bash
# 1. Setup
mkdir -p /tmp/todo-api && cd /tmp/todo-api && git init

# 2. Write spec
cat > spec.md << 'SPEC'
# Todo API

Build a REST API for managing todo items using Node.js and Express.

## Requirements
- GET /todos — list all todos
- POST /todos — create a todo (title, completed)
- PUT /todos/:id — update a todo
- DELETE /todos/:id — delete a todo
- Todos stored in-memory (no database)
- Input validation with descriptive error messages
- Health check endpoint at GET /health

## Technical Constraints
- Node.js with ESM modules
- Express framework
- No external database — in-memory array
- Port configurable via PORT env var (default 3000)

## Out of Scope
- Authentication
- Persistent storage
- Frontend
SPEC

# 3. Launch
RESULT=$(gsd headless --output-format json --timeout 0 --context spec.md new-milestone --auto 2>/dev/null)
EXIT=$?

# 4. Report
if [ $EXIT -eq 0 ]; then
  COST=$(echo "$RESULT" | jq -r '.cost.total')
  echo "Build complete (\$$COST)"
  echo "Files created:"
  find . -not -path './.gsd/*' -not -path './.git/*' -type f
else
  echo "Build failed (exit $EXIT)"
  echo "$RESULT" | jq .
fi
```
