# The System Prompt Anatomy

How pi's system prompt is built, what goes into it, when it's rebuilt, and every lever you have to shape it.

---

## The Final Prompt Structure

When `buildSystemPrompt()` runs, it assembles sections in this exact order:

```
┌──────────────────────────────────────────────────┐
│ 1. Base prompt (default or SYSTEM.md override)   │
│    ├── Identity statement                        │
│    ├── Available tools list                      │
│    ├── Custom tools note                         │
│    ├── Guidelines                                │
│    └── Pi documentation pointers                 │
│                                                  │
│ 2. Append system prompt (APPEND_SYSTEM.md)       │
│                                                  │
│ 3. Project context files                         │
│    ├── ~/.gsd/agent/AGENTS.md (global)            │
│    ├── Ancestor AGENTS.md / CLAUDE.md files      │
│    └── cwd AGENTS.md / CLAUDE.md                 │
│                                                  │
│ 4. Skills listing                                │
│    └── <available_skills> XML block              │
│                                                  │
│ 5. Date/time and working directory               │
└──────────────────────────────────────────────────┘
```

After `buildSystemPrompt()`, extensions can further modify via `before_agent_start`.

---

## Section 1: The Base Prompt

### Default Base Prompt (no SYSTEM.md)

When no SYSTEM.md exists, pi uses its built-in base:

```
You are an expert coding assistant operating inside pi, a coding agent harness.
You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make surgical edits to files (find exact text and replace)
- write: Create or overwrite files
- my_custom_tool: [promptSnippet or description]

In addition to the tools above, you may have access to other custom tools
depending on the project.

Guidelines:
- Use bash for file operations like ls, rg, find
- Use read to examine files before editing. You must use this tool instead of cat or sed.
- Use edit for precise changes (old text must match exactly)
- Use write only for new files or complete rewrites
- [extension tool promptGuidelines inserted here]
- Be concise in your responses
- Show file paths clearly when working with files

Pi documentation (read only when the user asks about pi itself...):
- Main documentation: [path]
- Additional docs: [path]
- Examples: [path]
```

### SYSTEM.md Override (full replacement)

If `.gsd/SYSTEM.md` (project) or `~/.gsd/agent/SYSTEM.md` (global) exists, its contents **completely replace** the default base prompt above. The tools list, guidelines, pi docs pointers — all gone. You own the entire base.

Project takes precedence over global. Only one SYSTEM.md is used (first found wins).

**What still gets appended even with a custom SYSTEM.md:**
- APPEND_SYSTEM.md content
- Project context files (AGENTS.md / CLAUDE.md)
- Skills listing (if the `read` tool is active)
- Date/time and cwd

**What you lose:**
- The entire default prompt structure
- Built-in tool descriptions and guidelines
- Pi documentation pointers
- Dynamic guidelines from `promptGuidelines` on tools

### How Tool Descriptions Appear

Each active tool gets a line in "Available tools":

```
- toolname: [one-line description]
```

The description is determined by priority:
1. `promptSnippet` from the tool registration (if provided)
2. Built-in description from `toolDescriptions` map (for read, bash, edit, write, grep, find, ls)
3. The tool's `name` as fallback

`promptSnippet` is normalized: newlines collapsed to spaces, trimmed to a single line.

### How Guidelines Are Built

Guidelines are assembled dynamically based on which tools are active:

| Condition | Guideline |
|---|---|
| bash active, no grep/find/ls | "Use bash for file operations like ls, rg, find" |
| bash active + grep/find/ls | "Prefer grep/find/ls tools over bash for file exploration" |
| read + edit active | "Use read to examine files before editing" |
| edit active | "Use edit for precise changes (old text must match exactly)" |
| write active | "Use write only for new files or complete rewrites" |
| edit or write active | "When summarizing your actions, output plain text directly" |
| Always | "Be concise in your responses" |
| Always | "Show file paths clearly when working with files" |

**Extension tool guidelines** from `promptGuidelines` are appended after the built-in guidelines. They're deduplicated (same string appears only once even if multiple tools register it).

---

## Section 2: Append System Prompt

If `.gsd/APPEND_SYSTEM.md` (project) or `~/.gsd/agent/APPEND_SYSTEM.md` (global) exists, its contents are appended after the base prompt.

This is the safe way to add project-wide instructions without replacing the default prompt. It works with both the default base and a custom SYSTEM.md.

---

## Section 3: Project Context Files

Pi walks the filesystem collecting context files:

```
1. ~/.gsd/agent/AGENTS.md (global)
2. Walk from cwd upward to root:
   - Each directory: check for AGENTS.md, then CLAUDE.md (first found wins per directory)
   - Files are collected root-down (ancestors first, cwd last)
```

All found files are concatenated under a "# Project Context" header:

```markdown
# Project Context

Project-specific instructions and guidelines:

## /Users/you/.gsd/agent/AGENTS.md

[global AGENTS.md content]

## /Users/you/projects/myapp/AGENTS.md

[project AGENTS.md content]
```

**AGENTS.md vs CLAUDE.md:** Both are treated identically. Per directory, AGENTS.md is checked first. If it exists, CLAUDE.md in the same directory is skipped.

---

## Section 4: Skills Listing

If the `read` tool is active and skills are loaded, an XML block is appended:

```xml
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory.

<available_skills>
  <skill>
    <name>commit-outstanding</name>
    <description>Commit all uncommitted files in logical groups</description>
    <location>/Users/you/.agents/skills/commit-outstanding/SKILL.md</location>
  </skill>
</available_skills>
```

