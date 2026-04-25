You are generating tests for recently completed GSD work.

## Slice: {{sliceId}} — {{sliceTitle}}

### Summary

{{sliceSummary}}

### Existing Test Patterns

{{existingTestPatterns}}

## Working Directory

`{{workingDirectory}}`

## Instructions

1. Read the slice summary above to understand what was built
2. Identify the source files that were created or modified for this slice
3. Read the implementation code to understand behavior, edge cases, and error paths
4. Write comprehensive tests following the project's existing test patterns and framework
5. Run the tests to verify they pass
6. Fix any failures

### Rules

- Follow the project's existing test patterns (framework, assertions, file structure)
- Test behavior, not implementation details
- Cover: happy path, edge cases, error conditions, boundary values
- Do NOT modify implementation files — only create or update test files
- Name test files consistently with the project's conventions
- Keep tests focused and readable
- Tests must only reference files that are tracked in git. Do NOT import, read, or depend on paths listed in `.gitignore` — in particular GSD-local state such as `.gsd/`, `.planning/`, and `.audits/`. If a test seems to need one of those files, replace it with an inline fixture or a tracked sample; otherwise the test will fail for everyone but the author.

{{skillActivation}}
