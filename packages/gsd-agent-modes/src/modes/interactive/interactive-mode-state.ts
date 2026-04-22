import type { AgentSession, AgentSessionEvent } from "@gsd/agent-core";
import type { Container, EditorComponent, Loader, TUI } from "@gsd/pi-tui";
import type { FooterComponent } from "./components/footer.js";
import type { KeybindingsManager } from "@gsd/agent-core";
import type { AssistantMessage } from "@gsd/pi-ai";
import type { SettingsManager } from "@gsd/agent-types";
import type { AssistantMessageComponent } from "./components/assistant-message.js";
import type { ToolExecutionComponent } from "./components/tool-execution.js";
import type { CustomEditor } from "./components/custom-editor.js";
import type { ExtensionSelectorComponent } from "./components/extension-selector.js";
import type { ExtensionInputComponent } from "./components/extension-input.js";
import type { ExtensionEditorComponent } from "./components/extension-editor.js";

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
	settingsManager: SettingsManager;
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
}

export type InteractiveModeEvent = AgentSessionEvent;
