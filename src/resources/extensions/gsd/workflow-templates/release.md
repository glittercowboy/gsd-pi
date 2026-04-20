# Release Workflow

<template_meta>
name: release
version: 1
mode: markdown-phase
requires_project: false
artifact_dir: .gsd/workflows/releases/
</template_meta>

<purpose>
Cut a software release in four phases with approval gates. Handles version
bump, changelog generation, tag creation, and publish/announce. Conservative
by default — prompts for confirmation before any action that's visible outside
the repo.
</purpose>

<phases>
1. prepare  — Decide version bump, verify state
2. bump     — Write version, changelog, create tag
3. publish  — Push tag, run release pipeline
4. announce — Post release notes
</phases>

<process>

## Phase 1: Prepare

**Goal:** Decide the version bump and confirm the repo is ready to release.

1. **Read the state of the repo:**
   - `git log <last_tag>..HEAD --oneline --no-merges` — commits since last release.
   - Check for uncommitted changes (`git status`).
   - Identify the branch (release from main/master unless explicitly told otherwise).

2. **Propose a semver bump:**
   - `major` if any commit has a `BREAKING CHANGE:` footer or `!` suffix.
   - `minor` if any commit is `feat:` / `feature:`.
   - `patch` otherwise.
   - Print: current version, proposed next version, and the commit categorization.

3. **Write `PREPARE.md`** in the artifact directory with:
   - Proposed version.
   - Commit summary grouped by type.
   - Any concerns (unmerged PRs, failing CI, recent reverts).

4. **Gate:** Present the plan and ask the user to confirm the version before
   proceeding. If the user wants a different bump, record the rationale.

## Phase 2: Bump

**Goal:** Commit the version bump and write the changelog.

1. **Bump the version** in the appropriate file(s):
   - Node: `package.json` (and workspace `package.json`s if monorepo).
   - Python: `pyproject.toml` / `setup.py` / `__version__`.
   - Rust: `Cargo.toml`.
   - Other: ask if unsure.

2. **Generate the changelog entry** — follow Keep a Changelog format. Add it
   to `CHANGELOG.md` under `## [x.y.z] - YYYY-MM-DD`. Preserve all existing
   entries untouched.

3. **Commit:**
   ```
   chore(release): v<x.y.z>
   ```

4. **Create an annotated tag:**
   ```
   git tag -a v<x.y.z> -m "Release v<x.y.z>"
   ```
   Don't push yet.

5. **Gate:** Show the diff (`git show HEAD`, `git show v<x.y.z>`) and confirm
   before pushing.

## Phase 3: Publish

**Goal:** Push the release and kick off downstream pipelines.

1. **Push commit + tag:**
   ```
   git push origin <branch>
   git push origin v<x.y.z>
   ```

2. **Trigger the release pipeline** if applicable:
   - GitHub Actions release workflow (often triggered by tag push).
   - `npm publish`, `cargo publish`, `pypi upload` — only if explicitly asked.

3. **Verify:**
   - CI passes on the tagged commit.
   - Release artifact appears where expected (GitHub releases, registry, etc).

4. **Gate:** Confirm the release is live and visible before announcing.

## Phase 4: Announce

**Goal:** Make the release discoverable.

1. **Create or update the GitHub Release** (via `gh release create` or an
   existing workflow output). Include:
   - Tag name.
   - Title: `v<x.y.z>`.
   - Body: the CHANGELOG entry for this version.

2. **Optional follow-ups** (ask the user first):
   - Slack / Discord announcement draft.
   - Update docs / examples that reference the version.
   - Close any milestone linked to this release.

3. **Write `RELEASE.md`** in the artifact dir capturing:
   - What shipped.
   - Links to the release, changelog, and key PRs.
   - Any post-release follow-ups.

</process>
