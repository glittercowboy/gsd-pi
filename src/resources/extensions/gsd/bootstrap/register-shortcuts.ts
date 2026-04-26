import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import { Key } from "@gsd/pi-tui";

import { GSD_SHORTCUTS } from "../shortcut-defs.js";
import { shortcutDesc } from "../../shared/mod.js";

async function getProjectRoot(): Promise<string> {
  const { projectRoot } = await import("../commands/context.js");
  return projectRoot();
}

export function registerShortcuts(pi: ExtensionAPI): void {
  const overlayOptions = {
    width: "90%",
    minWidth: 80,
    maxHeight: "92%",
    anchor: "center",
  } as const;

  const openDashboardOverlay = async (ctx: ExtensionContext) => {
    const [{ GSDDashboardOverlay }, basePath] = await Promise.all([
      import("../dashboard-overlay.js"),
      getProjectRoot(),
    ]);
    if (!existsSync(join(basePath, ".gsd"))) {
      ctx.ui.notify("No .gsd/ directory found. Run /gsd to start.", "info");
      return;
    }
    await ctx.ui.custom<boolean>(
      (tui, theme, _kb, done) => new GSDDashboardOverlay(tui, theme, () => done(true)),
      {
        overlay: true,
        overlayOptions,
      },
    );
  };

  const openNotificationsOverlay = async (ctx: ExtensionContext) => {
    const { GSDNotificationOverlay } = await import("../notification-overlay.js");
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
  };

  const openParallelOverlay = async (ctx: ExtensionContext) => {
    const basePath = await getProjectRoot();
    const parallelDir = join(basePath, ".gsd", "parallel");
    if (!existsSync(parallelDir)) {
      ctx.ui.notify("No parallel workers found. Run /gsd parallel start first.", "info");
      return;
    }
    const { ParallelMonitorOverlay } = await import("../parallel-monitor-overlay.js");
    await ctx.ui.custom<boolean>(
      (tui, theme, _kb, done) => new ParallelMonitorOverlay(tui, theme, () => done(true), basePath),
      {
        overlay: true,
        overlayOptions,
      },
    );
  };

  pi.registerShortcut(Key.ctrlAlt(GSD_SHORTCUTS.dashboard.key), {
    description: shortcutDesc(GSD_SHORTCUTS.dashboard.action, GSD_SHORTCUTS.dashboard.command),
    handler: openDashboardOverlay,
  });

  // Fallback for terminals where Ctrl+Alt letter chords are not forwarded reliably.
  pi.registerShortcut(Key.ctrlShift(GSD_SHORTCUTS.dashboard.key), {
    description: shortcutDesc(`${GSD_SHORTCUTS.dashboard.action} (fallback)`, GSD_SHORTCUTS.dashboard.command),
    handler: openDashboardOverlay,
  });

  pi.registerShortcut(Key.ctrlAlt(GSD_SHORTCUTS.notifications.key), {
    description: shortcutDesc(GSD_SHORTCUTS.notifications.action, GSD_SHORTCUTS.notifications.command),
    handler: openNotificationsOverlay,
  });

  // Fallback for terminals where Ctrl+Alt letter chords are not forwarded reliably.
  pi.registerShortcut(Key.ctrlShift(GSD_SHORTCUTS.notifications.key), {
    description: shortcutDesc(`${GSD_SHORTCUTS.notifications.action} (fallback)`, GSD_SHORTCUTS.notifications.command),
    handler: openNotificationsOverlay,
  });

  pi.registerShortcut(Key.ctrlAlt(GSD_SHORTCUTS.parallel.key), {
    description: shortcutDesc(GSD_SHORTCUTS.parallel.action, GSD_SHORTCUTS.parallel.command),
    handler: openParallelOverlay,
  });

  // No Ctrl+Shift+P fallback — conflicts with cycleModelBackward (shift+ctrl+p).
  // Use Ctrl+Alt+P or /gsd parallel watch instead.
}
