/**
 * TUI session selector for --resume flag
 */

import { ProcessTerminal, TUI } from "@gsd/pi-tui";
import { KeybindingsManager } from "@gsd/agent-core";
import {
	SessionSelectorComponent,
	type KeybindingsManager as PiKeybindingsManager,
} from "@gsd/pi-coding-agent";
import type { SessionInfo } from "@gsd/agent-types";

// SessionListProgress is not exported from pi-coding-agent index in 0.67.2
type SessionListProgress = (loaded: number, total: number) => void;

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

/** Show TUI session selector and return selected session path or null if cancelled */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
): Promise<string | null> {
	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal());
		const keybindings = KeybindingsManager.create();
		let resolved = false;

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			(path: string) => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(path);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
			() => {
				ui.stop();
				process.exit(0);
			},
			() => ui.requestRender(),
			// vendor-seam: dual-module-path -- KeybindingsManager resolves to different nominal types
			// between @gsd/agent-core and @gsd/pi-coding-agent; structurally identical at runtime.
			{ showRenameHint: false, keybindings: keybindings as unknown as PiKeybindingsManager },
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		ui.start();
	});
}
