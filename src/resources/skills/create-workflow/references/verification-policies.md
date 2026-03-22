<verification_policies>
The `verify` field on a step defines how the engine validates the step's output. It must be an object with a `policy` field set to one of four values.

**Policy 1: `content-heuristic`**

Checks the artifact content against size and pattern criteria. All sub-fields are optional.

```yaml
verify:
  policy: content-heuristic
  minSize: 500          # optional — minimum byte size of the artifact
  pattern: "## Summary" # optional — string pattern that must appear in the artifact
```

Fields:
- `policy`: `"content-heuristic"` (required)
- `minSize`: number (optional) — minimum artifact size in bytes
- `pattern`: string (optional) — text pattern to match in the artifact content

Use when: You want a lightweight sanity check that the step produced substantive output.

**Policy 2: `shell-command`**

Runs a shell command to verify the step's output. The command's exit code determines pass/fail.

```yaml
verify:
  policy: shell-command
  command: "test -f output/report.md && wc -l output/report.md | awk '{print ($1 > 10)}'"
```

Fields:
- `policy`: `"shell-command"` (required)
- `command`: string (required, non-empty) — shell command to execute

Use when: You need programmatic verification — file existence, test suite execution, linting, compilation, etc.

**Policy 3: `prompt-verify`**

Sends a verification prompt to an LLM to evaluate the step's output.

```yaml
verify:
  policy: prompt-verify
  prompt: "Review the generated API documentation. Does it cover all endpoints with request/response examples? Answer PASS or FAIL with reasoning."
```

Fields:
- `policy`: `"prompt-verify"` (required)
- `prompt`: string (required, non-empty) — the verification prompt sent to the LLM

Use when: Verification requires judgment that can't be expressed as a shell command — quality assessment, completeness review, style conformance.

**Policy 4: `human-review`**

Pauses execution and waits for a human to approve or reject the step's output.

```yaml
verify:
  policy: human-review
```

Fields:
- `policy`: `"human-review"` (required)
- No additional fields.

Use when: The step produces work that requires human judgment — design decisions, public-facing content, security-sensitive changes.

**Validation Details:**

The engine validates the `verify` object at definition-load time:
- `policy` must be one of the four strings above. Any other value is rejected.
- `shell-command` requires a non-empty `command` field. Missing or empty `command` is rejected.
- `prompt-verify` requires a non-empty `prompt` field. Missing or empty `prompt` is rejected.
- `content-heuristic` and `human-review` have no required sub-fields beyond `policy`.
</verification_policies>
