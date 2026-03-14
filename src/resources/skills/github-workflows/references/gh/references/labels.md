# GitHub Labels — Taxonomy and Management

## When to Use What

| Context | Tool |
|---------|------|
| Quick one-off command | `gh label` CLI |
| Scripted / multi-step | `PyGithub` (Python) or `@octokit/rest` (JS) |
| Claude Code hook | `@octokit/rest` or Node.js `https` built-in |

---

## Standard Label Taxonomy

Three axes: **priority**, **type**, **status**.

### Priority Labels

| Label | Color | Description |
|-------|-------|-------------|
| `priority:p0` | `#D73A4A` | Critical — blocks work or production |
| `priority:p1` | `#E99695` | High — should be done next |
| `priority:p2` | `#F9D0C4` | Medium — do when P0/P1 are clear |
| `priority:idea` | `#BFD4F2` | Unscoped — future consideration |

### Type Labels

| Label | Color | Description |
|-------|-------|-------------|
| `type:feature` | `#0E8A16` | New capability or skill |
| `type:bug` | `#B60205` | Something is broken |
| `type:refactor` | `#5319E7` | Internal improvement, no behavior change |
| `type:docs` | `#0075CA` | Documentation only |
| `type:chore` | `#EDEDED` | Maintenance, tooling, CI |

### Status Labels

All 8 lifecycle states from the backlog state machine (`.claude/skills/backlog/references/state-machine.md`) have corresponding labels.

| Label | Color | Description |
|-------|-------|-------------|
| `status:needs-grooming` | `#FEF2C0` | Captured but not yet groomed |
| `status:groomed` | `#C2E0C6` | Grooming complete, RT-ICA APPROVED |
| `status:blocked` | `#B60205` | RT-ICA BLOCKED or AC verification FAIL |
| `status:in-milestone` | `#BFD4F2` | Assigned to an active milestone |
| `status:in-progress` | `#1D76DB` | Actively being worked |
| `status:done` | `#0E8A16` | Implementation complete, AC verified PASS |
| `status:resolved` | `#6B737B` | Closed without full implementation (obsolete/superseded) |
| `status:closed` | `#EDEDED` | Terminal — milestone archived by complete-milestone |

> Note: `status:needs-review` was previously in this taxonomy but is not part of the
> state machine lifecycle. It has been retained in `github_project_setup.py` for
> backwards compatibility but should not be applied by backlog commands.

---

## gh CLI — Quick Commands

```bash
# List all labels
gh label list -R Jamie-BitFlight/claude_skills

# Create a label
gh label create "priority:p1" \
  --color "E99695" \
  --description "High priority — should be done next" \
  -R Jamie-BitFlight/claude_skills

# Edit a label
gh label edit "priority:p1" \
  --description "High priority — updated" \
  -R Jamie-BitFlight/claude_skills

# Apply labels to an issue
gh issue edit 42 -R Jamie-BitFlight/claude_skills \
  --add-label "status:in-progress" \
  --remove-label "status:needs-grooming"
```

---

## PyGithub — Scripted Operations (Python)

Use `PyGithub` (`github` package) in Python scripts — never shell out to `gh`.

```python
#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["PyGithub>=2.1.1"]
# ///
from __future__ import annotations

import os

from github import Auth, Github

gh = Github(auth=Auth.Token(os.environ["GITHUB_TOKEN"]))
repo = gh.get_repo("Jamie-BitFlight/claude_skills")

# Create a label
repo.create_label(name="priority:p1", color="E99695", description="High priority")

# Edit existing label
label = repo.get_label("priority:p1")
label.edit(name="priority:p1", color="E99695", description="Updated description")

# Apply label to issue
issue = repo.get_issue(42)
issue.add_to_labels(repo.get_label("status:in-progress"))
issue.remove_from_labels(repo.get_label("status:needs-grooming"))
```

---

## @octokit/rest — Claude Code Hooks (JavaScript)

Use `@octokit/rest` in `.cjs` hook files — never use child_process to call `gh`.

```javascript
// In a Claude Code hook (.cjs)
const { Octokit } = require('@octokit/rest');

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// Apply label to issue
await octokit.rest.issues.addLabels({
  owner: 'Jamie-BitFlight',
  repo: 'claude_skills',
  issue_number: 42,
  labels: ['status:in-progress'],
});

// Remove label
await octokit.rest.issues.removeLabel({
  owner: 'Jamie-BitFlight',
  repo: 'claude_skills',
  issue_number: 42,
  name: 'status:needs-grooming',
});
```

---

## Bulk Label Setup

```bash
# Creates all taxonomy labels; skips existing
uv run .claude/skills/gh/scripts/github_project_setup.py labels \
  --repo Jamie-BitFlight/claude_skills

# Force-update existing labels too
uv run .claude/skills/gh/scripts/github_project_setup.py labels \
  --repo Jamie-BitFlight/claude_skills --force
```

---

## Backlog Item Priority → Issue Label Mapping

| Per-item file priority | Issue label |
|--------------------|-------------|
| P0 | `priority:p0` |
| P1 | `priority:p1` |
| P2 | `priority:p2` |
| Ideas | `priority:idea` |

SOURCE: GitHub CLI label documentation — <https://cli.github.com/manual/gh_label> (accessed 2026-02-21)
SOURCE: PyGithub label API — <https://pygithub.readthedocs.io/en/latest/github_objects/Label.html> (accessed 2026-02-21)
SOURCE: Octokit.js REST — <https://github.com/octokit/rest.js> (accessed 2026-02-21)
