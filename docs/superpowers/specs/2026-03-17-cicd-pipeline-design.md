# CI/CD Pipeline Design — GSD 2

## Overview

A three-stage promotion pipeline for GSD 2 that moves merged PRs through Dev → Test → Prod using npm dist-tags as environment markers, GitHub Environments for approval gates, and Docker images for both CI acceleration and end-user distribution.

## Goals

1. Every merged PR is immediately installable via `npx gsd-pi@dev`
2. Verified builds auto-promote to `@next` for early adopters
3. Production releases require manual approval and optional live-LLM validation
4. CI builds are fast and reproducible via pre-built Docker builder image
5. End users can run GSD via Docker as an alternative to npm
6. LLM-dependent behavior is testable without API calls via recorded fixtures

## Non-Goals

- Replacing the existing PR gate workflow (`ci.yml`)
- Replacing the native binary cross-compilation workflow (`build-native.yml`)
- Cross-platform native binary builds (macOS/Windows remain on `build-native.yml`)
- Hosting GSD as a web service
- Automated prompt regression testing (future work)

## Pipeline Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    PR Merged to main                        │
│              ci.yml runs (build, test, typecheck)           │
└──────────────────────────┬──────────────────────────────────┘
                           ▼ (workflow_run: ci.yml success)
┌──────────────────────────────────────────────────────────────┐
│  STAGE: DEV                          Environment: dev        │
│                                                              │
│  1. Version stamp: <current>-dev.<short-sha>                 │
│  2. npm publish gsd-pi@<version>-dev.<sha> --tag dev         │
│  3. Smoke test: npx gsd-pi@dev --version                    │
│                                                              │
│  Note: Build/test/typecheck already ran in ci.yml            │
│  Docker: Build CI builder image (only if Dockerfile changed) │
└──────────────────────────┬──────────────────────────────────┘
                           ▼ (auto-promote if all green)
┌──────────────────────────────────────────────────────────────┐
│  STAGE: TEST                         Environment: test       │
│                                                              │
│  1. Install gsd-pi@dev from registry                         │
│  2. CLI smoke tests (--version, init, help, config)          │
│  3. Dry-run fixture suite (recorded LLM conversations)       │
│     - Agent session replay with fixture provider             │
│     - Tool use round-trips verified                          │
│     - Extension loading validated                            │
│  4. npm dist-tag add gsd-pi@<version> next                   │
│                                                              │
│  Docker: Build + push runtime image to GHCR as :next         │
└──────────────────────────┬──────────────────────────────────┘
                           ▼ (manual approval required)
┌──────────────────────────────────────────────────────────────┐
│  STAGE: PROD                         Environment: prod       │
│                                                              │
│  1. (Optional) Real LLM integration tests                    │
│     - Gated behind workflow input flag                       │
│     - Uses ANTHROPIC_API_KEY / OPENAI_API_KEY secrets        │
│     - Budget-capped: small models, short conversations       │
│  2. npm dist-tag add gsd-pi@<version> latest                 │
│  3. GitHub Release created with changelog                    │
│  4. Docker: tag runtime image as :latest + :v<version>       │
│  5. Post-publish smoke test against @latest                  │
└──────────────────────────────────────────────────────────────┘
```

### Version Strategy

| Dist-tag | When published | Version format | Risk level |
|----------|---------------|----------------|------------|
| `@dev` | Every merged PR | `2.27.0-dev.a3f2c1b` | Bleeding edge |
| `@next` | Auto-promoted from Dev | Same version, new tag | Candidate |
| `@latest` | Manually approved from Test | Same version, new tag | Production |

The `-dev.` prerelease identifier is distinct from the existing `-next.` convention used in `build-native.yml`. The two pipelines do not overlap — `build-native.yml` only triggers on `v*` tags and checks for `-next.` to determine npm dist-tag. The `-dev.` versions are published exclusively by `pipeline.yml`.

### Native Binary Strategy for Dev Publishes

Dev versions (`@dev` tag) use the native binaries from the most recent stable `build-native.yml` release. The `optionalDependencies` in `package.json` use `>=` ranges, so a `-dev.` version of `gsd-pi` resolves the latest stable `@gsd-build/engine-*` packages from the registry.

If a PR modifies Rust native crate code (`native/` directory), the dev publish will bundle stale native binaries. This is acceptable because:
- Native crate changes are infrequent and always accompanied by a `v*` tag release
- The Test stage validates the installed package works end-to-end
- Full native binary validation happens via `build-native.yml` on the version tag

### Concurrency Control

```yaml
concurrency:
  group: pipeline-${{ github.sha }}
  cancel-in-progress: false
