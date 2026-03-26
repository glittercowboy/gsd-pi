import { validateTaskPlanContent, validateSlicePlanContent } from '../observability-validator.ts';
import { createTestContext } from './test-helpers.ts';

const { assertEq, assertTrue, report } = createTestContext();
// ═══════════════════════════════════════════════════════════════════════════
// validateTaskPlanContent — empty/missing Steps section
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== validateTaskPlanContent: empty Steps section ===');
{
  const content = `# T01: Some Task

## Description

Do something useful.

## Steps

## Verification

- Run the tests and confirm output.
`;

  const issues = validateTaskPlanContent('T01-PLAN.md', content);
  const stepsIssues = issues.filter(i => i.ruleId === 'empty_steps_section');
  assertTrue(stepsIssues.length >= 1, 'empty Steps section produces empty_steps_section issue');
  if (stepsIssues.length > 0) {
    assertEq(stepsIssues[0].severity, 'warning', 'empty_steps_section severity is warning');
    assertEq(stepsIssues[0].scope, 'task-plan', 'empty_steps_section scope is task-plan');
  }
}

console.log('\n=== validateTaskPlanContent: missing Steps section entirely ===');
{
  const content = `# T01: Some Task

## Description

Do something useful.

## Verification

- Run the tests.
`;

  const issues = validateTaskPlanContent('T01-PLAN.md', content);
  const stepsIssues = issues.filter(i => i.ruleId === 'empty_steps_section');
  assertTrue(stepsIssues.length >= 1, 'missing Steps section produces empty_steps_section issue');
}

// ═══════════════════════════════════════════════════════════════════════════
// validateTaskPlanContent — placeholder-only Verification
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== validateTaskPlanContent: placeholder-only Verification ===');
{
  const content = `# T01: Some Task

## Steps

1. Do the thing.
2. Do the other thing.

## Verification

- {{placeholder verification step}}
- {{another placeholder}}
`;

  const issues = validateTaskPlanContent('T01-PLAN.md', content);
  const verifyIssues = issues.filter(i => i.ruleId === 'placeholder_verification');
  assertTrue(verifyIssues.length >= 1, 'placeholder-only Verification produces placeholder_verification issue');
  if (verifyIssues.length > 0) {
    assertEq(verifyIssues[0].severity, 'warning', 'placeholder_verification severity is warning');
    assertEq(verifyIssues[0].scope, 'task-plan', 'placeholder_verification scope is task-plan');
  }
}

console.log('\n=== validateTaskPlanContent: Verification with only template text ===');
{
  const content = `# T01: Some Task

## Steps

1. Do the thing.

## Verification

{{whatWasVerifiedAndHow — commands run, tests passed, behavior confirmed}}
`;

  const issues = validateTaskPlanContent('T01-PLAN.md', content);
  const verifyIssues = issues.filter(i => i.ruleId === 'placeholder_verification');
  assertTrue(verifyIssues.length >= 1, 'template-text-only Verification produces placeholder_verification issue');
}

// ═══════════════════════════════════════════════════════════════════════════
// validateSlicePlanContent — empty inline task entries
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== validateSlicePlanContent: empty inline task entries ===');
{
  const content = `# S01: Some Slice

**Goal:** Build the thing.
**Demo:** It works.

## Tasks

- [ ] **T01: First Task** \`est:20m\`

- [ ] **T02: Second Task** \`est:15m\`

## Verification

- Run the tests.
`;

  const issues = validateSlicePlanContent('S01-PLAN.md', content);
  const emptyTaskIssues = issues.filter(i => i.ruleId === 'empty_task_entry');
  assertTrue(emptyTaskIssues.length >= 1, 'task entries with no description produce empty_task_entry issue');
  if (emptyTaskIssues.length > 0) {
    assertEq(emptyTaskIssues[0].severity, 'warning', 'empty_task_entry severity is warning');
    assertEq(emptyTaskIssues[0].scope, 'slice-plan', 'empty_task_entry scope is slice-plan');
  }
}

