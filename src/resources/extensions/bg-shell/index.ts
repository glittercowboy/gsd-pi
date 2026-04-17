/**
 * Background Shell Extension v2
 *
 * Command/tool registration is deferred in interactive mode so startup does not
 * block on the full background-process stack before the TUI paints.
 */

import { type ExtensionAPI, type ExtensionContext } from "@gsd/pi-coding-agent";
import { importExtensionModule } from "@gsd/agent-core";
import { registerBgShellLifecycle } from "./bg-shell-lifecycle.js";

export interface BgShellSharedState {
  latestCtx: ExtensionContext | null;
  refreshWidget: () => void;
}

let featuresPromise: Promise<void> | null = null;

async function registerBgShellFeatures(pi: ExtensionAPI, state: BgShellSharedState): Promise<void> {
  if (!featuresPromise) {
    featuresPromise = (async () => {
      const [{ registerBgShellTool }, { registerBgShellCommand }] = await Promise.all([
        importExtensionModule<typeof import("./bg-shell-tool.js")>(import.meta.url, "./bg-shell-tool.js"),
        importExtensionModule<typeof import("./bg-shell-command.js")>(import.meta.url, "./bg-shell-command.js"),
      ]);
      registerBgShellTool(pi, state);
      registerBgShellCommand(pi, state);
    })().catch((error) => {
      featuresPromise = null;
      throw error;
    });
  }

  return featuresPromise;
}

export default function (pi: ExtensionAPI) {
  const state: BgShellSharedState = {
    latestCtx: null,
    refreshWidget: () => {},
  };

  registerBgShellLifecycle(pi, state);

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      void registerBgShellFeatures(pi, state).catch((error) => {
        ctx.ui.notify(`bg-shell failed to load: ${error instanceof Error ? error.message : String(error)}`, "warning");
      });
      return;
    }

    await registerBgShellFeatures(pi, state);
  });
}
