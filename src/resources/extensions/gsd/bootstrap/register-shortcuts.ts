import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Key } from "@gsd/pi-tui";

import { GSDDashboardOverlay } from "../dashboard-overlay.js";
import { GSDNotificationOverlay } from "../notification-overlay.js";
import { ParallelMonitorOverlay } from "../parallel-monitor-overlay.js";
import { projectRoot } from "../commands/context.js";
import { shortcutDesc } from "../../shared/mod.js";

export function registerShortcuts(pi: ExtensionAPI): void {
  pi.registerShortcut(Key.ctrlAlt("g"), {
    description: shortcutDesc("Open GSD dashboard", "/gsd status"),
    handler: async (ctx) => {
      const basePath = projectRoot();
      if (!existsSync(join(basePath, ".gsd"))) {
        ctx.ui.notify("No .gsd/ directory found. Run /gsd to start.", "info");
        return;
      }
      await ctx.ui.custom<boolean>(
        (tui, theme, _kb, done) => new GSDDashboardOverlay(tui, theme, () => done(true)),
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

  pi.registerShortcut(Key.ctrlAlt("n"), {
    description: shortcutDesc("Open notification history", "/gsd notifications"),
    handler: async (ctx) => {
      await ctx.ui.custom<boolean>(
        (tui, theme, _kb, done) => new GSDNotificationOverlay(tui, theme, () => done(true)),
        {
          overlay: true,
          overlayOptions: {
            width: "80%",
            minWidth: 60,
            maxHeight: "88%",
            anchor: "center",
            backdrop: true,
          },
        },
      );
    },
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: shortcutDesc("Open parallel worker monitor", "/gsd parallel watch"),
    handler: async (ctx) => {
      const basePath = projectRoot();
      const parallelDir = join(basePath, ".gsd", "parallel");
      if (!existsSync(parallelDir)) {
        ctx.ui.notify("No parallel workers found. Run /gsd parallel start first.", "info");
        return;
      }
      await ctx.ui.custom<boolean>(
        (tui, theme, _kb, done) => new ParallelMonitorOverlay(tui, theme, () => done(true)),
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
