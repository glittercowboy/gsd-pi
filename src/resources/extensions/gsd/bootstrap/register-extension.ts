// GSD2 — Extension registration: wires all GSD tools, commands, and hooks into pi

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { registerExitCommand } from "../exit-command.js";
import { registerLazyWorktreeCommands } from "../worktree-command-bootstrap.js";
import type { GSDEcosystemBeforeAgentStartHandler } from "../ecosystem/gsd-extension-api.js";
import { registerDbTools } from "./db-tools.js";
import { registerDynamicTools } from "./dynamic-tools.js";
import { registerExecTools } from "./exec-tools.js";
import { registerJournalTools } from "./journal-tools.js";
import { registerMemoryTools } from "./memory-tools.js";
import { registerQueryTools } from "./query-tools.js";
import { registerHooks } from "./register-hooks.js";
import { registerShortcuts } from "./register-shortcuts.js";
import { writeCrashLog } from "./crash-log.js";
import { logWarning } from "../workflow-logger.js";
// Static import so cmux event listeners are registered synchronously during
// extension bootstrap. Prior implementation used `void import().then()` which
// queued listener registration as a microtask — any CMUX_CHANNELS emit fired
// in the same event loop turn as registration (e.g. from a provider-error
// session hook calling startAuto) would be silently dropped because Node's
// EventEmitter does not buffer events for late subscribers.
import { initCmuxEventListeners } from "../../cmux/index.js";

export { writeCrashLog } from "./crash-log.js";

export function handleRecoverableExtensionProcessError(err: Error): boolean {
  if ((err as NodeJS.ErrnoException).code === "EPIPE") {
    process.exit(0);
  }
  if ((err as NodeJS.ErrnoException).code === "ENOENT") {
    const syscall = (err as NodeJS.ErrnoException).syscall;
    if (syscall?.startsWith("spawn")) {
      process.stderr.write(`[gsd] spawn ENOENT: ${(err as any).path ?? "unknown"} — command not found\n`);
      return true;
    }
    if (syscall === "uv_cwd") {
      process.stderr.write(`[gsd] ENOENT (${syscall}): ${err.message}\n`);
      return true;
    }
  }
  return false;
}

function installEpipeGuard(): void {
  if (!process.listeners("uncaughtException").some((listener) => listener.name === "_gsdEpipeGuard")) {
    const _gsdEpipeGuard = (err: Error): void => {
      if (handleRecoverableExtensionProcessError(err)) return;
      // Write crash log and exit cleanly for unrecoverable errors.
      // Logging and continuing was the original double-fault fix (#3163), but
      // continuing in an indeterminate state is worse than a clean exit (#3348).
      writeCrashLog(err, "uncaughtException");
      process.exit(1);
    };
    process.on("uncaughtException", _gsdEpipeGuard);
  }

  if (!process.listeners("unhandledRejection").some((listener) => listener.name === "_gsdRejectionGuard")) {
    const _gsdRejectionGuard = (reason: unknown, _promise: Promise<unknown>): void => {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      if (handleRecoverableExtensionProcessError(err)) return;
      writeCrashLog(err, "unhandledRejection");
      process.exit(1);
    };
    process.on("unhandledRejection", _gsdRejectionGuard);
  }
}

export function registerGsdExtension(pi: ExtensionAPI): void {
  // Note: registerGSDCommand is called by index.ts before this function,
  // so we intentionally skip it here to avoid double-registration.
  registerLazyWorktreeCommands(pi);
  registerExitCommand(pi);

  // Wire the Layer 2 event emitter bridge so deeply-nested GSD code can emit
  // extension events (git lifecycle, verify, budget, milestone, unit) without
  // threading `pi` through every call site.
  import("../hook-emitter.js")
    .then(({ setHookEmitter }) => setHookEmitter(pi))
    .catch((err) => {
      // Non-fatal — emitters simply become no-ops if this import fails, but
      // surface the failure so silent bootstrap breakage is debuggable.
      process.stderr.write(
        `[gsd] Failed to bootstrap hook-emitter bridge: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
    });

  installEpipeGuard();

  // Ecosystem handlers captured by the GSDExtensionAPI wrapper for the
  // GSD-owned `before_agent_start` dispatch step (#3338).
  const ecosystemHandlers: GSDEcosystemBeforeAgentStartHandler[] = [];

  pi.registerCommand("kill", {
    description: "Exit GSD immediately (no cleanup)",
    handler: async (_args: string, _ctx: ExtensionCommandContext) => {
      process.exit(0);
    },
  });

  // Wrap non-critical registrations individually so one failure
  // doesn't prevent the others from loading.
  const nonCriticalRegistrations: Array<[string, () => void]> = [
    ["dynamic-tools", () => registerDynamicTools(pi)],
    ["db-tools", () => registerDbTools(pi)],
    ["journal-tools", () => registerJournalTools(pi)],
    ["query-tools", () => registerQueryTools(pi)],
    ["memory-tools", () => registerMemoryTools(pi)],
    ["exec-tools", () => registerExecTools(pi)],
    ["shortcuts", () => registerShortcuts(pi)],
    // cmux is a library (no pi), so gsd sets up the event listeners on its
    // behalf using the shared event channel contract. Registration is
    // synchronous — see the import comment above for the rationale.
    ["cmux-events", () => initCmuxEventListeners(pi.events)],
    ["hooks", () => registerHooks(pi, ecosystemHandlers)],
    ["ecosystem", () => {
      void import("../ecosystem/loader.js")
        .then(({ loadEcosystemExtensions }) => loadEcosystemExtensions(pi, ecosystemHandlers))
        .catch((err) => {
          logWarning(
            "ecosystem",
            `loader failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }],
  ];

  for (const [name, register] of nonCriticalRegistrations) {
    try {
      register();
    } catch (err) {
      logWarning(
        "bootstrap",
        `Failed to register ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
