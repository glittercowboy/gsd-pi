import {
	TUI_KEYBINDINGS,
	type Keybinding,
	type KeybindingsConfig as EditorKeybindingsConfig,
	KeybindingsManager as EditorKeybindingsManager,
	type KeyId,
	matchesKey,
	setKeybindings as setEditorKeybindings,
} from "@gsd/pi-tui";

// EditorAction is the union of all dotted TUI keybinding IDs (e.g. "tui.editor.cursorUp").
// Phase 09: move to @gsd/agent-types.
type EditorAction = Keybinding;
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@gsd/pi-coding-agent";

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

/**
 * All configurable actions.
 */
export type KeyAction = AppAction | EditorAction;

/**
 * Full keybindings configuration (app + editor actions).
 */
export type KeybindingsConfig = {
	[K in KeyAction]?: KeyId | KeyId[];
};

/**
 * Default application keybindings.
 */
const DEFAULT_APP_KEYBINDINGS: Record<AppAction, KeyId | KeyId[]> = {
	interrupt: "escape",
	clear: "ctrl+c",
	exit: "ctrl+d",
	suspend: "ctrl+z",
	cycleThinkingLevel: "shift+tab",
	cycleModelForward: "ctrl+p",
	cycleModelBackward: "shift+ctrl+p",
	selectModel: "ctrl+l",
	expandTools: "ctrl+o",
	toggleThinking: "ctrl+t",
	toggleSessionNamedFilter: "ctrl+n",
	externalEditor: "ctrl+g",
	followUp: "alt+enter",
	dequeue: "alt+up",
	pasteImage: process.platform === "win32" ? "alt+v" : ["ctrl+v", "alt+v"],
	newSession: [],
	tree: [],
	fork: [],
	resume: [],
};

/**
 * All default keybindings (app + editor).
 * TUI_KEYBINDINGS provides defaults for the editor actions; map to first default key.
 */
const DEFAULT_EDITOR_KEYBINDING_DEFAULTS: Partial<Record<EditorAction, KeyId | KeyId[]>> = Object.fromEntries(
	Object.entries(TUI_KEYBINDINGS).map(([k, v]) => [k, v.defaultKeys]),
) as Partial<Record<EditorAction, KeyId | KeyId[]>>;

const DEFAULT_KEYBINDINGS: Required<KeybindingsConfig> = {
	...DEFAULT_EDITOR_KEYBINDING_DEFAULTS,
	...DEFAULT_APP_KEYBINDINGS,
} as Required<KeybindingsConfig>;

// App actions list for type checking
const APP_ACTIONS: AppAction[] = [
	"interrupt",
	"clear",
	"exit",
	"suspend",
	"cycleThinkingLevel",
	"cycleModelForward",
	"cycleModelBackward",
	"selectModel",
	"expandTools",
	"toggleThinking",
	"toggleSessionNamedFilter",
	"externalEditor",
	"followUp",
	"dequeue",
	"pasteImage",
	"newSession",
	"tree",
	"fork",
	"resume",
];

function isAppAction(action: string): action is AppAction {
	return APP_ACTIONS.includes(action as AppAction);
}

/**
 * Manages all keybindings (app + editor).
 */
export class KeybindingsManager {
	private config: KeybindingsConfig;
	private appActionToKeys: Map<AppAction, KeyId[]>;

	private constructor(config: KeybindingsConfig) {
		this.config = config;
		this.appActionToKeys = new Map();
		this.buildMaps();
	}

	/**
	 * Create from config file and set up editor keybindings.
	 */
	static create(agentDir: string = getAgentDir()): KeybindingsManager {
		const configPath = join(agentDir, "keybindings.json");
		const config = KeybindingsManager.loadFromFile(configPath);
		const manager = new KeybindingsManager(config);

		// Set up editor keybindings globally.
		// Include both editor actions and expandTools (shared between app and editor).
		// 0.67.2 KeybindingsManager takes (definitions, userBindings) where definitions
		// is the full keybinding definition map (TUI_KEYBINDINGS) and userBindings
		// are the user overrides (EditorKeybindingsConfig).
		const editorConfig: EditorKeybindingsConfig = {};
		for (const [action, keys] of Object.entries(config)) {
			if (!isAppAction(action) || action === "expandTools") {
				editorConfig[action as EditorAction] = keys;
			}
		}
		setEditorKeybindings(new EditorKeybindingsManager(TUI_KEYBINDINGS, editorConfig));

		return manager;
	}

	/**
	 * Create in-memory.
	 */
	static inMemory(config: KeybindingsConfig = {}): KeybindingsManager {
		return new KeybindingsManager(config);
	}

	private static loadFromFile(path: string): KeybindingsConfig {
		if (!existsSync(path)) return {};
		try {
			return JSON.parse(readFileSync(path, "utf-8"));
		} catch {
			return {};
		}
	}

	private buildMaps(): void {
		this.appActionToKeys.clear();

		// Set defaults for app actions
		for (const [action, keys] of Object.entries(DEFAULT_APP_KEYBINDINGS)) {
			const keyArray = Array.isArray(keys) ? keys : [keys];
			this.appActionToKeys.set(action as AppAction, [...keyArray]);
		}

		// Override with user config (app actions only)
		for (const [action, keys] of Object.entries(this.config)) {
			if (keys === undefined || !isAppAction(action)) continue;
			const keyArray = Array.isArray(keys) ? keys : [keys];
			this.appActionToKeys.set(action, keyArray);
		}
	}

	/**
	 * Check if input matches an app action.
	 */
	matches(data: string, action: AppAction): boolean {
		const keys = this.appActionToKeys.get(action);
		if (!keys) return false;
		for (const key of keys) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}

	/**
	 * Get keys bound to an app action.
	 */
	getKeys(action: AppAction): KeyId[] {
		return this.appActionToKeys.get(action) ?? [];
	}

	/**
	 * Get the full effective config.
	 */
	getEffectiveConfig(): Required<KeybindingsConfig> {
		const result = { ...DEFAULT_KEYBINDINGS };
		for (const [action, keys] of Object.entries(this.config)) {
			if (keys !== undefined) {
				(result as KeybindingsConfig)[action as KeyAction] = keys;
			}
		}
		return result;
	}
}

// Re-export for convenience
export type { EditorAction, KeyId };
