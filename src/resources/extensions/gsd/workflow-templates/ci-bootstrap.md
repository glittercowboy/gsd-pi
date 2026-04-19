# CI Bootstrap Workflow

<template_meta>
name: ci-bootstrap
version: 1
mode: markdown-phase
requires_project: false
artifact_dir: .gsd/workflows/ci/
</template_meta>

<purpose>
Set up continuous integration for a project that has none (or needs a rewrite).
Picks a provider, builds a minimal working pipeline, and incrementally adds
lint / test / build / deploy stages. Goal: green CI on the first PR after
bootstrap, not a 2000-line yaml no one will maintain.
</purpose>

<phases>
1. discover   — Understand the stack and what "passing" means today
2. design     — Choose provider + plan the pipeline
3. implement  — Land the config, fix local failures so CI passes
4. verify     — Confirm the pipeline catches regressions
</phases>

<process>

## Phase 1: Discover

**Goal:** Know what to automate.

1. **Detect the stack:**
   - Primary language(s) and version(s) — check `package.json`, `pyproject.toml`,
     `go.mod`, `Cargo.toml`, `.tool-versions`, `.nvmrc`.
   - Package manager (npm / pnpm / yarn / pip / poetry / cargo / go).
   - Test runner(s).
   - Linter(s) / formatter(s).
   - Build tool(s).

2. **Run each check locally and record:**
   - `<install command>` — does it complete?
   - `<lint command>` — does it pass? How many warnings/errors?
   - `<test command>` — does it pass? What's the duration?
   - `<build command>` — does it pass? What's the output?

   If any fails locally, CI will fail too. Record the failures honestly —
   we'll triage in Phase 2.

3. **Check existing CI config:**
   - `.github/workflows/`, `.circleci/`, `.gitlab-ci.yml`, `azure-pipelines.yml`.
   - Is something already there but disabled / broken?

4. **Write `DISCOVERY.md`:**
   - Stack summary.
   - Current local-check status (pass/fail per step).
   - Existing CI state.
   - Constraints: open-source (free minutes matter), private, self-hosted?

5. **Gate:** Confirm the discovery before spending time on CI config.

## Phase 2: Design

**Goal:** Pick a provider and shape the minimal viable pipeline.

1. **Choose a provider.** Default to **GitHub Actions** if the repo is on
   GitHub — it's the most portable and well-documented. Alternatives:
   - GitLab CI for GitLab-hosted repos.
   - CircleCI for existing infra / orb reuse.
   - Ask before picking something else.

2. **Plan the pipeline stages**:
   - `install` — cache-friendly dependency install.
   - `lint` — run linters (non-blocking? or blocking?).
   - `test` — run tests (parallelize if the suite is slow).
   - `build` — run the build (only if it produces a required artifact).
   - `deploy` — optional, usually a later phase.

3. **Decide triggers:**
   - Pull requests to `main` — always.
   - Pushes to `main` — yes, for post-merge verification.
   - Nightly / cron — only if the project has flakes that need monitoring.

4. **Plan caching** — this is what makes CI fast:
   - Package manager caches (`node_modules`, `.venv`, `~/.cargo`).
   - Build output caches (turborepo, bazel, etc.) if the project uses them.

5. **Write `PLAN.md`:**
   - Provider.
   - Pipeline YAML sketch (high-level, not final).
   - Jobs + their dependencies.
   - Expected first-run duration (estimate).

6. **Gate:** Confirm the plan. Scope creep on CI is very real.

## Phase 3: Implement

**Goal:** Land a green pipeline.

1. **Write the CI config** — single file in the correct location.
   - Use the latest stable syntax.
   - Pin action versions by tag (`actions/checkout@v4`), not `latest`.
   - Keep to one matrix axis unless there's a strong reason.

2. **Triage local failures first.** If Phase 1 surfaced lint or test
   failures, either fix them now or explicitly mark them as
   `continue-on-error` (document why).

3. **Iterate locally** using `act` for GitHub Actions if available, or push
   to a feature branch and watch the run.

4. **Commit atomically:**
   ```
   ci: add GitHub Actions pipeline (lint, test, build)
   ```

5. **Append notes to `IMPL.md`** — gotchas, action version picks, caching
   decisions, any YAML tricks.

## Phase 4: Verify

**Goal:** Prove the pipeline catches what it should.

1. **Green on main** — the pipeline must pass on the current `main`.

2. **Red on a broken PR** — open a test PR that:
   - Introduces a lint violation.
   - Breaks a test.
   - Breaks the build.
   Confirm CI catches each one, then revert.

3. **Check the timing** — total duration should be acceptable. If it's >15
   min for a small project, look at caching and parallelization.

4. **Document for contributors** — `CONTRIBUTING.md` (or equivalent):
   - How to run each check locally.
   - What the CI does.
   - How to debug a red build.

5. **Gate:** Final demo. Show the user:
   - A green run on main.
   - A red run on a deliberately-broken branch.
   - The timing.
   - The docs.

</process>
