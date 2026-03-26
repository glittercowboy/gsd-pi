# CI/CD Pipeline Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a three-stage promotion pipeline (Dev → Test → Prod) with Docker images, LLM fixture replay, and npm dist-tag management.

**Architecture:** GitHub Actions `workflow_run` trigger chains `ci.yml` success into a new `pipeline.yml` with three jobs (dev-publish, test-verify, prod-release). A `FixtureProvider` wraps `pi-ai`'s `ApiProvider` interface to record/replay LLM conversations. Two Docker images (CI builder + slim runtime) are built from a single multi-stage Dockerfile.

**Tech Stack:** GitHub Actions, Docker (multi-stage), Node 22, Rust toolchain, npm dist-tags, GHCR

**Spec:** `docs/superpowers/specs/2026-03-17-cicd-pipeline-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `Dockerfile` | Multi-stage: `builder` target (CI image) + `runtime` target (user image) |
| `.github/workflows/pipeline.yml` | Three-stage promotion pipeline (Dev → Test → Prod) |
| `.github/workflows/cleanup-dev-versions.yml` | Weekly scheduled cleanup of old `-dev.` npm versions |
| `scripts/version-stamp.mjs` | Reads `package.json` version, appends `-dev.<sha>`, writes back |
| `tests/smoke/run.ts` | Smoke test runner — discovers and executes all smoke tests |
| `tests/smoke/test-version.ts` | Verify `gsd --version` outputs valid semver |
| `tests/smoke/test-help.ts` | Verify `gsd --help` exits 0 and contains expected output |
| `tests/smoke/test-init.ts` | Verify `gsd init` creates expected files in a temp dir |
| `tests/fixtures/provider.ts` | `FixtureProvider` — wraps `ApiProvider`, records/replays turns |
| `tests/fixtures/run.ts` | Fixture test runner — loads recordings, replays via `FixtureProvider` |
| `tests/fixtures/record.ts` | Recording helper — runs a session with `GSD_FIXTURE_MODE=record` |
| `tests/fixtures/recordings/agent-creates-file.json` | Sample fixture: single-turn file creation |
| `tests/fixtures/recordings/agent-reads-and-edits.json` | Fixture: multi-turn read + edit flow |
| `tests/fixtures/recordings/agent-handles-error.json` | Fixture: error response handling |
| `tests/fixtures/recordings/agent-multi-turn-tools.json` | Fixture: multi-turn tool use round-trips |
| `tests/live/run.ts` | Live LLM test runner (optional, Prod gate only) |
| `tests/live/test-anthropic-roundtrip.ts` | Real Anthropic API round-trip test |
| `tests/live/test-openai-roundtrip.ts` | Real OpenAI API round-trip test |

### Modified Files

| File | Change |
|------|--------|
| `package.json` | Add 6 new scripts (`test:smoke`, `test:fixtures`, etc.) |

---

## Chunk 1: Version Stamp Script + Dockerfile

### Task 1: Version Stamp Script

**Files:**
- Create: `scripts/version-stamp.mjs`

- [ ] **Step 1: Write the version stamp script**

```javascript
// scripts/version-stamp.mjs
// Stamps the package.json version with -dev.<short-sha> for CI dev publishes.
// Usage: node scripts/version-stamp.mjs
// Example: 2.27.0 → 2.27.0-dev.a3f2c1b

import { readFileSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";

const pkgPath = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const shortSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const devVersion = `${pkg.version}-dev.${shortSha}`;

pkg.version = devVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

console.log(`Stamped version: ${devVersion}`);
```

- [ ] **Step 2: Test it locally**

Run: `node scripts/version-stamp.mjs`
Expected: Outputs `Stamped version: 2.27.0-dev.<your-sha>` and modifies `package.json`

- [ ] **Step 3: Revert the package.json change**

Run: `git checkout -- package.json`

- [ ] **Step 4: Commit**

```bash
git add scripts/version-stamp.mjs
git commit -m "feat(ci): add version stamp script for dev publishes"
```

---

### Task 2: Multi-Stage Dockerfile

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# ──────────────────────────────────────────────
# Stage 1: CI Builder
# Image: ghcr.io/gsd-build/gsd-ci-builder
# Used by: pipeline.yml Dev stage
# ──────────────────────────────────────────────
FROM node:22-bookworm AS builder

# Rust toolchain (stable, minimal profile)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

# Cross-compilation for linux-arm64
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc-aarch64-linux-gnu \
    g++-aarch64-linux-gnu \
    && rustup target add aarch64-unknown-linux-gnu \
    && rm -rf /var/lib/apt/lists/*

# Verify toolchain
RUN node --version && rustc --version && cargo --version

# ──────────────────────────────────────────────
# Stage 2: Runtime
# Image: ghcr.io/gsd-build/gsd-pi
# Used by: end users via docker run
# ──────────────────────────────────────────────
FROM node:22-slim AS runtime

# Git is required for GSD's git operations
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install GSD globally — version is controlled by the build arg
ARG GSD_VERSION=latest
RUN npm install -g gsd-pi@${GSD_VERSION}

# Default working directory for user projects
WORKDIR /workspace

ENTRYPOINT ["gsd"]
CMD ["--help"]
```

- [ ] **Step 2: Verify builder stage builds**

Run: `docker build --target builder -t gsd-ci-builder-test .`
Expected: Completes successfully (may take 5-10 min first time)

- [ ] **Step 3: Verify runtime stage builds**

Run: `docker build --target runtime -t gsd-pi-test .`
Expected: Completes successfully

- [ ] **Step 4: Verify runtime image works**

Run: `docker run --rm gsd-pi-test --version`
Expected: Outputs a version string

- [ ] **Step 5: Commit**

```bash
git add Dockerfile
git commit -m "feat(ci): add multi-stage Dockerfile for CI builder and runtime images"
```

---

## Chunk 2: Smoke Tests

### Task 3: Smoke Test Runner and Tests

**Files:**
- Create: `tests/smoke/run.ts`
- Create: `tests/smoke/test-version.ts`
- Create: `tests/smoke/test-help.ts`
- Create: `tests/smoke/test-init.ts`
- Modify: `package.json` (add `test:smoke` script)

- [ ] **Step 1: Create the smoke test runner**

```typescript
// tests/smoke/run.ts
// Discovers and runs all smoke tests in this directory.
// Usage: node --experimental-strip-types tests/smoke/run.ts
// Note: Uses execFileSync (not exec) to avoid shell injection.

import { readdirSync } from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const dir = dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(dir).filter((f) => f.startsWith("test-") && f.endsWith(".ts"));

let passed = 0;
let failed = 0;

for (const test of tests) {
  const path = join(dir, test);
  try {
    execFileSync("node", ["--experimental-strip-types", path], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 30_000,
    });
    console.log(`✓ ${test}`);
    passed++;
  } catch (err: any) {
    console.error(`✗ ${test}`);
    console.error(err.stdout || "");
    console.error(err.stderr || "");
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Create test-version.ts**

```typescript
// tests/smoke/test-version.ts
// Verifies that `gsd --version` outputs valid semver-like string.
// When GSD_SMOKE_BINARY is set (CI), uses that binary directly.
// Otherwise falls back to npx gsd-pi.

import { execFileSync } from "child_process";

const bin = process.env.GSD_SMOKE_BINARY;
const output = bin
  ? execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000 }).trim()
  : execFileSync("npx", ["gsd-pi", "--version"], { encoding: "utf8", timeout: 30_000 }).trim();

if (!/^\d+\.\d+\.\d+/.test(output)) {
  console.error(`Unexpected version output: "${output}"`);
  process.exit(1);
}

console.log(`version: ${output}`);
```

- [ ] **Step 3: Create test-help.ts**

```typescript
// tests/smoke/test-help.ts
// Verifies that `gsd --help` exits 0 and contains expected keywords.

import { execFileSync } from "child_process";

const bin = process.env.GSD_SMOKE_BINARY;
const output = bin
  ? execFileSync(bin, ["--help"], { encoding: "utf8", timeout: 30_000 })
  : execFileSync("npx", ["gsd-pi", "--help"], { encoding: "utf8", timeout: 30_000 });

const requiredKeywords = ["gsd", "usage"];
for (const keyword of requiredKeywords) {
  if (!output.toLowerCase().includes(keyword)) {
    console.error(`Missing keyword "${keyword}" in help output`);
    process.exit(1);
  }
}

console.log("help output OK");
```

- [ ] **Step 4: Create test-init.ts**

```typescript
// tests/smoke/test-init.ts
// Verifies that `gsd init` creates expected files in a temp directory.

import { execFileSync } from "child_process";
import { mkdtempSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "gsd-smoke-init-"));

