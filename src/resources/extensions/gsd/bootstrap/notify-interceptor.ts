// GSD Extension — Notify Interceptor
// Wraps ctx.ui.notify() in-place to persist every notification through the
// notification store. Uses a WeakSet to prevent double-wrapping and handle
// UI context replacement on /reload gracefully.

import type { ExtensionContext } from "@gsd/pi-coding-agent";

import { appendNotification, type NotifySeverity } from "../notification-store.js";

// Track which ui context objects have been wrapped to prevent double-install.
// WeakSet allows GC to collect replaced uiContext instances after /reload.
const _wrappedContexts = new WeakSet<object>();

/**
 * Install the notify interceptor on a context's UI object.
 * Mutates ctx.ui.notify in place — the original is called after persistence.
 * Safe to call multiple times; no-ops if already installed on the same ui object.
 */
export function installNotifyInterceptor(ctx: ExtensionContext): void {
  if (_wrappedContexts.has(ctx.ui)) return;

  const originalNotify = ctx.ui.notify.bind(ctx.ui);

  (ctx.ui as any).notify = (message: string, type?: "info" | "warning" | "error" | "success"): void => {
    try {
      appendNotification(message, (type ?? "info") as NotifySeverity, "notify");
    } catch {
      // Non-fatal — never let persistence break the UI
    }
    originalNotify(message, type);
  };

  _wrappedContexts.add(ctx.ui);
}
