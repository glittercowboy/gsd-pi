## Workflow Scaffolds

These files are **not active** — they live in `docs/proposals/workflows/` for review purposes only. If the RFC is accepted, they'll be moved to `.github/workflows/`.

| File | Purpose |
|------|---------|
| `create-release.yml` | Manually triggered — creates `release/X.Y` from `next`, sets up branch protection, opens tracking issue |
| `sync-next.yml` | Auto-triggered on version tag — ensures `next` branch exists and is merged up from `main` |
| `backmerge.yml` | Auto-triggered on release branch push — back-merges fixes to `next`, opens conflict PR if needed |
