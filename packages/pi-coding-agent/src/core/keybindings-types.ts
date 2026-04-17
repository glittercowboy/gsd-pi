/**
 * Type-only definitions extracted from keybindings.ts for use by the extension
 * system without pulling in the full keybindings implementation.
 *
 * This is a thin shim. keybindings.ts retains all implementation.
 */

/**
 * Application-level actions (coding agent specific).
 */
export type AppAction =
	| "interrupt"
	| "clear"
	| "exit"
	| "suspend"
	| "cycleThinkingLevel"
	| "cycleModelForward"
	| "cycleModelBackward"
	| "selectModel"
	| "expandTools"
	| "toggleThinking"
	| "toggleSessionNamedFilter"
	| "externalEditor"
	| "followUp"
	| "dequeue"
	| "pasteImage"
	| "newSession"
	| "tree"
	| "fork"
	| "resume";

// KeybindingsManager is a class — re-export as type to avoid duplicating the implementation.
export type { KeybindingsManager } from "@gsd/agent-core";
