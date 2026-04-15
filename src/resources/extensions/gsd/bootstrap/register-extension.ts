// GSD2 — Extension registration: wires all GSD tools, commands, and hooks into pi

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { registerExitCommand } from "../exit-command.js";
import { registerWorktreeCommand } from "../worktree-command.js";
import type { GSDEcosystemBeforeAgentStartHandler } from "../ecosystem/gsd-extension-api.js";
import { loadEcosystemExtensions } from "../ecosystem/loader.js";
import { registerDbTools } from "./db-tools.js";
import { registerDynamicTools } from "./dynamic-tools.js";
import { registerJournalTools } from "./journal-tools.js";
import { registerQueryTools } from "./query-tools.js";
import { registerHooks } from "./register-hooks.js";
import { registerShortcuts } from "./register-shortcuts.js";
import { writeCrashLog } from "./crash-log.js";
import { logWarning } from "../workflow-logger.js";

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
  registerWorktreeCommand(pi);
  registerExitCommand(pi);

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
    ["shortcuts", () => registerShortcuts(pi)],
    ["hooks", () => registerHooks(pi, ecosystemHandlers)],
    ["ecosystem", () => {
      void loadEcosystemExtensions(pi, ecosystemHandlers).catch((err) => {
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
