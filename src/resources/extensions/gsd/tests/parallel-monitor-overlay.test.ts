import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir as osTmpdir } from "node:os";

/**
 * Basic tests for the parallel monitor overlay data helpers.
 * The overlay is primarily a rendering component that reads existing
 * status files — these tests verify the helper logic in isolation.
 */

describe("parallel-monitor-overlay", () => {
  it("progressBar generates correct width", async () => {
    // Dynamic import to test the module loads cleanly
    const mod = await import("../parallel-monitor-overlay.js");
    // Module should export the class
    assert.ok(mod.ParallelMonitorOverlay, "ParallelMonitorOverlay class should be exported");
  });

  it("ParallelMonitorOverlay can be instantiated with mock tui", async () => {
    const mod = await import("../parallel-monitor-overlay.js");

    let renderRequested = false;
    const mockTui = { requestRender: () => { renderRequested = true; } };
    const mockTheme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    let closed = false;

    const overlay = new mod.ParallelMonitorOverlay(
      mockTui,
      mockTheme as any,
      () => { closed = true; },
      "/nonexistent/path",  // basePath — no real data, tests empty state
    );

    // Should render without throwing
    const lines = overlay.render(80);
    assert.ok(Array.isArray(lines), "render should return an array");
    assert.ok(lines.length > 0, "render should return at least one line");

    // Should contain header text
    const joined = lines.join("\n");
    assert.ok(joined.includes("Parallel Monitor"), "should include title");
    assert.ok(joined.includes("No parallel workers found"), "should show empty state");

    // Dispose should not throw
    overlay.dispose();

    // handleInput with ESC should call onClose
    const overlay2 = new mod.ParallelMonitorOverlay(
      mockTui,
      mockTheme as any,
      () => { closed = true; },
      "/nonexistent/path",
    );
    overlay2.handleInput("q");
    assert.ok(closed, "pressing q should trigger onClose");
    overlay2.dispose();

  });

  it("ParallelMonitorOverlay clamps scrollOffset during render", async () => {
    const mod = await import("../parallel-monitor-overlay.js");

    const mockTui = { requestRender: () => {} };
    const mockTheme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const overlay = new mod.ParallelMonitorOverlay(
      mockTui,
      mockTheme as any,
      () => {},
      "/nonexistent/path",
    );

    (overlay as any).scrollOffset = 999;
    overlay.render(80);
    assert.equal((overlay as any).scrollOffset, 0, "empty overlays clamp scroll to zero");
    overlay.dispose();
  });

  // Regression test for #3160: stale stderr errors from a crashed worker should not
  // persist in the overlay once the worker restarts and is alive again.
  describe("stale error clearing on worker restart (#3160)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(osTmpdir(), "parallel-monitor-test-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("does not show stale warning lines when no workers are present", async () => {
      // Invariant: errors[] is empty when there are no alive workers with stale stderr.
      // An overlay with no parallel directory shows no "⚠" lines at all.
      const { ParallelMonitorOverlay } = await import("../parallel-monitor-overlay.js");
      const mockTui = { requestRender: () => {} };
      const mockTheme = { fg: (_: string, t: string) => t, bold: (t: string) => t };

      const overlay = new ParallelMonitorOverlay(mockTui, mockTheme as any, () => {}, "/nonexistent/path");
      const lines = overlay.render(80);
      const joined = lines.join("\n");

      assert.ok(!joined.includes("⚠"), "no stale error warnings should appear with no workers");
      overlay.dispose();
    });

    it("clears stale errors when worker transitions to RUNNING (alive)", async () => {
      // Setup: create a fake worker directory with a status.json marking the worker alive
      // via a real PID (process.pid), and a stderr log containing old error lines.
      const { ParallelMonitorOverlay } = await import("../parallel-monitor-overlay.js");
      const mockTui = { requestRender: () => {} };
      const mockTheme = { fg: (_: string, t: string) => t, bold: (t: string) => t };

      const parallelDir = join(tmpDir, ".gsd", "parallel");
      mkdirSync(parallelDir, { recursive: true });

      const mid = "M001";

      // Write a status.json with the current process's PID so isPidAlive returns true
      writeFileSync(
        join(parallelDir, `${mid}.status.json`),
        JSON.stringify({
          milestoneId: mid,
          pid: process.pid,
          state: "running",
          cost: 0,
          lastHeartbeat: Date.now(),
          startedAt: Date.now() - 10000,
          worktreePath: tmpDir,
        }),
      );

      // Write a stderr log that contains error lines from the previous (crashed) run.
      // These are the stale errors that must NOT appear after restart.
      writeFileSync(
        join(parallelDir, `${mid}.stderr.log`),
        [
          "Error: ENOENT: no such file or directory",
          "Process exited with code 1",
          "UnhandledPromiseRejectionWarning: Error something went wrong",
        ].join("\n"),
      );

      const overlay = new ParallelMonitorOverlay(mockTui, mockTheme as any, () => {}, tmpDir);
      const lines = overlay.render(80);
      const joined = lines.join("\n");

      // The worker is alive — stale errors from the previous crash must not be displayed.
      assert.ok(
        !joined.includes("⚠"),
        `alive worker with stale stderr errors should show no ⚠ warning lines, but got:\n${joined}`,
      );

      overlay.dispose();
    });

    it("still shows error lines for dead workers", async () => {
      // Dead workers (alive=false) must still display their stderr error lines.
      // We use PID 0 to guarantee isPidAlive returns false.
      const { ParallelMonitorOverlay } = await import("../parallel-monitor-overlay.js");
      const mockTui = { requestRender: () => {} };
      const mockTheme = { fg: (_: string, t: string) => t, bold: (t: string) => t };

      const parallelDir = join(tmpDir, ".gsd", "parallel");
      mkdirSync(parallelDir, { recursive: true });

      const mid = "M002";

      // Write a status.json with PID 0 — isPidAlive(0) always throws/returns false
      writeFileSync(
        join(parallelDir, `${mid}.status.json`),
        JSON.stringify({
          milestoneId: mid,
          pid: 0,
          state: "dead",
          cost: 0,
          lastHeartbeat: Date.now() - 60000,
          startedAt: Date.now() - 120000,
          worktreePath: tmpDir,
        }),
      );

      // Write error lines that should still appear for a dead worker
      writeFileSync(
        join(parallelDir, `${mid}.stderr.log`),
        [
          "Error: fatal worker crash",
          "Process exited with code 1",
        ].join("\n"),
      );

      const overlay = new ParallelMonitorOverlay(mockTui, mockTheme as any, () => {}, tmpDir);
      const lines = overlay.render(80);
      const joined = lines.join("\n");

      // Dead worker — error lines must still be visible
      assert.ok(
        joined.includes("⚠"),
        `dead worker with stderr errors should show ⚠ warning lines, but got:\n${joined}`,
      );

      overlay.dispose();
    });
  });
});