```

Policy:
- Each pipeline run is keyed to its commit SHA — no two runs for the same commit race
- Newer merges do NOT cancel in-progress promotions — a version already in the Test stage completes its promotion
- If Run A is promoting version X to `@next` while Run B publishes version Y to `@dev`, they operate independently — `@next` and `@dev` point to different versions, which is correct
- The Prod stage always promotes whatever version is currently at `@next`, so approving promotion after a newer version has already moved to `@next` promotes the newer one (last-writer-wins, which is the desired behavior)

### Failure Modes & Recovery

| Failure | Impact | Recovery |
|---------|--------|----------|
| Dev publish succeeds, smoke test fails | Broken version on `@dev` tag | Next successful merge overwrites `@dev`. Manual fix: `npm dist-tag add gsd-pi@<last-good> dev` |
| Test stage fails after promoting to `@next` | Broken version on `@next` tag | Manual: `npm dist-tag add gsd-pi@<last-good> next`. `@latest` is never affected. |
| Prod promotion publishes `@latest` then found broken | Broken production release | Manual: `npm dist-tag add gsd-pi@<previous-stable> latest` and `docker tag ghcr.io/gsd-build/gsd-pi:<previous> latest && docker push`. Post-mortem required. |
| Docker push succeeds, npm dist-tag fails | Images and npm out of sync | Re-run the failed job (GitHub Actions retry). Images are tagged by version so stale tags are harmless. |
| GHCR push fails | No Docker image for this version | Non-blocking — npm publish is the primary distribution. Docker image can be rebuilt manually. |

Rollback responsibility: any maintainer with npm publish rights and GHCR push access. The Prod environment's required-reviewers list doubles as the rollback-authorized list.

### Relationship to Existing Workflows

| File | Trigger | Purpose | Status |
|------|---------|---------|--------|
| `ci.yml` | PR opened/updated, push to main | Pre-merge gate: build, test, typecheck | **Unchanged** |
| `build-native.yml` | `v*` tag or manual dispatch | Cross-compile native binaries for 5 platforms | **Unchanged** |
| `pipeline.yml` | `workflow_run` (after ci.yml succeeds on main) | Post-merge promotion: Dev → Test → Prod | **New** |

The pipeline triggers via `workflow_run` after `ci.yml` completes successfully on `main`, avoiding duplicate build/test work. The Dev stage only performs version stamping, publishing, and smoke testing.

## Docker Images

### Multi-Stage Dockerfile

Two images from a single `Dockerfile` at the repo root.

#### CI Builder Image

- **Name:** `ghcr.io/gsd-build/gsd-ci-builder`
- **Base:** `node:22-bookworm`
- **Contains:** Node 22, Rust stable toolchain, `aarch64-linux-gnu` cross-compiler
- **Size:** ~2 GB
- **Tags:** `:latest`, `:<YYYY-MM-DD>` (date-stamped for rollback)
- **Rebuilt:** Only when `Dockerfile` changes
- **Used by:** `pipeline.yml` Dev stage, optionally `ci.yml`
- **Purpose:** Eliminates 3-5 min toolchain install on every CI run

The builder image does NOT include Playwright system deps (not needed for current CI jobs). If browser-based E2E tests are added later, Playwright deps can be added at that point.

#### Builder Image Versioning

Builder images are tagged with both `:latest` and a date stamp (e.g., `:2026-03-17`). The `pipeline.yml` workflow pins to a specific date-stamped tag. When the Dockerfile is updated, the PR that changes it also updates the tag reference in `pipeline.yml`. This prevents a broken Dockerfile change from silently breaking all subsequent runs.

#### Runtime Image

- **Name:** `ghcr.io/gsd-build/gsd-pi`
- **Base:** `node:22-slim`
- **Contains:** Node 22, git, `gsd-pi` installed globally
- **Size:** ~250 MB
- **Tags:** `:latest`, `:next`, `:v2.27.0`
- **Published:** On every Prod promotion
- **Purpose:** `docker run ghcr.io/gsd-build/gsd-pi` as alternative to `npx`

### Why These Base Images

- **Bookworm for CI:** The Rust native crates depend on vendored `libgit2`, image processing, and cross-compilation to ARM64. Debian Bookworm provides the full toolchain via apt. Alpine breaks due to musl vs glibc incompatibilities with N-API bindings.
- **Slim for runtime:** Only needs Node + git. Native `.node` binaries are prebuilt and bundled in the npm package — no Rust toolchain needed at runtime.

## LLM Fixture Recording & Replay System

### Architecture

The fixture system hooks into the `pi-ai` provider abstraction layer to capture and replay LLM conversations without hitting real APIs.

```
Agent Session
    │
    ▼
