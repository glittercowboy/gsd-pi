# Context Files — Project Instructions

Pi loads instruction files automatically at startup:

### AGENTS.md (or CLAUDE.md)

Pi looks for `AGENTS.md` or `CLAUDE.md` in:
1. `~/.gsd/agent/AGENTS.md` (global)
2. Every parent directory from cwd up to filesystem root
3. Current directory

All matching files are concatenated and included in the system prompt. Use these for project conventions, common commands, architectural notes.

### System Prompt Override

Replace the default system prompt entirely:
- `.gsd/SYSTEM.md` (project)
- `~/.gsd/agent/SYSTEM.md` (global)

Append to it instead:
- `.gsd/APPEND_SYSTEM.md` (project)
- `~/.gsd/agent/APPEND_SYSTEM.md` (global)

### File Arguments

Include files directly in prompts from the CLI:

```bash
pi @prompt.md "Answer this"
pi -p @screenshot.png "What's in this image?"
pi @code.ts @test.ts "Review these files"
```

---
