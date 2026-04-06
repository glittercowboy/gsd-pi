/**
 * Extension runner - executes extensions and manages their lifecycle.
 */

import type { AgentMessage } from "@gsd/pi-agent-core";
import type { ImageContent, Model } from "@gsd/pi-ai";
import type { KeyId } from "@gsd/pi-tui";
import { type Theme, theme } from "../../modes/interactive/theme/theme.js";
import type { ResourceDiagnostic } from "../diagnostics.js";
import type { KeyAction, KeybindingsConfig } from "../keybindings.js";
import type { ModelRegistry } from "../model-registry.js";
import type { SessionManager } from "../session-manager.js";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeModelSelectEvent,
	BeforeModelSelectResult,
	BeforeProviderRequestEvent,
	CompactOptions,
	ContextEvent,
	ContextEventResult,
	ContextUsage,
	Extension,
	ExtensionActions,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFlag,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	InputEvent,
	InputEventResult,
	InputSource,
	MessageRenderer,
	RegisteredCommand,
	RegisteredTool,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionBeforeCompactResult,
	SessionBeforeForkResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	UserBashEvent,
	UserBashEventResult,
} from "./types.js";

// Keybindings for these actions cannot be overridden by extensions
const RESERVED_ACTIONS_FOR_EXTENSION_CONFLICTS: ReadonlyArray<KeyAction> = [
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
	"externalEditor",
	"followUp",
	"submit",
	"selectConfirm",
	"selectCancel",
	"copy",
	"deleteToLineEnd",
];

type BuiltInKeyBindings = Partial<Record<KeyId, { action: KeyAction; restrictOverride: boolean }>>;

const buildBuiltinKeybindings = (effectiveKeybindings: Required<KeybindingsConfig>): BuiltInKeyBindings => {
	const builtinKeybindings = {} as BuiltInKeyBindings;
	for (const [action, keys] of Object.entries(effectiveKeybindings)) {
		const keyAction = action as KeyAction;
		const keyList = Array.isArray(keys) ? keys : [keys];
		const restrictOverride = RESERVED_ACTIONS_FOR_EXTENSION_CONFLICTS.includes(keyAction);
		for (const key of keyList) {
			const normalizedKey = key.toLowerCase() as KeyId;
			builtinKeybindings[normalizedKey] = {
				action: keyAction,
				restrictOverride: restrictOverride,
			};
		}
	}
	return builtinKeybindings;
};

/** Combined result from all before_agent_start handlers */
interface BeforeAgentStartCombinedResult {
	messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPrompt?: string;
}

/**
 * Events handled by the generic emit() method.
 * Events with dedicated emitXxx() methods are excluded for stronger type safety.
 */
type RunnerEmitEvent = Exclude<
	ExtensionEvent,
	| ToolCallEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| BeforeAgentStartEvent
	| ResourcesDiscoverEvent
	| InputEvent
>;

type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{ type: "session_before_switch" | "session_before_fork" | "session_before_compact" | "session_before_tree" }
>;

type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeForkResult
	| SessionBeforeCompactResult
	| SessionBeforeTreeResult;

type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_fork" }
		? SessionBeforeForkResult | undefined
		: TEvent extends { type: "session_before_compact" }
			? SessionBeforeCompactResult | undefined
			: TEvent extends { type: "session_before_tree" }
				? SessionBeforeTreeResult | undefined
				: undefined;

export type ExtensionErrorListener = (error: ExtensionError) => void;