Skills with `disable-model-invocation: true` in their frontmatter are excluded from this listing.

**Key design:** Only names, descriptions, and file paths go into the system prompt. The full skill content is NOT loaded. The agent uses the `read` tool to load specific skills on demand. This keeps the system prompt small even with many skills.

---

## Section 5: Date/Time and CWD

Always appended last:

```
Current date and time: Saturday, March 7, 2026 at 08:55:05 AM CST
Current working directory: /Users/you/projects/myapp
```

---

## When the System Prompt Is Rebuilt

The base system prompt (`_baseSystemPrompt`) is rebuilt in these situations:

| Trigger | What happens |
|---|---|
| **Startup** (`_buildRuntime`) | Full rebuild with initial tool set |
| **`setActiveToolsByName()`** | Rebuild with new tool set (guidelines and snippets change) |
| **`reload()`** (`/reload`) | Full rebuild — reloads SYSTEM.md, APPEND_SYSTEM.md, context files, skills, extensions |
| **`extendResourcesFromExtensions()`** | Rebuild after `resources_discover` adds new skills/prompts/themes |
| **`_refreshToolRegistry()`** | Rebuild when extension tools change dynamically |

### Per-Prompt Modifications

On each user prompt, the `before_agent_start` hook can modify the system prompt. This modification is **not persisted** — the base prompt is restored if no extension modifies it on the next prompt:

```
User prompt 1:
  before_agent_start → extensions modify system prompt → LLM sees modified version

User prompt 2:
  before_agent_start → no extensions modify → LLM sees base system prompt (reset)
```

This means `before_agent_start` modifications are truly per-prompt. You cannot make a permanent system prompt change through this hook alone (the change must be re-applied every time).

---

## Every Lever for Shaping the System Prompt

From static configuration to dynamic extension hooks, ordered from broadest to most targeted:

### Static (file-based, loaded at startup)

| Mechanism | Scope | Effect |
|---|---|---|
| `SYSTEM.md` | Replace base prompt entirely | Nuclear option — you own everything |
| `APPEND_SYSTEM.md` | Append to base prompt | Safe additive instructions |
| `AGENTS.md` / `CLAUDE.md` | Project context section | Per-project conventions and rules |
| Skill `SKILL.md` files | Skills listing | On-demand capability descriptions |

### Dynamic (extension-based, runtime)

| Mechanism | Scope | Timing | Effect |
|---|---|---|---|
| `before_agent_start` → `systemPrompt` | Full prompt | Per user prompt | Modify/append/replace system prompt |
| `promptSnippet` on tools | Tool description line | When tool set changes | Custom one-liner in "Available tools" |
| `promptGuidelines` on tools | Guidelines section | When tool set changes | Add behavioral bullets |
| `pi.setActiveTools()` | Tool list + guidelines | Immediate, next prompt | Add/remove tools (rebuilds prompt) |
| `resources_discover` event | Skills listing | Startup + reload | Inject additional skills from extensions |

### Per-Turn (message-based, not system prompt)

These don't modify the system prompt but add to what the LLM sees:

| Mechanism | Timing | Effect |
|---|---|---|
| `before_agent_start` → `message` | Per user prompt | Inject custom message (becomes user role) |
| `context` event | Per LLM turn | Filter/inject/transform message array |
| `pi.sendMessage()` | Anytime | Inject custom message into conversation |

---

## Practical Tradeoffs

### SYSTEM.md vs before_agent_start

| | SYSTEM.md | before_agent_start |
|---|---|---|
| **Persistence** | Permanent until file changes | Per-prompt, must re-apply |
| **Dynamism** | Static file content | Can compute based on state |
| **Tool awareness** | Loses built-in tool guidelines | Preserves base prompt, appends |
| **Composability** | Only one SYSTEM.md (project or global) | Multiple extensions can chain |

**Recommendation:** Use SYSTEM.md only when you genuinely need to replace the entire prompt (e.g., custom agent personality, non-coding use case). Use `before_agent_start` for everything else.

### APPEND_SYSTEM.md vs AGENTS.md

Both append content, but they appear in different sections:

- **APPEND_SYSTEM.md** appears immediately after the base prompt, before "# Project Context"
- **AGENTS.md** appears inside "# Project Context" with a `## filepath` header

Functionally equivalent for the LLM. Use APPEND_SYSTEM.md for instructions that feel like system-level directives. Use AGENTS.md for project-specific conventions and context.

### promptGuidelines vs before_agent_start

| | promptGuidelines | before_agent_start |
|---|---|---|
| **Scope** | Only when the tool is active | Always (or conditionally in your code) |
| **Positioning** | Inside "Guidelines" section | Appended to end (or wherever you put it) |
| **Tool coupling** | Automatically appears/disappears with tool | Independent of tool state |

**Recommendation:** Use `promptGuidelines` for instructions directly related to tool usage. Use `before_agent_start` for behavioral modifications independent of tool state.

---

## The Full Context Surface Area

Everything the LLM sees on a given turn:

```
System prompt (built from all sources above + before_agent_start mods)
  +
Message array (after context event filtering + convertToLlm):
  - Compaction summaries (user role)
  - Branch summaries (user role)
  - Historical user/assistant/toolResult messages
  - Bash execution results (user role, unless !! excluded)
  - Custom messages from extensions (user role)
  - Current prompt + before_agent_start injected messages
  +
Tool definitions:
  - name, description, parameter JSON schema
  - Only for active tools (pi.getActiveTools())
```

Understanding this complete surface area — and which levers control which parts — is the key to effective context engineering in pi.
