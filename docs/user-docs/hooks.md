# Hooks

Hooks let you run shell commands at specific points in GSD's lifecycle without
writing a TypeScript extension. They're configured under the `hooks` key in
`settings.json`.

## Configuration

Add a `hooks` object to your global settings at `~/.pi/agent/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "match": { "tool": "bash" }, "command": "my-linter --stdin" }
    ],
    "PostToolUse": [
      { "match": { "tool": ["edit", "write"] }, "command": "prettier --write" }
    ],
    "Stop": [
      { "command": "notify-send 'GSD is done'" }
    ]
  }
}
```

Each hook is a shell command. GSD pipes the event payload to the command's
stdin as JSON. The command may reply with a JSON object on stdout to modify
the pending action (see **Control protocol** below).

### Hook entry fields

| Field     | Type     | Default | Description |
|-----------|----------|---------|-------------|
| `command` | `string` | —       | Shell command to execute |
| `match`   | object   | —       | Filter: `{ tool?: string \| string[]; command?: string }` |
| `timeout` | `number` | 30000   | Timeout in milliseconds |
| `blocking`| `boolean`| `true`  | When `true`, a non-zero exit vetoes the pending action |
| `env`     | object   | —       | Extra environment variables |

The child process also receives `GSD_HOOK_EVENT` and `GSD_HOOK_SCOPE` env vars.

## Available hooks

| Name | Fires on | Can block |
|------|----------|-----------|
| `PreToolUse` | Before every tool call | Yes |
| `PostToolUse` | After every tool call | No |
| `UserPromptSubmit` | When the user submits a prompt | Yes (by exit 1) |
| `SessionStart` | When a session starts | No |
| `SessionEnd` | When the in-process session ends | No |
| `Stop` | Agent reaches true quiescence | No |
| `Notification` | Agent signals a notification (blocked, idle, etc.) | No |
| `Blocked` | Specifically when the agent is blocked awaiting input | No |
| `PreCompact` | Before context compaction | Yes |
| `PostCompact` | After context compaction | No |
| `PreCommit` | Before a git commit | Yes (can rewrite message) |
| `PostCommit` | After a git commit | No |
| `PrePush` | Before a git push | Yes |
| `PostPush` | After a push | No |
| `PrePr` | Before a PR is opened | Yes (can rewrite title/body) |
| `PostPr` | After a PR is opened | No |
| `PreMilestone` | Before a milestone starts (autonomous builds) | No |
| `PostMilestone` | After a milestone ends | No |
| `PreUnit` | Before a unit starts | No |
| `PostUnit` | After a unit ends | No |
| `PreVerify` | Before verification runs | Yes |
| `PostVerify` | After verification — payload includes `failures[]` | No |
| `BudgetThreshold` | Cost crossed a fraction of the budget | Yes (can return `action`) |

## Control protocol

A hook may write a JSON object to stdout to mutate the pending action. Fields
that apply depend on the hook:

```jsonc
// PreToolUse / UserPromptSubmit / PreCompact / PreVerify / PrePush / PreCommit
{ "block": true, "reason": "policy: no rm -rf" }

// PreCommit — rewrite the message
{ "message": "feat(x): clarified intent" }

// PrePr — rewrite title and/or body
{ "title": "...", "body": "..." }

// BudgetThreshold — override the enforcement action
{ "action": "pause" }   // or "downgrade" | "continue"
```

Any non-JSON stdout is ignored (your command can still print progress). A
non-zero exit code counts as a block for `blocking: true` hooks (the default).

## Project-scoped hooks (trust model)

Hooks declared in `.pi/settings.json` (project-local) **are not executed
unless the user has explicitly trusted them**. This prevents a cloned
repository from running arbitrary shell commands on your machine.

To trust project hooks, create a marker file:

```shell
touch .pi/hooks.trusted
```

Hooks from the global config at `~/.pi/agent/settings.json` always run —
global settings are under the user's direct control.

## Example: block dangerous bash commands

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "match": { "tool": "bash" },
        "command": "jq -e '.input.command | test(\"rm -rf\")' > /dev/null && echo '{\"block\":true,\"reason\":\"rm -rf blocked by policy\"}' || true"
      }
    ]
  }
}
```

## Example: lint on commit

```json
{
  "hooks": {
    "PreCommit": [
      { "command": "eslint --fix $(jq -r '.files[]')" }
    ]
  }
}
```

## Example: notify on stop

```json
{
  "hooks": {
    "Stop": [
      { "command": "terminal-notifier -title GSD -message 'Agent stopped'" }
    ]
  }
}
```

## Claude Code compatibility

Hook names and the JSON stdin/stdout protocol mirror Claude Code's hooks, so
most existing Claude Code hook commands work unchanged. The one-to-one event
mapping lets you copy a Claude Code `settings.json` hooks block and drop it
into GSD with no modifications.
