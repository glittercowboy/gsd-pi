<schema_reference>
V1 Workflow Definition Schema — complete field-by-field reference extracted from `definition-loader.ts`.

**Top-Level Fields:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `version` | number | **yes** | — | Must be exactly `1`. |
| `name` | string | **yes** | — | Non-empty workflow name. |
| `description` | string | no | `undefined` | Optional human-readable description. |
| `params` | object | no | `undefined` | Key-value map of parameter defaults. Values must be strings. Used for `{{ key }}` substitution in step prompts. |
| `steps` | array | **yes** | — | Non-empty array of step objects. |

**Step Fields:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | **yes** | — | Unique identifier within the workflow. Must be non-empty. No two steps can share an ID. |
| `name` | string | **yes** | — | Human-readable step name. Must be non-empty. |
| `prompt` | string | **yes** | — | The prompt dispatched for this step. Must be non-empty. Supports `{{ key }}` parameter placeholders. |
| `requires` | string[] | no | `[]` | IDs of steps that must complete before this step runs. Alternative name: `depends_on`. |
| `depends_on` | string[] | no | `[]` | Alias for `requires`. If both are present, `requires` takes precedence. |
| `produces` | string[] | no | `[]` | Artifact paths produced by this step (relative to run directory). Paths must not contain `..`. |
| `context_from` | string[] | no | `undefined` | Step IDs whose artifacts are injected as context when this step runs. |
| `verify` | object | no | `undefined` | Verification policy for this step. See verification-policies.md for details. |
| `iterate` | object | no | `undefined` | Fan-out iteration config. See feature-patterns.md for details. |

**Validation Rules:**

1. `version` must be exactly `1` (number, not string).
2. `name` must be a non-empty string.
3. `steps` must be a non-empty array of objects.
4. Each step must have non-empty `id`, `name`, and `prompt`.
5. Step IDs must be unique — duplicates are rejected.
6. Dependencies must reference existing step IDs — dangling references are rejected.
7. A step cannot depend on itself.
8. The dependency graph must be acyclic — cycles are detected and rejected.
9. `produces` paths and `iterate.source` must not contain `..` (path traversal guard).
10. Unknown top-level or step-level fields are silently accepted for forward compatibility.

**Type Notes:**

- `requires` / `depends_on`: The engine reads `requires` first. If absent, it falls back to `depends_on`. Both must be arrays of strings if present.
- `params` values must be strings. During substitution, each `{{ key }}` in a step prompt is replaced with the merged param value (definition defaults ← CLI overrides). Any unresolved placeholder after substitution causes an error.
- Parameter values and `produces` paths are guarded against path traversal (`..` is rejected).
</schema_reference>
