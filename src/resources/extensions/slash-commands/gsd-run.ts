import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export default function gsdRun(pi: ExtensionAPI) {
  pi.registerCommand("gsd-run", {
    description: "Read GSD-WORKFLOW.md and execute — lightweight protocol-driven GSD",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const workflowPath = process.env.GSD_WORKFLOW_PATH ?? join(process.env.HOME ?? "~", ".pi", "GSD-WORKFLOW.md");

      let workflow: string;
      try {
        workflow = readFileSync(workflowPath, "utf-8");
      } catch {
        ctx.ui.notify(`Cannot read ${workflowPath}`, "error");
        return;
      }

      const userNote = (typeof args === "string" ? args : "").trim();
      const noteSection = userNote
        ? `\n\n## User Note\n\n${userNote}\n`
        : "";

      pi.sendMessage(
        {
          customType: "gsd-run",
          content: `Read the following GSD workflow protocol and execute exactly.\n\n${workflow}${noteSection}`,
          display: false,
        },
        { triggerTurn: true },
      );
    },
  });
}
