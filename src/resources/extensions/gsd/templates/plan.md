# {{sliceId}}: {{sliceTitle}}

**Goal:** {{goal}}
**Demo:** {{demo}}

## Must-Haves

- {{mustHave}}
- {{mustHave}}

## Threat Surface

<!-- Q3: How can this be exploited? OMIT ENTIRELY for simple slices with no auth, user input, or data exposure. -->

- **Abuse**: {{abuseScenarios — parameter tampering, replay, privilege escalation, or N/A}}
- **Data exposure**: {{sensitiveDataAccessible — PII, tokens, secrets, or none}}
- **Input trust**: {{untrustedInput — user input reaching DB/API/filesystem, or none}}

## Requirement Impact

<!-- Q4: What existing promises does this break? OMIT ENTIRELY if no existing requirements are affected. -->

- **Requirements touched**: {{requirementIds — e.g. R001, R003, or none}}
- **Re-verify**: {{whatMustBeRetested — e.g. login flow, API contract, or N/A}}
- **Decisions revisited**: {{decisionIds — e.g. D002, or none}}

## Proof Level

<!-- Omit this section entirely for simple slices where the answer is trivially obvious. -->

- This slice proves: {{contract | integration | operational | final-assembly}}
- Real runtime required: {{yes/no}}
- Human/UAT required: {{yes/no}}

## Verification

<!-- Define what "done" looks like BEFORE detailing tasks.
     This section is the slice's objective stopping condition — execution isn't done
     until everything here passes.

     For non-trivial projects:
     - Write actual test files into the codebase during the first task
     - Tests should assert on the slice's demo outcome and boundary contracts
     - Name the test files here so execution has an unambiguous target

     For simple projects or scripts:
     - Executable verification commands (bash assertions, curl checks, etc.) are sufficient

     If the project has no test framework and the work is non-trivial,
     the first task should set one up. A test runner costs 2 minutes
     and pays for itself immediately.

     For non-trivial backend, integration, async, stateful, or UI work:
     - Include at least one verification check for an observability or failure-path signal
     - Verify not just that the feature works, but that a future agent can inspect its state when it fails -->

- {{testFileOrCommand — e.g. `npm test -- --grep "auth flow"` or `bash scripts/verify-s01.sh`}}
- {{testFileOrCommand}}

## Observability / Diagnostics

<!-- Include this section for non-trivial backend, integration, async, stateful, or UI slices.
     OMIT ENTIRELY for simple slices where all fields would be "none".

     When included, describe how a future agent will inspect current state, detect failure,
     and localize the problem with minimal ambiguity. Keep it concise and high-signal. -->

- Runtime signals: {{structured log/event, state transition, metric, or none}}
- Inspection surfaces: {{status endpoint, CLI command, script, UI state, DB table, or none}}
- Failure visibility: {{last error, retry count, phase, timestamp, correlation id, or none}}
- Redaction constraints: {{secret/PII boundary or none}}

## Integration Closure

<!-- Omit this section entirely for simple slices with no meaningful integration concerns. -->

- Upstream surfaces consumed: {{specific files / modules / contracts}}
- New wiring introduced in this slice: {{entrypoint / composition / runtime hookup, or none}}
- What remains before the milestone is truly usable end-to-end: {{list or "nothing"}}

## Tasks

<!--
  If every task below is completed exactly as written, the Goal and Demo above
  should be true at the stated proof level. Tasks should close the loop on the
  slice, not merely prepare for later work unless the Demo truthfully says the
  slice only proves fixture/contract-level behavior.

  Write each task as an executable increment, not a vague intention.

  Prefer action-oriented titles:
  - "Wire real auth middleware into dashboard routes"
  - "Persist job status and expose failure diagnostics"
  - "Add browser test covering empty-state recovery"

  Avoid vague titles:
  - "Set up auth"
  - "Handle errors"
  - "Improve UI"

  Each task should usually include:
  - Why: why this task exists / what part of the slice it closes
  - Files: the main files likely touched
  - Do: concrete implementation steps and important constraints
  - Verify: the command, test, or runtime check that proves it worked
  - Done when: a measurable acceptance condition

  Keep the checkbox line format exactly:
  - [ ] **T01: Title** `est:30m`
-->

- [ ] **T01: {{taskTitle}}** `est:{{estimate}}`
  - Why: {{whyThisTaskExists}}
  - Files: `{{filePath}}`, `{{filePath}}`
  - Do: {{specificImplementationStepsAndConstraints}}
  - Verify: {{testCommandOrRuntimeCheck}}
  - Done when: {{measurableAcceptanceCondition}}
- [ ] **T02: {{taskTitle}}** `est:{{estimate}}`
  - Why: {{whyThisTaskExists}}
  - Files: `{{filePath}}`, `{{filePath}}`
  - Do: {{specificImplementationStepsAndConstraints}}
  - Verify: {{testCommandOrRuntimeCheck}}
  - Done when: {{measurableAcceptanceCondition}}
<!--
  Format rules (parsers depend on this exact structure):
  - Checkbox line: - [ ] **T01: Title** `est:30m`
  - Description:   indented text on the next line(s)
  - Mark done:     change [ ] to [x]
  - Tasks execute sequentially in order (T01, T02, T03, ...)
  - est: is informational (e.g. 30m, 1h, 2h) and optional

  Verify field rules:
  - MUST be a mechanically executable command: `npm test`, `grep -q "pattern" file`, `test -f path`
  - For content/document tasks: verify file existence, section count, YAML validity, or word count
    NOT exact phrasing, specific formulas, or "zero TBD" aspirational criteria
  - If no command can verify the output, write: "Manual review — file exists and is non-empty"
  - BAD: "Sections 3.1 and 3.2 exist with exact formulas. Zero TBD/TODO."
  - GOOD: `grep -c "^## " doc.md` returns >= 4 (4+ sections), `! grep -q "TBD\|TODO" doc.md`

  Integration closure rule:
  - At least one slice in any multi-boundary milestone should perform real composition/wiring, not just contract hardening
  - For the final assembly slice, verification must exercise the real entrypoint or runtime path
-->

## Files Likely Touched

- `{{filePath}}`
- `{{filePath}}`
