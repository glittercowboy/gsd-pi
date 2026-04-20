import type { Transport } from "@gsd/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";
import {
	COMPACTION_KEEP_RECENT_TOKENS,
	COMPACTION_RESERVE_TOKENS,
	RETRY_BASE_DELAY_MS,
	RETRY_MAX_DELAY_MS,
} from "./constants.js";
import type { BashInterceptorRule } from "./tools/bash-interceptor.js";

export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
}

export interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
	skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
	maxDelayMs?: number; // default: 300000 (max server-requested delay before failing)
}

export interface TerminalSettings {
	showImages?: boolean; // default: true (only relevant if terminal supports images)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export interface BashInterceptorSettings {
	enabled?: boolean; // default: true
	rules?: BashInterceptorRule[]; // override default rules
}

export interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
}

export interface MemorySettings {
	enabled?: boolean; // default: false
	maxRolloutsPerStartup?: number; // default: 64
	maxRolloutAgeDays?: number; // default: 30
	minRolloutIdleHours?: number; // default: 12
	stage1Concurrency?: number; // default: 8
	summaryInjectionTokenLimit?: number; // default: 5000
}

export interface AsyncSettings {
	enabled?: boolean;  // default: false
	maxJobs?: number;   // default: 100
}

export interface TaskIsolationSettings {
	mode?: "none" | "worktree" | "fuse-overlay"; // default: "none"
	merge?: "patch" | "branch"; // default: "patch"
}

export interface FallbackChainEntry {
	provider: string;
	model: string;
	priority: number;
}

export interface FallbackSettings {
	enabled?: boolean; // default: false
	chains?: Record<string, FallbackChainEntry[]>; // keyed by chain name
}

export interface ModelDiscoverySettings {
	enabled?: boolean; // default: false
	providers?: string[]; // limit discovery to specific providers
	ttlMinutes?: number; // override default TTLs (in minutes)
	autoRefreshOnModelSelect?: boolean; // default: false - refresh discovery when opening model selector
}

/**
 * A shell command bound to a Layer 0 hook event.
 *
 * Payload is passed to the command on stdin as JSON. The command may write a
 * JSON object to stdout to mutate the pending action — shape varies per hook
 * (e.g. `{"block":true,"reason":"..."}` for PreToolUse). Non-zero exit with
 * `blocking: true` vetoes the action.
 */
export interface HookEntry {
	/** Optional filter on the event payload (currently supports tool name / bash command prefix). */
	match?: {
		tool?: string | string[];
		command?: string;
	};
	/** The shell command to execute. */
	command: string;
	/** Timeout in milliseconds. Default: 30000. */
	timeout?: number;
	/** When true (default), a non-zero exit vetoes the pending action. */
	blocking?: boolean;
	/** Extra environment variables for the child process. */
	env?: Record<string, string>;
}

/**
 * Layer 0 shell hooks. Each key is the name of a hook event; each value is a
 * list of `HookEntry` — all matching entries run in order.
 *
 * Hook names mirror Claude Code's for portability.
 */
export interface HooksSettings {
	PreToolUse?: HookEntry[];
	PostToolUse?: HookEntry[];
	UserPromptSubmit?: HookEntry[];
	SessionStart?: HookEntry[];
	SessionEnd?: HookEntry[];
	Stop?: HookEntry[];
	Notification?: HookEntry[];
	PreCompact?: HookEntry[];
	PostCompact?: HookEntry[];
	PreCommit?: HookEntry[];
	PostCommit?: HookEntry[];
	PrePush?: HookEntry[];
	PostPush?: HookEntry[];
	PrePr?: HookEntry[];
	PostPr?: HookEntry[];
	PreMilestone?: HookEntry[];
	PostMilestone?: HookEntry[];
	PreUnit?: HookEntry[];
	PostUnit?: HookEntry[];
	PreVerify?: HookEntry[];
	PostVerify?: HookEntry[];
	BudgetThreshold?: HookEntry[];
	Blocked?: HookEntry[];
}

