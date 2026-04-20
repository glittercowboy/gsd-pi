# Issue Triage

<template_meta>
name: issue-triage
version: 1
mode: oneshot
requires_project: false
artifact_dir: null
</template_meta>

<purpose>
Classify a GitHub issue, recommend labels/priority, and propose the next
concrete action. Oneshot — read the issue, think, respond. No file edits,
no state.
</purpose>

<instructions>

## 1. Fetch the issue

- The user arguments should contain an issue number (`#123`) or URL. If not,
  ask once for the reference.
- Pull issue body, labels, author, age, reactions, comment count, and linked
  PRs via `gh issue view <ref> --json number,title,body,labels,author,createdAt,updatedAt,reactions,comments`.
- If already closed, say so and stop unless the user specifically asked to
  revisit it.

## 2. Classify

Assign exactly one of:
- `bug` — reproducible broken behavior.
- `feature-request` — new capability, not a fix.
- `question` / `support` — user needs help, no code change implied.
- `docs` — docs gap.
- `discussion` — open-ended, no clear action.
- `invalid` — duplicate, off-topic, spam.

Add these secondary labels as applicable: `needs-repro`, `needs-info`,
`good-first-issue`, `regression`, `security` (flag strongly if so),
`breaking`, `external-dep`.

## 3. Assess priority

- `p0` — production-breaking / security / data loss.
- `p1` — significantly degrades common workflow.
- `p2` — standard bug/feature.
- `p3` — minor / cosmetic / future.

Base the assessment on: blast radius, reproduction frequency, reactions,
whether a workaround exists, and whether prior issues reference it.

## 4. Recommend the next action

Write ONE of these, with a concrete next step:

- **Ask for info:** list the 1–3 specific things missing (repro steps, version,
  logs). Draft the comment text.
- **Accept and schedule:** suggest a workflow to run next (e.g.
  `/gsd start bugfix --issue #123` or `/gsd workflow small-feature`).
- **Close:** draft a polite close comment with the reason.
- **Escalate:** flag for human review with a specific reason.

## 5. Output format

```
Issue: #<n> — <title>
Author: <user>   Age: <d>d   Comments: <n>   Reactions: <n>

Classification: <primary>, <secondary labels>
Priority:       <p0/p1/p2/p3>

Why: <2–3 sentence rationale>

Next action: <recommendation>
Comment draft:
> <text to post — or "n/a" if no comment needed>
```

## 6. Don't post or edit

Draft the comment and any label changes as *suggestions* — never run
`gh issue comment` or `gh issue edit` unless the user explicitly confirms.

</instructions>
