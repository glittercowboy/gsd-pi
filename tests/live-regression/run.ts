/**
 * Live Regression Test Harness — Post-Build Pipeline Validation
 *
 * These tests run AFTER `npm publish` against the installed `gsd` binary.
 * They exercise the dispatch loop state machine end-to-end by:
 *
 * 1. Creating real `.gsd/` directory structures with milestone artifacts
 * 2. Calling `gsd headless query` to verify state derivation
 * 3. Verifying phase transitions match expected outcomes
 * 4. Testing crash recovery (lock file lifecycle) with a real captured PID
 * 5. Testing TTY / version-skew gating on startup
 *
 * These tests DO NOT require LLM API keys — they test the state machine
 * and infrastructure, not the LLM execution.
 *
 * Run from CI pipeline after `npm install -g gsd-pi@<version>`:
 *   node --experimental-strip-types tests/live-regression/run.ts
 *
 * Or locally:
 *   GSD_SMOKE_BINARY=dist/loader.js node --experimental-strip-types tests/live-regression/run.ts
 */

import { execFileSync, spawn } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Config ───────────────────────────────────────────────────────────────

const binary = process.env.GSD_SMOKE_BINARY || "gsd";
let passed = 0;
let failed = 0;

function run(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    passed++;
  } catch (err: any) {
    console.error(`  FAIL  ${label}`);
    console.error(`     ${err.message || err}`);
    failed++;
  }
}

const asyncTests: Array<{ label: string; fn: () => Promise<void> }> = [];
function runAsync(label: string, fn: () => Promise<void>): void {
  asyncTests.push({ label, fn });
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function gitInitRepo(dir: string): void {
  // Use execFileSync with a single argv per command — no shell
  // interpolation, no injection risk.
  const runGit = (args: string[]) => {
    try {
      execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    } catch {
      // Best-effort — if git is unavailable the test is still
      // meaningful (most paths don't require a real repo).
    }
  };
  runGit(["init"]);
  runGit(["config", "user.email", "test@test.com"]);
  runGit(["config", "user.name", "Test"]);
  runGit(["commit", "--allow-empty", "-m", "init"]);
}

function gsd(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(
      binary === "gsd" ? "gsd" : "node",
      binary === "gsd" ? args : [binary, ...args],
      {
        cwd,
        encoding: "utf-8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...env, GSD_NON_INTERACTIVE: "1" },
      },
    );
    return { stdout, stderr: "", code: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      code: err.status ?? 1,
    };
  }
}

function createTempProject(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gsd-live-${name}-`));
  gitInitRepo(dir);
  return dir;
}

function buildMinimalRoadmap(
  slices: Array<{ id: string; title: string; done: boolean }>,
): string {
  const lines = ["# M001: Test Milestone", "", "## Slices", ""];
  for (const s of slices) {
    const cb = s.done ? "x" : " ";
    lines.push(`- [${cb}] **${s.id}: ${s.title}** \`risk:low\` \`depends:[]\``);
    lines.push(`  > Demo for ${s.id}`);
    lines.push("");
  }
  return lines.join("\n");
}

function buildMinimalPlan(
  tasks: Array<{ id: string; title: string; done: boolean }>,
): string {
  const lines = ["# S01: Test Slice", "", "**Goal:** test", "", "## Tasks", ""];
  for (const t of tasks) {
    const cb = t.done ? "x" : " ";
    lines.push(`- [${cb}] **${t.id}: ${t.title}** \`est:5m\``);
  }
  return lines.join("\n");
}

function buildTaskSummary(id: string): string {
  return `---\nid: ${id}\nparent: S01\nmilestone: M001\nduration: 5m\nverification_result: passed\ncompleted_at: ${new Date().toISOString()}\n---\n\n# ${id}: Done\n\nCompleted.`;
}

// ─── Test: headless query returns valid JSON ──────────────────────────────

