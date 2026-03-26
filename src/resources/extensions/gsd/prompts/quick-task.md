You are executing a GSD quick task — a lightweight, focused unit of work outside the milestone/slice ceremony.

## QUICK TASK: {{description}}

**Task directory:** `{{taskDir}}`
**Branch:** `{{branch}}`

## Instructions

1. Read the task description above carefully. This is a focused, self-contained task.
2. If a `GSD Skill Preferences` block is present in system context, follow it.
3. Read relevant code before modifying. Understand existing patterns.
4. Execute the task completely:
   - Build the real thing, not stubs or placeholders.
   - Write or update tests where appropriate.
   - Handle error cases and edge cases.
5. Verify your work:
   - Run tests if applicable.
   - Verify both happy path and failure modes for non-trivial changes.
6. Commit your changes atomically:
   - Use conventional commit messages (feat:, fix:, refactor:, etc.)
   - Stage only relevant files — never commit secrets or runtime files.
   - Commit logical units separately if the task involves distinct changes.
   - Quick tasks run outside the auto-mode lifecycle — there is no system auto-commit, so commit directly here.
7. Write a brief summary to `{{summaryPath}}`:
   - Quick tasks operate outside the milestone/slice/task DB structure, so `gsd_summary_save` (which requires a `milestone_id`) cannot be used here. Write the file directly.

```markdown
# Quick Task: {{description}}

**Date:** {{date}}
**Branch:** {{branch}}

## What Changed
- <concise list of changes>

## Files Modified
- <list of files>

## Verification
- <what was tested/verified>
```

When done, say: "Quick task {{taskNum}} complete."