export type TransportSetting = Transport;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 */
export type PackageSource =
	| string
	| {
			source: string;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

export interface Settings {
	lastChangelogVersion?: string;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	transport?: TransportSetting; // default: "sse"
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	theme?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows)
	quietStartup?: boolean;
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
	packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
	extensions?: string[]; // Array of local extension file paths or directories
	skills?: string[]; // Array of local skill file paths or directories
	prompts?: string[]; // Array of local prompt template paths or directories
	themes?: string[]; // Array of local theme file paths or directories
	enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
	terminal?: TerminalSettings;
	images?: ImageSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	doubleEscapeAction?: "fork" | "tree" | "none"; // Action for double-escape with empty editor (default: "tree")
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default filter when opening /tree
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
	autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
	respectGitignoreInPicker?: boolean; // When false, @ file picker shows gitignored files (default: true)
	searchExcludeDirs?: string[]; // Directories to exclude from @ file search (e.g., ["node_modules", ".git", "dist"])
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	markdown?: MarkdownSettings;
	memory?: MemorySettings;
	async?: AsyncSettings;
	bashInterceptor?: BashInterceptorSettings;
	taskIsolation?: TaskIsolationSettings;
	fallback?: FallbackSettings;
	modelDiscovery?: ModelDiscoverySettings;
	editMode?: "standard" | "hashline"; // Edit tool mode: "standard" (text match) or "hashline" (LINE#ID anchors). Default: "standard"
	timestampFormat?: "date-time-iso" | "date-time-us"; // Timestamp display format for messages. Default: "date-time-iso"
	allowedCommandPrefixes?: string[]; // Override built-in SAFE_COMMAND_PREFIXES for !command resolution (global-only — ignored in project settings)
	fetchAllowedUrls?: string[]; // Hostnames exempted from SSRF blocklist in fetch_page (global-only — ignored in project settings)
	hooks?: HooksSettings; // Layer 0 shell-command hooks. Project-scoped hooks require explicit trust (.pi/hooks.trusted).
}

/** Settings keys that are only respected from global config — project settings cannot override these. */
const GLOBAL_ONLY_KEYS: ReadonlySet<keyof Settings> = new Set([
	"allowedCommandPrefixes",
	"fetchAllowedUrls",
]);

/** Remove global-only keys from a settings object. Applied once at load time. */
function stripGlobalOnlyKeys(settings: Settings): Settings {
	const result = { ...settings };
	for (const key of GLOBAL_ONLY_KEYS) {
		delete (result as Record<string, unknown>)[key];
	}
	return result;
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const result: Settings = { ...base };

	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		const overrideValue = overrides[key];
		const baseValue = base[key];

		if (overrideValue === undefined) {
			continue;
		}

		// For nested objects, merge recursively
		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			(result as Record<string, unknown>)[key] = { ...baseValue, ...overrideValue };
		} else {
			// For primitives and arrays, override value wins
			(result as Record<string, unknown>)[key] = overrideValue;
		}
	}

	return result;
}

export type SettingsScope = "global" | "project";

export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

export interface SettingsError {
	scope: SettingsScope;
	error: Error;
}

class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string = process.cwd(), agentDir: string = getAgentDir()) {
		this.globalSettingsPath = join(agentDir, "settings.json");
		this.projectSettingsPath = join(cwd, CONFIG_DIR_NAME, "settings.json");
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// Only create directory and lock if file exists or we need to write
			const fileExists = existsSync(path);
			if (fileExists) {
				release = this.acquireLockSyncWithRetry(path);
			}
			const current = fileExists ? readFileSync(path, "utf-8") : undefined;
			const next = fn(current);
			if (next !== undefined) {
				// Only create directory when we actually need to write
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (!release) {
					release = this.acquireLockSyncWithRetry(path);
				}
				writeFileSync(path, next, "utf-8");
			}
		} finally {
			if (release) {
				release();
			}
		}
	}
}

class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}
}

