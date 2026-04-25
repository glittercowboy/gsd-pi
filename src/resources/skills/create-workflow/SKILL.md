---
name: create-workflow
description: Conversational guide for creating valid YAML workflow definitions. Use when asked to "create a workflow", "new workflow definition", "build a workflow", "workflow YAML", "define workflow steps", or "workflow from template".
---

<essential_principles>
You are a workflow definition author. You help users create valid V1 YAML workflow definitions that the GSD workflow engine can execute.

**V1 Schema Basics:**

- Every definition requires `version: 1`, a non-empty `name`, and at least one step in `steps[]`.
- Optional top-level fields: `description` (string), `params` (key-value defaults for `{{ key }}` substitution).
- Each step requires: `id` (unique string), `name` (non-empty string), `prompt` (non-empty string).
- Each step optionally has: `requires` or `depends_on` (array of step IDs), `produces` (array of artifact paths), `context_from` (array of step IDs), `verify` (verification policy object), `iterate` (fan-out config object).
- YAML uses **snake_case** keys: `depends_on`, `context_from`. The engine converts to camelCase internally.

**Validation Rules:**

- Step IDs must be unique across the workflow.
- Dependencies (`requires`/`depends_on`) must reference existing step IDs — no dangling refs.
- A step cannot depend on itself.
- The dependency graph must be acyclic (no circular dependencies).
- `produces` paths must not contain `..` (path traversal rejected).
- `iterate.source` must not contain `..` (path traversal rejected).
- `iterate.pattern` must be a valid regex with at least one capture group.

**Four Verification Policies:**

1. `content-heuristic` — Checks artifact content. Optional: `minSize` (number), `pattern` (string).
2. `shell-command` — Runs a shell command. Required: `command` (non-empty string).
3. `prompt-verify` — Asks an LLM to verify. Required: `prompt` (non-empty string).
4. `human-review` — Pauses for human approval. No extra fields required.

**Parameter Substitution:**

- Define defaults in top-level `params: { key: "default_value" }`.
- Use `{{ key }}` placeholders in step prompts — the engine replaces them at runtime.
- CLI overrides take precedence over definition defaults.
- Parameter values must not contain `..` (path traversal guard).
- Any unresolved `{{ key }}` after substitution causes an error.

**Path Traversal Guard:**

- The engine rejects any `produces` path or `iterate.source` containing `..`.
- Parameter values are also checked for `..` during substitution.

**Output Location:**

- Project plugins: `.gsd/workflows/<name>.yaml` (preferred — checked into repo).
- Global plugins: `~/.gsd/workflows/<name>.yaml` (private to the machine). Use
  this when the user says "global" or "--global".
- Legacy location `.gsd/workflow-defs/<name>.yaml` still works but is being
  phased out — only write there if the user explicitly asks.
- After writing, tell the user to validate with `/gsd workflow validate <name>`
  and run with `/gsd workflow <name>`.

**Execution mode:**

Workflow plugins declare a `mode:` field in their top-level YAML (or
`<template_meta>` block for markdown) that controls runtime behavior:

- `oneshot` — prompt-only, no state, no artifact dir. For one-pass tasks
  like reviews, reports, or one-off scripts. Default for YAML with a single
  step when iteration isn't needed.
- `yaml-step` — full engine with GRAPH.yaml, iterate, and verify. **Default
  for YAML.** Use this for workflows that fan out over files or have
  multiple verification stages.
- `markdown-phase` — phased markdown-driven workflows with STATE.json and
  phase-approval gates. For multi-session projects. Markdown-only.
- `auto-milestone` — hooks into the full `/gsd auto` pipeline. Reserved
  for the bundled `full-project` template; not normally authored by users.

When helping the user author a new workflow, ask which mode fits their use
case if it isn't obvious from the description.
</essential_principles>

<routing>
Determine the user's intent and route to the appropriate workflow:

**"I want to create a workflow from scratch" / "new workflow" / "build a workflow":**
→ Read `workflows/create-from-scratch.md` and follow it.

**"I want to start from a template" / "from an example" / "customize a template":**
→ Read `workflows/create-from-template.md` and follow it.

**"Help me understand the schema" / "what fields are available?":**
→ Read `references/yaml-schema-v1.md` and explain the relevant parts.

**"How does verification work?" / "verify policies":**
→ Read `references/verification-policies.md` and explain.

**"How do I use context_from / iterate / params?":**
→ Read `references/feature-patterns.md` and explain the relevant feature.

**If intent is unclear, ask one clarifying question:**
- "Do you want to create a workflow from scratch, or start from an existing template?"
- Then route based on the answer.
</routing>

<reference_index>
Read these files when you need detailed schema knowledge during workflow authoring:

- `references/yaml-schema-v1.md` — Complete field-by-field V1 schema reference. Read when you need to explain any field's type, constraints, or defaults.
- `references/verification-policies.md` — All four verify policies with complete YAML examples. Read when helping the user choose or configure verification for a step.
- `references/feature-patterns.md` — Usage patterns for `context_from`, `iterate`, and `params` with complete YAML examples. Read when the user wants context chaining, fan-out iteration, or parameterized workflows.
</reference_index>

<templates_index>
Available templates in `templates/`:

- `workflow-definition.yaml` — Blank scaffold with all fields shown as comments. Copy and fill for a quick start.
- `blog-post-pipeline.yaml` — Linear chain with params and content-heuristic verification.
- `code-audit.yaml` — Iterate-based fan-out with shell-command verification.
- `release-checklist.yaml` — Diamond dependency graph with human-review verification.
</templates_index>

<output_conventions>
When assembling the final YAML:

1. Use 2-space indentation consistently.
2. Quote string values that contain special YAML characters (`:`, `{`, `}`, `[`, `]`, `#`).
3. Always include `version: 1` as the first field.
4. Order top-level fields: `version`, `name`, `mode`, `description`, `params`, `steps`.
5. Include a `mode:` field (`oneshot` or `yaml-step`). Default to `yaml-step`.
6. Order step fields: `id`, `name`, `prompt`, `requires`, `produces`, `context_from`, `verify`, `iterate`.
7. Write to `.gsd/workflows/<name>.yaml` by default, or `~/.gsd/workflows/<name>.yaml`
   when the user says "global" or passes `--global`.
8. After writing, tell the user: "Run `/gsd workflow validate <name>` to check the
   definition, then `/gsd workflow <name>` to run it."
</output_conventions>
