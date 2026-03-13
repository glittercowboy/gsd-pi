You are executing GSD auto-mode.

## UNIT: Run UAT — {{milestoneId}}/{{sliceId}}

All relevant context has been preloaded below. Start working immediately without re-reading these files.

{{inlinedContext}}

If a `GSD Skill Preferences` block is present in system context, use it to decide which skills to load and follow during UAT execution, without relaxing required verification or artifact rules.

---

## UAT Instructions

**UAT file:** `{{uatPath}}`
**UAT type:** `{{uatType}}`
**Result file to write:** `{{uatResultPath}}`

### If UAT type is `artifact-driven`

You are the test runner. Execute every check defined in `{{uatPath}}` directly:

- Run shell commands with `bash`
- Run `grep` / `rg` checks against files
- Run `node` / script invocations
- Read files and verify their contents
- Check that expected artifacts exist and have correct structure

For each check, record:
- The check description (from the UAT file)
- The command or action taken
- The actual result observed
- PASS or FAIL verdict

After running all checks, compute the **overall verdict**:
- `PASS` — all checks passed
- `FAIL` — one or more checks failed
- `PARTIAL` — some checks passed, some failed or were skipped

Write `{{uatResultPath}}` with:

```markdown
---
sliceId: {{sliceId}}
uatType: {{uatType}}
verdict: PASS | FAIL | PARTIAL
date: <ISO 8601 timestamp>
---

# UAT Result — {{sliceId}}

## Checks

| Check | Result | Notes |
|-------|--------|-------|
| <check description> | PASS / FAIL | <observed output or reason> |

## Overall Verdict

<PASS / FAIL / PARTIAL> — <one sentence summary>

## Notes

<any additional context, errors encountered, or follow-up items>
```

### If UAT type is NOT `artifact-driven` (type is `{{uatType}}`)

This UAT type requires human execution or live-runtime observation that you cannot perform mechanically. Your role is to surface it clearly for review.

Write `{{uatResultPath}}` with:

```markdown
---
sliceId: {{sliceId}}
uatType: {{uatType}}
verdict: surfaced-for-human-review
date: <ISO 8601 timestamp>
---

# UAT Result — {{sliceId}}

## UAT Type

`{{uatType}}` — requires human execution or live-runtime verification.

## Status

Surfaced for human review. Auto-mode will pause after this unit so the UAT can be performed manually.

## UAT File

See `{{uatPath}}` for the full UAT specification and acceptance criteria.

## Instructions for Human Reviewer

Review `{{uatPath}}`, perform the described UAT steps, then update this file with:
- The actual verdict (PASS / FAIL / PARTIAL)
- Results for each check
- Date completed

Once updated, run `/gsd auto` to resume auto-mode.
```

---

**You MUST write `{{uatResultPath}}` before finishing.**

When done, say: "UAT {{sliceId}} complete."
