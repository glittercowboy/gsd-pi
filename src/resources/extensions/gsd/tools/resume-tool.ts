// GSD Resume Tool — returns the contents of .gsd/last-snapshot.md so
// agents can re-orient after compaction or session resume without
// re-deriving project memory state.

import { readCompactionSnapshot } from "../compaction-snapshot.js";

export interface ResumeToolParams {
  /** Ignored — reserved for future variant (e.g. dated snapshots). */
  _variant?: string;
}

export interface ToolExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

export function executeResume(
  _params: ResumeToolParams,
  opts: { baseDir: string },
): ToolExecutionResult {
  const snapshot = readCompactionSnapshot(opts.baseDir);
  if (snapshot == null) {
    return {
      content: [
        {
          type: "text",
          text:
            "No snapshot found at .gsd/last-snapshot.md. The snapshot is written automatically " +
            "on session_before_compact (enabled by default; set context_mode.enabled=false to opt out).",
        },
      ],
      details: { operation: "gsd_resume", found: false },
    };
  }
  return {
    content: [{ type: "text", text: snapshot }],
    details: { operation: "gsd_resume", found: true, bytes: Buffer.byteLength(snapshot, "utf-8") },
  };
}
