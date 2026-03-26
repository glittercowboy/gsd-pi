# RFC: GitOps Branching & Versioning Strategy

> **Status:** 🧪 Experimental — requesting feedback before implementation  
> **Author:** @trek-e  
> **Date:** 2026-03-19

## Problem

The current workflow is trunk-based: all PRs target `main`, the pipeline auto-bumps version on merge, and `@dev`/`@next`/`@latest` dist-tags promote through stages. This works but has gaps:

1. **No stable release branch.** If v2.33 ships a regression, the only fix path is forward — merge to main, wait for the full pipeline. There's no branch to cherry-pick a hotfix onto.
2. **No batched releases.** Every merge to main triggers a version bump. Contributors can't group related features into a coordinated release.
3. **Ad-hoc branch naming.** Branch prefixes (`fix/`, `feat/`, `docs/`, `refactor/`) are conventional but not enforced. No automated integration branches collect work-in-progress.
4. **No pre-release channel for breaking changes.** Major version bumps (v3.0.0) have no staging area — they'd need to land on main directly.

## Proposal: Git-Flow Lite with Automated Integration Branches

A lightweight adaptation of git-flow that preserves our trunk-based CI speed while adding release stability. Three branch tiers:

```
main                    ← production-ready, tagged releases only
  ├── release/2.34      ← stabilization branch, created when 2.34 is feature-complete
  ├── release/2.33      ← maintenance branch for hotfixes to the current stable
  └── next              ← integration branch for the next minor release
       ├── feat/1325-user-prefs
       ├── feat/1340-parallel-v2
       └── fix/1326-silent-commit
```

### Branch Roles

| Branch | Purpose | Merges Into | Auto-Created |
|--------|---------|-------------|--------------|
| `main` | Production releases only. Every commit is a tagged release. | — | — |
| `next` | Integration branch for the next minor version. PRs target here. | `main` (via release branch) | Yes, on version bump |
| `release/X.Y` | Stabilization branch. Created when `next` is feature-complete. Only bugfixes allowed. | `main` + back-merged to `next` | Yes, via `/release` command or workflow |
| `hotfix/X.Y.Z` | Emergency fixes for production. Cherry-picked from `next` or created fresh. | `release/X.Y` + `main` | No, manual |
| `feat/<issue>-<slug>` | Feature work. Targets `next`. | `next` | No, developer creates |
| `fix/<issue>-<slug>` | Bug fix. Targets `next` (or `release/X.Y` for hotfixes). | `next` or `release/X.Y` | No, developer creates |

### Version Scheme

Semantic versioning with automated bump logic based on conventional commits (already implemented in `generate-changelog.mjs`):

| Commit Type | Bump | Example |
|-------------|------|---------|
| `fix:` | Patch | 2.33.0 → 2.33.1 |
| `feat:` | Minor | 2.33.0 → 2.34.0 |
| `feat!:` / `BREAKING CHANGE` | Major | 2.33.0 → 3.0.0 |

Pre-release versions on `next`:

```
2.34.0-next.1    ← first merge to next after 2.33.0 release
2.34.0-next.2    ← second merge to next
2.34.0-next.N    ← continues until release/2.34 is cut
```

### Lifecycle

```
1. Development
   Developer creates feat/1325-user-prefs from next
   Developer opens PR targeting next
   CI runs on PR (build, test, typecheck, windows)
   PR is reviewed and merged to next
   Pipeline publishes gsd-pi@2.34.0-next.N with @next tag

2. Stabilization
   Maintainer runs: gh workflow dispatch create-release -- version=2.34
   Workflow creates release/2.34 from next
   Only fix: commits allowed on release/2.34 (enforced by branch protection)
   Pipeline publishes gsd-pi@2.34.0-rc.N with @rc tag
   Back-merges fixes to next automatically

3. Production Release
   Maintainer approves prod-release for release/2.34
   Pipeline merges release/2.34 → main, tags v2.34.0, publishes @latest
   release/2.34 branch is kept alive for patch releases (2.34.1, 2.34.2)

4. Hotfix
   Critical bug found in v2.34.0
   Developer creates fix/1400-critical from release/2.34
   PR targets release/2.34
   Pipeline publishes 2.34.1-rc.1 for verification
   Merged to release/2.34 → auto-merged to main → back-merged to next
```

## Automation: Workflow Additions

### 1. `create-release.yml` — Release Branch Creation

```yaml
name: Create Release Branch

on:
  workflow_dispatch:
    inputs:
      version:
        description: "Release version (e.g., 2.34)"
        required: true
        type: string

jobs:
  create-release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v6
        with:
          ref: next
          fetch-depth: 0
          token: ${{ secrets.RELEASE_PAT }}

      - name: Validate version format
        run: |
          if ! echo "${{ inputs.version }}" | grep -qE '^[0-9]+\.[0-9]+$'; then
            echo "::error::Version must be X.Y format (e.g., 2.34)"
            exit 1
          fi

      - name: Create release branch
        run: |
          BRANCH="release/${{ inputs.version }}"
          git checkout -b "$BRANCH"
          git push origin "$BRANCH"
          echo "Created $BRANCH from next"

      - name: Configure branch protection
        env:
          GH_TOKEN: ${{ secrets.RELEASE_PAT }}
        run: |
          # Require PR reviews, block force-push, restrict to fix: commits
          gh api repos/${{ github.repository }}/branches/release%2F${{ inputs.version }}/protection \
            -X PUT \
            -f required_pull_request_reviews='{"required_approving_review_count":1}' \
            -F enforce_admins=true \
            -F allow_force_pushes=false \
            || echo "::warning::Branch protection setup requires admin permissions"

      - name: Open tracking issue
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh issue create \
            --title "Release v${{ inputs.version }}.0" \
            --label "release" \
            --body "## Release v${{ inputs.version }}.0

          Release branch: \`release/${{ inputs.version }}\`
          Created from: \`next\` at $(git rev-parse --short HEAD)

          ### Checklist
          - [ ] All targeted fixes merged to release/${{ inputs.version }}
          - [ ] RC published and smoke-tested
          - [ ] CHANGELOG reviewed
          - [ ] Production deployment approved"
```