try {
  const bin = process.env.GSD_SMOKE_BINARY;
  const args = bin ? [bin, "init"] : ["npx", "gsd-pi", "init"];
  execFileSync(args[0], args.slice(1), {
    encoding: "utf8",
    cwd: tmp,
    timeout: 30_000,
    env: { ...process.env, GSD_NON_INTERACTIVE: "1" },
  });

  // Check that .gsd directory was created
  if (!existsSync(join(tmp, ".gsd"))) {
    console.error("Expected .gsd/ directory not found after init");
    process.exit(1);
  }

  console.log("init OK");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
```

- [ ] **Step 5: Add test:smoke script to package.json**

Add to `package.json` `scripts`:
```json
"test:smoke": "node --experimental-strip-types tests/smoke/run.ts"
```

- [ ] **Step 6: Run the smoke tests locally**

Run: `npm run test:smoke`
Expected: All 3 tests pass (version, help, init)

- [ ] **Step 7: Commit**

```bash
git add tests/smoke/ package.json
git commit -m "feat(ci): add CLI smoke tests for pipeline test stage"
```

---

## Chunk 3: LLM Fixture Provider

### Task 4: FixtureProvider Implementation

**Files:**
- Create: `tests/fixtures/provider.ts`

The `FixtureProvider` operates at the `ApiProvider` level defined in `packages/pi-ai/src/api-registry.ts:23-27`. The key interface is:

```typescript
interface ApiProvider<TApi, TOptions> {
  api: TApi;
  stream: StreamFunction<TApi, TOptions>;
  streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}
```

The provider is registered via `registerApiProvider()` from `packages/pi-ai/src/api-registry.ts:66`.

- [ ] **Step 1: Write the FixtureProvider**

```typescript
// tests/fixtures/provider.ts
// Records and replays LLM conversations at the pi-ai ApiProvider level.
//
// Record mode: wraps a real provider, saves request/response to JSON.
// Replay mode: loads saved JSON, serves responses by turn index.
//
// Controlled via environment variables:
//   GSD_FIXTURE_MODE=record|replay
//   GSD_FIXTURE_DIR=./tests/fixtures/recordings

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export interface FixtureTurn {
  request: {
    model: string;
    messages: unknown[];
    tools?: string[];
  };
  response: {
    content: unknown[];
    stopReason: string;
    usage: { input: number; output: number };
  };
}

export interface FixtureFile {
  name: string;
  recorded: string;
  provider: string;
  model: string;
  turns: FixtureTurn[];
}

export type FixtureMode = "record" | "replay" | "off";

export function getFixtureMode(): FixtureMode {
  const mode = process.env.GSD_FIXTURE_MODE;
  if (mode === "record" || mode === "replay") return mode;
  return "off";
}

export function getFixtureDir(): string {
  return process.env.GSD_FIXTURE_DIR || join(process.cwd(), "tests/fixtures/recordings");
}

export function loadFixture(filepath: string): FixtureFile {
  const raw = readFileSync(filepath, "utf8");
  return JSON.parse(raw) as FixtureFile;
}

export function saveFixture(filepath: string, fixture: FixtureFile): void {
  const dir = filepath.substring(0, filepath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(filepath, JSON.stringify(fixture, null, 2) + "\n");
}

/**
 * Creates a replay-mode result from a saved fixture turn.
 * Returns an object with an async result() method that resolves
 * to the saved response, compatible with AssistantMessageEventStream.
 */
export function createReplayStream(turn: FixtureTurn) {
  const message = {
    content: turn.response.content,
    stopReason: turn.response.stopReason,
    usage: turn.response.usage,
  };

  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "message_complete" as const, message };
    },
    result: async () => message,
  };
}

/**
 * FixtureRecorder collects turns during a recording session
 * and saves them to a JSON file when finalized.
 */
export class FixtureRecorder {
  private turns: FixtureTurn[] = [];
  private name: string;
  private provider: string;
  private model: string;

  constructor(name: string, provider: string, model: string) {
    this.name = name;
    this.provider = provider;
    this.model = model;
  }

  addTurn(turn: FixtureTurn): void {
    this.turns.push(turn);
  }

  save(dir: string): string {
    const fixture: FixtureFile = {
      name: this.name,
      recorded: new Date().toISOString(),
      provider: this.provider,
      model: this.model,
      turns: this.turns,
    };
    const filepath = join(dir, `${this.name}.json`);
    saveFixture(filepath, fixture);
    return filepath;
  }
}

/**
 * FixtureReplayer serves saved responses by turn index.
 * Throws if the conversation requests more turns than recorded.
 */
export class FixtureReplayer {
  private fixture: FixtureFile;
  private turnIndex = 0;

  constructor(fixture: FixtureFile) {
    this.fixture = fixture;
  }

  nextTurn(): FixtureTurn {
    if (this.turnIndex >= this.fixture.turns.length) {
      throw new Error(
        `Fixture "${this.fixture.name}" exhausted: requested turn ${this.turnIndex} but only ${this.fixture.turns.length} turns recorded`
      );
    }
    return this.fixture.turns[this.turnIndex++];
  }