run("headless query returns valid JSON on initialized project", () => {
  const dir = createTempProject("query");
  try {
    const gsdDir = join(dir, ".gsd");
    mkdirSync(join(gsdDir, "milestones"), { recursive: true });

    const result = gsd(["headless", "query"], dir);
    assert(
      result.code === 0,
      `expected exit 0, got ${result.code}: ${result.stderr}`,
    );

    const json = JSON.parse(result.stdout);
    assert(
      typeof (json.state?.phase ?? json.phase) === "string",
      "response should have phase field",
    );
    assert(
      Array.isArray(json.milestones) || json.milestones === undefined,
      "milestones should be array or undefined",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Test: state derivation — empty project ──────────────────────────────

run("headless query: empty project reports pre-planning or idle", () => {
  const dir = createTempProject("empty");
  try {
    mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });

    const result = gsd(["headless", "query"], dir);
    assert(result.code === 0, `expected exit 0, got ${result.code}`);

    const json = JSON.parse(result.stdout);
    const phase = json.state?.phase ?? json.phase;
    // Empty project: no milestones, no roadmap, no slices.  The derived
    // phase is either "pre-planning" (no M001 yet) or "idle" (nothing
    // scheduled) — both are valid representations of the same state.
    assert(
      phase === "pre-planning" || phase === "idle",
      `expected pre-planning or idle, got: ${phase}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Test: state derivation — milestone with roadmap ─────────────────────

run("headless query: milestone with roadmap reports planning phase", () => {
  const dir = createTempProject("planning");
  try {
    const mDir = join(dir, ".gsd", "milestones", "M001");
    mkdirSync(join(mDir, "slices", "S01"), { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\nContext.");
    writeFileSync(
      join(mDir, "M001-ROADMAP.md"),
      buildMinimalRoadmap([{ id: "S01", title: "First Slice", done: false }]),
    );

    const result = gsd(["headless", "query"], dir);
    assert(result.code === 0, `expected exit 0, got ${result.code}`);

    const json = JSON.parse(result.stdout);
    assert(
      (json.state?.phase ?? json.phase) === "planning",
      `expected planning, got: ${json.state?.phase ?? json.phase}`,
    );
    assert(
      (json.state?.activeMilestone ?? json.activeMilestone) === "M001" ||
        (json.state?.activeMilestone ?? json.activeMilestone)?.id === "M001",
      `expected active milestone M001`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Test: state derivation — all tasks done ─────────────────────────────

run("headless query: all tasks done reports summarizing phase", () => {
  const dir = createTempProject("summarizing");
  try {
    const mDir = join(dir, ".gsd", "milestones", "M001");
    const sDir = join(mDir, "slices", "S01");
    mkdirSync(join(sDir, "tasks"), { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\nContext.");
    writeFileSync(
      join(mDir, "M001-ROADMAP.md"),
      buildMinimalRoadmap([{ id: "S01", title: "First Slice", done: false }]),
    );
    writeFileSync(
      join(sDir, "S01-PLAN.md"),
      buildMinimalPlan([{ id: "T01", title: "Task One", done: true }]),
    );
    writeFileSync(
      join(sDir, "tasks", "T01-SUMMARY.md"),
      buildTaskSummary("T01"),
    );

    const result = gsd(["headless", "query"], dir);
    assert(result.code === 0, `expected exit 0, got ${result.code}`);

    const json = JSON.parse(result.stdout);
    assert(
      (json.state?.phase ?? json.phase) === "summarizing",
      `expected summarizing, got: ${json.state?.phase ?? json.phase}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Test: state derivation — complete milestone ─────────────────────────
//
// Previously this accepted {complete, idle, pre-planning} — three-way
// accept meant it could not distinguish "rolled forward correctly" from
// "broken."  Now: the roadmap has its only slice checked and a SUMMARY
// file exists, so the milestone must roll forward to either "complete"
// (M001 reported as done) or "idle" (M001 archived, no successor).
// "pre-planning" indicates we forgot the completed milestone — a bug.

run("headless query: milestone with summary reports complete or idle", () => {
  const dir = createTempProject("complete");
  try {
    const mDir = join(dir, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(
      join(mDir, "M001-ROADMAP.md"),
      buildMinimalRoadmap([{ id: "S01", title: "Done", done: true }]),
    );
    writeFileSync(join(mDir, "M001-SUMMARY.md"), "# M001 Summary\n\nComplete.");

    const result = gsd(["headless", "query"], dir);
    assert(result.code === 0, `expected exit 0, got ${result.code}`);

    const json = JSON.parse(result.stdout);
    const phase = json.state?.phase ?? json.phase;
    assert(
      phase === "complete" || phase === "idle",
      `expected complete or idle (not pre-planning — completed milestone must not be forgotten), got: ${phase}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Test: lock file lifecycle — captured real PID ───────────────────────
//
// Previously this hardcoded PID 99999999 as "doesn't exist."  That is
// fragile on long-lived hosts (PID wrap, slot reuse) and in containers
// where the kernel hands out high PIDs.  Capture a real PID by
// spawning then terminating a subprocess — guaranteed-dead PID under
// our control.

runAsync("stale auto.lock with captured dead PID does not block --version", async () => {
  const dir = createTempProject("stale-lock");
  try {
    const deadPid = await captureDeadPid();
    const gsdDir = join(dir, ".gsd");
    mkdirSync(gsdDir, { recursive: true });
    writeFileSync(
      join(gsdDir, "auto.lock"),
      JSON.stringify({
        pid: deadPid,
        startedAt: new Date().toISOString(),
        unitType: "starting",
        unitId: "bootstrap",
        unitStartedAt: new Date().toISOString(),
        completedUnits: 0,
      }),
    );

    const result = gsd(["--version"], dir);
    assert(
      result.code === 0,
      `--version should succeed even with stale lock, got code ${result.code}: ${result.stderr}`,
    );
    assert(
      /^\d+\.\d+\.\d+/.test(result.stdout.trim()),
      `should output version, got: ${result.stdout}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Test: `gsd doctor` emits actionable guidance on stale lock ─────────
//
// Previously "crash recovery shows actionable guidance" called
// `headless query` (which does not emit guidance) and asserted only
// exit 0.  A silent no-op passed.  Now: invoke `gsd doctor` — the
// command users are pointed at for recovery — and assert the output
// actually mentions the stale lock with its PID.

runAsync("gsd doctor surfaces actionable guidance about the stale lock", async () => {
  const dir = createTempProject("crash-guidance");
  try {
    const deadPid = await captureDeadPid();
    const gsdDir = join(dir, ".gsd");
    mkdirSync(join(gsdDir, "milestones"), { recursive: true });
    writeFileSync(
      join(gsdDir, "auto.lock"),
      JSON.stringify({
        pid: deadPid,
        startedAt: new Date().toISOString(),
        unitType: "execute-task",
        unitId: "M001/S01/T02",
        unitStartedAt: new Date().toISOString(),
        completedUnits: 5,
      }),
    );

    const candidates: string[][] = [
      ["doctor"],
      ["doctor", "--json"],
      ["headless", "doctor"],
    ];
    let emitted = "";
    let exitCode = 1;
    let ran = false;
    for (const argv of candidates) {
      const r = gsd(argv, dir);
      const combined = `${r.stdout}\n${r.stderr}`;
      if (r.code === 0 || r.code === 1) {
        emitted = combined;
        exitCode = r.code;
        ran = true;
        if (combined.toLowerCase().includes("lock")) break;
      }
    }
    if (!ran) {
      throw new Error("gsd doctor command is not available on this binary");
    }

    const lower = emitted.toLowerCase();
    assert(
      lower.includes("lock"),
      `output must mention "lock" (got: ${emitted.slice(0, 200)})`,
    );
    assert(
      emitted.includes(String(deadPid)),
      `output must mention the stale PID ${deadPid} (got: ${emitted.slice(0, 200)})`,
    );
    assert(
      lower.includes("stale") ||
        lower.includes("clear") ||
        lower.includes("fix") ||
        lower.includes("stale_crash_lock"),
      `output should include mitigation guidance (stale/clear/fix), got: ${emitted.slice(0, 200)}`,
    );
    assert(
      exitCode === 0 || exitCode === 1,
      `doctor should exit 0 (clean) or 1 (issues detected), got ${exitCode}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Test: non-TTY invocation exits with clean error ─────────────────────
//
// Split from the old "exits quickly" assertion.  The 5s budget was
// arbitrary and unjustified, and flaked on cold starts.  Correctness
// (exit 1 + stderr mentions terminal) is the signal; any perf budget
// belongs in its own percentile-based job, not here.

run("non-TTY invocation exits with clean TTY error", () => {
  const dir = createTempProject("tty-check");
  try {
    const result = gsd([], dir);
    assert(
      result.code === 1,
      `expected exit 1 for non-TTY, got ${result.code}`,
    );
    assert(
      result.stderr.includes("TTY") ||
        result.stderr.includes("terminal") ||
        result.stderr.includes("Interactive"),
      `should mention TTY / terminal / Interactive in stderr, got: ${result.stderr.slice(0, 200)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Test: version skew is detected (distinct from TTY error) ───────────
//
// Previously this accepted *either* a TTY error or a version-skew
// error — identical coverage to the TTY test above it.  Now: prime a
// fake managed-resources.json with a known-future version and assert
// that stderr specifically names the version-skew path, not just
// "exit 1."

run("version skew is detected and named in stderr", () => {
  const dir = createTempProject("version-skew");
  try {
    const fakeHome = dir;
    mkdirSync(join(fakeHome, ".gsd", "agent"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".gsd", "agent", "managed-resources.json"),
      JSON.stringify({ gsdVersion: "999.0.0" }),
    );

    const result = gsd([], dir, { HOME: fakeHome });
    assert(result.code === 1, `expected exit 1, got ${result.code}`);

    const stderr = result.stderr;
    const hitVersionSkew =
      stderr.includes("999.0.0") ||
      /version\s*(skew|mismatch)/i.test(stderr) ||
      /managed-resources/i.test(stderr);
    assert(
      hitVersionSkew,
      `expected stderr to mention version skew / 999.0.0 / managed-resources; got: ${stderr.slice(0, 400)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// NB: the previous "gsd --help works" test was a duplicate of
// tests/smoke/test-help.ts and has been removed from this harness
// (see #4801).  Smoke coverage of `--help` now lives in one place.

// ─── helpers ────────────────────────────────────────────────────────────

async function captureDeadPid(): Promise<number> {
  // Spawn then kill a subprocess; use its (now-freed) PID as a
  // guaranteed-dead PID.  There is a narrow race where the kernel
  // could reuse the PID before we write the lock, but on a modern
  // Linux/macOS host with PID_MAX in the millions the odds per run
  // are vanishingly small, and the consequence is a self-fix (the
  // stale-lock code path would not fire — we'd get a clear failure
  // message, not a false positive).
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
      detached: false,
    });
    const pid = child.pid;
    if (!pid) {
      reject(new Error("failed to spawn dead-pid helper"));
      return;
    }
    child.on("exit", () => resolve(pid));
    child.kill("SIGKILL");
  });
}

// ─── async driver + summary ─────────────────────────────────────────────

(async () => {
  for (const { label, fn } of asyncTests) {
    try {
      await fn();
      console.log(`  PASS  ${label}`);
      passed++;
    } catch (err: any) {
      console.error(`  FAIL  ${label}`);
      console.error(`     ${err.message || err}`);
      failed++;
    }
  }

  console.log(`\nLive regression: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
