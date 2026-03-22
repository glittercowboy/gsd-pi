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

- Finished definitions go in `.gsd/workflow-defs/<name>.yaml`.
- After writing, tell the user to validate with `/gsd workflow validate <name>`.
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
4. Order top-level fields: `version`, `name`, `description`, `params`, `steps`.
5. Order step fields: `id`, `name`, `prompt`, `requires`, `produces`, `context_from`, `verify`, `iterate`.
6. Write the file to `.gsd/workflow-defs/<name>.yaml`.
7. After writing, tell the user: "Run `/gsd workflow validate <name>` to check the definition."
</output_conventions>
