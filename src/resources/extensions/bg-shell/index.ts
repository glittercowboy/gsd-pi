/**
 * Background Shell Extension v2
 *
 * A next-generation background process manager designed for agentic workflows.
 * Provides intelligent process lifecycle management, structured output digests,
 * event-driven readiness detection, and context-efficient communication.
 *
 * Key capabilities:
 * - Multi-tier output: digest (30 tokens) → highlights → raw (full context)
 * - Readiness detection: port probing, pattern matching, auto-classification
 * - Process lifecycle events: starting → ready → error → exited
 * - Output diffing & dedup: detect novel errors vs. repeated noise
 * - Process groups: manage related processes as a unit
 * - Cross-session persistence: survive context resets
 * - Expect-style interactions: send_and_wait for interactive CLIs
 * - Context injection: proactive alerts for crashes and state changes
 *
 * Tools:
 *   bg_shell — start, output, digest, wait_for_ready, send, send_and_wait, run,
 *              signal, list, kill, restart, group_status
 *
 * Commands:
 *   /bg — interactive process manager overlay
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import { registerBgShellTool } from "./bg-shell-tool.js";
import { registerBgShellCommand } from "./bg-shell-command.js";
import { registerBgShellLifecycle } from "./bg-shell-lifecycle.js";

// ── Re-exports for consumers ───────────────────────────────────────────────

export type { ProcessStatus, ProcessType, BgProcess, BgProcessInfo, OutputDigest, OutputLine, ProcessEvent } from "./types.js";
export { processes, startProcess, killProcess, restartProcess, cleanupAll, cleanupSessionProcesses } from "./process-manager.js";
export { generateDigest, getHighlights, getOutput, formatDigestText } from "./output-formatter.js";
export { waitForReady, probePort } from "./readiness-detector.js";
export { sendAndWait, runOnSession, queryShellEnv } from "./interaction.js";
export { BgManagerOverlay } from "./overlay.js";

// ── Shared State ────────────────────────────────────────────────────────────

export interface BgShellSharedState {
	latestCtx: ExtensionContext | null;
	refreshWidget: () => void;
}

// ── Extension Entry Point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const state: BgShellSharedState = {
		latestCtx: null,
		refreshWidget: () => {},
	};

	registerBgShellLifecycle(pi, state);
	registerBgShellTool(pi, state);
	registerBgShellCommand(pi, state);
}
