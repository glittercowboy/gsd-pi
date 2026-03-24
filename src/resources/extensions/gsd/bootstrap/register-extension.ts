import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { registerGSDCommand } from "../commands.js";
import { registerExitCommand } from "../exit-command.js";
import { registerWorktreeCommand } from "../worktree-command.js";
import { registerDbTools } from "./db-tools.js";
import { registerDynamicTools } from "./dynamic-tools.js";
import { registerJournalTools } from "./journal-tools.js";
import { registerHooks } from "./register-hooks.js";
import { registerShortcuts } from "./register-shortcuts.js";

function installEpipeGuard(): void {
  if (!process.listeners("uncaughtException").some((listener) => listener.name === "_gsdEpipeGuard")) {
    const _gsdEpipeGuard = (err: Error): void => {
      if ((err as NodeJS.ErrnoException).code === "EPIPE") {
        process.exit(0);
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && (err as any).syscall?.startsWith("spawn")) {
        process.stderr.write(`[gsd] spawn ENOENT: ${(err as any).path ?? "unknown"} — command not found\n`);
        return;
      }
      throw err;
    };
    process.on("uncaughtException", _gsdEpipeGuard);
  }
}

export function registerGsdExtension(pi: ExtensionAPI): void {
  registerGSDCommand(pi);
  registerWorktreeCommand(pi);
  registerExitCommand(pi);

  installEpipeGuard();

  pi.registerCommand("kill", {
    description: "Exit GSD immediately (no cleanup)",
    handler: async (_args: string, _ctx: ExtensionCommandContext) => {
      process.exit(0);
    },
  });

  registerDynamicTools(pi);
  registerDbTools(pi);
  registerJournalTools(pi);
  registerShortcuts(pi);
  registerHooks(pi);
}

