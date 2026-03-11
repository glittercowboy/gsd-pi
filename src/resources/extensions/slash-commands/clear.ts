import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export default function clearCommand(pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Alias for /new — start a new session",
    async handler(_args: string, ctx: ExtensionCommandContext) {
      await ctx.newSession();
    },
  });
}
