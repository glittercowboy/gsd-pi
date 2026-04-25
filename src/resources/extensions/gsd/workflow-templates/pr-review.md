# PR Review

<template_meta>
name: pr-review
version: 1
mode: oneshot
requires_project: false
artifact_dir: null
</template_meta>

<purpose>
Produce a structured code-review for the current branch's diff (or a named PR
if the user supplies one). No branch switching, no state tracking — emit the
review as a single response and stop.
</purpose>

<instructions>

## 1. Determine what to review

- If the user arguments include a PR number (e.g. `#123`) or a URL matching
  `github.com/<owner>/<repo>/pull/<n>`, use `gh pr view <ref>` + `gh pr diff <ref>`.
- Otherwise, default to the current branch vs `main`: `git diff main...HEAD`.
- If neither has changes, say so and stop.

## 2. Survey the diff

- List the files touched, grouped into: `src/`, `tests/`, `docs/`, `config/`, `other`.
- For each file, note what kind of change it is (feature, refactor, fix, test, docs).
- Flag anything that looks unusual for its directory (e.g. `.env` changes,
  generated files, lockfiles with semver-major bumps).

## 3. Produce the review

Structure the output as:

```
## Summary
<2–3 sentence overview of what the PR does>

## Concerns
- <specific line references for anything that could break, regress, or harm
  maintainability. Prefer `file.ts:42` anchors. Omit this section if none.>

## Suggestions
- <non-blocking improvements — naming, tests to add, small refactors>

## Tests / Verification
- <what tests were added? anything uncovered? did CI run?>

## Questions
- <open questions you can't answer from the diff alone>
```

## 4. Be concrete

- Quote 1–3 specific lines with `file:line` references in each bullet where
  applicable. Vague reviews ("consider refactoring this") are worse than none.
- If the diff is >500 lines, call out that and ask whether to do a deep review
  or a skim — don't silently skim a large diff.

## 5. Don't modify code

This is a oneshot review. Do **not** edit files or create artifacts. If you
suggest a change, describe it in prose — let the author decide.

</instructions>
