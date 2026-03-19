/**
 * Comprehensive tests for parallel engine hardening features:
 * 1. Stale detection with 60s default timeout
 * 2. ParallelConfig defaults (overlap_policy, max_retries)
 * 3. WorkerInfo shape (stderrLines, restartCount)
 * 4. Stderr ring buffer pattern (50-line cap)
 * 5. Restart logic pattern (restartCount vs max_retries)
 * 6. Overlap blocking policy (block vs warn)
 * 7. Heartbeat timer guard (no-op without GSD_PARALLEL_WORKER)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isSessionStale,
  type SessionStatus,
} from "../session-status-io.js";

import { resolveParallelConfig } from "../preferences.js";

import {
  analyzeParallelEligibility,
  formatEligibilityReport,
} from "../parallel-eligibility.js";

import { invalidateStateCache } from "../state.js";

import type { WorkerInfo } from "../parallel-orchestrator.js";

import { startWorkerHeartbeat, stopWorkerHeartbeat } from "../auto-timers.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    milestoneId: "M001",
    pid: process.pid,
    state: "running",
    currentUnit: null,
    completedUnits: 0,
    cost: 0,
    lastHeartbeat: Date.now(),
    startedAt: Date.now() - 60_000,
    worktreePath: "/tmp/test-wt",
    ...overrides,
  };
}

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-engine-hardening-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

/**
 * Write a minimal milestone roadmap with one slice that touches specific files.
 */
function writeMilestoneWithFiles(
  base: string,
  mid: string,
  sliceId: string,
  files: string[],
): void {
  // Roadmap — uses checkbox format expected by parseRoadmapSlices
  const mDir = join(base, ".gsd", "milestones", mid);
  mkdirSync(mDir, { recursive: true });
  writeFileSync(
    join(mDir, `${mid}-ROADMAP.md`),
    `# ${mid}\n\n## Slices\n\n- [ ] **${sliceId}: Test slice**\n`,
  );

  // Slice plan with filesLikelyTouched
  const sDir = join(mDir, "slices", sliceId);
  mkdirSync(sDir, { recursive: true });
  const filesList = files.map((f) => `- ${f}`).join("\n");
  writeFileSync(
    join(sDir, `${sliceId}-PLAN.md`),
    `# ${sliceId} Plan\n\n## Files Likely Touched\n\n${filesList}\n`,
  );
}

// ─── Group 1: Stale Detection Defaults ──────────────────────────────────────

describe("stale detection: 60s default timeout", () => {
  it("returns false with alive PID and recent heartbeat (default 60s)", () => {
    const status = makeStatus({ pid: process.pid, lastHeartbeat: Date.now() });
    assert.equal(isSessionStale(status), false);
  });

  it("returns false with alive PID and 45s-old heartbeat (proves 60s, not 30s)", () => {
    const status = makeStatus({
      pid: process.pid,
      lastHeartbeat: Date.now() - 45_000,
    });
    assert.equal(isSessionStale(status), false);
  });

  it("returns true with alive PID and 65s-old heartbeat", () => {
    const status = makeStatus({
      pid: process.pid,
      lastHeartbeat: Date.now() - 65_000,
    });
    assert.equal(isSessionStale(status), true);
  });

  it("returns false with custom 120s timeout and 90s-old heartbeat", () => {
    const status = makeStatus({
      pid: process.pid,
      lastHeartbeat: Date.now() - 90_000,
    });
    assert.equal(isSessionStale(status, 120_000), false);
  });

  it("returns true with dead PID regardless of heartbeat", () => {
    // PID 2147483647 is virtually impossible to be alive
    const status = makeStatus({
      pid: 2147483647,
      lastHeartbeat: Date.now(),
    });
    assert.equal(isSessionStale(status), true);
  });
});

// ─── Group 2: ParallelConfig Defaults ──────────────────────────────────────

describe("ParallelConfig: overlap_policy and max_retries defaults", () => {
  it("resolveParallelConfig(undefined) returns overlap_policy 'warn' and max_retries 1", () => {
    const config = resolveParallelConfig(undefined);
    assert.equal(config.overlap_policy, "warn");
    assert.equal(config.max_retries, 1);
  });

  it("resolveParallelConfig with overlap_policy 'block' returns 'block'", () => {
    const config = resolveParallelConfig({
      parallel: {
        enabled: true,
        max_workers: 2,
        merge_strategy: "per-milestone",
        auto_merge: "confirm",
        overlap_policy: "block",
      },
    });
    assert.equal(config.overlap_policy, "block");
  });

  it("resolveParallelConfig with max_retries 3 returns 3", () => {
    const config = resolveParallelConfig({
      parallel: {
        enabled: true,
        max_workers: 2,
        merge_strategy: "per-milestone",
        auto_merge: "confirm",
        max_retries: 3,
      },
    });
    assert.equal(config.max_retries, 3);
  });

  it("resolveParallelConfig with max_retries -1 clamps to 0", () => {
    const config = resolveParallelConfig({
      parallel: {
        enabled: true,
        max_workers: 2,
        merge_strategy: "per-milestone",
        auto_merge: "confirm",
        max_retries: -1,
      },
    });
    assert.equal(config.max_retries, 0);
  });
});