export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings: Settings;
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = stripGlobalOnlyKeys(initialProject);
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Create a SettingsManager that loads from files */
	static create(cwd: string = process.cwd(), agentDir: string = getAgentDir()): SettingsManager {
		const storage = new FileSettingsStorage(cwd, agentDir);
		return SettingsManager.fromStorage(storage);
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage): SettingsManager {
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project");
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push({ scope: "global", error: globalLoad.error });
		}
		if (projectLoad.error) {
			initialErrors.push({ scope: "project", error: projectLoad.error });
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		return new SettingsManager(storage, settings, {});
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope): Settings {
		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		const settings = JSON.parse(content);
		return SettingsManager.migrateSettings(settings);
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
	): { settings: Settings; error: Error | null } {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		// Migrate queueMode -> steeringMode
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}

		// Migrate legacy websockets boolean -> transport enum
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}

		// Migrate old skills object format to new array format
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		return settings as Settings;
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	getBashInterceptorEnabled(): boolean {
		return this.settings.bashInterceptor?.enabled ?? true;
	}

	getBashInterceptorRules(): BashInterceptorRule[] | undefined {
		return this.settings.bashInterceptor?.rules;
	}

	reload(): void {
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project");
		if (!projectLoad.error) {
			this.projectSettings = stripGlobalOnlyKeys(projectLoad.settings);
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		this.settings = deepMergeSettings(this.settings, overrides);
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push({ scope, error: normalizedError });
	}

	/**
	 * Check if project-level settings are active (loaded from a file).
	 * Used to scope model persistence to the project when possible,
	 * preventing model config bleed between concurrent instances (#650).
	 */
	private hasProjectSettings(): boolean {
		// Project settings are active if we loaded them and they weren't empty/errored
		return !this.projectSettingsLoadError && Object.keys(this.projectSettings).length > 0;
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? SettingsManager.migrateSettings(JSON.parse(current) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	private save(): void {
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		if (this.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.projectSettings = stripGlobalOnlyKeys(structuredClone(settings));
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		if (this.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	// ── Generic setter helpers ──────────────────────────────────────────

	/** Set a top-level global setting field, mark modified, and save. */
	private setGlobalSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
		this.globalSettings[key] = value;
		this.markModified(key);
		this.save();
	}

	/** Set a top-level setting, scoped to project when project settings are active. */
	private setScopedSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
		if (this.hasProjectSettings()) {
			this.projectSettings[key] = value;
			this.markProjectModified(key);
			this.saveProjectSettings(this.projectSettings);
		} else {
			this.setGlobalSetting(key, value);
		}
	}

	/** Set a nested field within a global settings object (e.g. compaction.enabled). */
	private setNestedGlobalSetting<K extends keyof Settings, NK extends string & keyof NonNullable<Settings[K]>>(
		key: K,
		nestedKey: NK,
		value: NonNullable<Settings[K]>[NK],
	): void {
		if (!this.globalSettings[key]) {
			(this.globalSettings as Record<string, unknown>)[key] = {};
		}
		(this.globalSettings[key] as Record<string, unknown>)[nestedKey] = value;
		this.markModified(key, nestedKey);
		this.save();
	}

	/** Set a field on project settings (clone, set, mark modified, save). */
	private setProjectSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings[key] = value;
		this.markProjectModified(key);
		this.saveProjectSettings(projectSettings);
	}

	// ── Public getters and setters ──────────────────────────────────────

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.setGlobalSetting("lastChangelogVersion", version);
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.setScopedSetting("defaultProvider", provider);
	}

	setDefaultModel(modelId: string): void {
		this.setScopedSetting("defaultModel", modelId);
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		if (this.hasProjectSettings()) {
			this.projectSettings.defaultProvider = provider;
			this.projectSettings.defaultModel = modelId;
			this.markProjectModified("defaultProvider");
			this.markProjectModified("defaultModel");
			this.saveProjectSettings(this.projectSettings);
		} else {
			this.globalSettings.defaultProvider = provider;
			this.globalSettings.defaultModel = modelId;
			this.markModified("defaultProvider");
			this.markModified("defaultModel");
			this.save();
		}
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.setGlobalSetting("steeringMode", mode);
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.setGlobalSetting("followUpMode", mode);
	}

	getTheme(): string | undefined {
		return this.settings.theme;
	}

	setTheme(theme: string): void {
		this.setGlobalSetting("theme", theme);
	}

	getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): void {
		this.setGlobalSetting("defaultThinkingLevel", level);
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? "sse";
	}

	setTransport(transport: TransportSetting): void {
		this.setGlobalSetting("transport", transport);
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		this.setNestedGlobalSetting("compaction", "enabled", enabled);
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? COMPACTION_RESERVE_TOKENS;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? COMPACTION_KEEP_RECENT_TOKENS;
	}

	getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? COMPACTION_RESERVE_TOKENS,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		this.setNestedGlobalSetting("retry", "enabled", enabled);
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number; maxDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? RETRY_BASE_DELAY_MS,
			maxDelayMs: this.settings.retry?.maxDelayMs ?? RETRY_MAX_DELAY_MS,
		};
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.setGlobalSetting("hideThinkingBlock", hide);
	}

	getShellPath(): string | undefined {
		return this.settings.shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.setGlobalSetting("shellPath", path);
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): void {
		this.setGlobalSetting("quietStartup", quiet);
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.setGlobalSetting("shellCommandPrefix", prefix);
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? false;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.setGlobalSetting("collapseChangelog", collapse);
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.setGlobalSetting("packages", packages);
	}

	setProjectPackages(packages: PackageSource[]): void {
		this.setProjectSetting("packages", packages);
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.setGlobalSetting("extensions", paths);
	}

	setProjectExtensionPaths(paths: string[]): void {
		this.setProjectSetting("extensions", paths);
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.setGlobalSetting("skills", paths);
	}

	setProjectSkillPaths(paths: string[]): void {
		this.setProjectSetting("skills", paths);
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.setGlobalSetting("prompts", paths);
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.setProjectSetting("prompts", paths);
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.setGlobalSetting("themes", paths);
	}

	setProjectThemePaths(paths: string[]): void {
		this.setProjectSetting("themes", paths);
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.setGlobalSetting("enableSkillCommands", enabled);
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		this.setNestedGlobalSetting("terminal", "showImages", show);
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.PI_CLEAR_ON_SHRINK === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		this.setNestedGlobalSetting("terminal", "clearOnShrink", enabled);
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		this.setNestedGlobalSetting("images", "autoResize", enabled);
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	setBlockImages(blocked: boolean): void {
		this.setNestedGlobalSetting("images", "blockImages", blocked);
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.setGlobalSetting("enabledModels", patterns);
	}

	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		this.setGlobalSetting("doubleEscapeAction", action);
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "default";
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.setGlobalSetting("treeFilterMode", mode);
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.PI_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.setGlobalSetting("showHardwareCursor", enabled);
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): void {
		this.setGlobalSetting("editorPaddingX", Math.max(0, Math.min(3, Math.floor(padding))));
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.setGlobalSetting("autocompleteMaxVisible", Math.max(3, Math.min(20, Math.floor(maxVisible))));
	}

	getRespectGitignoreInPicker(): boolean {
		return this.settings.respectGitignoreInPicker ?? true;
	}

	setRespectGitignoreInPicker(value: boolean): void {
		this.setGlobalSetting("respectGitignoreInPicker", value);
	}

	getSearchExcludeDirs(): string[] {
		return this.settings.searchExcludeDirs ?? [];
	}

	setSearchExcludeDirs(dirs: string[]): void {
		this.setGlobalSetting("searchExcludeDirs", dirs.filter(Boolean));
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}

	getMemorySettings(): {
		enabled: boolean;
		maxRolloutsPerStartup: number;
		maxRolloutAgeDays: number;
		minRolloutIdleHours: number;
		stage1Concurrency: number;
		summaryInjectionTokenLimit: number;
	} {
		return {
			enabled: this.settings.memory?.enabled ?? false,
			maxRolloutsPerStartup: this.settings.memory?.maxRolloutsPerStartup ?? 64,
			maxRolloutAgeDays: this.settings.memory?.maxRolloutAgeDays ?? 30,
			minRolloutIdleHours: this.settings.memory?.minRolloutIdleHours ?? 12,
			stage1Concurrency: this.settings.memory?.stage1Concurrency ?? 8,
			summaryInjectionTokenLimit: this.settings.memory?.summaryInjectionTokenLimit ?? 5000,
		};
	}

	getAsyncEnabled(): boolean {
		return this.settings.async?.enabled ?? false;
	}

	getAsyncMaxJobs(): number {
		return this.settings.async?.maxJobs ?? 100;
	}

	getTaskIsolationMode(): "none" | "worktree" | "fuse-overlay" {
		return this.settings.taskIsolation?.mode ?? "none";
	}

	getTaskIsolationMerge(): "patch" | "branch" {
		return this.settings.taskIsolation?.merge ?? "patch";
	}

	getFallbackEnabled(): boolean {
		return this.settings.fallback?.enabled ?? false;
	}

	setFallbackEnabled(enabled: boolean): void {
		this.setNestedGlobalSetting("fallback", "enabled", enabled);
	}

	getFallbackChains(): Record<string, FallbackChainEntry[]> {
		return this.settings.fallback?.chains ?? {};
	}

	getFallbackChain(name: string): FallbackChainEntry[] | undefined {
		return this.settings.fallback?.chains?.[name];
	}

	setFallbackChain(name: string, entries: FallbackChainEntry[]): void {
		if (!this.globalSettings.fallback) {
			this.globalSettings.fallback = {};
		}
		if (!this.globalSettings.fallback.chains) {
			this.globalSettings.fallback.chains = {};
		}
		// Sort by priority
		this.globalSettings.fallback.chains[name] = [...entries].sort((a, b) => a.priority - b.priority);
		this.markModified("fallback");
		this.save();
	}

	removeFallbackChain(name: string): boolean {
		if (!this.globalSettings.fallback?.chains?.[name]) {
			return false;
		}
		delete this.globalSettings.fallback.chains[name];
		if (Object.keys(this.globalSettings.fallback.chains).length === 0) {
			delete this.globalSettings.fallback.chains;
		}
		this.markModified("fallback");
		this.save();
		return true;
	}

	getFallbackSettings(): { enabled: boolean; chains: Record<string, FallbackChainEntry[]> } {
		return {
			enabled: this.getFallbackEnabled(),
			chains: this.getFallbackChains(),
		};
	}

	getModelDiscoverySettings(): ModelDiscoverySettings {
		return this.settings.modelDiscovery ?? {};
	}

	setModelDiscoveryEnabled(enabled: boolean): void {
		this.setNestedGlobalSetting("modelDiscovery", "enabled", enabled);
	}

	getEditMode(): "standard" | "hashline" {
		return this.settings.editMode ?? "standard";
	}

	setEditMode(mode: "standard" | "hashline"): void {
		this.setGlobalSetting("editMode", mode);
	}

	getTimestampFormat(): "date-time-iso" | "date-time-us" {
		return this.settings.timestampFormat ?? "date-time-iso";
	}

	setTimestampFormat(format: "date-time-iso" | "date-time-us"): void {
		this.setGlobalSetting("timestampFormat", format);
	}

	/**
	 * Get the allowed command prefixes from global settings only.
	 * Returns undefined if not configured (caller should use built-in defaults).
	 */
	getAllowedCommandPrefixes(): string[] | undefined {
		return this.globalSettings.allowedCommandPrefixes;
	}

	setAllowedCommandPrefixes(prefixes: string[]): void {
		this.setGlobalSetting("allowedCommandPrefixes", prefixes);
	}

	/**
	 * Get the fetch URL allowlist from global settings only.
	 * Returns undefined if not configured (caller should use empty allowlist).
	 */
	getFetchAllowedUrls(): string[] | undefined {
		return this.globalSettings.fetchAllowedUrls;
	}

	setFetchAllowedUrls(urls: string[]): void {
		this.setGlobalSetting("fetchAllowedUrls", urls);
	}
}