pi-ai provider abstraction
    │
    ▼
FixtureProvider (intercept layer)
    │
    ├── record mode → Real API + save to fixture JSON
    │
    └── replay mode → Load fixture JSON (no API call)
```

### Integration Design

The `FixtureProvider` implements the `Provider` interface from `@gsd/pi-ai` (the same interface all 20+ built-in providers implement). It registers itself via environment variable detection at provider initialization:

```typescript
// Pseudocode — actual implementation will follow pi-ai patterns
import type { Provider, StreamingResponse } from "@gsd/pi-ai";

class FixtureProvider implements Provider {
  // In record mode: wraps the real provider, saves responses
  // In replay mode: returns saved responses directly

  async *stream(request: ProviderRequest): AsyncGenerator<StreamingResponse> {
    if (this.mode === "replay") {
      // Yield fixture response chunks (simulated streaming)
      yield* this.replayTurn(this.turnIndex++);
    } else {
      // Proxy to real provider, capture response
      const chunks = [];
      for await (const chunk of this.realProvider.stream(request)) {
        chunks.push(chunk);
        yield chunk;
      }
      this.saveTurn(request, chunks);
    }
  }
}
```

Key integration details:
- **Streaming:** Fixture replay simulates streaming by yielding saved response chunks with minimal delay. This exercises the same consumer code paths as real streaming.
- **Registration:** When `GSD_FIXTURE_MODE` is set, the fixture provider wraps the configured real provider. No changes to provider selection logic needed.
- **Provider-agnostic:** Fixtures are captured at the `Provider` interface level (above HTTP transport), so they work regardless of which underlying provider was used during recording.

### Modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Record** | `GSD_FIXTURE_MODE=record GSD_FIXTURE_DIR=./fixtures` | Wraps real provider, saves request/response pairs |
| **Replay** | `GSD_FIXTURE_MODE=replay GSD_FIXTURE_DIR=./fixtures` | Returns saved responses, zero API calls |
| **Off** | Default (no env vars) | Normal operation, no interception |

### Fixture Format

One JSON file per recorded session:

```json
{
  "name": "agent-creates-file",
  "recorded": "2026-03-17T00:00:00Z",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "turns": [
    {
      "request": {
        "messages": [{ "role": "user", "content": "Create hello.ts" }],
        "tools": ["Write", "Read"],
        "model": "claude-sonnet-4-6"
      },
      "response": {
        "content": [
          { "type": "text", "text": "I'll create hello.ts for you." },
          { "type": "tool_use", "name": "Write", "input": { "file_path": "hello.ts", "content": "console.log('hello')" } }
        ],
        "stopReason": "toolUse",
        "usage": { "input": 150, "output": 45 }
      }
    }
  ]
}
```

### Matching Strategy

Turn-index based. Response N is served for request N in sequence. If the conversation diverges from the fixture (e.g., unexpected turn count), the test fails explicitly with a descriptive error rather than silently producing wrong results.

Why not request-body hashing: request bodies contain timestamps, random IDs, and system prompt variations that cause brittle mismatches.

Why not a generic HTTP VCR: The `pi-ai` layer abstracts 20+ providers with different wire formats. Intercepting above the transport means fixtures are provider-agnostic.

### What Gets Tested via Fixtures

- Agent session lifecycle (start → tool calls → completion)
- Tool dispatch and response handling
- Multi-turn conversation flow
- Extension loading and routing
- Error handling paths (fixtures can include error responses)

### What Does NOT Get Tested (Deferred to Live Gate)

- Model output quality
- Prompt regression
- New tool compatibility with live APIs

### Fixture Storage

Committed to repo under `tests/fixtures/recordings/`. Each fixture is 5-50KB of JSON. Recording is a manual developer action, not automated in CI.

### Dev Version Cleanup

Old `-dev.` versions accumulate on npm with every merged PR. A scheduled workflow (`cleanup-dev-versions.yml`) runs weekly and unpublishes dev versions older than 30 days via `npm unpublish gsd-pi@<old-dev-version>`. This prevents registry bloat while keeping recent dev versions available.

## New Files & Scripts

### Directory Structure

```
tests/
├── smoke/                     # CLI smoke tests (Stage: Test)
│   ├── run.ts
│   ├── test-version.ts
│   ├── test-help.ts
│   └── test-init.ts
│
├── fixtures/                  # Recorded LLM replay tests (Stage: Test)
│   ├── run.ts                 # Test runner
│   ├── record.ts              # Recording helper
│   ├── provider.ts            # FixtureProvider intercept layer
│   └── recordings/
│       ├── agent-creates-file.json
│       ├── agent-reads-and-edits.json
│       ├── agent-handles-error.json
│       └── agent-multi-turn-tools.json
│
├── live/                      # Real LLM tests (Stage: Prod, optional)
│   ├── run.ts
│   ├── test-anthropic-roundtrip.ts
│   └── test-openai-roundtrip.ts
│
scripts/
├── version-stamp.mjs          # Stamps <version>-dev.<sha>