// ─── Group 3: WorkerInfo Shape ─────────────────────────────────────────────

describe("WorkerInfo: stderrLines and restartCount shape", () => {
  it("constructs with stderrLines and restartCount defaults", () => {
    const worker: Pick<WorkerInfo, "stderrLines" | "restartCount"> = {
      stderrLines: [],
      restartCount: 0,
    };
    assert.deepEqual(worker.stderrLines, []);
    assert.equal(worker.restartCount, 0);
  });

  it("stderrLines is mutable and supports push/shift", () => {
    const worker: Pick<WorkerInfo, "stderrLines"> = { stderrLines: [] };
    worker.stderrLines.push("line1");
    worker.stderrLines.push("line2");
    assert.equal(worker.stderrLines.length, 2);
    worker.stderrLines.shift();
    assert.equal(worker.stderrLines.length, 1);
    assert.equal(worker.stderrLines[0], "line2");
  });
});

// ─── Group 4: Stderr Ring Buffer Pattern ────────────────────────────────────

describe("stderr ring buffer: 50-line cap with FIFO eviction", () => {
  it("keeps last 50 lines when 60 are pushed", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 60; i++) {
      lines.push(`line ${i}`);
      if (lines.length > 50) lines.shift();
    }
    assert.equal(lines.length, 50);
    assert.equal(lines[0], "line 11");
    assert.equal(lines[49], "line 60");
  });

  it("preserves all lines when fewer than 50", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) {
      lines.push(`error ${i}`);
      if (lines.length > 50) lines.shift();
    }
    assert.equal(lines.length, 30);
    assert.equal(lines[0], "error 1");
    assert.equal(lines[29], "error 30");
  });

  it("correctly handles exactly 50 lines (boundary)", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 50; i++) {
      lines.push(`msg ${i}`);
      if (lines.length > 50) lines.shift();
    }
    assert.equal(lines.length, 50);
    assert.equal(lines[0], "msg 1");
    assert.equal(lines[49], "msg 50");
  });

  it("evicts 51st line correctly (off-by-one check)", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 51; i++) {
      lines.push(`x${i}`);
      if (lines.length > 50) lines.shift();
    }
    assert.equal(lines.length, 50);
    assert.equal(lines[0], "x2");
    assert.equal(lines[49], "x51");
  });
});

// ─── Group 5: Restart Logic Pattern ─────────────────────────────────────────

describe("restart logic: restartCount vs max_retries decision", () => {
  function shouldRestart(exitCode: number | null, restartCount: number, maxRetries: number): boolean {
    if (exitCode === 0 || exitCode === null) return false;
    return restartCount < maxRetries;
  }

  it("restartCount=0, max_retries=1 → should restart", () => {
    assert.equal(shouldRestart(1, 0, 1), true);
  });

  it("restartCount=1, max_retries=1 → should NOT restart", () => {
    assert.equal(shouldRestart(1, 1, 1), false);
  });

  it("restartCount=0, max_retries=0 → should NOT restart", () => {
    assert.equal(shouldRestart(1, 0, 0), false);
  });

  it("exit code 0 → should NOT restart regardless", () => {
    assert.equal(shouldRestart(0, 0, 5), false);
  });

  it("exit code null → should NOT restart (clean termination)", () => {
    assert.equal(shouldRestart(null, 0, 5), false);
  });

  it("restartCount=2, max_retries=3 → should restart", () => {
    assert.equal(shouldRestart(1, 2, 3), true);
  });

  it("restartCount=3, max_retries=3 → should NOT restart (exhausted)", () => {
    assert.equal(shouldRestart(1, 3, 3), false);
  });
});

// ─── Group 6: Overlap Blocking Policy ──────────────────────────────────────