export type NewSessionHandler = (options?: {
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

export type ForkHandler = (entryId: string) => Promise<{ cancelled: boolean }>;

export type NavigateTreeHandler = (
	targetId: string,
	options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
) => Promise<{ cancelled: boolean }>;

export type SwitchSessionHandler = (sessionPath: string) => Promise<{ cancelled: boolean }>;

export type ReloadHandler = () => Promise<void>;

export type ShutdownHandler = () => void;


const noOpUIContext: ExtensionUIContext = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	pasteToEditor: () => {},
	setEditorText: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	setEditorComponent: () => {},
	get theme() {
		return theme;
	},
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: (_theme: string | Theme) => ({ success: false, error: "UI not available" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

export class ExtensionRunner {
	private extensions: Extension[];
	private runtime: ExtensionRuntime;
	private uiContext: ExtensionUIContext;
	private cwd: string;
	private sessionManager: SessionManager;
	private modelRegistry: ModelRegistry;
	private errorListeners: Set<ExtensionErrorListener> = new Set();
	private getModel: () => Model<any> | undefined = () => undefined;
	private isIdleFn: () => boolean = () => true;
	private waitForIdleFn: () => Promise<void> = async () => {};
	private abortFn: () => void = () => {};
	private hasPendingMessagesFn: () => boolean = () => false;
	private getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	private compactFn: (options?: CompactOptions) => void = () => {};
	private getSystemPromptFn: () => string = () => "";
	private newSessionHandler: NewSessionHandler = async () => {
		throw new Error("Command context not yet bound: newSession is unavailable during early lifecycle");
	};
	private forkHandler: ForkHandler = async () => {
		throw new Error("Command context not yet bound: fork is unavailable during early lifecycle");
	};
	private navigateTreeHandler: NavigateTreeHandler = async () => {
		throw new Error("Command context not yet bound: navigateTree is unavailable during early lifecycle");
	};
	private switchSessionHandler: SwitchSessionHandler = async () => {
		throw new Error("Command context not yet bound: switchSession is unavailable during early lifecycle");
	};
	private reloadHandler: ReloadHandler = async () => {
		throw new Error("Command context not yet bound: reload is unavailable during early lifecycle");
	};
	private shutdownHandler: ShutdownHandler = () => {};
	private shortcutDiagnostics: ResourceDiagnostic[] = [];
	private commandDiagnostics: ResourceDiagnostic[] = [];

	constructor(
		extensions: Extension[],
		runtime: ExtensionRuntime,
		cwd: string,
		sessionManager: SessionManager,
		modelRegistry: ModelRegistry,
	) {
		this.extensions = extensions;
		this.runtime = runtime;
		this.uiContext = noOpUIContext;
		this.cwd = cwd;
		this.sessionManager = sessionManager;
		this.modelRegistry = modelRegistry;
		// Bind emit methods into the shared runtime so createExtensionAPI can delegate to them.
		this.runtime.emitBeforeModelSelect = (event) => this.emitBeforeModelSelect(event);
	}

	bindCore(actions: ExtensionActions, contextActions: ExtensionContextActions): void {
		// Copy actions into the shared runtime (all extension APIs reference this)
		this.runtime.sendMessage = actions.sendMessage;
		this.runtime.sendUserMessage = actions.sendUserMessage;
		this.runtime.retryLastTurn = actions.retryLastTurn;
		this.runtime.appendEntry = actions.appendEntry;
		this.runtime.setSessionName = actions.setSessionName;
		this.runtime.getSessionName = actions.getSessionName;
		this.runtime.setLabel = actions.setLabel;
		this.runtime.getActiveTools = actions.getActiveTools;
		this.runtime.getAllTools = actions.getAllTools;
		this.runtime.setActiveTools = actions.setActiveTools;
		this.runtime.refreshTools = actions.refreshTools;
		this.runtime.getCommands = actions.getCommands;
		this.runtime.setModel = actions.setModel;
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		this.runtime.setThinkingLevel = actions.setThinkingLevel;

		// Context actions (required)
		this.getModel = contextActions.getModel;
		this.isIdleFn = contextActions.isIdle;
		this.abortFn = contextActions.abort;
		this.hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.shutdownHandler = contextActions.shutdown;
		this.getContextUsageFn = contextActions.getContextUsage;
		this.compactFn = contextActions.compact;
		this.getSystemPromptFn = contextActions.getSystemPrompt;

		// Flush provider registrations queued during extension loading
		for (const { name, config } of this.runtime.pendingProviderRegistrations) {
			this.modelRegistry.registerProvider(name, config);
		}
		this.runtime.pendingProviderRegistrations = [];

		// From this point on, provider registration/unregistration takes effect immediately
		// without requiring a /reload.
		this.runtime.registerProvider = (name, config) => this.modelRegistry.registerProvider(name, config);
		this.runtime.unregisterProvider = (name) => this.modelRegistry.unregisterProvider(name);
	}

	bindCommandContext(actions?: ExtensionCommandContextActions): void {
		if (actions) {
			this.waitForIdleFn = actions.waitForIdle;
			this.newSessionHandler = actions.newSession;
			this.forkHandler = actions.fork;
			this.navigateTreeHandler = actions.navigateTree;
			this.switchSessionHandler = actions.switchSession;
			this.reloadHandler = actions.reload;
			return;
		}

		this.waitForIdleFn = async () => {};
		this.newSessionHandler = async () => ({ cancelled: false });
		this.forkHandler = async () => ({ cancelled: false });
		this.navigateTreeHandler = async () => ({ cancelled: false });
		this.switchSessionHandler = async () => ({ cancelled: false });
		this.reloadHandler = async () => {};
	}

	setUIContext(uiContext?: ExtensionUIContext): void {
		this.uiContext = uiContext ?? noOpUIContext;
	}

	getUIContext(): ExtensionUIContext {
		return this.uiContext;
	}

	hasUI(): boolean {
		return this.uiContext !== noOpUIContext;
	}

	getExtensionPaths(): string[] {
		return this.extensions.map((e) => e.path);
	}

	/** Get all registered tools from all extensions (first registration per name wins). */
	getAllRegisteredTools(): RegisteredTool[] {
		const toolsByName = new Map<string, RegisteredTool>();
		for (const ext of this.extensions) {
			for (const tool of ext.tools.values()) {
				if (!toolsByName.has(tool.definition.name)) {
					toolsByName.set(tool.definition.name, tool);
				}
			}
		}
		return Array.from(toolsByName.values());
	}

	/** Get a tool definition by name. Returns undefined if not found. */
	getToolDefinition(toolName: string): RegisteredTool["definition"] | undefined {
		for (const ext of this.extensions) {
			const tool = ext.tools.get(toolName);
			if (tool) {
				return tool.definition;
			}
		}
		return undefined;
	}

	getFlags(): Map<string, ExtensionFlag> {
		const allFlags = new Map<string, ExtensionFlag>();
		for (const ext of this.extensions) {
			for (const [name, flag] of ext.flags) {
				if (!allFlags.has(name)) {
					allFlags.set(name, flag);
				}
			}
		}
		return allFlags;
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	getShortcuts(effectiveKeybindings: Required<KeybindingsConfig>): Map<KeyId, ExtensionShortcut> {
		this.shortcutDiagnostics = [];
		const builtinKeybindings = buildBuiltinKeybindings(effectiveKeybindings);
		const extensionShortcuts = new Map<KeyId, ExtensionShortcut>();

		const addDiagnostic = (message: string, extensionPath: string) => {
			this.shortcutDiagnostics.push({ type: "warning", message, path: extensionPath });
			if (!this.hasUI()) {
				console.warn(message);
			}
		};

		for (const ext of this.extensions) {
			for (const [key, shortcut] of ext.shortcuts) {
				const normalizedKey = key.toLowerCase() as KeyId;

				const builtInKeybinding = builtinKeybindings[normalizedKey];
				if (builtInKeybinding?.restrictOverride === true) {
					addDiagnostic(
						`Extension shortcut '${key}' from ${shortcut.extensionPath} conflicts with built-in shortcut. Skipping.`,
						shortcut.extensionPath,
					);
					continue;
				}

				if (builtInKeybinding?.restrictOverride === false) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' is built-in shortcut for ${builtInKeybinding.action} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						shortcut.extensionPath,
					);
				}

				const existingExtensionShortcut = extensionShortcuts.get(normalizedKey);
				if (existingExtensionShortcut) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' registered by both ${existingExtensionShortcut.extensionPath} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						shortcut.extensionPath,
					);
				}
				extensionShortcuts.set(normalizedKey, shortcut);
			}
		}
		return extensionShortcuts;
	}

	getShortcutDiagnostics(): ResourceDiagnostic[] {
		return this.shortcutDiagnostics;
	}

	onError(listener: ExtensionErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	emitError(error: ExtensionError): void {
		for (const listener of this.errorListeners) {
			listener(error);
		}
	}

	hasHandlers(eventType: string): boolean {
		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	getRegisteredCommands(reserved?: Set<string>): RegisteredCommand[] {
		this.commandDiagnostics = [];

		const commands: RegisteredCommand[] = [];
		const commandOwners = new Map<string, string>();
		for (const ext of this.extensions) {
			for (const command of ext.commands.values()) {
				if (reserved?.has(command.name)) {
					const message = `Extension command '${command.name}' from ${ext.path} conflicts with built-in commands. Skipping.`;
					this.commandDiagnostics.push({ type: "warning", message, path: ext.path });
					if (!this.hasUI()) {
						console.warn(message);
					}
					continue;
				}

				const existingOwner = commandOwners.get(command.name);
				if (existingOwner) {
					const message = `Extension command '${command.name}' from ${ext.path} conflicts with ${existingOwner}. Skipping.`;
					this.commandDiagnostics.push({ type: "warning", message, path: ext.path });
					if (!this.hasUI()) {
						console.warn(message);
					}
					continue;
				}

				commandOwners.set(command.name, ext.path);
				commands.push(command);
			}
		}
		return commands;
	}

	getCommandDiagnostics(): ResourceDiagnostic[] {
		return this.commandDiagnostics;
	}

	getRegisteredCommandsWithPaths(): Array<{ command: RegisteredCommand; extensionPath: string }> {
		const result: Array<{ command: RegisteredCommand; extensionPath: string }> = [];
		for (const ext of this.extensions) {
			for (const command of ext.commands.values()) {
				result.push({ command, extensionPath: ext.path });
			}
		}
		return result;
	}

	getCommand(name: string): RegisteredCommand | undefined {
		for (const ext of this.extensions) {
			const command = ext.commands.get(name);
			if (command) {
				return command;
			}
		}
		return undefined;
	}

	/**
	 * Request a graceful shutdown. Called by extension tools and event handlers.
	 * The actual shutdown behavior is provided by the mode via bindExtensions().
	 */
	shutdown(): void {
		this.shutdownHandler();
	}

	/**
	 * Create an ExtensionContext for use in event handlers and tool execution.
	 * Context values are resolved at call time, so changes via bindCore/bindUI are reflected.
	 */
	createContext(): ExtensionContext {
		const getModel = this.getModel;
		return {
			ui: this.uiContext,
			hasUI: this.hasUI(),
			cwd: this.cwd,
			sessionManager: this.sessionManager,
			modelRegistry: this.modelRegistry,
			get model() {
				return getModel();
			},
			isIdle: () => this.isIdleFn(),
			abort: () => this.abortFn(),
			hasPendingMessages: () => this.hasPendingMessagesFn(),
			shutdown: () => this.shutdownHandler(),
			getContextUsage: () => this.getContextUsageFn(),
			compact: (options) => this.compactFn(options),
			getSystemPrompt: () => this.getSystemPromptFn(),
		};
	}

	createCommandContext(): ExtensionCommandContext {
		return {
			...this.createContext(),
			waitForIdle: () => this.waitForIdleFn(),
			newSession: (options) => this.newSessionHandler(options),
			fork: (entryId) => this.forkHandler(entryId),
			navigateTree: (targetId, options) => this.navigateTreeHandler(targetId, options),
			switchSession: (sessionPath) => this.switchSessionHandler(sessionPath),
			reload: () => this.reloadHandler(),
		};
	}

	private isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
		return (
			event.type === "session_before_switch" ||
			event.type === "session_before_fork" ||
			event.type === "session_before_compact" ||
			event.type === "session_before_tree"
		);
	}

	/**
	 * Shared handler invocation loop.
	 *
	 * Iterates every handler registered for `eventType` across all extensions,
	 * calling each inside a try/catch that emits an ExtensionError on failure.
	 *
	 * `getEvent` builds the event object for each handler call — callers that
	 * mutate state between calls (e.g. context, before_provider_request) supply
	 * a function; callers with a fixed event can pass a constant.
	 *
	 * `processResult` receives each handler's return value and the owning
	 * extension's path. It returns `{ done: true }` to short-circuit
	 * or `{ done: false }` to keep iterating.
	 */
	private async invokeHandlers(
		eventType: string,
		getEvent: () => unknown,
		processResult: (handlerResult: unknown, extensionPath: string) => { done: boolean },
	): Promise<void> {
		const ctx = this.createContext();

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventType);
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event = getEvent();
					const handlerResult = await handler(event, ctx);
					const action = processResult(handlerResult, ext.path);
					if (action.done) return;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: eventType,
						error: message,
						stack,
					});
				}
			}
		}
	}

	async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		let result: SessionBeforeEventResult | undefined;
		const isSessionBefore = this.isSessionBeforeEvent(event);

		await this.invokeHandlers(event.type, () => event, (handlerResult) => {
			if (isSessionBefore && handlerResult) {
				result = handlerResult as SessionBeforeEventResult;
				if (result.cancel) return { done: true };
			}
			return { done: false };
		});

		return result as RunnerEmitResult<TEvent>;
	}

	async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		const currentEvent: ToolResultEvent = { ...event };
		let modified = false;

		await this.invokeHandlers("tool_result", () => currentEvent, (handlerResult) => {
			const r = handlerResult as ToolResultEventResult | undefined;
			if (!r) return { done: false };

			if (r.content !== undefined) { currentEvent.content = r.content; modified = true; }
			if (r.details !== undefined) { currentEvent.details = r.details; modified = true; }
			if (r.isError !== undefined) { currentEvent.isError = r.isError; modified = true; }
			return { done: false };
		});

		if (!modified) return undefined;
		return { content: currentEvent.content, details: currentEvent.details, isError: currentEvent.isError };
	}

	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		let result: ToolCallEventResult | undefined;

		await this.invokeHandlers("tool_call", () => event, (handlerResult) => {
			if (handlerResult) {
				result = handlerResult as ToolCallEventResult;
				if (result.block) return { done: true };
			}
			return { done: false };
		});

		return result;
	}

	async emitBashTransform(command: string, cwd: string): Promise<string> {
		if (!this.hasHandlers("bash_transform")) return command;

		let current = command;
		await this.invokeHandlers(
			"bash_transform",
			() => ({ type: "bash_transform" as const, command: current, cwd }),
			(handlerResult) => {
				const result = handlerResult as import("./types.js").BashTransformEventResult | undefined;
				if (result?.command && result.command.trim()) {
					current = result.command;
				}
				return { done: false }; // chain all handlers
			},
		);
		return current;
	}

	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		let result: UserBashEventResult | undefined;

		await this.invokeHandlers("user_bash", () => event, (handlerResult) => {
			if (handlerResult) {
				result = handlerResult as UserBashEventResult;
				return { done: true };
			}
			return { done: false };
		});

		return result;
	}

	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		let currentMessages = structuredClone(messages);

		await this.invokeHandlers("context", () => ({ type: "context", messages: currentMessages } satisfies ContextEvent), (handlerResult) => {
			if (handlerResult && (handlerResult as ContextEventResult).messages) {
				currentMessages = (handlerResult as ContextEventResult).messages!;
			}
			return { done: false };
		});

		return currentMessages;
	}

	async emitBeforeProviderRequest(payload: unknown, model?: { provider: string; id: string }): Promise<unknown> {
		let currentPayload = payload;

		await this.invokeHandlers("before_provider_request", () => ({
			type: "before_provider_request",
			payload: currentPayload,
			model,
		} satisfies BeforeProviderRequestEvent), (handlerResult) => {
			if (handlerResult !== undefined) currentPayload = handlerResult;
			return { done: false };
		});

		return currentPayload;
	}

	async emitBeforeModelSelect(event: Omit<BeforeModelSelectEvent, "type">): Promise<BeforeModelSelectResult | undefined> {
		let result: BeforeModelSelectResult | undefined;
		await this.invokeHandlers("before_model_select", () => ({
			type: "before_model_select" as const,
			...event,
		} satisfies BeforeModelSelectEvent), (handlerResult) => {
			if (handlerResult) {
				result = handlerResult as BeforeModelSelectResult;
				return { done: true }; // first override wins
			}
			return { done: false };
		});
		return result;
	}

	async emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPrompt: string,
	): Promise<BeforeAgentStartCombinedResult | undefined> {
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
		let currentSystemPrompt = systemPrompt;
		let systemPromptModified = false;

		await this.invokeHandlers("before_agent_start", () => ({
			type: "before_agent_start",
			prompt,
			images,
			systemPrompt: currentSystemPrompt,
		} satisfies BeforeAgentStartEvent), (handlerResult) => {
			if (handlerResult) {
				const r = handlerResult as BeforeAgentStartEventResult;
				if (r.message) messages.push(r.message);
				if (r.systemPrompt !== undefined) {
					currentSystemPrompt = r.systemPrompt;
					systemPromptModified = true;
				}
			}
			return { done: false };
		});

		if (messages.length > 0 || systemPromptModified) {
			return {
				messages: messages.length > 0 ? messages : undefined,
				systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
			};
		}
		return undefined;
	}

	async emitResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverEvent["reason"],
	): Promise<{
		skillPaths: Array<{ path: string; extensionPath: string }>;
		promptPaths: Array<{ path: string; extensionPath: string }>;
		themePaths: Array<{ path: string; extensionPath: string }>;
	}> {
		const skillPaths: Array<{ path: string; extensionPath: string }> = [];
		const promptPaths: Array<{ path: string; extensionPath: string }> = [];
		const themePaths: Array<{ path: string; extensionPath: string }> = [];

		await this.invokeHandlers("resources_discover", () => ({
			type: "resources_discover",
			cwd,
			reason,
		} satisfies ResourcesDiscoverEvent), (handlerResult, extensionPath) => {
			const r = handlerResult as ResourcesDiscoverResult | undefined;
			if (r?.skillPaths?.length) skillPaths.push(...r.skillPaths.map((path) => ({ path, extensionPath })));
			if (r?.promptPaths?.length) promptPaths.push(...r.promptPaths.map((path) => ({ path, extensionPath })));
			if (r?.themePaths?.length) themePaths.push(...r.themePaths.map((path) => ({ path, extensionPath })));
			return { done: false };
		});

		return { skillPaths, promptPaths, themePaths };
	}

	/** Emit input event. Transforms chain, "handled" short-circuits. */
	async emitInput(text: string, images: ImageContent[] | undefined, source: InputSource): Promise<InputEventResult> {
		let currentText = text;
		let currentImages = images;
		let handled: InputEventResult | undefined;

		await this.invokeHandlers("input", () => ({
			type: "input",
			text: currentText,
			images: currentImages,
			source,
		} satisfies InputEvent), (handlerResult) => {
			const r = handlerResult as InputEventResult | undefined;
			if (r?.action === "handled") {
				handled = r;
				return { done: true };
			}
			if (r?.action === "transform") {
				currentText = r.text;
				currentImages = r.images ?? currentImages;
			}
			return { done: false };
		});

		if (handled) return handled;
		return currentText !== text || currentImages !== images
			? { action: "transform", text: currentText, images: currentImages }
			: { action: "continue" };
	}
}
