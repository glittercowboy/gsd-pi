import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const webMode = await import("../../web-mode.ts");

// ---------------------------------------------------------------------------
// #2628 — On Windows, child processes spawned by web-mode must set
// `windowsHide: true` to prevent console windows from flashing on screen.
// ---------------------------------------------------------------------------

test("launchWebMode passes windowsHide: true in spawn options", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-web-winhide-"));
  const standaloneRoot = join(tmp, "dist", "web", "standalone");
  const serverPath = join(standaloneRoot, "server.js");
  mkdirSync(standaloneRoot, { recursive: true });
  writeFileSync(serverPath, 'console.log("stub")\n');

  const pidFilePath = join(tmp, "web-server.pid");
  const registryPath = join(tmp, "web-instances.json");

  let capturedOptions: Record<string, unknown> | undefined;

  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const status = await webMode.launchWebMode(
    {
      cwd: "/tmp/winhide-project",
      projectSessionsDir: "/tmp/.gsd/sessions/winhide",
      agentDir: "/tmp/.gsd/agent",
      packageRoot: tmp,
    },
    {
      initResources: () => {},
      resolvePort: async () => 46000,
      execPath: "/custom/node",
      env: { TEST_ENV: "1" },
      spawn: (_command, _args, options) => {
        capturedOptions = options as Record<string, unknown>;
        return {
          pid: 70001,
          once: () => undefined,
          unref: () => {},
        } as any;
      },
      waitForBootReady: async () => undefined,
      openBrowser: () => {},
      pidFilePath,
      writePidFile: webMode.writePidFile,
      registryPath,
      stderr: { write: () => true },
    },
  );

  assert.equal(status.ok, true, "launch should succeed");
  assert.ok(capturedOptions, "spawn must have been called");
  assert.equal(
    capturedOptions!.windowsHide,
    true,
    "spawn options must include windowsHide: true to prevent console window flashing on Windows (#2628)",
  );
});

test("launchWebMode source-dev host also passes windowsHide: true", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-web-winhide-src-"));
  const webRoot = join(tmp, "web");
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(webRoot, "package.json"), '{"name":"web"}\n');

  const pidFilePath = join(tmp, "web-server.pid");
  const registryPath = join(tmp, "web-instances.json");

  let capturedOptions: Record<string, unknown> | undefined;

  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const status = await webMode.launchWebMode(
    {
      cwd: "/tmp/winhide-src-project",
      projectSessionsDir: "/tmp/.gsd/sessions/winhide-src",
      agentDir: "/tmp/.gsd/agent",
      packageRoot: tmp,
    },
    {
      initResources: () => {},
      resolvePort: async () => 46001,
      execPath: "/custom/node",
      env: { TEST_ENV: "1" },
      platform: "win32",
      spawn: (_command, _args, options) => {
        capturedOptions = options as Record<string, unknown>;
        return {
          pid: 70002,
          once: () => undefined,
          unref: () => {},
        } as any;
      },
      waitForBootReady: async () => undefined,
      openBrowser: () => {},
      pidFilePath,
      writePidFile: webMode.writePidFile,
      registryPath,
      stderr: { write: () => true },
    },
  );

  assert.equal(status.ok, true, "launch should succeed");
  assert.ok(capturedOptions, "spawn must have been called");
  assert.equal(
    capturedOptions!.windowsHide,
    true,
    "source-dev spawn must also include windowsHide: true (#2628)",
  );
  assert.equal(
    capturedOptions!.shell,
    true,
    "source-dev spawn must include shell: true when launching npm.cmd on Windows",
  );
});
