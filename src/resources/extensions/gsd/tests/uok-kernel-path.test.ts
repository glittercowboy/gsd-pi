import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import { runAutoLoopWithUok } from "../uok/kernel.ts";
import type { AutoSession } from "../auto/session.ts";
import type { LoopDeps } from "../auto/loop-deps.ts";
import { gsdRoot } from "../paths.ts";
import type { GSDPreferences } from "../preferences.ts";

function makeBasePath(): string {
  return mkdtempSync(join(tmpdir(), "gsd-uok-kernel-"));
}

function makeArgs(
  basePath: string,
  preferences: GSDPreferences | undefined,
): {
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  s: AutoSession;
  deps: LoopDeps;
  runKernelLoop: (
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    s: AutoSession,
    deps: LoopDeps,
  ) => Promise<void>;
  runLegacyLoop: (
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    s: AutoSession,
    deps: LoopDeps,
  ) => Promise<void>;
  calls: {
    kernel: number;
    legacy: number;
    kernelDeps: LoopDeps | null;
    legacyDeps: LoopDeps | null;
  };
} {
  const calls = {
    kernel: 0,
    legacy: 0,
    kernelDeps: null as LoopDeps | null,
    legacyDeps: null as LoopDeps | null,
  };

  return {
    ctx: {
      sessionManager: {
        getSessionId: (): string => "session-test",
      },
    } as unknown as ExtensionContext,
    pi: {} as unknown as ExtensionAPI,
    s: {
      basePath,
      autoStartTime: 1,
    } as unknown as AutoSession,
    deps: {
      loadEffectiveGSDPreferences: () => ({ preferences }),
    } as unknown as LoopDeps,
    runKernelLoop: async (_ctx, _pi, _s, loopDeps): Promise<void> => {
      calls.kernel += 1;
      calls.kernelDeps = loopDeps;
    },
    runLegacyLoop: async (_ctx, _pi, _s, loopDeps): Promise<void> => {
      calls.legacy += 1;
      calls.legacyDeps = loopDeps;
    },
    calls,
  };
}

function readParityEvents(basePath: string): Array<Record<string, unknown>> {
  const file = join(gsdRoot(basePath), "runtime", "uok-parity.jsonl");
  const raw = readFileSync(file, "utf-8").trim();
  if (raw.length === 0) return [];
  return raw.split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
}

test("runAutoLoopWithUok uses kernel path by default and records uok-kernel parity", async () => {
  const basePath = makeBasePath();
  try {
    const args = makeArgs(basePath, {
      uok: {
        enabled: true,
        audit_unified: { enabled: false },
        gitops: { enabled: false },
      },
    });
    await runAutoLoopWithUok(args);

    assert.equal(args.calls.kernel, 1);
    assert.equal(args.calls.legacy, 0);
    assert.ok(args.calls.kernelDeps);
    assert.notEqual(args.calls.kernelDeps, args.deps);
    assert.ok(args.calls.kernelDeps?.uokObserver);
    assert.equal(process.env.GSD_UOK_AUDIT_UNIFIED, "0");

    const events = readParityEvents(basePath);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.path, "uok-kernel");
    assert.equal(events[0]?.phase, "enter");
    assert.equal(events[1]?.path, "uok-kernel");
    assert.equal(events[1]?.phase, "exit");
    assert.equal(events[1]?.status, "ok");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("runAutoLoopWithUok uses legacy path when explicit legacy fallback is enabled", async () => {
  const basePath = makeBasePath();
  try {
    const args = makeArgs(basePath, {
      uok: {
        enabled: true,
        legacy_fallback: { enabled: true },
      },
    });
    await runAutoLoopWithUok(args);

    assert.equal(args.calls.kernel, 0);
    assert.equal(args.calls.legacy, 1);
    assert.equal(args.calls.legacyDeps, args.deps);

    const events = readParityEvents(basePath);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.path, "legacy-fallback");
    assert.equal(events[1]?.path, "legacy-fallback");
    assert.equal(events[1]?.status, "ok");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("runAutoLoopWithUok respects GSD_UOK_FORCE_LEGACY emergency switch", async () => {
  const basePath = makeBasePath();
  const previous = process.env.GSD_UOK_FORCE_LEGACY;
  process.env.GSD_UOK_FORCE_LEGACY = "1";
  try {
    const args = makeArgs(basePath, {
      uok: {
        enabled: true,
      },
    });
    await runAutoLoopWithUok(args);

    assert.equal(args.calls.kernel, 0);
    assert.equal(args.calls.legacy, 1);

    const events = readParityEvents(basePath);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.path, "legacy-fallback");
    assert.equal(events[1]?.path, "legacy-fallback");
  } finally {
    if (previous === undefined) delete process.env.GSD_UOK_FORCE_LEGACY;
    else process.env.GSD_UOK_FORCE_LEGACY = previous;
    rmSync(basePath, { recursive: true, force: true });
  }
});
