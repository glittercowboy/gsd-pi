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
7. Write a brief summary to `{{summaryPath}}`:

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

8. Update `.gsd/STATE.md` — add or update the "Quick Tasks Completed" table:
   - If the section doesn't exist, create it after "### Blockers/Concerns"
   - Table format: `| # | Description | Date | Commit | Directory |`
   - Add a row: `| {{taskNum}} | {{description}} | {{date}} | <commit-hash> | [{{taskNum}}-{{slug}}](./quick/{{taskNum}}-{{slug}}/) |`
   - Update the "Last activity" line

When done, say: "Quick task {{taskNum}} complete."
