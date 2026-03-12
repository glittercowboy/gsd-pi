/**
 * Debounced recursive file watcher for .gsd/ directory.
 * Uses Bun/Node fs.watch with recursive: true and configurable debounce.
 */
import { watch, type FSWatcher } from "node:fs";
import type { WatcherOptions } from "./types";

/**
 * Creates a debounced file watcher that monitors a directory recursively.
 * Coalesces rapid file events into a single onChange callback with
 * the set of all changed filenames during the debounce window.
 *
 * Filters out:
 * - Files ending in ~ (editor backups)
 * - Files ending in .swp (vim swap files)
 * - .mission-control-session.json (session file)
 * - Dotfiles not under .gsd path
 */
export function createFileWatcher(options: WatcherOptions): { close: () => void } {
  const { planningDir, debounceMs = 50, onChange } = options;
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  let watcher: FSWatcher;
  try {
    watcher = watch(planningDir, { recursive: true }, (_eventType, filename) => {
      try {
        if (closed) return;
        if (!filename) return;

        // Normalize path separators to forward slashes
        const normalized = filename.replace(/\\/g, "/");

        // Filter out temp/swap files
        if (normalized.endsWith("~")) return;
        if (normalized.endsWith(".swp")) return;

        // Filter out session file
        if (normalized === ".mission-control-session.json") return;

        // Filter out dotfiles that are not under .gsd path
        const firstSegment = normalized.split("/")[0];
        if (firstSegment.startsWith(".") && !firstSegment.startsWith(".gsd")) return;

        pending.add(normalized);

        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (closed) return;
          const files = new Set(pending);
          pending.clear();
          timer = null;
          onChange(files);
        }, debounceMs);
      } catch {
        // Prevent crashes on weird filesystem events
      }
    });
  } catch (err) {
    // If watch fails to start, return a no-op closer
    console.error("[watcher] Failed to start file watcher:", err);
    return { close: () => {} };
  }

  return {
    close: () => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        watcher.close();
      } catch {
        // Ignore close errors
      }
    },
  };
}
