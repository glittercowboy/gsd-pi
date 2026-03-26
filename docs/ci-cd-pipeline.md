# CI/CD Pipeline Guide

## Overview

GSD 2 uses a three-stage promotion pipeline that automatically moves merged PRs through **Dev → Test → Prod** environments using npm dist-tags.

```
PR merged to main
        │
        ▼
   ┌─────────┐    ci.yml passes (build, test, typecheck)
   │   DEV   │    → publishes gsd-pi@<version>-dev.<sha> with @dev tag
   └────┬────┘
        ▼ (automatic if green)
   ┌─────────┐    CLI smoke tests + LLM fixture replay
   │  TEST   │    → promotes to @next tag
   └────┬────┘    → pushes Docker image as :next
        ▼ (manual approval required)
   ┌─────────┐    optional real-LLM integration tests
   │  PROD   │    → promotes to @latest tag
   └─────────┘    → creates GitHub Release
```

## For Contributors: Testing Your PR Before It Ships

### Install the Dev Build

Every merged PR is immediately installable:

```bash
# Latest dev build (bleeding edge, every merged PR)
npx gsd-pi@dev

# Test candidate (passed smoke + fixture tests)
npx gsd-pi@next

# Stable production release
npx gsd-pi@latest    # or just: npx gsd-pi
```

### Using Docker

```bash
# Test candidate
docker run --rm -v $(pwd):/workspace ghcr.io/gsd-build/gsd-pi:next --version

# Stable
docker run --rm -v $(pwd):/workspace ghcr.io/gsd-build/gsd-pi:latest --version
```

### Checking if a Fix Landed

1. Find the PR's merge commit SHA (first 7 chars)
2. Check if it's in `@dev`: `npm view gsd-pi@dev version`
   - If the version ends in `-dev.<your-sha>`, your PR is in dev
3. Check if it promoted to `@next`: `npm view gsd-pi@next version`
4. Check if it's in production: `npm view gsd-pi@latest version`

## For Maintainers

### Pipeline Workflows

| Workflow | File | Trigger | Purpose |
|----------|------|---------|---------|
| CI | `ci.yml` | PR + push to main | Build, test, typecheck — **gate for all promotions** |
| Release Pipeline | `pipeline.yml` | After CI succeeds on main | Three-stage promotion |
| Native Binaries | `build-native.yml` | `v*` tags | Cross-compile platform binaries |
| Dev Cleanup | `cleanup-dev-versions.yml` | Weekly (Monday 06:00 UTC) | Unpublish `-dev.` versions older than 30 days |
| AI Triage | `triage.yml` | New issues + PRs | Automated classification via Claude Haiku (v2.36) |

**CI optimization (v2.38):** GitHub Actions minutes were reduced ~60-70% (~10k → ~3-4k/month) through workflow consolidation and caching improvements.

**Pipeline optimization (v2.41):**
- **Shallow clones** — CI lint and build jobs use `fetch-depth: 1` or `fetch-depth: 2` instead of full history, saving ~30-60s per job
- **npm cache in pipeline** — dev-publish, test-verify, and prod-release now use `cache: 'npm'` on setup-node, saving ~1-2 min per job on repeat runs
- **Exponential backoff** — npm registry propagation waits in `build-native.yml` replaced hardcoded `sleep 30` + fixed 15s retries with exponential backoff (5s → 10s → 20s → 30s cap), typically finishing in <15s when the registry is fast
- **Security hardening** — pipeline.yml moved `${{ }}` expressions from `run:` blocks to `env:` variables to prevent command injection vectors
### Docs-Only PR Detection (v2.41)

CI automatically detects when a PR contains only documentation changes (`.md` files and `docs/` content). When docs-only:

- **Skipped:** `build`, `windows-portability` (no code to compile or test)
- **Still runs:** `lint` (secret scanning, `.gsd/` check), `docs-check` (prompt injection scan)

This saves CI minutes on documentation PRs while still enforcing security checks.

### Prompt Injection Scan (v2.41)

The `docs-check` job runs `scripts/docs-prompt-injection-scan.sh` on every PR that touches markdown files. It scans documentation prose (excluding fenced code blocks) for patterns that could manipulate LLM behavior when docs are ingested as context:

- **System prompt markers** — `<system-prompt>`, `<|im_start|>system`, `[SYSTEM]:`
- **Role/instruction overrides** — `ignore previous instructions`, `you are now`, `new instructions:`
- **Hidden HTML directives** — `<!-- PROMPT:`, `<!-- INSTRUCTION:`
- **Tool call injection** — `<tool_call>`, `<function_call>`, `<invoke`
- **Invisible Unicode** — zero-width character sequences that hide directives

