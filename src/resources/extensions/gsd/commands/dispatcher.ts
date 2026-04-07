import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { isAutoActive, isAutoPaused } from "../auto.js";
import { withSpan, GSD } from "../tracing/index.js";
import { handleAutoCommand } from "./handlers/auto.js";
import { handleCoreCommand } from "./handlers/core.js";
import { handleOpsCommand } from "./handlers/ops.js";
import { handleParallelCommand } from "./handlers/parallel.js";
import { handleWorkflowCommand } from "./handlers/workflow.js";

export async function handleGSDCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const trimmed = (typeof args === "string" ? args : "").trim();
  const commandName = trimmed.split(/\s+/)[0] || "next";
  const commandArgs = trimmed.slice(commandName.length).trim();

  return withSpan("gsd.command", async (span) => {
    span.setAttribute(GSD.COMMAND_NAME, commandName);
    if (commandArgs) span.setAttribute(GSD.COMMAND_ARGS, commandArgs);

    const autoState = isAutoActive() ? "active" : isAutoPaused() ? "paused" : "idle";
    span.setAttribute(GSD.COMMAND_AUTO_STATE, autoState);

    const handlers: Array<[string, () => Promise<boolean>]> = [
      ["core",     () => handleCoreCommand(trimmed, ctx)],
      ["auto",     () => handleAutoCommand(trimmed, ctx, pi)],
      ["parallel", () => handleParallelCommand(trimmed, ctx, pi)],
      ["workflow", () => handleWorkflowCommand(trimmed, ctx, pi)],
      ["ops",      () => handleOpsCommand(trimmed, ctx, pi)],
    ];

    for (const [group, handler] of handlers) {
      if (await handler()) {
        span.setAttribute(GSD.COMMAND_HANDLER, group);
        return;
      }
    }

    span.setAttribute(GSD.COMMAND_HANDLER, "unknown");
    ctx.ui.notify(`Unknown: /gsd ${trimmed}. Run /gsd help for available commands.`, "warning");
  });
}
