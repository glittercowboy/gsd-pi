import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rewriteCommandWithRtk as rewriteSharedCommandWithRtk } from "../resources/extensions/shared/rtk.ts";
import { runVerificationGate } from "../resources/extensions/gsd/verification-gate.ts";
import { AsyncJobManager } from "../resources/extensions/async-jobs/job-manager.ts";
import { createAsyncBashTool } from "../resources/extensions/async-jobs/async-bash-tool.ts";
import { cleanupAll, startProcess } from "../resources/extensions/bg-shell/process-manager.ts";
import { runOnSession } from "../resources/extensions/bg-shell/interaction.ts";
import { createFakeRtk } from "./rtk-test-utils.ts";

const noopSignal = new AbortController().signal;

async function waitFor(predicate: () => boolean, timeoutMs = 2_000, pollMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function waitForOutputMatch(
  getOutput: () => string,
  pattern: RegExp,
  timeoutMs = 2_000,
): Promise<string> {
  let latest = getOutput();
  await waitFor(() => {
    latest = getOutput();
    return pattern.test(latest);
  }, timeoutMs);
  return latest;
}

function withFakeRtk<T>(mapping: Record<string, string | { status?: number; stdout?: string }>, run: () => Promise<T> | T): Promise<T> | T {
  const fake = createFakeRtk(mapping);
  const previousPath = process.env.GSD_RTK_PATH;
  const previousDisabled = process.env.GSD_RTK_DISABLED;
  const previousTimeout = process.env.GSD_RTK_REWRITE_TIMEOUT_MS;
  process.env.GSD_RTK_PATH = fake.path;
  process.env.GSD_RTK_REWRITE_TIMEOUT_MS = "20000";
  delete process.env.GSD_RTK_DISABLED;

  const finalize = () => {
    if (previousPath === undefined) delete process.env.GSD_RTK_PATH;
    else process.env.GSD_RTK_PATH = previousPath;
    if (previousDisabled === undefined) delete process.env.GSD_RTK_DISABLED;
    else process.env.GSD_RTK_DISABLED = previousDisabled;
    if (previousTimeout === undefined) delete process.env.GSD_RTK_REWRITE_TIMEOUT_MS;
    else process.env.GSD_RTK_REWRITE_TIMEOUT_MS = previousTimeout;
    fake.cleanup();
  };

  try {
    const result = run();
    if (result && typeof (result as Promise<T>).then === "function") {
      return (result as Promise<T>).finally(finalize);
    }
    finalize();
    return result;
  } catch (error) {
    finalize();
    throw error;
  }
}

function withManagedFakeRtk<T>(mapping: Record<string, string | { status?: number; stdout?: string }>, run: (env: NodeJS.ProcessEnv, managedPath: string) => Promise<T> | T): Promise<T> | T {
  const fake = createFakeRtk(mapping);
  const managedHome = mkdtempSync(join(tmpdir(), "gsd-rtk-managed-home-"));
  const managedDir = join(managedHome, "agent", "bin");
  const managedPath = join(managedDir, process.platform === "win32" ? "rtk.cmd" : "rtk");
  mkdirSync(managedDir, { recursive: true });
  copyFileSync(fake.path, managedPath);
  if (process.platform !== "win32") {
    chmodSync(managedPath, 0o755);
  }

  const previousHome = process.env.GSD_HOME;
  const previousPath = process.env.GSD_RTK_PATH;
  const previousDisabled = process.env.GSD_RTK_DISABLED;
  const previousTimeout = process.env.GSD_RTK_REWRITE_TIMEOUT_MS;
  process.env.GSD_HOME = managedHome;
  process.env.GSD_RTK_REWRITE_TIMEOUT_MS = "20000";
  delete process.env.GSD_RTK_PATH;
  delete process.env.GSD_RTK_DISABLED;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GSD_HOME: managedHome,
    GSD_RTK_REWRITE_TIMEOUT_MS: "20000",
  };
  delete env.GSD_RTK_PATH;

  const finalize = () => {
    if (previousHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousHome;
    if (previousPath === undefined) delete process.env.GSD_RTK_PATH;
    else process.env.GSD_RTK_PATH = previousPath;
    if (previousDisabled === undefined) delete process.env.GSD_RTK_DISABLED;
    else process.env.GSD_RTK_DISABLED = previousDisabled;
    if (previousTimeout === undefined) delete process.env.GSD_RTK_REWRITE_TIMEOUT_MS;
    else process.env.GSD_RTK_REWRITE_TIMEOUT_MS = previousTimeout;
    fake.cleanup();
    rmSync(managedHome, { recursive: true, force: true });
  };

  try {
    const result = run(env, managedPath);
    if (result && typeof (result as Promise<T>).then === "function") {
      return (result as Promise<T>).finally(finalize);
    }
    finalize();
    return result;
  } catch (error) {
    finalize();
    throw error;
  }
}

// NOTE: The bash tool itself no longer does RTK rewriting directly. That's now
// handled by the bash_transform extension hook in register-hooks.ts. The seam
// tests below verify the GSD-layer surfaces that still call rewriteCommandWithRtk
// directly: shared/rtk.ts, verification-gate, async-bash, and bg-shell.

test("shared RTK helper rewrites commands via fake RTK binary", async () => {
  await withFakeRtk({ "echo raw": "echo rewritten" }, async () => {
    const rewritten = rewriteSharedCommandWithRtk("echo raw");
    assert.equal(rewritten, "echo rewritten");
  });
});

test("shared RTK helper falls back to the managed RTK path when GSD_RTK_PATH is unset", async () => {
  await withManagedFakeRtk({ "echo raw": "echo rewritten" }, async (env) => {
    assert.equal(rewriteSharedCommandWithRtk("echo raw", env), "echo rewritten");
  });
});

test("verification gate executes the RTK-rewritten command", async () => {
  await withFakeRtk({ "echo raw": "echo rewritten" }, async () => {
    const result = runVerificationGate({
      basePath: process.cwd(),
      unitId: "T-RTK",
      cwd: process.cwd(),
      preferenceCommands: ["echo raw"],
    });

    assert.equal(result.passed, true);
    assert.equal(result.checks.length, 1);
    assert.match(result.checks[0]?.stdout ?? "", /rewritten/);
  });
});

test("async_bash executes the RTK-rewritten command", async () => {
  await withFakeRtk({ "echo raw": "echo rewritten" }, async () => {
    const manager = new AsyncJobManager();
    const tool = createAsyncBashTool(() => manager, () => process.cwd());

    const result = await tool.execute(
      "rtk-async",
      { command: "echo raw", label: "rtk-async" },
      noopSignal,
      () => {},
      undefined as never,
    );

    const text = result.content.map((entry) => entry.text ?? "").join("\n");
    const jobId = text.match(/\*\*(bg_[a-f0-9]+)\*\*/)?.[1];
    assert.ok(jobId, "expected async_bash to return a job id");

    const job = manager.getJob(jobId!);
    assert.ok(job, "job should be registered");
    await job!.promise;
    assert.match(job!.resultText ?? "", /rewritten/);
    manager.shutdown();
  });
});

test("bg_shell start and runOnSession both execute RTK-rewritten commands", async (t) => {
  if (process.platform === "win32") {
    t.skip("bg_shell requires bash; Windows CI runners don't have Git Bash");
    return;
  }
  t.after(cleanupAll);

  await withFakeRtk({ "echo raw": "echo rewritten" }, async () => {
    const oneshot = startProcess({
      command: "echo raw",
      cwd: process.cwd(),
      ownerSessionFile: "session-rtk",
    });

    assert.match(
      await waitForOutputMatch(() => oneshot.output.map((line) => line.line).join("\n"), /rewritten/),
      /rewritten/,
    );

    const shellSession = startProcess({
      command: "",
      cwd: process.cwd(),
      ownerSessionFile: "session-rtk-shell",
      type: "shell",
    });

    await waitFor(() => shellSession.status === "ready" || !shellSession.alive);
    const result = await runOnSession(shellSession, "echo raw", 2_000);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /rewritten/);
  });
});
