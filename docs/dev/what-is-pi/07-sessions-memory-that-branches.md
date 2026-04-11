# Sessions — Memory That Branches

Sessions are pi's memory system. They're more sophisticated than simple conversation history.

### Storage Format

Sessions are **JSONL files** (one JSON object per line). Each line is an "entry" with a `type`, `id`, and `parentId`:

```
~/.gsd/agent/sessions/--path--to--project--/<timestamp>_<uuid>.jsonl
```

### The Entry Tree

Entries form a **tree structure**, not a linear list. This is the key architectural insight:

```
                    ┌─ [user] ─ [assistant] ─ [tool] ─ [assistant]  ← Branch A
[header] ─ [user] ─┤
                    └─ [user] ─ [assistant]                          ← Branch B (via /tree)
```

Every entry has an `id` and `parentId`. When you navigate to a previous point with `/tree` and continue from there, a new branch is created from that point. **All branches coexist in the same file.** Nothing is deleted.

### Entry Types

| Type | Purpose |
|------|---------|
| `session` | Header — file metadata, version, working directory |
| `message` | A conversation message (user, assistant, tool result, custom) |
| `compaction` | Summary of older messages (created by compaction) |
| `branch_summary` | Summary of an abandoned branch (created by `/tree`) |
| `model_change` | Records when the user switched models |
| `thinking_level_change` | Records when the user changed thinking level |
| `custom` | Extension state (NOT sent to LLM) |
| `custom_message` | Extension-injected message (IS sent to LLM) |
| `label` | User bookmark on an entry |
| `session_info` | Session metadata (display name) |

### Message Types Within Entries

Message entries contain typed message objects:

| Role | What it is |
|------|-----------|
| `user` | User's prompt (text and/or images) |
| `assistant` | LLM's response (text, thinking, tool calls) — includes model, provider, usage stats |
| `toolResult` | Output from a tool execution — includes `details` for rendering and state |
| `bashExecution` | Output from user's `!command` (not from LLM tool calls) |
| `custom` | Extension-injected message |
| `branchSummary` | Summary of an abandoned branch |
| `compactionSummary` | Summary from compaction |

### Context Building

When pi needs to send messages to the LLM, it walks the tree from the current leaf to the root:

1. If there's a compaction entry on the path → emit the summary first, then messages from `firstKeptEntryId` onward
2. If there's a branch summary → include it as context
3. Custom message entries → included in LLM context
4. Custom entries (extension state) → NOT included in LLM context

### Session Commands

| Command | What it does |
|---------|-------------|
| `/tree` | Navigate to any point in the session tree and continue from there |
| `/fork` | Create a new session file from the current branch |
| `/resume` | Browse and switch to a previous session |
| `/new` | Start a fresh session |
| `/name <name>` | Set a display name for the session |
| `/session` | Show session info (path, tokens, cost) |
| `/compact` | Manually trigger compaction |

### Branching in Practice

**`/tree`** — In-place branching. You select a previous point, the conversation continues from there. The old branch is preserved and can be revisited. Pi optionally generates a summary of the branch you're leaving so context isn't lost.

**`/fork`** — Creates a new session file from the current branch. Opens a selector, copies history up to the selected point, and puts that message in the editor for modification. Good for "start fresh but keep the context."

---
