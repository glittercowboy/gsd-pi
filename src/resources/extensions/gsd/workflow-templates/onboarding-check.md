# Onboarding Check

<template_meta>
name: onboarding-check
version: 1
mode: oneshot
requires_project: false
artifact_dir: null
</template_meta>

<purpose>
Walk the project's README end-to-end as a brand-new contributor would, and
report every step that fails, is unclear, or is missing. Oneshot — produce a
gap report, not a fix.
</purpose>

<instructions>

## 1. Read the README top-to-bottom

- Read `README.md` (and any `CONTRIBUTING.md`, `docs/setup.md`, or other
  docs the README links from its "Getting Started" section).
- Make a list of every command the docs tell you to run, in order.

## 2. Check the environment

For each prerequisite the README claims ("Node ≥ 22", "Python 3.11",
"Docker", etc.):
- Check whether the version is stated.
- Check whether it's pinned in the repo (e.g. `package.json` engines, `.nvmrc`,
  `.tool-versions`, `pyproject.toml`, `Dockerfile`).
- If the README's claim and the repo's pin disagree, flag it.

## 3. Dry-run the commands

Where safe, run the commands in the **current** environment:
- `npm install` / `pip install -r requirements.txt` / equivalent.
- The "build" / "test" / "run" commands.
- The "dev server" command (spawn, wait 5s, kill it).

Skip any command that:
- Would hit external APIs with credentials (record as "needs real creds, not tested").
- Would incur real cost (cloud deploys, paid APIs).
- Would modify global state (`sudo`, package manager global installs).

## 4. Report

```
# Onboarding Report — <project name>

## Summary
<1–2 sentences: did a new contributor have a path that "just works"?>

## Prerequisites
- [✓/✗/?] <prereq> — <notes, version mismatch, etc.>

## Steps
1. [✓/✗/?] <command> — <exit code, error, or output snippet>

## Gaps
- <missing docs>
- <commands that failed or produced surprising output>
- <undocumented side effects>

## Recommendations
- <specific README edits that would fix the top 3 gaps>
```

## 5. Don't edit

Don't modify the README or any config — just report. The author decides which
gaps to close.

</instructions>
