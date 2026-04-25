// GSD-2 — Deprecation stub for google-search (moved to @gsd-extensions/google-search)
import type { ExtensionAPI } from "@gsd/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      "google_search is being extracted to @gsd-extensions/google-search " +
      "(not yet published to npm). This stub will be replaced once the " +
      "package is available. No action needed for now.",
      "warning",
    );
  });
}
