# Answer Injection

Pre-supply answers and secrets to eliminate interactive prompts during headless execution.

## Usage

```bash
gsd headless --answers answers.json auto
gsd headless --answers answers.json new-milestone --context spec.md --auto
```

The `--answers` flag takes a path to a JSON file containing pre-supplied answers and secrets.

## Answer File Schema

```json
{
  "questions": {
    "question_id": "selected_option_label",
    "multi_select_question": ["option_a", "option_b"]
  },
  "secrets": {
    "API_KEY": "sk-...",
    "DATABASE_URL": "postgres://..."
  },
  "defaults": {
    "strategy": "first_option"
  }
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `questions` | `Record<string, string \| string[]>` | Map question ID → answer. String for single-select, string array for multi-select. |
| `secrets` | `Record<string, string>` | Map env var name → value. Injected into child process environment variables. |
| `defaults.strategy` | `"first_option" \| "cancel"` | Fallback for unmatched questions. Default: `"first_option"`. |

## How Secrets Work

Secrets are injected as environment variables into the GSD child process:

1. The orchestrator passes the answer file via `--answers`
2. GSD reads the file and sets secret values as env vars in the child process
3. When `secure_env_collect` runs inside the agent, it finds the keys already in `process.env`
4. The tool skips the interactive prompt and reports the keys as "already configured"

Secrets are never logged or included in event streams.

## How Question Matching Works

Two-phase correlation:

1. **Observe** — GSD monitors `tool_execution_start` events for `ask_user_questions` to extract question metadata (ID, options, allowMultiple)
2. **Match** — Subsequent `extension_ui_request` events are correlated to the metadata and responded to with the pre-supplied answer

Handles out-of-order events (extension_ui_request can arrive before tool_execution_start) via a deferred processing queue with 500ms timeout.

## Coexistence with `--supervised`

Both `--answers` and `--supervised` can be active simultaneously. Priority order:

1. Answer injector tries first
2. If no answer found, supervised mode forwards to the orchestrator
3. If no orchestrator response within `--response-timeout`, the auto-responder kicks in

## Without Answer Injection

Headless mode has built-in auto-responders for all prompt types:

| Prompt Type | Default Behavior |
|-------------|-----------------|
| Select | Picks first option |
| Confirm | Auto-confirms |
| Input | Empty string |
| Editor | Returns prefill or empty |

Answer injection overrides these defaults with specific answers when precision matters.

## Diagnostics

The injector tracks statistics printed in the session summary:

| Stat | Description |
|------|-------------|
| `questionsAnswered` | Questions resolved from the answer file |
| `questionsDefaulted` | Questions handled by the default strategy |
| `secretsProvided` | Number of secrets injected |

Unused question IDs and secret keys are warned about at exit.

## Example: Orchestrator with Answers

```bash
# Create answer file
cat > answers.json << 'EOF'
{
  "questions": {
    "test_framework": "vitest",
    "package_manager": "pnpm"
  },
  "secrets": {
    "OPENAI_API_KEY": "sk-...",
    "DATABASE_URL": "postgres://localhost:5432/mydb"
  },
  "defaults": {
    "strategy": "first_option"
  }
}
EOF

# Run with pre-supplied answers
gsd headless --answers answers.json --output-format json auto 2>/dev/null

# Parse result
RESULT=$(gsd headless --answers answers.json --output-format json next 2>/dev/null)
echo "$RESULT" | jq '{status: .status, cost: .cost.total}'
```
