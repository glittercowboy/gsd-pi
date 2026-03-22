<workflow>
Guide the user through creating a workflow definition from scratch. Follow these phases in order.

<required_reading>
Before starting, read these references so you can answer schema questions accurately:
- `../references/yaml-schema-v1.md` — all fields, types, and constraints
- `../references/verification-policies.md` — the four verify policies
- `../references/feature-patterns.md` — context_from, iterate, params patterns
</required_reading>

<phase name="purpose">
Ask the user:
- "What does this workflow accomplish? Give me a one-sentence description."
- "What should the workflow be named?" (suggest a kebab-case name based on their description)

Record: `name`, `description`.
</phase>

<phase name="steps">
Ask the user:
- "What are the main steps? List them in order. For each step, give a short name and what it should do."

For each step the user describes:
1. Generate an `id` (lowercase, short, descriptive — e.g., `gather`, `analyze`, `write-draft`).
2. Confirm the `name` (human-readable).
3. Write the `prompt` — this is the instruction the engine dispatches. It should be detailed enough for an LLM to execute independently.
4. Ask: "Does this step depend on any previous steps?" → populate `requires`.
5. Ask: "What files or artifacts does this step produce?" → populate `produces`.
</phase>

<phase name="verification">
For each step, ask:
- "How should we verify this step's output?"
  - **No verification needed** → omit `verify`
  - **Check that the output exists and has content** → `content-heuristic`
  - **Run a shell command to validate** → `shell-command` (ask for the command)
  - **Have an LLM review the output** → `prompt-verify` (ask for the verification prompt)
  - **Require human approval** → `human-review`

Refer to `../references/verification-policies.md` for the exact YAML structure of each policy.
</phase>

<phase name="context_chaining">
Ask:
- "Should any step receive artifacts from earlier steps as context?"

If yes, for each such step:
- Ask which prior steps to pull context from → populate `context_from`.
- Remind the user: `context_from` does not imply a dependency. If the step should wait for the context source, it must also list it in `requires`.
</phase>

<phase name="parameters">
Ask:
- "Should any values in this workflow be configurable at run time? (e.g., a topic, a target directory, a language)"

If yes:
- Define each parameter with a default value in top-level `params`.
- Replace hardcoded values in step prompts with `{{ key }}` placeholders.
- Explain: "Users can override these when running the workflow."
</phase>

<phase name="iteration">
Ask:
- "Does any step need to fan out — running once per item in a list? (e.g., review each file, process each section)"

If yes:
- Identify the source artifact (the list to iterate over).
- Define the `pattern` regex with a capture group to extract each item.
- Set `iterate.source` and `iterate.pattern` on the step.
- Refer to `../references/feature-patterns.md` for examples.
</phase>

<phase name="assemble">
Assemble the complete YAML definition:

1. Start with `version: 1`.
2. Add `name` and `description`.
3. Add `params` if any were defined.
4. Add `steps` in dependency order.
5. For each step, include all configured fields in this order: `id`, `name`, `prompt`, `requires`, `produces`, `context_from`, `verify`, `iterate`.
6. Use 2-space indentation.

Show the complete YAML to the user for review.

Ask: "Does this look correct? Any changes?"

Apply any requested changes.
</phase>

<phase name="write">
Write the file to `.gsd/workflow-defs/<name>.yaml`.

Tell the user:
- "Definition saved to `.gsd/workflow-defs/<name>.yaml`."
- "Run `/gsd workflow validate <name>` to check it against the schema."
- "Run `/gsd workflow run <name>` to execute it."
</phase>

<success_criteria>
- A valid YAML file exists at `.gsd/workflow-defs/<name>.yaml`
- The definition passes `validateDefinition()` from `definition-loader.ts`
- The user has reviewed and approved the definition
</success_criteria>
</workflow>
