import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { AutoSession } from "../auto/session.js";
import type { LoopDeps } from "../auto/loop-deps.js";
import { gsdRoot } from "../paths.js";
import { buildAuditEnvelope, emitUokAuditEvent } from "./audit.js";
import { setUnifiedAuditEnabled } from "./audit-toggle.js";
import { resolveUokFlags } from "./flags.js";
import { createTurnObserver } from "./loop-adapter.js";

interface RunAutoLoopWithUokArgs {
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
}

function parityLogPath(basePath: string): string {
  return join(gsdRoot(basePath), "runtime", "uok-parity.jsonl");
}

function writeParityEvent(basePath: string, event: Record<string, unknown>): void {
  try {
    mkdirSync(join(gsdRoot(basePath), "runtime"), { recursive: true });
    appendFileSync(parityLogPath(basePath), `${JSON.stringify(event)}\n`, "utf-8");
  } catch {
    // parity telemetry must never block orchestration
  }
}

function resolveKernelPathLabel(
  flags: ReturnType<typeof resolveUokFlags>,
): "uok-kernel" | "legacy-wrapper" | "legacy-fallback" {
  if (flags.legacyFallback) return "legacy-fallback";
  return flags.enabled ? "uok-kernel" : "legacy-wrapper";
}

export async function runAutoLoopWithUok(args: RunAutoLoopWithUokArgs): Promise<void> {
  const { ctx, pi, s, deps, runKernelLoop, runLegacyLoop } = args;
  const prefs = deps.loadEffectiveGSDPreferences()?.preferences;
  const flags = resolveUokFlags(prefs);
  setUnifiedAuditEnabled(flags.auditUnified);

  writeParityEvent(s.basePath, {
    ts: new Date().toISOString(),
    path: resolveKernelPathLabel(flags),
    flags,
    phase: "enter",
  });

  if (flags.auditUnified) {
    emitUokAuditEvent(
      s.basePath,
      buildAuditEnvelope({
        traceId: `session:${String(s.autoStartTime || Date.now())}`,
        category: "orchestration",
        type: "uok-kernel-enter",
        payload: {
          flags,
          sessionId: ctx.sessionManager?.getSessionId?.(),
        },
      }),
    );
  }

  const decoratedDeps: LoopDeps = flags.enabled
    ? {
        ...deps,
        uokObserver: createTurnObserver({
          basePath: s.basePath,
          gitAction: flags.gitopsTurnAction,
          gitPush: flags.gitopsTurnPush,
          enableAudit: flags.auditUnified,
          enableGitops: flags.gitops,
        }),
      }
    : deps;

  try {
    if (flags.enabled) {
      await runKernelLoop(ctx, pi, s, decoratedDeps);
    } else {
      await runLegacyLoop(ctx, pi, s, deps);
    }
    writeParityEvent(s.basePath, {
      ts: new Date().toISOString(),
      path: resolveKernelPathLabel(flags),
      flags,
      phase: "exit",
      status: "ok",
    });
  } catch (err) {
    writeParityEvent(s.basePath, {
      ts: new Date().toISOString(),
      path: resolveKernelPathLabel(flags),
      flags,
      phase: "exit",
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
