import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const gsdDir = resolve(import.meta.dirname, "..");

function readGsdFile(relativePath: string): string {
  return readFileSync(resolve(gsdDir, relativePath), "utf-8");
}

test("command entrypoints use startAutoDetached instead of awaiting startAuto (#3733)", () => {
  const autoHandlerSrc = readGsdFile("commands/handlers/auto.ts");
  const workflowHandlerSrc = readGsdFile("commands/handlers/workflow.ts");
  const guidedFlowSrc = readGsdFile("guided-flow.ts");

  assert.ok(
    !autoHandlerSrc.includes("await startAuto("),
    "auto command handler should not await startAuto from the active agent turn",
  );
  assert.ok(
    !workflowHandlerSrc.includes("await startAuto("),
    "workflow command handler should not await startAuto from the active agent turn",
  );
  assert.ok(
    !guidedFlowSrc.includes("await startAuto("),
    "guided flow should not await startAuto from the active agent turn",
  );

  assert.ok(
    autoHandlerSrc.includes("startAutoDetached("),
    "auto command handler should launch auto-mode through startAutoDetached",
  );
  assert.ok(
    workflowHandlerSrc.includes("startAutoDetached("),
    "workflow handler should launch auto-mode through startAutoDetached",
  );
  assert.ok(
    guidedFlowSrc.includes("startAutoDetached("),
    "guided flow should launch auto-mode through startAutoDetached",
  );
});

test("startAutoDetached reports failures asynchronously (#3733)", () => {
  const autoSrc = readGsdFile("auto.ts");

  assert.ok(
    autoSrc.includes("export function startAutoDetached"),
    "auto.ts should export startAutoDetached",
  );
  assert.ok(
    autoSrc.includes("void startAuto(ctx, pi, base, verboseMode, options).catch"),
    "startAutoDetached should launch startAuto without awaiting it",
  );
  assert.ok(
    autoSrc.includes("ctx.ui.notify(`Auto-start failed: ${message}`, \"error\")"),
    "startAutoDetached should surface async startup failures to the user",
  );
});

test("detached auto-start preserves milestone lock across pause/stop cleanup (#3733)", () => {
  const autoSrc = readGsdFile("auto.ts");
  const sessionSrc = readGsdFile("auto/session.ts");

  assert.ok(
    autoSrc.includes("milestoneLock?: string | null"),
    "startAuto/startAutoDetached options should carry an explicit milestone lock",
  );
  assert.ok(
    autoSrc.includes("s.sessionMilestoneLock = options.milestoneLock ?? null;"),
    "startAuto should capture the requested milestone lock before async work begins",
  );
  assert.ok(
    autoSrc.includes("milestoneLock: s.sessionMilestoneLock ?? undefined"),
    "pause metadata should persist the detached milestone lock for resume",
  );
  assert.ok(
    autoSrc.includes("s.sessionMilestoneLock = meta.milestoneLock ?? null;"),
    "resume should restore the persisted milestone lock",
  );
  assert.ok(
    autoSrc.includes("restoreMilestoneLockEnv();"),
    "auto cleanup should restore the previous process milestone-lock env",
  );

  assert.ok(
    sessionSrc.includes("sessionMilestoneLock: string | null = null;"),
    "AutoSession should track the detached milestone lock explicitly",
  );
});
