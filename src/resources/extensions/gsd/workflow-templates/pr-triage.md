# PR Triage

<template_meta>
name: pr-triage
version: 1
mode: oneshot
requires_project: false
artifact_dir: null
</template_meta>

<purpose>
Walk open pull requests and produce a triage report: which to merge, close,
or nudge. Oneshot — report only, no actions taken.
</purpose>

<instructions>

## 1. List open PRs

Run `gh pr list --state open --limit 50 --json number,title,author,createdAt,updatedAt,isDraft,labels,reviewDecision,mergeable,headRefName,statusCheckRollup,additions,deletions`.

If there are more than 50 open PRs, note that and use `--limit 100`. If still
more, just pick the 100 most recently updated and warn that the report is
partial.

## 2. Bucket each PR

For each PR, compute:
- **Age**: days since creation.
- **Staleness**: days since last update.
- **Size**: `additions + deletions` (small ≤ 100, medium ≤ 500, large > 500).
- **CI**: passing, failing, pending, none.
- **Reviews**: approved, changes-requested, pending, none.
- **Mergeability**: clean, conflicting, unknown.
- **Draft**: yes/no.

Put each PR into exactly ONE bucket:

- **✅ Ready to merge** — non-draft, approved, CI passing, mergeable.
- **🛠 Waiting on author** — changes-requested or CI failing.
- **👀 Needs review** — no reviews, non-draft, CI passing, ≤ 30 days old.
- **💤 Stale** — no update in 30+ days.
- **❌ Close candidate** — stale > 90 days AND (no reviews OR conflicting)
  OR author is inactive OR scope is clearly superseded.
- **🚧 Draft** — explicitly drafted, not yet ready.

## 3. Output

```
PR Triage — <N> open PRs (as of YYYY-MM-DD)

## ✅ Ready to merge (<n>)
- #123 <title> — by @author, +X/-Y, approved, CI ✓
  Next: merge with `gh pr merge 123`.

## 🛠 Waiting on author (<n>)
- #124 <title> — CI failing: <reason>. Nudge author.

## 👀 Needs review (<n>)
- #125 <title> — 5 days old, no reviews yet.

## 💤 Stale (<n>)
- #126 <title> — no update in 45 days. Suggest: nudge @author, or close.

## ❌ Close candidates (<n>)
- #127 <title> — 120 days stale, conflicts with main, superseded by #140.

## 🚧 Drafts (<n>)
- #128 — <title>
```

## 4. Recommend specific actions

At the bottom, produce a short action list of the top 3–5 PRs that would have
the biggest impact if resolved (oldest bottlenecking, most approved but unmerged,
easiest close-candidates).

## 5. Don't act

Do not run `gh pr merge`, `gh pr close`, or `gh pr comment`. The report is
for humans to act on.

</instructions>
