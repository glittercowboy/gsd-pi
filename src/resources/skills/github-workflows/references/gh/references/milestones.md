# GitHub Milestones — Management

`gh` has no native `milestone` subcommand. Use `gh api` (REST) for quick operations or `PyGithub` in scripts.

## When to Use What

| Context | Tool |
|---------|------|
| Quick one-off | `gh api repos/{owner}/{repo}/milestones` |
| Scripted / multi-step | `PyGithub` — `repo.create_milestone()` |
| Claude Code hook | `@octokit/rest` |

---

## gh CLI (REST) — Quick Commands

### List Milestones

```bash
gh api repos/Jamie-BitFlight/claude_skills/milestones \
  --jq '.[] | [.number, .title, .state, .open_issues, .due_on] | @tsv'
```

### Create a Milestone

```bash
gh api repos/Jamie-BitFlight/claude_skills/milestones \
  -X POST \
  -f title="v1.0 — Skills Foundation" \
  -f description="Core skills for the claude_skills plugin marketplace" \
  -f due_on="2026-03-31T00:00:00Z" \
  -f state="open"
```

Returns JSON with `number` field — use this to assign issues.

### Update a Milestone

```bash
gh api repos/Jamie-BitFlight/claude_skills/milestones/1 \
  -X PATCH -f due_on="2026-04-15T00:00:00Z"
```

### Assign Milestone to Issue

```bash
# -F sends value as integer (required for milestone field)
gh api repos/Jamie-BitFlight/claude_skills/issues/42 \
  -X PATCH -F milestone=1

# Remove milestone
gh api repos/Jamie-BitFlight/claude_skills/issues/42 \
  -X PATCH -F milestone=null
```

### List Issues in a Milestone

```bash
gh issue list -R Jamie-BitFlight/claude_skills \
  --milestone "v1.0 — Skills Foundation" \
  --json number,title,state,labels
```

---

## PyGithub — Scripted Operations (Python)

Use `PyGithub` in Python scripts — never shell out to `gh`.

```python
#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["PyGithub>=2.1.1"]
# ///
from __future__ import annotations

import os
from datetime import datetime, timezone

from github import Auth, Github

gh = Github(auth=Auth.Token(os.environ["GITHUB_TOKEN"]))
repo = gh.get_repo("Jamie-BitFlight/claude_skills")

# Create milestone
milestone = repo.create_milestone(
    title="v1.0 — Skills Foundation",
    description="Core skills for the claude_skills plugin marketplace",
    due_on=datetime(2026, 3, 31, tzinfo=timezone.utc),
)

# List milestones
for m in repo.get_milestones(state="all"):
    print(f"#{m.number} {m.title}")

# Assign milestone to issue
repo.get_issue(42).edit(milestone=repo.get_milestone(1))

# Close milestone
m = repo.get_milestone(1)
m.edit(title=m.title, state="closed")
```

---

## @octokit/rest — Claude Code Hooks (JavaScript)

```javascript
const { Octokit } = require('@octokit/rest');

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// Create milestone
const { data: milestone } = await octokit.rest.issues.createMilestone({
  owner: 'Jamie-BitFlight',
  repo: 'claude_skills',
  title: 'v1.0 — Skills Foundation',
  due_on: '2026-03-31T00:00:00Z',
});

// Assign milestone to issue
await octokit.rest.issues.update({
  owner: 'Jamie-BitFlight',
  repo: 'claude_skills',
  issue_number: 42,
  milestone: milestone.number,
});
```

---

## Automation Script

```bash
uv run .claude/skills/gh/scripts/github_project_setup.py milestone list
uv run .claude/skills/gh/scripts/github_project_setup.py milestone create \
  --title "v1.0 — Skills Foundation" --due 2026-03-31
uv run .claude/skills/gh/scripts/github_project_setup.py milestone start \
  --number 3
uv run .claude/skills/gh/scripts/github_project_setup.py milestone start \
  --number 3 --dry-run
```

---

## Milestone Naming Conventions

```text
v1.0 — Skills Foundation        # initial stable release
v1.1 — Quality Gates            # linting/validation improvements
v2.0 — GitHub Integration       # issues, projects, milestones support
Backlog Grooming — 2026-Q1      # quarterly grooming milestone
```

SOURCE: GitHub REST API — Milestones — <https://docs.github.com/en/rest/issues/milestones> (accessed 2026-02-21)
SOURCE: PyGithub Milestone API — <https://pygithub.readthedocs.io/en/latest/github_objects/Milestone.html> (accessed 2026-02-21)
SOURCE: Octokit.js REST — <https://octokit.github.io/rest.js/v20#issues-create-milestone> (accessed 2026-02-21)