### 2. `sync-next.yml` — Auto-Create/Maintain `next` Branch

```yaml
name: Sync Next Branch

on:
  push:
    tags:
      - "v*"

jobs:
  sync-next:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
          token: ${{ secrets.RELEASE_PAT }}

      - name: Ensure next branch exists and is up to date
        run: |
          git fetch origin next 2>/dev/null || true

          if git show-ref --verify --quiet refs/remotes/origin/next; then
            # next exists — merge main into it (fast-forward if possible)
            git checkout next
            git merge origin/main --no-edit || {
              echo "::warning::Merge conflict merging main into next. Manual resolution required."
              exit 1
            }
          else
            # next doesn't exist — create from main
            git checkout -b next
          fi

          git push origin next
```

### 3. `backmerge.yml` — Auto Back-Merge Release Fixes to `next`

```yaml
name: Back-merge Release Fixes

on:
  push:
    branches:
      - "release/**"

jobs:
  backmerge:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
          token: ${{ secrets.RELEASE_PAT }}

      - name: Back-merge to next
        run: |
          RELEASE_BRANCH="${GITHUB_REF#refs/heads/}"
          git fetch origin next
          git checkout next
          git merge "origin/${RELEASE_BRANCH}" --no-edit || {
            # Conflict — open a PR instead of failing
            git merge --abort
            gh pr create \
              --base next \
              --head "${RELEASE_BRANCH}" \
              --title "backmerge: ${RELEASE_BRANCH} → next (conflict)" \
              --body "Automated back-merge from ${RELEASE_BRANCH} to next has a conflict. Please resolve manually."
            exit 0
          }
          git push origin next
        env:
          GH_TOKEN: ${{ secrets.RELEASE_PAT }}
```

## Pipeline Changes

The existing `pipeline.yml` needs minor adjustments:

| Current | Proposed |
|---------|----------|
| Pipeline triggers on `main` CI success | Pipeline triggers on `main`, `next`, and `release/*` CI success |
| Dev publish uses `-dev.<sha>` | `next` uses `-next.N`, `release/*` uses `-rc.N` |
| Prod release auto-bumps version | Prod release reads version from release branch |
| Single `@latest` promotion | `@next` from `next` branch, `@rc` from release branches, `@latest` from main |

## Migration Path

This can be adopted incrementally:

1. **Phase 1 (low risk):** Create `next` branch as an alias for `main`. PRs can target either. Pipeline handles both. Zero behavioral change.
2. **Phase 2:** Start targeting `next` for new feature PRs. `main` receives only merges from release branches.
3. **Phase 3:** Add `create-release.yml` workflow. Cut first release branch for the next minor.
4. **Phase 4:** Add back-merge automation. Enforce branch protection on release branches.

## What This Doesn't Change

- **Conventional commits** — same `feat:`, `fix:`, `refactor:` prefixes
- **CI workflow** — same build/test/typecheck gates on every PR
- **Dev publish** — still publishes on every merge (just to `next` instead of `main`)
- **Prod approval** — still requires manual environment approval
- **Changelog generation** — same script, just reads from release branch instead of main
- **Docker images** — same multi-stage build, same GHCR tags

## Open Questions

1. **Is the `next` branch worth the overhead?** Trunk-based is simpler. The main benefit is batched releases and a stable `main`.
2. **Should release branches be long-lived or ephemeral?** Long-lived enables patch releases (2.34.1, 2.34.2). Ephemeral (delete after merge) is simpler.
3. **How many simultaneous release branches?** Maintaining 2+ releases (current + previous) adds backport burden. Is `current + hotfix` enough?
4. **Should `next` branch get its own npm dist-tag?** Currently `@next` is promoted from `@dev`. With this model, `@next` would come from the `next` branch directly.
5. **Branch protection on `next`?** Require PR reviews? Or allow direct push for maintainers?

## Alternatives Considered

### Trunk-Based (Current)
Pros: Simple, fast. Cons: No release stabilization, no hotfix path.

### Full Git-Flow
Pros: Maximum control. Cons: Heavy — `develop`, `release`, `hotfix`, `feature` branches with strict merge rules. Overkill for a team this size.

### GitHub Flow + Release Tags
Pros: Simple branching, release via tags only. Cons: No stabilization period, same forward-only problem as current.

### Release Please / Semantic Release
Pros: Fully automated versioning. Cons: Less control over release timing, doesn't solve the hotfix branch problem.

## Feedback Requested

- Does this match how you want to manage releases?
- Is the `next` branch overhead justified for this project's pace?
- Which open questions have strong opinions?
- Any workflows or automation missing?