  get turnsRemaining(): number {
    return this.fixture.turns.length - this.turnIndex;
  }
}
```

Note: This provider implements the core recording/replay data structures and utilities. Wiring it into the `pi-ai` registry as a drop-in `ApiProvider` (via `registerApiProvider()` from `packages/pi-ai/src/api-registry.ts`) requires importing `@gsd/pi-ai` internals, which couples tests to the build output. This integration is deferred to a follow-up task after the pipeline is operational. The current implementation validates fixture format, turn sequencing, and replay correctness independently.

- [ ] **Step 2: Verify the file has no syntax errors**

Run: `node --experimental-strip-types -e "import('./tests/fixtures/provider.ts').then(() => console.log('OK'))"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/provider.ts
git commit -m "feat(ci): add FixtureProvider for LLM conversation recording and replay"
```

---

### Task 5: Fixture Test Runner

**Files:**
- Create: `tests/fixtures/run.ts`
- Create: `tests/fixtures/recordings/agent-creates-file.json`
- Modify: `package.json` (add `test:fixtures` script)

- [ ] **Step 1: Create a sample fixture recording**

Save to `tests/fixtures/recordings/agent-creates-file.json`:

```json
{
  "name": "agent-creates-file",
  "recorded": "2026-03-17T00:00:00Z",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "turns": [
    {
      "request": {
        "model": "claude-sonnet-4-6",
        "messages": [{ "role": "user", "content": "Create a file called hello.ts with a console.log" }],
        "tools": ["Write", "Read"]
      },
      "response": {
        "content": [
          { "type": "text", "text": "I'll create hello.ts for you." },
          {
            "type": "tool_use",
            "id": "toolu_01",
            "name": "Write",
            "input": { "file_path": "hello.ts", "content": "console.log('hello');\n" }
          }
        ],
        "stopReason": "toolUse",
        "usage": { "input": 150, "output": 45 }
      }
    }
  ]
}
```

- [ ] **Step 2: Create the fixture test runner**

```typescript
// tests/fixtures/run.ts
// Loads all fixture recordings and replays them through the FixtureProvider.
// Verifies each turn produces the expected response shape.
//
// Usage: node --experimental-strip-types tests/fixtures/run.ts

import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  loadFixture,
  FixtureReplayer,
  createReplayStream,
} from "./provider.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const recordingsDir = join(dir, "recordings");

const files = readdirSync(recordingsDir).filter((f) => f.endsWith(".json"));

if (files.length === 0) {
  console.error("No fixture recordings found in", recordingsDir);
  process.exit(1);
}

let passed = 0;
let failed = 0;

