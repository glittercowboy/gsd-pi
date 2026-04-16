import { join } from "node:path";

/**
 * Structured error thrown when all credentials for a provider are in a
 * backoff window.  Carries typed metadata so callers (e.g. the auto-loop)
 * can make informed retry decisions instead of string-matching the message.
 */
export class CredentialCooldownError extends Error {
	readonly code = "AUTH_COOLDOWN" as const;
	/** Milliseconds until the earliest credential becomes available, or undefined if unknown. */
	readonly retryAfterMs: number | undefined;

	constructor(provider: string, retryAfterMs?: number) {
		super(
			`All credentials for "${provider}" are in a cooldown window. ` +
				`Please wait a moment and try again, or switch to a different provider.`,
		);
		this.name = "CredentialCooldownError";
		this.retryAfterMs = retryAfterMs;
	}
}
import { Agent, type AgentMessage, type ThinkingLevel } from "@gsd/pi-agent-core";
import type { Message, Model } from "@gsd/pi-ai";
import { getAgentDir, getDocsPath } from "@gsd/pi-coding-agent";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "@gsd/pi-coding-agent";
import { DEFAULT_THINKING_LEVEL } from "@gsd/pi-coding-agent";
import type { ExtensionRunner, LoadExtensionsResult, ToolDefinition } from "@gsd/agent-types";
import { convertToLlm } from "@gsd/pi-coding-agent";
import { ModelRegistry } from "@gsd/pi-coding-agent";
import { findInitialModel } from "@gsd/pi-coding-agent";
import type { ResourceLoader } from "@gsd/agent-types";
import { DefaultResourceLoader } from "@gsd/pi-coding-agent";
import { SessionManager } from "@gsd/pi-coding-agent";
import { SettingsManager } from "@gsd/pi-coding-agent";
import { time } from "@gsd/pi-coding-agent";
import {
	allTools,
	bashTool,
	codingTools,
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	editTool,
	findTool,
	grepTool,
	lsTool,
	readOnlyTools,
	readTool,
	type Tool,
	type ToolName,
	writeTool,
} from "@gsd/pi-coding-agent";

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.pi/agent */
	agentDir?: string;

	/** Auth storage for credentials. Default: AuthStorage.create(agentDir/auth.json) */
	authStorage?: AuthStorage;
	/** Model registry. Default: new ModelRegistry(authStorage, agentDir/models.json) */
	modelRegistry?: ModelRegistry;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/** Built-in tools to use. Default: codingTools [read, bash, edit, write] */
	tools?: Tool[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;

	/** Optional: check if the claude-code CLI provider is ready (installed + authed).
	 * Passed to RetryHandler for third-party block recovery (#3772). */
	isClaudeCodeReady?: () => boolean;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

// Re-exports

export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "@gsd/agent-types";
export type { PromptTemplate } from "@gsd/agent-types";
export type { Skill } from "@gsd/agent-types";
export type { Tool } from "@gsd/agent-types";

export {
	// Pre-built tools (use process.cwd())
	readTool,
	bashTool,
	editTool,
	writeTool,
	grepTool,
	findTool,
	lsTool,
	codingTools,
	readOnlyTools,
	allTools as allBuiltInTools,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@gsd/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: [readTool, bashTool],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	// Use provided or create AuthStorage and ModelRegistry
	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const authStorage = options.authStorage ?? AuthStorage.create(authPath);
	const modelRegistry = options.modelRegistry ?? (modelsPath ? ModelRegistry.create(authStorage, modelsPath) : ModelRegistry.create(authStorage));

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd);

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Flush provider registrations queued during extension loading so that
	// extension models (e.g. pi-claude-cli) are visible in the registry before
	// findInitialModel() runs. bindCore() repeats this flush as a safety net
	// for any late-arriving registrations.
	const { runtime: extensionRuntime } = resourceLoader.getExtensions();
	for (const { name, config } of extensionRuntime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config);
	}
	extensionRuntime.pendingProviderRegistrations = [];

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel) {
			const authResult = await modelRegistry.getApiKeyAndHeaders(restoredModel);
			if (authResult.ok) {
				model = restoredModel;
			}
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// Flush extension provider registrations so extension-provided models (e.g. claude-code/*)
	// are available in the registry before model resolution. Without this, findInitialModel()
	// cannot find extension models and falls back to built-in providers (#3534).
	const extensionsForModelResolution = resourceLoader.getExtensions();
	for (const { name, config } of extensionsForModelResolution.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config);
	}
	// Clear the queue so bindCore() doesn't re-register the same providers.
	extensionsForModelResolution.runtime.pendingProviderRegistrations = [];

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRegistry,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = `No models available. Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}. Then use /model to select a model.`;
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model || !model.reasoning) {
		thinkingLevel = "off";
	}

	// getEditMode() was removed from SettingsManager in 0.67.2; use the standard tool set.
	const defaultActiveToolNames: ToolName[] = ["read", "bash", "edit", "write"];
	const initialActiveToolNames: ToolName[] = options.tools
		? options.tools.map((t) => t.name).filter((n): n is ToolName => n in allTools)
		: defaultActiveToolNames;

	let agent: Agent;

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		onPayload: async (payload, currentModel) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getRetrySettings().maxDelayMs,
		getApiKey: async (provider) => {
			// Use the provider argument from the in-flight request;
			// agent.state.model may already be switched mid-turn.
			const resolvedProvider = provider || agent.state.model?.provider;
			if (!resolvedProvider) {
				throw new Error("No model selected");
			}

			// GSD extension: cast to access GSD-added methods absent from 0.67.2 AuthStorage.
			// These methods were present in 0.57.1 and provide cooldown-aware retry behavior.
			// In 0.67.2 they are removed; optional chaining makes the call a no-op when absent.
			const gsdAuthStorage = modelRegistry.authStorage as unknown as {
				getEarliestBackoffExpiry?: (provider: string) => number | undefined;
				hasLegacyOAuthCredential?: (provider: string) => boolean;
				areAllCredentialsBackedOff?: (provider: string) => boolean;
			};

			// Retry key resolution with backoff to handle transient network failures.
			const maxAttempts = 3;
			const baseDelayMs = 2000;
			const maxCooldownWaitMs = 60_000;
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				const key = await modelRegistry.getApiKeyForProvider(resolvedProvider);
				if (key) return key;

				if (attempt >= maxAttempts) break;

				const hasAuth = modelRegistry.authStorage.hasAuth(resolvedProvider);
				const model = agent.state.model;
				const isOAuth = model && modelRegistry.isUsingOAuth(model);
				if (!hasAuth && !isOAuth) break;

				// If credentials are in a cooldown window, wait for the earliest to expire.
				const backoffExpiry = gsdAuthStorage.getEarliestBackoffExpiry?.(resolvedProvider);
				if (backoffExpiry !== undefined) {
					const waitMs = backoffExpiry - Date.now() + 500;
					if (waitMs > 0 && waitMs <= maxCooldownWaitMs) {
						await new Promise(resolve => setTimeout(resolve, waitMs));
						continue;
					}
					if (waitMs > maxCooldownWaitMs) {
						break;
					}
				}

				await new Promise(resolve => setTimeout(resolve, baseDelayMs * attempt));
			}

			// All retries exhausted — surface a descriptive error.
			const hasAuth = modelRegistry.authStorage.hasAuth(resolvedProvider);
			if (hasAuth) {
				// Detect stale Anthropic OAuth credentials (removed in v2.74.0, #3952).
				if (
					resolvedProvider === "anthropic" &&
					gsdAuthStorage.hasLegacyOAuthCredential?.(resolvedProvider)
				) {
					throw new Error(
						`Your Anthropic credentials were set up via OAuth, which is no longer supported. ` +
							`Please re-authenticate: run '/login', select 'Paste an API key' → Anthropic. ` +
							`Alternatively, switch to the Claude Code CLI provider.`,
					);
				}
				const expiry = gsdAuthStorage.getEarliestBackoffExpiry?.(resolvedProvider);
				const retryAfterMs = expiry !== undefined ? Math.max(0, expiry - Date.now()) : undefined;
				throw new CredentialCooldownError(resolvedProvider, retryAfterMs);
			}
			const model = agent.state.model;
			const isOAuth = model && modelRegistry.isUsingOAuth(model);
			if (isOAuth) {
				if (gsdAuthStorage.areAllCredentialsBackedOff?.(resolvedProvider)) {
					const expiry = gsdAuthStorage.getEarliestBackoffExpiry?.(resolvedProvider);
					const retryAfterMs = expiry !== undefined ? Math.max(0, expiry - Date.now()) : undefined;
					throw new CredentialCooldownError(resolvedProvider, retryAfterMs);
				}
				throw new Error(
					`Authentication failed for "${resolvedProvider}". ` +
						`Credentials may have expired or network is unavailable. ` +
						`Run '/login ${resolvedProvider}' to re-authenticate.`,
				);
			}
			throw new Error(
				`No API key found for "${resolvedProvider}". ` +
					`Set an API key environment variable or run '/login ${resolvedProvider}'.`,
			);
		},
	});

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.state.messages = existingSession.messages;
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRegistry,
		initialActiveToolNames,
		extensionRunnerRef,
		isClaudeCodeReady: options.isClaudeCodeReady,
	});
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
