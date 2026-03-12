/**
 * SC-1: Config bridge — config.json values flow into SessionManager and processFactory.
 *
 * RED state: These tests will fail until Plan 01 wires config.json reading into startPipeline.
 * Expected failures:
 *   - skipPermissions option not passed from config to processFactory
 *   - setWorktreeEnabled not called with config value
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPipeline } from "../src/server/pipeline";

describe("SC-1: Config bridge — skip_permissions flows to processFactory", () => {
  let tempDir: string;
  let planningDir: string;
  let capturedOptions: Array<{ cwd: string; opts?: unknown }>;
  let handle: { stop(): void } | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "config-bridge-test-"));
    planningDir = join(tempDir, ".planning");
    await mkdir(planningDir, { recursive: true });

    // Write a minimal config.json
    await writeFile(
      join(planningDir, "config.json"),
      JSON.stringify({ skip_permissions: false, worktree_enabled: true })
    );

    capturedOptions = [];
  });

  afterEach(async () => {
    if (handle) {
      handle.stop();
      handle = null;
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("passes skipPermissions: false to processFactory when config has skip_permissions: false", async () => {
    // This test will FAIL until Plan 01 reads config.json and passes options to processFactory.
    // Currently startPipeline does not accept a processFactory option at all.
    const processFactoryCalls: Array<{ cwd: string; skipPermissions?: boolean }> = [];

    // startPipeline does not currently accept a processFactory — this test documents
    // the expected interface after Plan 01.
    // The assertion will fail because the option doesn't exist yet.
    handle = await startPipeline({
      planningDir,
      wsPort: 14100,
      // @ts-expect-error — processFactory injection not yet implemented (Plan 01)
      processFactory: (cwd: string, opts?: { skipPermissions?: boolean }) => {
        processFactoryCalls.push({ cwd, skipPermissions: opts?.skipPermissions });
        return {
          isActive: true,
          isProcessing: false,
          sessionId: null,
          onEvent: () => {},
          start: async () => {},
          sendMessage: async () => {},
          kill: async () => {},
        };
      },
    });

    // Expect the factory to have been called with skipPermissions: false (from config)
    expect(processFactoryCalls.length).toBeGreaterThan(0);
    expect(processFactoryCalls[0].skipPermissions).toBe(false);
  });
});

describe("SC-1: Config bridge — worktree_enabled flows to SessionManager", () => {
  let tempDir: string;
  let planningDir: string;
  let handle: { stop(): void; sessionManager: { worktreeEnabled: boolean } } | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "config-bridge-wt-test-"));
    planningDir = join(tempDir, ".planning");
    await mkdir(planningDir, { recursive: true });

    await writeFile(
      join(planningDir, "config.json"),
      JSON.stringify({ skip_permissions: false, worktree_enabled: true })
    );
  });

  afterEach(async () => {
    if (handle) {
      handle.stop();
      handle = null;
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("calls sessionManager.setWorktreeEnabled(true) when config has worktree_enabled: true", async () => {
    // This test will FAIL until Plan 01 reads config.json and calls setWorktreeEnabled.
    // Currently startPipeline ignores config.json entirely.
    handle = await startPipeline({
      planningDir,
      wsPort: 14101,
    }) as any;

    // Expect worktreeEnabled to be true (set from config)
    expect(handle!.sessionManager.worktreeEnabled).toBe(true);
  });
});
