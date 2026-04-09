# The Customization Stack

Pi has four layers of customization, each serving a different purpose:

```
┌─────────────────────────────────────┐
│           Extensions                │  ← TypeScript code. Full runtime access.
│  Custom tools, events, UI,          │     Can do anything.
│  commands, providers                │
├─────────────────────────────────────┤
│           Skills                    │  ← Markdown instructions + scripts.
│  On-demand capability packages      │     Loaded when the task matches.
│  loaded by the agent                │
├─────────────────────────────────────┤
│       Prompt Templates              │  ← Markdown snippets.
│  Reusable prompts expanded          │     Quick text expansion via /name.
│  via /templatename                  │
├─────────────────────────────────────┤
│           Themes                    │  ← JSON color definitions.
│  Visual appearance                  │     Hot-reload on change.
└─────────────────────────────────────┘
```

### Extensions

TypeScript modules with full runtime access. They can hook into every event, register tools the LLM can call, add commands, render custom UI, override built-in behavior, and register model providers. Extensions are the most powerful customization mechanism.

**Placement:**
- `~/.gsd/agent/extensions/` (global)
- `.gsd/extensions/` (project-local)

See the companion doc **Pi-Extensions-Complete-Guide.md** for the full 50KB reference.

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). A skill is a directory with a `SKILL.md` file containing instructions the agent follows. Skills are progressive: only their names and descriptions are in the system prompt. The agent reads the full SKILL.md only when the task matches.

**How skills work:**
1. At startup, pi scans for skills and extracts names + descriptions
2. Descriptions are listed in the system prompt
3. When a task matches, the agent uses `read` to load the full SKILL.md
4. The agent follows the instructions, using relative paths for scripts/assets

**Invocation:**
```
/skill:brave-search              # Explicit invocation
/skill:pdf-tools extract file.pdf  # With arguments
```

**Placement:**
- `~/.agents/skills/` (global — shared across all agents)
- `.agents/skills/` (project, searched up to git root)

**Skill structure:**
```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts (optional)
│   └── process.sh
└── references/           # Reference docs (optional)
    └── api-guide.md
```

### Prompt Templates

Markdown files that expand into prompts via `/name`. Simple text expansion with positional argument support (`$1`, `$2`, `$@`).

```markdown
<!-- ~/.gsd/agent/prompts/review.md -->
---
description: Review staged git changes
---
Review the staged changes (`git diff --cached`). Focus on:
- Bugs and logic errors  
- Security issues
- Performance problems
Focus area: $1
```

Usage: `/review "error handling"` → expands with `$1` = "error handling"

**Placement:**
- `~/.gsd/agent/prompts/` (global)
- `.gsd/prompts/` (project-local)

### Themes

JSON files defining the color palette for the TUI. Hot-reload: edit the file and pi applies changes immediately.

**Built-in:** `dark`, `light`

**Placement:**
- `~/.gsd/agent/themes/` (global)
- `.gsd/themes/` (project-local)

---
