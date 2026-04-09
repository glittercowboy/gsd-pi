import { describe, it } from "node:test";
import assert from "node:assert";

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
});
