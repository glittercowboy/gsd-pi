<feature_patterns>
Advanced workflow features: `context_from`, `iterate`, and `params`. Each section includes a complete YAML example.

**Feature 1: `context_from` — Context Chaining**

Injects artifacts from prior steps as context when the current step runs. The value is an array of step IDs.

```yaml
version: 1
name: research-and-synthesize
steps:
  - id: gather
    name: Gather sources
    prompt: "Find and summarize the top 5 sources on the topic."
    produces:
      - sources.md

  - id: analyze
    name: Analyze sources
    prompt: "Analyze the gathered sources for key themes."
    requires:
      - gather
    context_from:
      - gather
    produces:
      - analysis.md

  - id: synthesize
    name: Write synthesis
    prompt: "Synthesize the analysis into a coherent report."
    requires:
      - analyze
    context_from:
      - gather
      - analyze
    produces:
      - report.md
```

How it works:
- `context_from: [gather]` means the engine includes artifacts from the `gather` step when executing `analyze`.
- You can reference multiple prior steps: `context_from: [gather, analyze]`.
- The referenced steps must exist in the workflow (they are validated as step IDs).
- `context_from` does not imply a dependency — if you want the step to wait, also add the ID to `requires`.

**Feature 2: `iterate` — Fan-Out Iteration**

Reads an artifact, applies a regex pattern, and creates one sub-execution per match. The capture group extracts the iteration variable.

```yaml
version: 1
name: file-by-file-review
steps:
  - id: inventory
    name: List files to review
    prompt: "List all TypeScript files in src/ that need review, one per line."
    produces:
      - file-list.txt

  - id: review
    name: Review each file
    prompt: "Review the file for code quality issues."
    requires:
      - inventory
    iterate:
      source: file-list.txt
      pattern: "^(.+\\.ts)$"
    produces:
      - reviews/
```

How it works:
- `source`: Path to an artifact (relative to the run directory). Must not contain `..`.
- `pattern`: A regex string applied with the global flag. Must contain at least one capture group `(...)`.
- The engine reads the source artifact, applies the pattern, and creates one execution per match.
- Each capture group match becomes available as the iteration variable.
- The regex is validated at definition-load time — invalid regex or missing capture groups are rejected.

Pattern requirements:
- Must be a valid JavaScript regex.
- Must contain at least one non-lookahead capture group: `(...)` not `(?:...)`.
- Example valid patterns: `^(.+)$`, `- (.+\.ts)`, `\[(.+?)\]`.

**Feature 3: `params` — Parameterized Workflows**

Define default parameter values at the top level. Use `{{ key }}` placeholders in step prompts. CLI overrides take precedence.

```yaml
version: 1
name: blog-post
description: Generate a blog post on a configurable topic.
params:
  topic: "AI in healthcare"
  audience: "technical professionals"
  word_count: "1500"
steps:
  - id: outline
    name: Create outline
    prompt: "Create a detailed outline for a blog post about {{ topic }} targeting {{ audience }}."
    produces:
      - outline.md

  - id: draft
    name: Write draft
    prompt: "Write a {{ word_count }}-word blog post about {{ topic }} for {{ audience }} based on the outline."
    requires:
      - outline
    context_from:
      - outline
    produces:
      - draft.md
    verify:
      policy: content-heuristic
      minSize: 500
```

How it works:
- `params` is a top-level object mapping string keys to string default values.
- `{{ key }}` in any step prompt is replaced with the corresponding param value.
- Merge order: definition `params` (defaults) ← CLI overrides (win).
- After substitution, any remaining `{{ key }}` that has no value causes an error — all placeholders must resolve.
- Parameter values must not contain `..` (path traversal guard).
- Keys in `{{ }}` match `\w+` (letters, digits, underscore).

Common usage:
- Make workflows reusable across different topics, projects, or configurations.
- Users override defaults at run time: `/gsd workflow run blog-post topic="Rust performance"`.
</feature_patterns>
