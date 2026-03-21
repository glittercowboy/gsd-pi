import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { checkRemoteAutoSession, isAutoActive, isAutoPaused, stopAutoRemote } from "../auto.js";
import { assertSafeDirectory } from "../validate-directory.js";
import { resolveProjectRoot } from "../worktree.js";
import { showNextAction } from "../../shared/tui.js";
import { handleStatus } from "./handlers/core.js";

export interface GsdDispatchContext {
  ctx: ExtensionCommandContext;
  pi: ExtensionAPI;
  trimmed: string;
}

export function projectRoot(): string {
  const cwd = process.cwd();
  const root = resolveProjectRoot(cwd);
  if (root !== cwd) {
    assertSafeDirectory(cwd);
  } else {
    assertSafeDirectory(root);
  }
  return root;
}

export async function guardRemoteSession(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<boolean> {
  if (isAutoActive() || isAutoPaused()) return true;

  const remote = checkRemoteAutoSession(projectRoot());
  if (!remote.running || !remote.pid) return true;

  const unitLabel = remote.unitType && remote.unitId
    ? `${remote.unitType} (${remote.unitId})`
    : "unknown unit";
  const unitsMsg = remote.completedUnits != null
    ? `${remote.completedUnits} units completed`
    : "";

  const choice = await showNextAction(ctx, {
    title: `Auto-mode is running in another terminal (PID ${remote.pid})`,
    summary: [
      `Currently executing: ${unitLabel}`,
      ...(unitsMsg ? [unitsMsg] : []),
      ...(remote.startedAt ? [`Started: ${remote.startedAt}`] : []),
    ],
    actions: [
      {
        id: "status",
        label: "View status",
        description: "Show the current GSD progress dashboard.",
        recommended: true,
      },
      {
        id: "steer",
        label: "Steer the session",
        description: "Use /gsd steer <instruction> to redirect the running session.",
      },
      {
        id: "stop",
        label: "Stop remote session",
        description: `Send SIGTERM to PID ${remote.pid} to stop it gracefully.`,
      },
      {
        id: "force",
        label: "Force start (steal lock)",
        description: "Start a new session, terminating the existing one.",
      },
    ],
    notYetMessage: "Run /gsd when ready.",
  });

  if (choice === "status") {
    await handleStatus(ctx);
    return false;
  }
  if (choice === "steer") {
    ctx.ui.notify(
      "Use /gsd steer <instruction> to redirect the running auto-mode session.\n" +
      "Example: /gsd steer Use Postgres instead of SQLite",
      "info",
    );
    return false;
  }
  if (choice === "stop") {
    const result = stopAutoRemote(projectRoot());
    if (result.found) {
      ctx.ui.notify(`Sent stop signal to auto-mode session (PID ${result.pid}). It will shut down gracefully.`, "info");
    } else if (result.error) {
      ctx.ui.notify(`Failed to stop remote auto-mode: ${result.error}`, "error");
    } else {
      ctx.ui.notify("Remote session is no longer running.", "info");
    }
    return false;
  }

  return choice === "force";
}

