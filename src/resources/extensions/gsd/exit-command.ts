import { importExtensionModule, type ExtensionAPI, type ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { getErrorMessage } from "./error-utils.js";

type StopAutoFn = (ctx: ExtensionCommandContext, pi: ExtensionAPI, reason?: string) => Promise<void>;

export function registerExitCommand(
  pi: ExtensionAPI,
  deps: { stopAuto?: StopAutoFn } = {},
): void {
  pi.registerCommand("exit", {
    description: "Exit GSD gracefully",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      // Stop auto-mode first so locks and activity state are cleaned up before shutdown.
      // Wrapped in try/catch: if gsd-pi was updated on disk mid-session, the dynamic
      // import may resolve a new auto-worktree.js whose static imports reference
      // exports absent from the process-cached native-git-bridge.js (ESM cache is
      // immutable). The user's work is already saved — this is cleanup only.
      try {
        const stopAuto = deps.stopAuto ?? (await importExtensionModule<typeof import("./auto.js")>(import.meta.url, "./auto.js")).stopAuto;
        await stopAuto(ctx, pi, "Graceful exit");
      } catch (e) {
        const msg = getErrorMessage(e);
        ctx.ui?.notify?.(
          `Auto-mode cleanup skipped (module version mismatch): ${msg}`,
          "warning",
        );
      }
      ctx.shutdown();
    },
  });
}
