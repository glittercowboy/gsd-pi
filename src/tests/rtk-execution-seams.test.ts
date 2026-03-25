import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBashTool } from "../../packages/pi-coding-agent/src/core/tools/bash.ts";
import { rewriteCommandForGsd } from "../../packages/pi-coding-agent/src/utils/rtk.ts";
import { rewriteCommandWithRtk as rewriteSharedCommandWithRtk } from "../resources/extensions/shared/rtk.ts";
import { createAsyncBashTool } from "../resources/extensions/async-jobs/async-bash-tool.ts";
import { AsyncJobManager } from "../resources/extensions/async-jobs/job-manager.ts";
import { runVerificationGate } from "../resources/extensions/gsd/verification-gate.ts";
import { cleanupAll, startProcess } from "../resources/extensions/bg-shell/process-manager.ts";
import { runOnSession } from "../resources/extensions/bg-shell/interaction.ts";
import { createFakeRtk } from "./rtk-test-utils.ts";

const noopSignal = new AbortController().signal;

function withFakeRtk<T>(mapping: Record<string, string | { status?: number; stdout?: string }>, run: () => Promise<T> | T): Promise<T> | T {
  const fake = createFakeRtk(mapping);
  const previousPath = process.env.GSD_RTK_PATH;
  const previousDisabled = process.env.GSD_RTK_DISABLED;
  process.env.GSD_RTK_PATH = fake.path;
  delete process.env.GSD_RTK_DISABLED;

  const finalize = () => {
    if (previousPath === undefined) delete process.env.GSD_RTK_PATH;
    else process.env.GSD_RTK_PATH = previousPath;
    if (previousDisabled === undefined) delete process.env.GSD_RTK_DISABLED;
    else process.env.GSD_RTK_DISABLED = previousDisabled;
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
  const managedPath = join(managedDir, process.platform === "win32" ? "rtk.exe" : "rtk");
  mkdirSync(managedDir, { recursive: true });
  copyFileSync(fake.path, managedPath);
  if (process.platform !== "win32") {
    chmodSync(managedPath, 0o755);
  }

  const previousHome = process.env.GSD_HOME;
  const previousPath = process.env.GSD_RTK_PATH;
  const previousDisabled = process.env.GSD_RTK_DISABLED;
  process.env.GSD_HOME = managedHome;
  delete process.env.GSD_RTK_PATH;
  delete process.env.GSD_RTK_DISABLED;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GSD_HOME: managedHome,
  };
  delete env.GSD_RTK_PATH;

  const finalize = () => {
    if (previousHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousHome;
    if (previousPath === undefined) delete process.env.GSD_RTK_PATH;
    else process.env.GSD_RTK_PATH = previousPath;
    if (previousDisabled === undefined) delete process.env.GSD_RTK_DISABLED;
    else process.env.GSD_RTK_DISABLED = previousDisabled;
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

test("bash tool rewrites commands through RTK before execution", async () => {
  await withFakeRtk({ "echo raw": "echo rewritten" }, async () => {
    let seenCommand = "";
    const bashTool = createBashTool(process.cwd(), {
      operations: {
        exec: async (command, _cwd, { onData }) => {
          seenCommand = command;
          onData(Buffer.from("wrapped output\n"));
          return { exitCode: 0 };
        },
      },
    });

    const result = await bashTool.execute("rtk-bash", { command: "echo raw" });
    assert.equal(seenCommand, "echo rewritten");
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /wrapped output/);
  });
});

test("pi-coding-agent RTK helper rewrites commands before delegated execution", async () => {
  await withFakeRtk({ "echo raw": "echo rewritten" }, async () => {
    const rewritten = rewriteCommandForGsd("echo raw", {
      binaryPath: process.env.GSD_RTK_PATH,
    });

    assert.equal(rewritten, "echo rewritten");
  });
});

test("pi-coding-agent RTK helpers fall back to the managed RTK path when GSD_RTK_PATH is unset", async () => {
  await withManagedFakeRtk({ "echo raw": "echo rewritten" }, async (env, managedPath) => {
    assert.equal(rewriteCommandForGsd("echo raw", { env }), "echo rewritten");
    assert.equal(rewriteSharedCommandWithRtk("echo raw", env), "echo rewritten");
    assert.equal(rewriteCommandForGsd("echo raw", { env, binaryPath: managedPath }), "echo rewritten");
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
  t.after(cleanupAll);

  await withFakeRtk({ "echo raw": "echo rewritten" }, async () => {
    const oneshot = startProcess({
      command: "echo raw",
      cwd: process.cwd(),
      ownerSessionFile: "session-rtk",
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.match(oneshot.output.map((line) => line.line).join("\n"), /rewritten/);

    const shellSession = startProcess({
      command: "",
      cwd: process.cwd(),
      ownerSessionFile: "session-rtk-shell",
      type: "shell",
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await runOnSession(shellSession, "echo raw", 2_000);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /rewritten/);
  });
});
