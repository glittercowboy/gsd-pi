import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Key } from "@gsd/pi-tui";

import { GSDDashboardOverlay } from "../dashboard-overlay.js";
import { shortcutDesc } from "../../shared/mod.js";

export function registerShortcuts(pi: ExtensionAPI): void {
  pi.registerShortcut(Key.ctrlAlt("g"), {
    description: shortcutDesc("Open GSD dashboard", "/gsd status"),
    handler: async (ctx) => {
      if (!existsSync(join(process.cwd(), ".gsd"))) {
        ctx.ui.notify("No .gsd/ directory found. Run /gsd to start.", "info");
        return;
      }
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => new GSDDashboardOverlay(tui, theme, () => done()),
        {
          overlay: true,
          overlayOptions: {
            width: "90%",
            minWidth: 80,
            maxHeight: "92%",
            anchor: "center",
          },
        },
      );
    },
  });
}
