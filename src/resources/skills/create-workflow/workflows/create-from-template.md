<workflow>
Guide the user through creating a workflow definition by customizing an existing template.

<required_reading>
Before starting, read these references for schema details:
- `../references/yaml-schema-v1.md` — all fields, types, and constraints
- `../references/verification-policies.md` — the four verify policies
- `../references/feature-patterns.md` — context_from, iterate, params patterns
</required_reading>

<phase name="choose_template">
List the available templates in `templates/`:

1. **workflow-definition.yaml** — Blank scaffold with all fields shown as comments. Best for: starting with the full schema visible.
2. **blog-post-pipeline.yaml** — Linear 3-step chain with `params` (topic, audience) and `content-heuristic` verification. Best for: workflows with sequential steps and configurable inputs.
3. **code-audit.yaml** — 3 steps using `iterate` to fan out over a file list, with `shell-command` verification. Best for: workflows that process each item in a list.
4. **release-checklist.yaml** — 4 steps with diamond dependencies and `human-review` verification. Best for: workflows with branching/merging dependency graphs.

Ask: "Which template would you like to start from?"

Read the chosen template file from `templates/`.
</phase>

<phase name="understand">
Show the user the template contents and explain:
- What each step does
- How the dependencies flow
- What features it demonstrates (params, context_from, iterate, verify)

Ask: "What do you want this workflow to do instead? I'll help you adapt the template."
</phase>

<phase name="customize">
Based on the user's goal, walk through customization:

1. **Rename**: Change `name` and `description` to match the new purpose.
2. **Adjust steps**: Add, remove, or modify steps. For each change:
   - Update `id` and `name` to reflect the new purpose.
   - Rewrite `prompt` for the new task.
   - Update `requires` to reflect new dependency order.
   - Update `produces` for new artifact paths.
3. **Modify params**: Add or remove parameters. Update `{{ key }}` placeholders in prompts to match.
4. **Change verification**: Switch verify policies or adjust policy-specific fields.
5. **Add/remove features**: Add `context_from`, `iterate`, or `params` if the new workflow needs them.

Show the modified YAML after each round of changes. Ask: "Any more changes?"
</phase>

<phase name="validate_and_write">
Once the user approves:

1. Review the YAML for common issues:
   - All step IDs are unique.
   - All `requires` references point to existing step IDs.
   - No circular dependencies.
   - All `{{ key }}` placeholders have corresponding `params` entries.
   - No `..` in `produces` paths or `iterate.source`.

2. Write to `.gsd/workflow-defs/<name>.yaml`.

3. Tell the user:
   - "Definition saved to `.gsd/workflow-defs/<name>.yaml`."
   - "Run `/gsd workflow validate <name>` to check it against the schema."
   - "Run `/gsd workflow run <name>` to execute it."
</phase>

<success_criteria>
- A valid YAML file exists at `.gsd/workflow-defs/<name>.yaml`
- The definition is a meaningful customization of the template, not a copy
- The user has reviewed and approved the definition
</success_criteria>
</workflow>
