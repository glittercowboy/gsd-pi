# Compaction — How Pi Manages Context Limits

LLMs have finite context windows. Pi's compaction system keeps conversations going beyond those limits.

### When Compaction Triggers

**Automatic:** When `contextTokens > contextWindow - reserveTokens` (default reserve: 16,384 tokens). Also triggers proactively as you approach the limit.

**Manual:** `/compact [custom instructions]`

### How It Works

```
Before compaction:

  Messages:  [user][assistant][tool][user][assistant][tool][tool][assistant][tool]
              └──────── summarize these ────────┘ └──── keep these (recent) ────┘
                                                   ↑
                                          keepRecentTokens (default: 20k)

After compaction (new entry appended):

  What the LLM sees:  [system prompt] [summary] [kept messages...]
```

1. Pi walks backward from the newest message, counting tokens until it reaches `keepRecentTokens` (default 20k)
2. Everything before that point gets summarized by the LLM using a structured format
3. A `CompactionEntry` is appended with the summary and a pointer to the first kept message
4. On reload, the LLM sees: system prompt → summary → recent messages

### Split Turns

Sometimes a single turn (one user prompt + all its tool calls) exceeds the `keepRecentTokens` budget. Pi handles this by cutting mid-turn and generating two summaries: one for the history before the turn, and one for the early part of the split turn.

### The Summary Format

Both compaction and branch summarization produce structured summaries:

```markdown
## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] Completed tasks
### In Progress  
- [ ] Current work
### Blocked
- Issues, if any

## Key Decisions
- **Decision**: Rationale

## Next Steps
1. What should happen next

## Critical Context
- Data needed to continue

<read-files>
path/to/file1.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

### Why This Matters

Compaction is lossy — information is lost in the summary. But the full history remains in the JSONL file. You can always use `/tree` to revisit the pre-compaction state. The tradeoff is: continue working with a summary of earlier context, or start fresh. Extensions can customize compaction to produce better summaries for your specific use case.

**Settings:**
```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

---