for (const file of files) {
  const filepath = join(recordingsDir, file);
  try {
    const fixture = loadFixture(filepath);
    const replayer = new FixtureReplayer(fixture);

    // Replay each turn and verify the response is well-formed
    for (let i = 0; i < fixture.turns.length; i++) {
      const turn = replayer.nextTurn();

      // Verify response has required fields
      if (!turn.response.content || !Array.isArray(turn.response.content)) {
        throw new Error(`Turn ${i}: response.content is not an array`);
      }
      if (!turn.response.stopReason) {
        throw new Error(`Turn ${i}: response.stopReason is missing`);
      }
      if (typeof turn.response.usage?.input !== "number") {
        throw new Error(`Turn ${i}: response.usage.input is not a number`);
      }

      // Verify the replay stream produces a result
      const stream = createReplayStream(turn);
      const result = await stream.result();

      if (!result.content) {
        throw new Error(`Turn ${i}: replayed result has no content`);
      }
    }

    // Verify replayer is exhausted
    if (replayer.turnsRemaining !== 0) {
      throw new Error(`${replayer.turnsRemaining} turns remaining after replay`);
    }

    console.log(`✓ ${fixture.name} (${fixture.turns.length} turns)`);
    passed++;
  } catch (err: any) {
    console.error(`✗ ${file}: ${err.message}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 3: Add test:fixtures script to package.json**

Add to `package.json` `scripts`:
```json
"test:fixtures": "node --experimental-strip-types tests/fixtures/run.ts"
```

- [ ] **Step 4: Run the fixture tests**

Run: `npm run test:fixtures`
Expected: `✓ agent-creates-file (1 turns)` — 1 passed, 0 failed

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/run.ts tests/fixtures/recordings/ package.json
git commit -m "feat(ci): add fixture test runner with sample recording"
```

---

### Task 5b: Additional Fixture Recordings

**Files:**
- Create: `tests/fixtures/recordings/agent-reads-and-edits.json`
- Create: `tests/fixtures/recordings/agent-handles-error.json`
- Create: `tests/fixtures/recordings/agent-multi-turn-tools.json`

- [ ] **Step 1: Create multi-turn read+edit fixture**

Save to `tests/fixtures/recordings/agent-reads-and-edits.json`:

```json
{
  "name": "agent-reads-and-edits",
  "recorded": "2026-03-17T00:00:00Z",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "turns": [
    {
      "request": {
        "model": "claude-sonnet-4-6",
        "messages": [{ "role": "user", "content": "Read hello.ts and add a comment" }],
        "tools": ["Read", "Edit"]
      },
      "response": {
        "content": [
          { "type": "text", "text": "Let me read the file first." },
          { "type": "tool_use", "id": "toolu_01", "name": "Read", "input": { "file_path": "hello.ts" } }
        ],
        "stopReason": "toolUse",
        "usage": { "input": 120, "output": 35 }
      }
    },
    {
      "request": {
        "model": "claude-sonnet-4-6",
        "messages": [{ "role": "tool", "content": "console.log('hello');\n" }],
        "tools": ["Read", "Edit"]
      },
      "response": {
        "content": [
          { "type": "text", "text": "I'll add a comment." },
          { "type": "tool_use", "id": "toolu_02", "name": "Edit", "input": { "file_path": "hello.ts", "old_string": "console.log", "new_string": "// greeting\nconsole.log" } }
        ],
        "stopReason": "toolUse",
        "usage": { "input": 180, "output": 50 }
      }
    }
  ]
}
```

- [ ] **Step 2: Create error-handling fixture**

Save to `tests/fixtures/recordings/agent-handles-error.json`:

```json
{
  "name": "agent-handles-error",
  "recorded": "2026-03-17T00:00:00Z",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "turns": [
    {
      "request": {
        "model": "claude-sonnet-4-6",
        "messages": [{ "role": "user", "content": "Read nonexistent.ts" }],
        "tools": ["Read"]
      },
      "response": {
        "content": [
          { "type": "text", "text": "Let me try to read that file." },
          { "type": "tool_use", "id": "toolu_01", "name": "Read", "input": { "file_path": "nonexistent.ts" } }
        ],
        "stopReason": "toolUse",
        "usage": { "input": 100, "output": 30 }
      }
    },
    {
      "request": {
        "model": "claude-sonnet-4-6",
        "messages": [{ "role": "tool", "content": "Error: File does not exist" }],
        "tools": ["Read"]
      },
      "response": {
        "content": [
          { "type": "text", "text": "The file nonexistent.ts doesn't exist. Would you like me to create it?" }
        ],
        "stopReason": "stop",
        "usage": { "input": 140, "output": 25 }
      }
    }
  ]
}
```

- [ ] **Step 3: Create multi-turn tool use fixture**

Save to `tests/fixtures/recordings/agent-multi-turn-tools.json`:

```json
{
  "name": "agent-multi-turn-tools",
  "recorded": "2026-03-17T00:00:00Z",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "turns": [
    {
      "request": {
        "model": "claude-sonnet-4-6",
        "messages": [{ "role": "user", "content": "Create utils.ts with an add function, then create a test file" }],
        "tools": ["Write", "Read"]
      },
      "response": {
        "content": [
          { "type": "text", "text": "I'll create both files." },
          { "type": "tool_use", "id": "toolu_01", "name": "Write", "input": { "file_path": "utils.ts", "content": "export function add(a: number, b: number): number {\n  return a + b;\n}\n" } }
        ],
        "stopReason": "toolUse",
        "usage": { "input": 130, "output": 55 }
      }
    },
    {
      "request": {
        "model": "claude-sonnet-4-6",
        "messages": [{ "role": "tool", "content": "File created successfully" }],
        "tools": ["Write", "Read"]
      },
      "response": {
        "content": [
          { "type": "text", "text": "Now the test file." },
          { "type": "tool_use", "id": "toolu_02", "name": "Write", "input": { "file_path": "utils.test.ts", "content": "import { add } from './utils.ts';\nimport { test } from 'node:test';\nimport assert from 'node:assert';\n\ntest('add', () => {\n  assert.strictEqual(add(1, 2), 3);\n});\n" } }
        ],
        "stopReason": "toolUse",
        "usage": { "input": 200, "output": 70 }
      }
    }
  ]
}
```

- [ ] **Step 4: Re-run fixture tests to verify all 4 fixtures pass**

Run: `npm run test:fixtures`
Expected: 4 passed, 0 failed

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/recordings/
git commit -m "feat(ci): add additional fixture recordings for multi-turn and error scenarios"
```

---

## Chunk 4: Live Tests (Stub) + npm Scripts

### Task 6: Live Test Stubs

**Files:**
- Create: `tests/live/run.ts`
- Create: `tests/live/test-anthropic-roundtrip.ts`
- Modify: `package.json` (add remaining scripts)

- [ ] **Step 1: Create live test runner**

```typescript
// tests/live/run.ts
// Runs real LLM integration tests. Only executes when GSD_LIVE_TESTS=1.
// These tests cost real money — used in the Prod gate only.
//
// Usage: GSD_LIVE_TESTS=1 node --experimental-strip-types tests/live/run.ts

if (process.env.GSD_LIVE_TESTS !== "1") {
  console.log("Skipping live tests (set GSD_LIVE_TESTS=1 to enable)");
  process.exit(0);
}

import { readdirSync } from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const dir = dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(dir).filter((f) => f.startsWith("test-") && f.endsWith(".ts"));

let passed = 0;
let failed = 0;

for (const test of tests) {
  const path = join(dir, test);
  try {
    execFileSync("node", ["--experimental-strip-types", path], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 120_000,
      env: { ...process.env },
    });
    console.log(`✓ ${test}`);
    passed++;
  } catch (err: any) {
    console.error(`✗ ${test}`);
    console.error(err.stdout || "");
    console.error(err.stderr || "");
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Create Anthropic roundtrip test**

```typescript
// tests/live/test-anthropic-roundtrip.ts
// Sends a minimal request to the Anthropic API and verifies a response.
// Requires ANTHROPIC_API_KEY in environment.

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 32,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  }),
});

if (!response.ok) {
  const body = await response.text();
  console.error(`API error ${response.status}: ${body}`);
  process.exit(1);
}

const data = (await response.json()) as { content: Array<{ text: string }> };
const text = data.content[0]?.text;

if (!text || text.length === 0) {
  console.error("Empty response from API");
  process.exit(1);
}

console.log(`Anthropic roundtrip OK: "${text.substring(0, 50)}"`);
```

- [ ] **Step 3: Create OpenAI roundtrip test**

```typescript
// tests/live/test-openai-roundtrip.ts
// Sends a minimal request to the OpenAI API and verifies a response.
// Requires OPENAI_API_KEY in environment.

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY not set");
  process.exit(1);
}

const response = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model: "gpt-4o-mini",
    max_tokens: 32,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  }),
});

if (!response.ok) {
  const body = await response.text();
  console.error(`API error ${response.status}: ${body}`);
  process.exit(1);
}

const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
const text = data.choices[0]?.message?.content;

if (!text || text.length === 0) {
  console.error("Empty response from API");
  process.exit(1);
}

console.log(`OpenAI roundtrip OK: "${text.substring(0, 50)}"`);
```

- [ ] **Step 4: Add remaining scripts to package.json**

Add to `package.json` `scripts`:
```json
"test:fixtures:record": "GSD_FIXTURE_MODE=record node --experimental-strip-types tests/fixtures/record.ts",
"test:live": "GSD_LIVE_TESTS=1 node --experimental-strip-types tests/live/run.ts",
"pipeline:version-stamp": "node scripts/version-stamp.mjs",
"docker:build-runtime": "docker build --target runtime -t ghcr.io/gsd-build/gsd-pi .",
"docker:build-builder": "docker build --target builder -t ghcr.io/gsd-build/gsd-ci-builder ."
```

- [ ] **Step 5: Verify live tests skip without env var**

Run: `npm run test:live`
Expected: `Skipping live tests (set GSD_LIVE_TESTS=1 to enable)` and exit 0

- [ ] **Step 6: Commit**

```bash
git add tests/live/ package.json
git commit -m "feat(ci): add live LLM test stubs and remaining npm scripts"
```

---

## Chunk 5: GitHub Actions Workflows

### Task 7: Pipeline Workflow

**Files:**
- Create: `.github/workflows/pipeline.yml`

- [ ] **Step 1: Write the pipeline workflow**

```yaml
# .github/workflows/pipeline.yml
# Three-stage promotion pipeline: Dev → Test → Prod
# Triggers after ci.yml succeeds on main branch.

name: Release Pipeline

on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
    branches: [main]

concurrency:
  group: pipeline-${{ github.sha }}
  cancel-in-progress: false

jobs:
  # ─── DEV STAGE ─────────────────────────────────────────────
  dev-publish:
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/gsd-build/gsd-ci-builder:latest  # Pin to date tag after first build
    environment: dev
    outputs:
      dev-version: ${{ steps.stamp.outputs.version }}

    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
        with:
          ref: ${{ github.event.workflow_run.head_sha }}
          fetch-depth: 0

      - name: Setup npm registry
        run: echo "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}" > ~/.npmrc
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Stamp dev version
        id: stamp
        run: |
          node scripts/version-stamp.mjs
          VERSION=$(node -p "require('./package.json').version")
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          echo "Dev version: $VERSION"

      - name: Publish to npm with @dev tag
        run: npm publish --tag dev
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Smoke test published package
        run: |
          mkdir /tmp/smoke-test && cd /tmp/smoke-test
          npm init -y
          npm install gsd-pi@dev
          npx gsd --version

  # ─── TEST STAGE ────────────────────────────────────────────
  test-verify:
    needs: dev-publish
    runs-on: ubuntu-latest
    environment: test

    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
        with:
          ref: ${{ github.event.workflow_run.head_sha }}

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: "22"
          registry-url: "https://registry.npmjs.org"

      - name: Install published dev package globally
        run: npm install -g gsd-pi@dev

      - name: Install dev dependencies for test runners
        run: npm ci

      - name: Run CLI smoke tests
        run: npm run test:smoke
        env:
          GSD_SMOKE_BINARY: gsd  # Use globally installed binary, not npx

      - name: Run fixture replay tests
        run: npm run test:fixtures

      - name: Promote to @next
        run: npm dist-tag add gsd-pi@${{ needs.dev-publish.outputs.dev-version }} next
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Build and push runtime Docker image
        run: |
          echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin
          docker build --target runtime \
            --build-arg GSD_VERSION=${{ needs.dev-publish.outputs.dev-version }} \
            -t ghcr.io/gsd-build/gsd-pi:next \
            -t ghcr.io/gsd-build/gsd-pi:${{ needs.dev-publish.outputs.dev-version }} \
            .
          docker push ghcr.io/gsd-build/gsd-pi:next
          docker push ghcr.io/gsd-build/gsd-pi:${{ needs.dev-publish.outputs.dev-version }}

  # ─── PROD STAGE ────────────────────────────────────────────
  prod-release:
    needs: [dev-publish, test-verify]
    runs-on: ubuntu-latest
    environment: prod  # Requires manual approval

    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
        with:
          ref: ${{ github.event.workflow_run.head_sha }}

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: "22"
          registry-url: "https://registry.npmjs.org"

      - name: Run live LLM tests (optional)
        if: ${{ vars.RUN_LIVE_TESTS == 'true' }}
        run: |
          npm ci
          npm run build
          GSD_LIVE_TESTS=1 npm run test:live
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}

      - name: Promote to @latest
        run: npm dist-tag add gsd-pi@${{ needs.dev-publish.outputs.dev-version }} latest
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Tag and push Docker images
        run: |
          echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin
          docker pull ghcr.io/gsd-build/gsd-pi:${{ needs.dev-publish.outputs.dev-version }}
          docker tag ghcr.io/gsd-build/gsd-pi:${{ needs.dev-publish.outputs.dev-version }} ghcr.io/gsd-build/gsd-pi:latest
          docker push ghcr.io/gsd-build/gsd-pi:latest

      - name: Create GitHub Release
        run: |
          gh release create v${{ needs.dev-publish.outputs.dev-version }} \
            --generate-notes \
            --title "v${{ needs.dev-publish.outputs.dev-version }}"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Post-publish smoke test
        run: |
          mkdir /tmp/prod-smoke && cd /tmp/prod-smoke
          npm init -y
          npm install gsd-pi@latest
          npx gsd --version

  # ─── CI BUILDER IMAGE (conditional) ────────────────────────
  update-builder:
    if: |
      github.event.workflow_run.conclusion == 'success' &&
      contains(toJSON(github.event.workflow_run.head_commit.modified), 'Dockerfile')
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
        with:
          ref: ${{ github.event.workflow_run.head_sha }}

      - name: Generate date tag
        id: tag
        run: echo "date=$(date +%Y-%m-%d)" >> "$GITHUB_OUTPUT"

      - name: Build and push CI builder image
        run: |
          echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin
          docker build --target builder \
            -t ghcr.io/gsd-build/gsd-ci-builder:latest \
            -t ghcr.io/gsd-build/gsd-ci-builder:${{ steps.tag.outputs.date }} \
            .
          docker push ghcr.io/gsd-build/gsd-ci-builder:latest
          docker push ghcr.io/gsd-build/gsd-ci-builder:${{ steps.tag.outputs.date }}

      - name: Verify builder image
        run: |
          docker run --rm ghcr.io/gsd-build/gsd-ci-builder:latest node --version
          docker run --rm ghcr.io/gsd-build/gsd-ci-builder:latest rustc --version
```

- [ ] **Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/pipeline.yml'))"`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/pipeline.yml
git commit -m "feat(ci): add three-stage promotion pipeline workflow"
```

---

### Task 8: Dev Version Cleanup Workflow

**Files:**
- Create: `.github/workflows/cleanup-dev-versions.yml`

- [ ] **Step 1: Write the cleanup workflow**

```yaml
# .github/workflows/cleanup-dev-versions.yml
# Weekly cleanup of old -dev. npm versions to prevent registry bloat.
# Unpublishes dev versions older than 30 days.

name: Cleanup Dev Versions

on:
  schedule:
    - cron: "0 6 * * 1"  # Every Monday at 06:00 UTC
  workflow_dispatch: {}   # Allow manual trigger

jobs:
  cleanup:
    runs-on: ubuntu-latest

    steps:
      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: "22"
          registry-url: "https://registry.npmjs.org"

      - name: Remove old dev versions
        run: |
          VERSIONS=$(npm view gsd-pi versions --json 2>/dev/null || echo "[]")

          DEV_VERSIONS=$(echo "$VERSIONS" | node -e "
            const stdin = require('fs').readFileSync('/dev/stdin', 'utf8');
            const versions = JSON.parse(stdin);
            for (const v of versions) {
              if (v.includes('-dev.')) {
                console.log(v);
              }
            }
          ")

          if [ -z "$DEV_VERSIONS" ]; then
            echo "No dev versions to clean up"
            exit 0
          fi

          THIRTY_DAYS_MS=2592000000

          for VERSION in $DEV_VERSIONS; do
            PUBLISH_TIME=$(npm view "gsd-pi@$VERSION" time --json 2>/dev/null || echo "")

            if [ -n "$PUBLISH_TIME" ]; then
              AGE_MS=$(node -e "
                const t = JSON.parse('$PUBLISH_TIME');
                console.log(Date.now() - new Date(t).getTime());
              " 2>/dev/null || echo "0")

              if [ "$AGE_MS" -gt "$THIRTY_DAYS_MS" ]; then
                echo "Unpublishing gsd-pi@$VERSION"
                npm unpublish "gsd-pi@$VERSION" || echo "Failed to unpublish $VERSION"
              else
                echo "Keeping gsd-pi@$VERSION (within 30 days)"
              fi
            fi
          done
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- [ ] **Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/cleanup-dev-versions.yml'))"`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/cleanup-dev-versions.yml
git commit -m "feat(ci): add weekly dev version cleanup workflow"
```

---

## Chunk 6: Recording Helper + Final Integration

### Task 9: Fixture Recording Helper

**Files:**
- Create: `tests/fixtures/record.ts`

- [ ] **Step 1: Create the recording helper**

```typescript
// tests/fixtures/record.ts
// Helper for recording new LLM fixtures.
//
// Usage:
//   GSD_FIXTURE_MODE=record \
//   GSD_FIXTURE_DIR=./tests/fixtures/recordings \
//   node --experimental-strip-types tests/fixtures/record.ts
//
// This is a developer tool, not used in CI.
// After recording, review and commit the generated fixture JSON.

import { getFixtureMode, getFixtureDir } from "./provider.ts";

const mode = getFixtureMode();
const dir = getFixtureDir();

if (mode !== "record") {
  console.error("Recording requires GSD_FIXTURE_MODE=record");
  console.error("");
  console.error("Usage:");
  console.error("  GSD_FIXTURE_MODE=record GSD_FIXTURE_DIR=./tests/fixtures/recordings \\");
  console.error("  node --experimental-strip-types tests/fixtures/record.ts");
  process.exit(1);
}

console.log("Fixture recording mode enabled");
console.log(`Recordings will be saved to: ${dir}`);
console.log("");
console.log("To record a fixture:");
console.log("1. Set GSD_FIXTURE_MODE=record in your environment");
console.log("2. Run your GSD session normally");
console.log("3. The FixtureProvider will intercept and save all LLM calls");
console.log("4. Review the generated JSON in the recordings directory");
console.log("5. Commit the fixture to version control");
console.log("");
console.log("Note: The FixtureProvider must be integrated into the");
console.log("agent session startup to intercept real API calls.");
console.log("See tests/fixtures/provider.ts for the integration API.");
```

- [ ] **Step 2: Commit**

```bash
git add tests/fixtures/record.ts
git commit -m "feat(ci): add fixture recording helper with usage instructions"
```

---

### Task 10: Final Integration Verification

**Prerequisite:** All work should be on the `ci-cd` branch (created from `main` before starting Task 1).

- [ ] **Step 1: Run the full test suite**

```bash
npm run test:smoke
npm run test:fixtures
npm run test:live
```

Expected:
- Smoke tests: 3 passed
- Fixture tests: 1 passed
- Live tests: Skipped (no `GSD_LIVE_TESTS=1`)

- [ ] **Step 2: Validate all workflow YAML files**

```bash
python3 -c "
import yaml, glob
for f in glob.glob('.github/workflows/*.yml'):
    yaml.safe_load(open(f))
    print(f'OK: {f}')
"
```

Expected: All `.yml` files parse without errors

- [ ] **Step 3: Verify git status is clean**

Run: `git status`
Expected: Nothing to commit, working tree clean

- [ ] **Step 4: Review commit history**

Run: `git log --oneline ci-cd ^main`
Expected: ~10 commits, each self-contained and descriptive

---

## Post-Implementation: GitHub Configuration (Manual)

These steps require repo admin access and cannot be automated:

1. **Create GitHub Environments:**
   - `dev` — no protection rules
   - `test` — no protection rules
   - `prod` — add required reviewers (maintainer list)

2. **Add secrets:**
   - `NPM_TOKEN` → all environments
   - `ANTHROPIC_API_KEY` → prod only
   - `OPENAI_API_KEY` → prod only

3. **Add environment variable:**
   - `RUN_LIVE_TESTS` → `false` by default on `prod` (set to `true` to enable)

4. **Enable GHCR:**
   - Ensure GitHub Container Registry is enabled for the `gsd-build` org

5. **Test the pipeline end-to-end:**
   - Merge a test PR to `main`
   - Watch Dev stage publish to `@dev`
   - Watch Test stage auto-promote to `@next`
   - Manually approve Prod to promote to `@latest`
