import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export function registerExitCommand(pi: Pick<ExtensionAPI, "registerCommand">): void {
  pi.registerCommand("exit", {
    description: "Exit GSD gracefully",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.shutdown();
    },
  });
}
