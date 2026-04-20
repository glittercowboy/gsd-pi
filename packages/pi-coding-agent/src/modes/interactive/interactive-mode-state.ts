import type { AgentSessionEvent } from "../../core/agent-session.js";

export interface InteractiveModeStateHost {
	defaultEditor: any;
	editor: any;
	session: any;
	ui: any;
	footer: any;
	keybindings: any;
	statusContainer: any;
	chatContainer: any;
	pinnedMessageContainer: any;
	settingsManager: any;
	pendingTools: Map<string, any>;
	toolOutputExpanded: boolean;
	hideThinkingBlock: boolean;
	isBashMode: boolean;
	onInputCallback?: (text: string) => void;
	isInitialized: boolean;
	loadingAnimation?: any;
	pendingWorkingMessage?: string;
	defaultWorkingMessage: string;
	streamingComponent?: any;
	streamingMessage?: any;
	retryEscapeHandler?: () => void;
	retryLoader?: any;
	autoCompactionLoader?: any;
	autoCompactionEscapeHandler?: () => void;
	compactionQueuedMessages: Array<{ text: string; mode: "steer" | "followUp" }>;
	extensionSelector?: any;
	extensionInput?: any;
	extensionEditor?: any;
	editorContainer: any;
	keybindingsManager?: any;
}

export type InteractiveModeEvent = AgentSessionEvent;

