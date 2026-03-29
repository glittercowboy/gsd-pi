// GSD-2 — Deprecation stub for google-search (moved to @gsd-extensions/google-search)
import type { ExtensionAPI } from "@gsd/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      "google_search has moved to @gsd-extensions/google-search. " +
      "Install: gsd extensions install @gsd-extensions/google-search",
      "warning",
    );
  });
}
