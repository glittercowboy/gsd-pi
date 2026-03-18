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
- Hosting GSD as a web service
- Automated prompt regression testing (future work)

## Pipeline Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    PR Merged to main                        │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  STAGE: DEV                          Environment: dev        │
│                                                              │
│  1. Build all packages (TS + Rust native)                    │
│  2. Run existing unit + integration tests                    │
│  3. Typecheck extensions                                     │
│  4. Package validation (validate-pack)                       │
│  5. npm publish gsd-pi@<version>-dev.<sha> --tag dev         │
│  6. Smoke test: npx gsd-pi@dev --version                    │
│                                                              │
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
| `@dev` | Every merged PR | `1.5.0-dev.a3f2c1b` | Bleeding edge |
| `@next` | Auto-promoted from Dev | Same version, new tag | Candidate |
| `@latest` | Manually approved from Test | Same version, new tag | Production |

### Relationship to Existing Workflows

| File | Trigger | Purpose | Status |
|------|---------|---------|--------|
| `ci.yml` | PR opened/updated | Pre-merge gate: build, test, typecheck | **Unchanged** |
| `build-native.yml` | `v*` tag or manual dispatch | Cross-compile native binaries for 5 platforms | **Unchanged** |
| `pipeline.yml` | Push to `main` | Post-merge promotion: Dev → Test → Prod | **New** |

## Docker Images

### Multi-Stage Dockerfile

Two images from a single `Dockerfile` at the repo root.

#### CI Builder Image

- **Name:** `ghcr.io/gsd-build/gsd-ci-builder`
- **Base:** `node:22-bookworm`
- **Contains:** Node 22, Rust stable toolchain, `aarch64-linux-gnu` cross-compiler, Playwright system deps
- **Size:** ~2.5 GB
- **Rebuilt:** Only when `Dockerfile` changes
- **Purpose:** Eliminates 3-5 min toolchain install on every CI run

#### Runtime Image

- **Name:** `ghcr.io/gsd-build/gsd-pi`
- **Base:** `node:22-slim`
- **Contains:** Node 22, git, `gsd-pi` installed globally
- **Size:** ~250 MB
- **Tags:** `:latest`, `:next`, `:v1.2.3`
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

### Modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Record** | `GSD_FIXTURE_MODE=record GSD_FIXTURE_DIR=./fixtures` | Proxies to real API, saves request/response pairs |
| **Replay** | `GSD_FIXTURE_MODE=replay GSD_FIXTURE_DIR=./fixtures` | Matches by turn index, returns saved response |
| **Off** | Default (no env vars) | Normal operation |

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

Turn-index based. Response N is served for request N in sequence. If the conversation diverges from the fixture, the test fails explicitly.

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

## New Files & Scripts

### Directory Structure

```
tests/
├── smoke/                     # CLI smoke tests (Stage: Test)
│   ├── run.mjs
│   ├── test-version.mjs
│   ├── test-help.mjs
│   └── test-init.mjs
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
```

### New npm Scripts

```json
{
  "test:smoke": "node tests/smoke/run.mjs",
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

1. A merged PR is installable via `npx gsd-pi@dev` within 10 minutes
2. Fixture replay tests complete in under 60 seconds with zero API calls
3. The full Dev → Test promotion completes without human intervention
4. Prod promotion is blocked until a maintainer explicitly approves
5. `docker run ghcr.io/gsd-build/gsd-pi --version` returns the correct version
6. Existing `ci.yml` and `build-native.yml` workflows continue to work unchanged
7. CI builder image reduces toolchain setup from ~3-5 min to ~30s pull