Content inside fenced code blocks (` ``` `) is excluded — patterns in code examples are expected and legitimate.

**False positives:** Add exceptions to `.prompt-injection-scanignore` using the same format as `.secretscanignore` (one pattern per line, `file:regex` for file-scoped exceptions).

### Gating Tests

The pipeline only triggers after `ci.yml` passes. Key gating tests include:

- **Unit tests** (`npm run test:unit`) — includes `auto-session-encapsulation.test.ts` which enforces that all auto-mode state is encapsulated in `AutoSession`, plus dispatch loop regression tests that exercise the full `deriveState → resolveDispatch → idempotency` chain without an LLM. Any PR adding module-level mutable state to `auto.ts` will fail CI and block the pipeline.
- **Integration tests** (`npm run test:integration`)
- **Extension typecheck** (`npm run typecheck:extensions`)
- **Package validation** (`npm run validate-pack`)
- **Smoke tests** (`npm run test:smoke`) — run post-build in the pipeline against the local binary and again against the globally-installed `@dev` package
- **Fixture tests** (`npm run test:fixtures`) — replay recorded LLM conversations without hitting real APIs
- **Live regression tests** (`npm run test:live-regression`) — run against the installed binary in the Test stage to catch runtime regressions before promotion to `@next`

### Approving a Prod Release

1. A version reaches the Test stage automatically
2. In GitHub Actions, the `prod-release` job will show "Waiting for review"
3. Click **Review deployments** → select `prod` → **Approve**
4. The version is promoted to `@latest` and a GitHub Release is created

To enable live LLM tests during Prod promotion:
- Set the `RUN_LIVE_TESTS` environment variable to `true` on the `prod` environment

### Rolling Back a Release

If a broken version reaches production:

```bash
# Roll back npm
npm dist-tag add gsd-pi@<previous-good-version> latest

# Roll back Docker
docker pull ghcr.io/gsd-build/gsd-pi:<previous-good-version>
docker tag ghcr.io/gsd-build/gsd-pi:<previous-good-version> ghcr.io/gsd-build/gsd-pi:latest
docker push ghcr.io/gsd-build/gsd-pi:latest
```

For `@dev` or `@next` rollbacks, the next successful merge will overwrite the tag automatically.

### GitHub Configuration Required

| Setting | Value |
|---------|-------|
| Environment: `dev` | No protection rules |
| Environment: `test` | No protection rules |
| Environment: `prod` | Required reviewers: maintainers |
| Secret: `NPM_TOKEN` | All environments |
| Secret: `ANTHROPIC_API_KEY` | Prod environment only |
| Secret: `OPENAI_API_KEY` | Prod environment only |
| Variable: `RUN_LIVE_TESTS` | `false` (set to `true` to enable live LLM tests) |
| GHCR | Enabled for the `gsd-build` org |

### Docker Images

| Image | Base | Purpose | Tags |
|-------|------|---------|------|
| `ghcr.io/gsd-build/gsd-ci-builder` | `node:24-bookworm` | CI build environment with Rust toolchain | `:latest`, `:<date>` |
| `ghcr.io/gsd-build/gsd-pi` | `node:24-slim` | User-facing runtime | `:latest`, `:next`, `:v<version>` |

The CI builder image is rebuilt automatically when the `Dockerfile` changes. It eliminates ~3-5 min of toolchain setup per CI run.

## LLM Fixture Tests

The fixture system records and replays LLM conversations without hitting real APIs (zero cost).

### Running Fixture Tests

```bash
npm run test:fixtures
```

### Recording New Fixtures

```bash
# Set your API key, then record
GSD_FIXTURE_MODE=record GSD_FIXTURE_DIR=./tests/fixtures/recordings \
  node --experimental-strip-types tests/fixtures/record.ts
```

Fixtures are JSON files in `tests/fixtures/recordings/`. Each one captures a conversation's request/response pairs and replays them by turn index.

### When to Re-Record

Re-record fixtures when:
- Provider wire format changes (e.g., new field in Anthropic response)
- Tool definitions change (affects request shape)
- System prompt changes (may cause turn count mismatch)

## Version Strategy

| Tag | Published | Format | Who uses it |
|-----|-----------|--------|-------------|
| `@dev` | Every merged PR | `2.27.0-dev.a3f2c1b` | Developers verifying fixes |
| `@next` | Auto-promoted from dev | Same version | Early adopters, beta testers |
| `@latest` | Manually approved | Same version | Production users |

Old `-dev.` versions are cleaned up weekly (30-day retention).
