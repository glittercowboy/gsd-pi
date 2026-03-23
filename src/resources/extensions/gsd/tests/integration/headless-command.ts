/**
 * Integration test for `gsd headless` CLI subcommand
 *
 * Validates that the headless CLI entry point works end-to-end:
 *   1. Creates a temp dir with a complete .gsd/ project fixture
 *   2. Initializes a git repo in the temp dir
 *   3. Spawns `node dist/loader.js headless --json next` as a child process
 *   4. Waits for the process to exit (with a 5-minute timeout)
 *   5. Validates exit code, JSONL stdout, stderr progress, and task artifact
 *
 * Auth: Uses OAuth credentials from ~/.gsd/agent/auth.json (Claude Code Max).
 * Falls back to ANTHROPIC_API_KEY env var if OAuth is not configured (D013).
 *
 * Usage:
 *   npx tsx src/resources/extensions/gsd/tests/integration/headless-command.ts
 *   Add --dry-run to validate fixture without running the agent.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { spawn, execSync } from "node:child_process";

// ── Configuration ────────────────────────────────────────────────────────────

const TIMEOUT_MS = parseInt(process.env.HEADLESS_TIMEOUT_MS ?? "300000", 10); // 5 minutes
const DRY_RUN = process.argv.includes("--dry-run");

// ── Fixture Data ─────────────────────────────────────────────────────────────
// A complete .gsd/ project state that deriveState() can parse.
// The trivial task asks the agent to create a single file — zero questions needed.

const FIXTURE_PROJECT_MD = `# Project

## What This Is

Headless proof test project. A minimal fixture used to validate GSD auto-mode via RPC.

## Core Value

Proves headless auto-mode works end-to-end.

## Current State

Empty project with GSD milestone planned.

## Architecture / Key Patterns

- Single milestone, single slice, single task

## Capability Contract

None.

## Milestone Sequence

- [ ] M001: Headless Proof — Create a test file to prove the agent loop works
`;

const FIXTURE_STATE_MD = `# GSD State

**Active Milestone:** M001 — Headless Proof
**Active Slice:** S01 — Create Test File
**Phase:** executing
**Requirements Status:** 0 active · 0 validated · 0 deferred · 0 out of scope

## Milestone Registry
- 🔄 **M001:** Headless Proof

## Recent Decisions
- None recorded

## Blockers
- None

## Next Action
Execute T01: Create hello.txt in slice S01.
`;

const FIXTURE_CONTEXT_MD = `# M001: Headless Proof — Context

**Gathered:** 2025-01-01
**Status:** Ready for planning

## Project Description

A minimal test project for validating GSD auto-mode in headless/RPC mode.

## Why This Milestone

Proves that the agent loop can complete a task without a TUI attached.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Run GSD in headless mode and have it complete a trivial task

### Entry point / environment

- Entry point: RPC mode via headless-proof.ts
- Environment: local dev
- Live dependencies involved: none

## Completion Class

- Contract complete means: agent creates the requested file
- Integration complete means: not applicable
- Operational complete means: not applicable

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- Agent creates hello.txt with the correct content

## Risks and Unknowns

- None — this is a trivial proof task

## Existing Codebase / Prior Art

- None

## Relevant Requirements

- None

## Scope

### In Scope

- Creating a single file

### Out of Scope / Non-Goals

- Everything else

## Technical Constraints

- None

## Integration Points

- None

## Open Questions

- None
`;

const FIXTURE_ROADMAP_MD = `# M001: Headless Proof

**Vision:** Prove GSD auto-mode works headlessly.

## Success Criteria

- Agent creates hello.txt with content "Hello from headless GSD"

## Key Risks / Unknowns

- None

## Slices

- [ ] **S01: Create Test File** \`risk:low\` \`depends:[]\`
  > After this: hello.txt exists in the project root

## Boundary Map

### S01

Produces:
- hello.txt file in project root

Consumes:
- nothing (first slice)
`;

const FIXTURE_PLAN_MD = `# S01: Create Test File

**Goal:** Create a single file to prove the agent loop works headlessly.
**Demo:** hello.txt exists with the correct content after the agent runs.

## Must-Haves

- hello.txt created with content "Hello from headless GSD"

## Verification

- File hello.txt exists in project root with content "Hello from headless GSD"

## Tasks

- [ ] **T01: Create hello.txt** \`est:5m\`
  - Why: Proves the agent can execute a tool call and produce an artifact
  - Files: \`hello.txt\`
  - Do: Create a file called hello.txt in the project root with the content "Hello from headless GSD"
  - Verify: File exists with correct content
  - Done when: hello.txt exists with content "Hello from headless GSD"

## Files Likely Touched

- \`hello.txt\`
`;

const FIXTURE_TASK_PLAN_MD = `---
estimated_steps: 1
estimated_files: 1
---

# T01: Create hello.txt

**Slice:** S01 — Create Test File
**Milestone:** M001

## Description

Create a file called hello.txt in the project root with the content "Hello from headless GSD".

## Steps

1. Create the file hello.txt with the content "Hello from headless GSD"

## Must-Haves

- [ ] hello.txt created with content "Hello from headless GSD"

## Verification

- File hello.txt exists in project root with content "Hello from headless GSD"

## Expected Output

- \`hello.txt\` — file containing "Hello from headless GSD"
`;

// ── Fixture Creation ─────────────────────────────────────────────────────────

function createFixture(): string {
  const tmpDir = mkdtempSync(join(tmpdir(), "gsd-headless-cmd-"));

  // Initialize git repo (GSD requires it for branch-per-slice)
  execSync("git init -b main", { cwd: tmpDir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: tmpDir, stdio: "pipe" });

  // Create .gsd/ structure
  const gsdDir = join(tmpDir, ".gsd");
  const milestonesDir = join(gsdDir, "milestones");
  const m001Dir = join(milestonesDir, "M001");
  const slicesDir = join(m001Dir, "slices");
  const s01Dir = join(slicesDir, "S01");
  const tasksDir = join(s01Dir, "tasks");

  mkdirSync(tasksDir, { recursive: true });

  // Write fixture files
  writeFileSync(join(gsdDir, "PROJECT.md"), FIXTURE_PROJECT_MD);
  writeFileSync(join(gsdDir, "STATE.md"), FIXTURE_STATE_MD);
  writeFileSync(join(m001Dir, "M001-CONTEXT.md"), FIXTURE_CONTEXT_MD);
  writeFileSync(join(m001Dir, "M001-ROADMAP.md"), FIXTURE_ROADMAP_MD);
  writeFileSync(join(s01Dir, "S01-PLAN.md"), FIXTURE_PLAN_MD);
  writeFileSync(join(tasksDir, "T01-PLAN.md"), FIXTURE_TASK_PLAN_MD);

  // Add .gitignore for runtime files
  writeFileSync(join(tmpDir, ".gitignore"), [
    ".gsd/auto.lock",
    ".gsd/metrics.json",
    ".gsd/activity/",
    ".gsd/runtime/",
  ].join("\n") + "\n");

  // Initial commit so GSD has a clean git state
  execSync("git add -A && git commit -m 'init: headless command test fixture'", {
    cwd: tmpDir,
    stdio: "pipe",
  });

  return tmpDir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
    console.warn(`  [warn] Failed to clean up temp dir: ${dir}`);
  }
}

// ── JSONL Parsing ────────────────────────────────────────────────────────────

interface JsonlEvent {
  type?: string;
  [key: string]: unknown;
}

function parseJsonlLines(output: string): JsonlEvent[] {
  const events: JsonlEvent[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as JsonlEvent);
    } catch {
      // Not valid JSON — skip (could be non-JSONL output)
    }
  }
  return events;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Resolve gsd-2 repo root (6 levels up from tests/integration/)
  const repoRoot = join(__dirname, "..", "..", "..", "..", "..", "..");

  console.log("=== GSD Headless Command Integration Test ===\n");

  // ── Step 1: Create fixture ──────────────────────────────────────────────
  console.log("[1/6] Creating fixture...");
  const fixtureDir = createFixture();
  console.log(`  Fixture created at: ${fixtureDir}`);

  // Validate fixture structure
  const requiredFiles = [
    ".gsd/PROJECT.md",
    ".gsd/STATE.md",
    ".gsd/milestones/M001/M001-CONTEXT.md",
    ".gsd/milestones/M001/M001-ROADMAP.md",
    ".gsd/milestones/M001/slices/S01/S01-PLAN.md",
    ".gsd/milestones/M001/slices/S01/tasks/T01-PLAN.md",
  ];

  for (const file of requiredFiles) {
    const fullPath = join(fixtureDir, file);
    if (!existsSync(fullPath)) {
      console.error(`  FAIL: Missing fixture file: ${file}`);
      cleanup(fixtureDir);
      process.exit(1);
    }
    console.log(`  OK ${file}`);
  }

  // ── Step 2: Validate environment ────────────────────────────────────────
  console.log("\n[2/6] Validating environment...");

  // Auth: prefer OAuth credentials from ~/.gsd/agent/auth.json (D013).
  // Fall back to ANTHROPIC_API_KEY env var if present.
  const authJsonPath = join(homedir(), ".gsd", "agent", "auth.json");
  let hasOAuth = false;
  if (existsSync(authJsonPath)) {
    try {
      const authData = JSON.parse(readFileSync(authJsonPath, "utf-8"));
      hasOAuth = authData?.anthropic?.type === "oauth";
    } catch {
      // Non-fatal
    }
  }

  if (hasOAuth) {
    console.log("  OK OAuth credentials found in ~/.gsd/agent/auth.json (Claude Code Max)");
  } else if (process.env.ANTHROPIC_API_KEY) {
    console.log("  OK ANTHROPIC_API_KEY present (env var fallback)");
  } else {
    console.error("  FAIL: No auth available. Need either:");
    console.error("    - OAuth credentials in ~/.gsd/agent/auth.json (Claude Code Max)");
    console.error("    - ANTHROPIC_API_KEY environment variable");
    cleanup(fixtureDir);
    process.exit(1);
  }

  const loaderPath = join(repoRoot, "dist", "loader.js");
  if (!existsSync(loaderPath)) {
    console.error(`  FAIL: CLI not found at ${loaderPath}. Run 'npm run build' first.`);
    cleanup(fixtureDir);
    process.exit(1);
  }
  console.log(`  OK CLI found at ${loaderPath}`);

  // ── Step 3: Dry-run exit ────────────────────────────────────────────────
  if (DRY_RUN) {
    console.log("\n[dry-run] Fixture validated. Skipping headless execution.");
    console.log("[dry-run] All checks passed.\n");
    cleanup(fixtureDir);
    process.exit(0);
  }

  // ── Step 4: Spawn headless command ──────────────────────────────────────
  console.log("\n[3/6] Spawning headless command...");
  console.log(`  Command: node ${loaderPath} headless --json next`);
  console.log(`  CWD: ${fixtureDir}`);
  console.log(`  Timeout: ${TIMEOUT_MS / 1000}s`);

  const { exitCode, stdout, stderr } = await new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;

    const child = spawn("node", [loaderPath, "headless", "--json", "next"], {
      cwd: fixtureDir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      // Stream stderr for live progress visibility
      process.stderr.write(`  [headless] ${text}`);
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        console.error(`\n  TIMEOUT: Process did not exit within ${TIMEOUT_MS / 1000}s. Killing...`);
        child.kill("SIGTERM");
        // Give it a moment to exit gracefully, then force kill
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5000);
        resolve({ exitCode: null, stdout: stdoutBuf, stderr: stderrBuf });
      }
    }, TIMEOUT_MS);

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code, stdout: stdoutBuf, stderr: stderrBuf });
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        stderrBuf += `\nSpawn error: ${err.message}`;
        resolve({ exitCode: 1, stdout: stdoutBuf, stderr: stderrBuf });
      }
    });
  });

  // ── Step 5: Validate results ────────────────────────────────────────────
  console.log("\n[4/6] Validating process output...");

  let allPassed = true;

  // Check 1: Exit code
  const exitOk = exitCode === 0;
  console.log(`  ${exitOk ? "PASS" : "FAIL"} Exit code: ${exitCode ?? "null (timeout)"}`);
  if (!exitOk) allPassed = false;

  // Check 2: stdout contains JSONL events
  const events = parseJsonlLines(stdout);
  const hasJsonlEvents = events.length > 0;
  console.log(`  ${hasJsonlEvents ? "PASS" : "FAIL"} JSONL events in stdout: ${events.length}`);
  if (!hasJsonlEvents) allPassed = false;

  if (hasJsonlEvents) {
    // Summarize event types
    const typeCounts: Record<string, number> = {};
    for (const event of events) {
      const type = String(event.type ?? "unknown");
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    }
    console.log(`  Event types: ${JSON.stringify(typeCounts)}`);
  }

  // Check 3: stderr contains progress output
  const hasStderrOutput = stderr.trim().length > 0;
  console.log(`  ${hasStderrOutput ? "PASS" : "FAIL"} stderr contains progress output: ${hasStderrOutput} (${stderr.length} bytes)`);
  if (!hasStderrOutput) allPassed = false;

  // ── Step 6: Verify artifact ─────────────────────────────────────────────
  console.log("\n[5/6] Verifying task artifact...");

  const helloPath = join(fixtureDir, "hello.txt");
  const artifactExists = existsSync(helloPath);
  console.log(`  ${artifactExists ? "PASS" : "FAIL"} hello.txt exists: ${artifactExists}`);
  if (!artifactExists) allPassed = false;

  if (artifactExists) {
    const content = readFileSync(helloPath, "utf-8").trim();
    const contentMatch = content === "Hello from headless GSD";
    console.log(`  ${contentMatch ? "PASS" : "WARN"} hello.txt content: "${content.slice(0, 80)}"`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("\n[6/6] Summary");
  console.log(`  Exit code: ${exitCode ?? "null (timeout)"}`);
  console.log(`  JSONL events: ${events.length}`);
  console.log(`  stderr length: ${stderr.length} bytes`);
  console.log(`  hello.txt exists: ${artifactExists}`);

  // Cleanup
  cleanup(fixtureDir);

  if (allPassed) {
    console.log("\n=== PASSED ===\n");
    process.exit(0);
  } else {
    // Print diagnostic info on failure
    if (stdout.length > 0) {
      console.log(`\n--- stdout (last 2000 chars) ---`);
      console.log(stdout.slice(-2000));
    }
    if (stderr.length > 0) {
      console.log(`\n--- stderr (last 2000 chars) ---`);
      console.log(stderr.slice(-2000));
    }
    console.log("\n=== FAILED ===\n");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
