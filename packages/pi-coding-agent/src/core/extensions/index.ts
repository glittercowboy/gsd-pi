/**
 * Extension system for lifecycle events and custom tools.
 */

export type { ExtensionManifest } from "./extension-manifest.js";
export { readManifest, readManifestFromEntryPath } from "./extension-manifest.js";
export type { SortResult, SortWarning } from "./extension-sort.js";
export { sortExtensionPaths } from "./extension-sort.js";
export type { SlashCommandInfo, SlashCommandLocation, SlashCommandSource } from "../slash-commands.js";
export {
	createExtensionRuntime,
	discoverAndLoadExtensions,
	getUntrustedExtensionPaths,
	importExtensionModule,
	isProjectTrusted,
	loadExtensionFromFactory,
	loadExtensions,
	trustProject,
} from "./loader.js";
export type {
	ExtensionErrorListener,
	ForkHandler,
	NavigateTreeHandler,
	NewSessionHandler,
	ShutdownHandler,
	SwitchSessionHandler,
} from "./runner.js";
export { ExtensionRunner } from "./runner.js";
export type {
	AgentEndEvent,
	AgentStartEvent,
	// Re-exports
	AgentToolResult,
	AgentToolUpdateCallback,
	// App keybindings (for custom editors)
	AppAction,
	// Events - Tool (ToolCallEvent types)
	BashToolCallEvent,
	BashToolResultEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	// Context
	CompactOptions,
	// Events - Agent
	ContextEvent,
	// Event Results
	ContextEventResult,
	ContextUsage,
	CustomToolCallEvent,
	CustomToolResultEvent,
	EditToolCallEvent,
	EditToolResultEvent,
	ExecOptions,
	ExecResult,
	Extension,
	ExtensionActions,
	// API
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	// Errors
	ExtensionError,
	ExtensionEvent,
	ExtensionFactory,
	ExtensionFlag,
	ExtensionHandler,
	// Runtime
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	FindToolCallEvent,
	FindToolResultEvent,
	GrepToolCallEvent,
	GrepToolResultEvent,
	// Events - Input
	InputEvent,
	InputEventResult,
	InputSource,
	KeybindingsManager,
	LoadExtensionsResult,
	LsToolCallEvent,
	LsToolResultEvent,
	// Events - Message
	MessageEndEvent,
	// Message Rendering
	MessageRenderer,
	MessageRenderOptions,
	MessageStartEvent,
	MessageUpdateEvent,
	ModelSelectEvent,
	ModelSelectSource,
	// Provider Registration
	ProviderConfig,
	ProviderModelConfig,
	LifecycleHookContext,
	LifecycleHookHandler,
	LifecycleHookMap,
	LifecycleHookPhase,
	LifecycleHookScope,
	ReadToolCallEvent,
	ReadToolResultEvent,
	// Commands
	RegisteredCommand,
	RegisteredTool,
	// Events - Resources
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionBeforeForkEvent,
	SessionBeforeForkResult,
	SessionBeforeSwitchEvent,
	SessionBeforeSwitchResult,
	SessionBeforeTreeEvent,
	SessionBeforeTreeResult,
	SessionCompactEvent,
	SessionDirectoryEvent,
	SessionDirectoryHandler,
	SessionDirectoryResult,
	SessionEvent,
	SessionForkEvent,
	SessionShutdownEvent,
	// Events - Session
	SessionStartEvent,
	SessionSwitchEvent,
	SessionTreeEvent,
	TerminalInputHandler,
	// Events - Tool
	ToolCallEvent,
	ToolCallEventResult,
	// Tools
	ToolDefinition,
	// Events - Tool Execution
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolInfo,
	ToolRenderResultOptions,
	ToolResultEvent,
	ToolResultEventResult,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
	// Events - User Bash
	UserBashEvent,
	UserBashEventResult,
	BashTransformEvent,
	BashTransformEventResult,
	WidgetPlacement,
	WriteToolCallEvent,
	WriteToolResultEvent,
} from "./types.js";
// Type guards
export { isToolCallEventType, isToolResultEventType } from "./types.js";
export {
	wrapRegisteredTool,
	wrapRegisteredTools,
	wrapToolsWithExtensions,
	wrapToolWithExtensions,
} from "./wrapper.js";