console.log('\n=== validateSlicePlanContent: task entries with content are fine ===');
{
  const content = `# S01: Some Slice

**Goal:** Build the thing.
**Demo:** It works.

## Tasks

- [ ] **T01: First Task** \`est:20m\`
  - Why: Because it matters.
  - Files: \`src/index.ts\`
  - Do: Implement the feature.

- [ ] **T02: Second Task** \`est:15m\`
  - Why: Also important.
  - Do: Add tests.

## Verification

- Run the tests.
`;

  const issues = validateSlicePlanContent('S01-PLAN.md', content);
  const emptyTaskIssues = issues.filter(i => i.ruleId === 'empty_task_entry');
  assertEq(emptyTaskIssues.length, 0, 'task entries with description content produce no empty_task_entry issues');
}

// ═══════════════════════════════════════════════════════════════════════════
// validateTaskPlanContent — scope_estimate over threshold
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== validateTaskPlanContent: scope_estimate over threshold ===');
{
  const content = `---
estimated_steps: 12
estimated_files: 15
---

# T01: Big Task

## Steps

1. Step one.
2. Step two.
3. Step three.

## Verification

- Check it works.
`;

  const issues = validateTaskPlanContent('T01-PLAN.md', content);
  const stepsOverIssues = issues.filter(i => i.ruleId === 'scope_estimate_steps_high');
  const filesOverIssues = issues.filter(i => i.ruleId === 'scope_estimate_files_high');
  assertTrue(stepsOverIssues.length >= 1, 'estimated_steps=12 (>=10) produces scope_estimate_steps_high issue');
  assertTrue(filesOverIssues.length >= 1, 'estimated_files=15 (>=12) produces scope_estimate_files_high issue');
  if (stepsOverIssues.length > 0) {
    assertEq(stepsOverIssues[0].severity, 'warning', 'scope_estimate_steps_high severity is warning');
    assertEq(stepsOverIssues[0].scope, 'task-plan', 'scope_estimate_steps_high scope is task-plan');
  }
  if (filesOverIssues.length > 0) {
    assertEq(filesOverIssues[0].severity, 'warning', 'scope_estimate_files_high severity is warning');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// validateTaskPlanContent — scope_estimate within limits
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== validateTaskPlanContent: scope_estimate within limits ===');
{
  const content = `---
estimated_steps: 4
estimated_files: 6
---

# T01: Small Task

## Steps

1. Do the thing.

## Verification

- Verify it works.
`;

  const issues = validateTaskPlanContent('T01-PLAN.md', content);
  const scopeIssues = issues.filter(i =>
    i.ruleId === 'scope_estimate_steps_high' || i.ruleId === 'scope_estimate_files_high'
  );
  assertEq(scopeIssues.length, 0, 'scope_estimate within limits produces no scope issues');
}

// ═══════════════════════════════════════════════════════════════════════════
// validateTaskPlanContent — missing scope_estimate (no warning)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== validateTaskPlanContent: missing scope_estimate ===');
{
  const content = `# T01: No Frontmatter Task

## Steps

1. Do the thing.

## Verification

- Verify it works.
`;

  const issues = validateTaskPlanContent('T01-PLAN.md', content);
  const scopeIssues = issues.filter(i =>
    i.ruleId === 'scope_estimate_steps_high' || i.ruleId === 'scope_estimate_files_high'
  );
  assertEq(scopeIssues.length, 0, 'missing scope_estimate produces no scope issues');
}

console.log('\n=== validateTaskPlanContent: frontmatter without scope keys ===');
{
  const content = `---
id: T01
parent: S01
---

# T01: Task With Other Frontmatter

## Steps

1. Do the thing.

## Verification

- Verify it works.
`;

  const issues = validateTaskPlanContent('T01-PLAN.md', content);
  const scopeIssues = issues.filter(i =>
    i.ruleId === 'scope_estimate_steps_high' || i.ruleId === 'scope_estimate_files_high'
  );
  assertEq(scopeIssues.length, 0, 'frontmatter without scope keys produces no scope issues');
}

// ═══════════════════════════════════════════════════════════════════════════
// Clean plans — no false positives
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== Clean task plan: no plan-quality issues ===');
{
  const content = `---
estimated_steps: 5
estimated_files: 3
---

# T01: Well-Formed Task

## Description

A real task with real content.

## Steps

1. Read the input files.
2. Parse the configuration.
3. Transform the data.
4. Write the output.
5. Verify the results.

## Must-Haves

- [ ] Output file is valid JSON
- [ ] All input records are processed

## Verification

- Run \`node --test tests/transform.test.ts\` — all assertions pass
- Manually inspect output.json for correct structure

## Observability Impact

- Signals added/changed: structured error log on parse failure
- How a future agent inspects this: check stderr for JSON parse errors
- Failure state exposed: exit code 1 + error message on invalid input
`;

  const issues = validateTaskPlanContent('T01-PLAN.md', content);
  const planQualityIssues = issues.filter(i =>
    i.ruleId === 'empty_steps_section' ||
    i.ruleId === 'placeholder_verification' ||
    i.ruleId === 'scope_estimate_steps_high' ||
    i.ruleId === 'scope_estimate_files_high'
  );
  assertEq(planQualityIssues.length, 0, 'clean task plan produces no plan-quality issues');
}

console.log('\n=== Clean slice plan: no plan-quality issues ===');
{
  const content = `# S01: Well-Formed Slice

**Goal:** Build a complete feature.
**Demo:** Run the test suite and see all green.

## Tasks

- [ ] **T01: Create tests** \`est:20m\`
  - Why: Tests define the contract before implementation.
  - Files: \`tests/feature.test.ts\`
  - Do: Write comprehensive test assertions.
  - Verify: Test file runs without syntax errors.

- [ ] **T02: Implement feature** \`est:30m\`
  - Why: Core implementation.
  - Files: \`src/feature.ts\`
  - Do: Build the feature to make tests pass.
  - Verify: All tests pass.

## Verification

- \`node --test tests/feature.test.ts\` — all assertions pass
- Check error output for diagnostic messages

## Observability / Diagnostics

- Runtime signals: structured error objects with error codes
- Inspection surfaces: test output shows pass/fail counts
- Failure visibility: exit code 1 on failure with descriptive message
- Redaction constraints: none
`;

  const issues = validateSlicePlanContent('S01-PLAN.md', content);
  const planQualityIssues = issues.filter(i => i.ruleId === 'empty_task_entry');
  assertEq(planQualityIssues.length, 0, 'clean slice plan produces no empty_task_entry issues');
}

// ═══════════════════════════════════════════════════════════════════════════
// validateTaskPlanContent — missing output file paths
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== validateTaskPlanContent: missing output file paths ===');
{
  const content = `# T01: Some Task

## Description

Do something.

## Steps

1. Do the thing

## Verification

- Check it works

## Expected Output

This task produces the main output.
`;

  const issues = validateTaskPlanContent('T01-PLAN.md', content);
  const outputIssues = issues.filter(i => i.ruleId === 'missing_output_file_paths');
  assertTrue(outputIssues.length >= 1, 'Expected Output without file paths triggers missing_output_file_paths');
}

console.log('\n=== validateTaskPlanContent: valid output file paths ===');
{
  const content = `# T01: Some Task

## Description

Do something.

## Steps

1. Do the thing

## Verification

- Check it works

## Expected Output

- \`src/types.ts\` — New type definitions
`;

  const issues = validateTaskPlanContent('T01-PLAN.md', content);
  const outputIssues = issues.filter(i => i.ruleId === 'missing_output_file_paths');
  assertEq(outputIssues.length, 0, 'Expected Output with file paths does not trigger warning');
}

console.log('\n=== validateTaskPlanContent: missing input file paths (info severity) ===');
{
  const content = `# T01: Some Task

## Description

Do something.

## Steps

1. Do the thing

## Verification

- Check it works

## Inputs

Prior task summary insights about the architecture.

## Expected Output

- \`src/output.ts\` — Output file
`;

  const issues = validateTaskPlanContent('T01-PLAN.md', content);
  const inputIssues = issues.filter(i => i.ruleId === 'missing_input_file_paths');
  assertTrue(inputIssues.length >= 1, 'Inputs without file paths triggers missing_input_file_paths');
  if (inputIssues.length > 0) {
    assertEq(inputIssues[0].severity, 'info', 'missing_input_file_paths is info severity (not warning)');
  }
}

console.log('\n=== validateTaskPlanContent: no Expected Output section at all ===');
{
  const content = `# T01: Some Task

## Description

Do something.

## Steps

1. Do the thing

## Verification

- Check it works
`;

  const issues = validateTaskPlanContent('T01-PLAN.md', content);
  const outputIssues = issues.filter(i => i.ruleId === 'missing_output_file_paths');
  assertTrue(outputIssues.length >= 1, 'Missing Expected Output section triggers missing_output_file_paths');
}

report();