Dockerfile                     # Multi-stage: builder + runtime
.github/workflows/pipeline.yml # Promotion pipeline
.github/workflows/cleanup-dev-versions.yml # Weekly dev version pruning
```

All test files use `.ts` with `--experimental-strip-types` for consistency with the existing test convention in the project.

### New npm Scripts

```json
{
  "test:smoke": "node --experimental-strip-types tests/smoke/run.ts",
  "test:fixtures": "node --experimental-strip-types tests/fixtures/run.ts",
  "test:fixtures:record": "GSD_FIXTURE_MODE=record node --experimental-strip-types tests/fixtures/record.ts",
  "test:live": "GSD_LIVE_TESTS=1 node --experimental-strip-types tests/live/run.ts",
  "pipeline:version-stamp": "node scripts/version-stamp.mjs",
  "docker:build-runtime": "docker build --target runtime -t ghcr.io/gsd-build/gsd-pi .",
  "docker:build-builder": "docker build --target builder -t ghcr.io/gsd-build/gsd-ci-builder ."
}
```

## GitHub Configuration

| Setting | Value |
|---------|-------|
| Environment: `dev` | No protection rules |
| Environment: `test` | No protection rules (auto-promote) |
| Environment: `prod` | Required reviewers: maintainers |
| Secret: `NPM_TOKEN` | All environments |
| Secret: `ANTHROPIC_API_KEY` | Prod only |
| Secret: `OPENAI_API_KEY` | Prod only |
| GHCR | Enabled for org |

## Success Criteria

1. A merged PR is installable via `npx gsd-pi@dev` within 15 minutes (assumes warm CI builder image cache)
2. Fixture replay tests complete in under 60 seconds with zero API calls
3. The full Dev → Test promotion completes without human intervention
4. Prod promotion is blocked until a maintainer explicitly approves
5. `docker run ghcr.io/gsd-build/gsd-pi --version` returns the correct version
6. Existing `ci.yml` and `build-native.yml` workflows continue to work unchanged
7. CI builder image reduces toolchain setup from ~3-5 min to ~30s pull
