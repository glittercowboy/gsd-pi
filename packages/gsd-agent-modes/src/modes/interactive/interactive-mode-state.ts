import type { AgentSessionEvent } from "@gsd/agent-core";
import type { AgentSession, KeybindingsManager } from "@gsd/agent-core";
import type { AssistantMessage } from "@gsd/pi-ai";
import type { Container, EditorComponent, Loader, TUI } from "@gsd/pi-tui";
import type { AssistantMessageComponent } from "./components/assistant-message.js";
import type { CustomEditor } from "./components/custom-editor.js";
import type { ExtensionEditorComponent } from "./components/extension-editor.js";
import type { ExtensionInputComponent } from "./components/extension-input.js";
import type { ExtensionSelectorComponent } from "./components/extension-selector.js";
import type { FooterComponent } from "./components/footer.js";
import type { ToolExecutionComponent } from "./components/tool-execution.js";

export interface InteractiveModeStateHost {
	defaultEditor: CustomEditor;
	editor: EditorComponent;
	session: AgentSession;
	ui: TUI;
	footer: FooterComponent;
	keybindings: KeybindingsManager;
	statusContainer: Container;
	chatContainer: Container;
	pinnedMessageContainer: Container;
	settingsManager: AgentSession["settingsManager"];
	pendingTools: Map<string, ToolExecutionComponent>;
	toolOutputExpanded: boolean;
	hideThinkingBlock: boolean;
	isBashMode: boolean;
	onInputCallback?: (text: string) => void;
	isInitialized: boolean;
	loadingAnimation?: Loader;
	pendingWorkingMessage?: string;
	defaultWorkingMessage: string;
	streamingComponent?: AssistantMessageComponent;
	streamingMessage?: AssistantMessage;
	retryEscapeHandler?: () => void;
	retryLoader?: Loader;
	autoCompactionLoader?: Loader;
	autoCompactionEscapeHandler?: () => void;
	compactionQueuedMessages: Array<{ text: string; mode: "steer" | "followUp" }>;
	extensionSelector?: ExtensionSelectorComponent;
	extensionInput?: ExtensionInputComponent;
	extensionEditor?: ExtensionEditorComponent;
	editorContainer: Container;
	keybindingsManager?: KeybindingsManager;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	[key: string]: any;
}

export type InteractiveModeEvent = AgentSessionEvent;
