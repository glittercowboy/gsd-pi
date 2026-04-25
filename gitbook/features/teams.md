# Working in Teams

GSD supports multi-user workflows where several developers work on the same repository concurrently.

## Quick Setup

The simplest way: set team mode in your project preferences.

```yaml
# .gsd/PREFERENCES.md (committed to git)
---
version: 1
mode: team
---
```

This enables unique milestone IDs, push branches, pre-merge checks, and other team-appropriate defaults in one setting.

## What Team Mode Does

| Setting | Effect |
|---------|--------|
| `unique_milestone_ids` | IDs like `M001-eh88as` instead of `M001` — no collisions |
| `git.push_branches` | Milestone branches are pushed to remote |
| `git.pre_merge_check` | Validation runs before merging |

You can override individual settings on top of `mode: team`.

## Configure `.gitignore`

Share planning artifacts while keeping runtime files local:

```bash
# Runtime files (per-developer, gitignore these)
.gsd/auto.lock
.gsd/completed-units.json
.gsd/STATE.md
.gsd/metrics.json
.gsd/activity/
.gsd/runtime/
.gsd/worktrees/
.gsd/milestones/**/continue.md
.gsd/milestones/**/*-CONTINUE.md
```

**What gets shared** (committed to git):
- `.gsd/PREFERENCES.md` — project preferences
- `.gsd/PROJECT.md` — living project description
- `.gsd/REQUIREMENTS.md` — requirement contract
- `.gsd/DECISIONS.md` — architectural decisions
- `.gsd/milestones/` — roadmaps, plans, summaries, research

**What stays local** (gitignored):
- Lock files, metrics, state, activity logs, worktrees

## Commit the Config

```bash
git add .gsd/PREFERENCES.md
git commit -m "chore: enable GSD team workflow"
```

## Keeping `.gsd/` Local

For teams where only some members use GSD:

```yaml
git:
  commit_docs: false
```

This gitignores `.gsd/` entirely. You get structured planning without affecting teammates.

## Parallel Development

Multiple developers can run auto mode simultaneously on different milestones. Each developer:

- Gets their own worktree (`.gsd/worktrees/<MID>/`)
- Works on a unique `milestone/<MID>` branch
- Squash-merges to main independently

Milestone dependencies can be declared:

```yaml
# In M00X-CONTEXT.md frontmatter
---
depends_on: [M001-eh88as]
---
```

GSD enforces that dependent milestones complete before starting downstream work.
