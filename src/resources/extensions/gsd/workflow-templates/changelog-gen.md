# Changelog Generator

<template_meta>
name: changelog-gen
version: 1
mode: oneshot
requires_project: false
artifact_dir: null
</template_meta>

<purpose>
Generate a CHANGELOG entry (or release notes draft) from git commits since the
last release tag. Categorizes by type, follows Keep a Changelog format, and
writes to `CHANGELOG.md` (or prints if the user prefers).
</purpose>

<instructions>

## 1. Locate the range

- Find the last release tag: `git describe --tags --abbrev=0` (fall back to
  the first commit if no tags exist).
- Gather commits: `git log <last_tag>..HEAD --oneline --no-merges`.
- If zero commits, say "No changes since <tag>" and stop.

## 2. Categorize each commit

Use the conventional-commit prefix when present:

| Prefix                      | Category        |
| --------------------------- | --------------- |
| `feat:` / `feature:`        | Added           |
| `fix:` / `bugfix:`          | Fixed           |
| `refactor:`                 | Changed         |
| `docs:`                     | Docs            |
| `chore:` / `ci:` / `build:` | Maintenance     |
| `perf:`                     | Performance     |
| `BREAKING CHANGE` footer    | Breaking        |

For commits without a prefix, infer the category from the subject line.

## 3. Produce the entry

Format using Keep a Changelog v1.1 conventions:

```
## [Unreleased] - YYYY-MM-DD

### Added
- <user-visible description> (#PR / commit sha)

### Fixed
- …

### Changed
- …

### Breaking
- …
```

- Prefer user-visible descriptions over commit-log verbatim.
- Group breaking changes FIRST when present, even though the section appears later.
- Omit empty sections.

## 4. Write or print

- If `CHANGELOG.md` exists, insert the new entry **after** the top-level
  heading and before any existing `## [x.y.z]` entries. Do NOT touch prior
  releases.
- If it doesn't exist, create one with the standard Keep a Changelog header.
- If the user's arguments include `--print`, print to the chat only — don't
  write the file.

## 5. Report

End with:
- the file path (or "printed, not written"),
- the commit range used,
- the number of commits processed per category.

</instructions>
