import { importExtensionModule, type ExtensionAPI, type ExtensionCommandContext } from "@gsd/pi-coding-agent";

type StopAutoFn = (ctx: ExtensionCommandContext, pi: ExtensionAPI, reason?: string) => Promise<void>;

export function registerExitCommand(
  pi: ExtensionAPI,
  deps: { stopAuto?: StopAutoFn } = {},
): void {
  pi.registerCommand("exit", {
    description: "Exit GSD gracefully",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      // Stop auto-mode first so locks and activity state are cleaned up before shutdown.
      const stopAuto = deps.stopAuto ?? (await importExtensionModule<typeof import("./auto.js")>(import.meta.url, "./auto.js")).stopAuto;
      await stopAuto(ctx, pi, "Graceful exit");
      ctx.shutdown();
    },
  });
}
