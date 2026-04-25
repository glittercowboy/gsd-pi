import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { checkRemoteAutoSession, isAutoActive, isAutoPaused, stopAutoRemote } from "../auto.js";
import { validateDirectory } from "../validate-directory.js";
import { resolveProjectRoot } from "../worktree.js";
import { showNextAction } from "../../shared/tui.js";
import { handleStatus } from "./handlers/core.js";

export interface GsdDispatchContext {
  ctx: ExtensionCommandContext;
  pi: ExtensionAPI;
  trimmed: string;
}

/**
 * Typed error for when GSD is run outside a valid project directory.
 * Command handlers catch this to show a friendly message instead of a raw exception.
 */
export class GSDNoProjectError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "GSDNoProjectError";
  }
}

export function projectRoot(): string {
  let cwd: string;
  try {
    cwd = process.cwd();
  } catch {
    // cwd directory was deleted (e.g. worktree teardown) — fall back to HOME (#3598)
    cwd = process.env.HOME ?? "/";
  }
  const root = resolveProjectRoot(cwd);
  const pathToCheck = root !== cwd ? cwd : root;
  const result = validateDirectory(pathToCheck);
  if (result.severity === "blocked") {
    throw new GSDNoProjectError(result.reason ?? "GSD must be run inside a project directory.");
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

  // In RPC/web bridge mode, interactive TUI prompts (showNextAction) block
  // forever because there is no terminal to answer them. Notify and bail.
  if (process.env.GSD_WEB_BRIDGE_TUI === "1") {
    ctx.ui.notify(
      `Another auto-mode session (PID ${remote.pid}) is running on this project (${unitLabel}). ` +
      `Stop it first with /gsd stop, or use /gsd steer to redirect it.`,
      "warning",
    );
    return false;
  }

  const choice = await showNextAction(ctx, {
    title: `Auto-mode is running in another terminal (PID ${remote.pid})`,
    summary: [
      `Currently executing: ${unitLabel}`,
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