describe("overlap blocking: analyzeParallelEligibility with overlap_policy", () => {
  let base: string;
  beforeEach(() => { base = makeTmpBase(); invalidateStateCache(); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); invalidateStateCache(); });

  it("overlap_policy 'block' moves overlapping milestones to ineligible", async () => {
    // M001 and M002 both touch src/shared.ts
    writeMilestoneWithFiles(base, "M001", "S01", ["src/shared.ts", "src/a.ts"]);
    writeMilestoneWithFiles(base, "M002", "S01", ["src/shared.ts", "src/b.ts"]);

    const result = await analyzeParallelEligibility(base, { overlap_policy: "block" });

    // Both should be ineligible due to overlap
    assert.equal(result.eligible.length, 0);
    assert.ok(result.ineligible.length >= 2);
    const blocked = result.ineligible.filter((r) => r.reason.includes("Blocked by overlap_policy"));
    assert.ok(blocked.length >= 2, `Expected 2+ blocked, got ${blocked.length}`);
    assert.ok(result.fileOverlaps.length > 0);
  });

  it("overlap_policy 'warn' keeps overlapping milestones in eligible with warning", async () => {
    // Same setup as above
    writeMilestoneWithFiles(base, "M001", "S01", ["src/shared.ts", "src/a.ts"]);
    writeMilestoneWithFiles(base, "M002", "S01", ["src/shared.ts", "src/b.ts"]);

    const result = await analyzeParallelEligibility(base, { overlap_policy: "warn" });

    // Both should remain eligible
    assert.equal(result.eligible.length, 2);
    const warned = result.eligible.filter((r) => r.reason.includes("WARNING"));
    assert.equal(warned.length, 2);
    assert.ok(result.fileOverlaps.length > 0);
  });

  it("default (no config) behaves as warn — overlapping milestones stay eligible", async () => {
    writeMilestoneWithFiles(base, "M001", "S01", ["src/shared.ts"]);
    writeMilestoneWithFiles(base, "M002", "S01", ["src/shared.ts"]);

    const result = await analyzeParallelEligibility(base);

    assert.equal(result.eligible.length, 2);
    const warned = result.eligible.filter((r) => r.reason.includes("WARNING"));
    assert.equal(warned.length, 2);
  });

  it("non-overlapping milestones stay eligible regardless of policy", async () => {
    writeMilestoneWithFiles(base, "M001", "S01", ["src/a.ts"]);
    writeMilestoneWithFiles(base, "M002", "S01", ["src/b.ts"]);

    const result = await analyzeParallelEligibility(base, { overlap_policy: "block" });

    assert.equal(result.eligible.length, 2);
    assert.equal(result.fileOverlaps.length, 0);
  });

  it("block reason includes overlapping milestone ID and file names", async () => {
    writeMilestoneWithFiles(base, "M001", "S01", ["src/types.ts"]);
    writeMilestoneWithFiles(base, "M002", "S01", ["src/types.ts"]);

    const result = await analyzeParallelEligibility(base, { overlap_policy: "block" });

    const m1 = result.ineligible.find((r) => r.milestoneId === "M001");
    const m2 = result.ineligible.find((r) => r.milestoneId === "M002");
    assert.ok(m1, "M001 should be in ineligible");
    assert.ok(m2, "M002 should be in ineligible");
    assert.ok(m1!.reason.includes("M002"), "M001 reason should mention M002");
    assert.ok(m2!.reason.includes("M001"), "M002 reason should mention M001");
    assert.ok(m1!.reason.includes("src/types.ts"), "reason should mention file name");
  });
});

describe("formatEligibilityReport: overlap policy annotation", () => {
  it("mentions block policy when config has overlap_policy 'block'", () => {
    const candidates = {
      eligible: [],
      ineligible: [
        { milestoneId: "M001", title: "Test", eligible: false, reason: "Blocked by overlap_policy" },
      ],
      fileOverlaps: [],
    };
    const report = formatEligibilityReport(candidates, { overlap_policy: "block" });
    assert.ok(report.includes("block"), "report should mention block policy");
  });

  it("does not mention block policy with default config", () => {
    const candidates = {
      eligible: [{ milestoneId: "M001", title: "Test", eligible: true, reason: "OK" }],
      ineligible: [],
      fileOverlaps: [],
    };
    const report = formatEligibilityReport(candidates);
    assert.ok(!report.includes("Overlap policy: **block**"), "report should not mention block by default");
  });
});

// ─── Group 7: Heartbeat Timer Guard ────────────────────────────────────────

describe("heartbeat timer: no-op without GSD_PARALLEL_WORKER", () => {
  it("startWorkerHeartbeat does nothing when GSD_PARALLEL_WORKER is not set", () => {
    // Save and clear the env var
    const saved = process.env.GSD_PARALLEL_WORKER;
    delete process.env.GSD_PARALLEL_WORKER;

    try {
      // Create a minimal session-like object
      const fakeSession = { heartbeatHandle: null } as any;
      startWorkerHeartbeat(fakeSession);
      // Should not have set an interval
      assert.equal(fakeSession.heartbeatHandle, null);
    } finally {
      // Restore env var
      if (saved !== undefined) {
        process.env.GSD_PARALLEL_WORKER = saved;
      }
    }
  });
});
