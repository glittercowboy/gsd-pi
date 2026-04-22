// Core session management

// Config paths
export {
	APP_NAME,
	CONFIG_DIR_NAME,
	ENV_AGENT_DIR,
	getAgentDir,
	getAuthPath,
	getChangelogPath,
	getDebugLogPath,
	getDocsPath,
	getExportTemplateDir,
	getExamplesPath,
	getModelsPath,
	getReadmePath,
	getShareViewerUrl,
	getUpdateInstruction,
	VERSION,
} from "./config.js";
export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type ParsedSkillBlock,
	type PromptOptions,
	parseSkillBlock,
	type SessionStats,
} from "./core/agent-session.js";
// Auth and model registry
export {
	type ApiKeyCredential,
	type AuthCredential,
	AuthStorage,
	type AuthStorageBackend,
	FileAuthStorageBackend,
	InMemoryAuthStorageBackend,
	type OAuthCredential,
} from "./core/auth-storage.js";
// Compaction
export {
	type BranchPreparation,
	type BranchSummaryResult,
	type CollectEntriesResult,
	type CompactionResult,
	type CutPointResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	type FileOperations,
	findCutPoint,
	findTurnStartIndex,
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	generateSummary,
	getLastAssistantUsage,
	prepareBranchEntries,
	serializeConversation,
	shouldCompact,
} from "./core/compaction/index.js";
export { createEventBus, type EventBus, type EventBusController } from "./core/event-bus.js";
// Extension system
export type {
	AdjustToolSetEvent,
	AdjustToolSetResult,
	AgentEndEvent,
	AgentStartEvent,
	AgentToolResult,
	AgentToolUpdateCallback,
	AppAction,
	BashToolCallEvent,
	BeforeAgentStartEvent,
	BeforeCommitEvent,
	BeforeCommitEventResult,
	BeforePrEvent,
	BeforePrEventResult,
	BeforePushEvent,
	BeforePushEventResult,
	BeforeVerifyEvent,
	BeforeVerifyEventResult,
	BudgetThresholdEvent,
	BudgetThresholdEventResult,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	CommitEvent,
	NotificationEvent,
	PrOpenedEvent,
	PushEvent,
	VerifyFailure,
	VerifyResultEvent,
	CompactOptions,
	ContextEvent,
	ContextUsage,
	CustomToolCallEvent,
	EditToolCallEvent,
	ExecOptions,
	ExecResult,
	Extension,
	ExtensionActions,
	ExtensionAPI,
	ExtensionManifest,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFactory,
	ExtensionFlag,
	ExtensionHandler,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	FindToolCallEvent,
	GrepToolCallEvent,
	InputEvent,
	InputEventResult,
	InputSource,
	KeybindingsManager,
	LoadExtensionsResult,
	LsToolCallEvent,
	MessageRenderer,
	MessageRenderOptions,
	ProviderConfig,
	ProviderModelConfig,
	LifecycleHookContext,
	LifecycleHookHandler,
	LifecycleHookMap,
	LifecycleHookPhase,
	LifecycleHookScope,
	ReadToolCallEvent,
	RegisteredCommand,
	RegisteredTool,
	SessionBeforeCompactEvent,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionBeforeTreeEvent,
	SessionCompactEvent,
	SessionForkEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionSwitchEvent,
	SessionTreeEvent,
	SlashCommandInfo,
	SlashCommandLocation,
	SlashCommandSource,
	TerminalInputHandler,
	ToolCallEvent,
	ToolCompatibility,
	ToolDefinition,
	ToolInfo,
	SortResult,
	SortWarning,
	ToolRenderResultOptions,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
	UserBashEvent,
	UserBashEventResult,
	BashTransformEvent,
	BashTransformEventResult,
	WidgetPlacement,
	WriteToolCallEvent,
} from "./core/extensions/index.js";
export {
	createExtensionRuntime,
	discoverAndLoadExtensions,
	ExtensionRunner,
	importExtensionModule,
	isToolCallEventType,
	isToolResultEventType,
	readManifest,
	readManifestFromEntryPath,
	sortExtensionPaths,
	wrapRegisteredTool,
	wrapRegisteredTools,
	wrapToolsWithExtensions,
	wrapToolWithExtensions,
} from "./core/extensions/index.js";
// Footer data provider (git branch + extension statuses - data not otherwise available to extensions)
export type { ReadonlyFooterDataProvider } from "./core/footer-data-provider.js";
export {
	type BashExecutionMessage,
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	type CustomMessage,
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "./core/messages.js";
export { ModelDiscoveryCache } from "./core/discovery-cache.js";
export { DEFAULT_THINKING_LEVEL } from "./core/defaults.js";
export type { DiscoveredModel, DiscoveryResult, ProviderDiscoveryAdapter } from "./core/model-discovery.js";
export { getDiscoverableProviders, getDiscoveryAdapter } from "./core/model-discovery.js";
export { ModelRegistry } from "./core/model-registry.js";
export { ModelsJsonWriter } from "./core/models-json-writer.js";
export type {
	PackageManager,
	PathMetadata,
	ProgressCallback,
	ProgressEvent,
	ResolvedPaths,
	ResolvedResource,
} from "./core/package-manager.js";
export { DefaultPackageManager } from "./core/package-manager.js";
export type { PackageCommand, PackageCommandOptions, PackageCommandRunnerOptions, PackageCommandRunnerResult } from "./core/package-commands.js";
export { getPackageCommandUsage, parsePackageCommand, runPackageCommand } from "./core/package-commands.js";
export type { ResourceCollision, ResourceDiagnostic, ResourceExtensionPaths, ResourceLoader } from "./core/resource-loader.js";
export { DefaultResourceLoader } from "./core/resource-loader.js";
export { type BashResult, executeBash, executeBashWithOperations } from "./core/bash-executor.js";
export { ContextualTips, type TipContext } from "./core/contextual-tips.js";
export { exportFromFile } from "./core/export-html/index.js";
export { findInitialModel, resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.js";
export { time, printTimings } from "./core/timings.js";
export { runMigrations, showDeprecationWarnings } from "./migrations.js";
export { expandPromptTemplate } from "./core/prompt-templates.js";
export { BUILTIN_SLASH_COMMANDS } from "./core/slash-commands.js";
// SDK for programmatic usage
export {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	CredentialCooldownError,
	// Factory
	createAgentSession,
	createBashTool,
	// Tool factories (for custom cwd)
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	type PromptTemplate,
	// Pre-built tools (use process.cwd())
	readOnlyTools,
} from "./core/sdk.js";
export {
	type BranchSummaryEntry,
	buildSessionContext,
	type CompactionEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	getLatestCompactionEntry,
	type ModelChangeEntry,
	migrateSessionEntries,
	type NewSessionOptions,
	parseSessionEntries,
	type SessionContext,
	type SessionEntry,
	type SessionEntryBase,
	type SessionHeader,
	type SessionInfo,
	type SessionInfoEntry,
	SessionManager,
	type SessionMessageEntry,
	type ThinkingLevelChangeEntry,
} from "./core/session-manager.js";
// Blob and artifact storage
export { BlobStore, isBlobRef, parseBlobRef, externalizeImageData, resolveImageData } from "./core/blob-store.js";
export { ArtifactManager } from "./core/artifact-manager.js";
export {
	type AsyncSettings,
	type CompactionSettings,
	type ImageSettings,
	type MemorySettings,
	type PackageSource,
	type RetrySettings,
	SettingsManager,
	type TaskIsolationSettings,
} from "./core/settings-manager.js";
export {
	SAFE_COMMAND_PREFIXES,
	setAllowedCommandPrefixes,
	getAllowedCommandPrefixes,
} from "./core/resolve-config-value.js";
// Skills
export {
	ECOSYSTEM_SKILLS_DIR,
	ECOSYSTEM_PROJECT_SKILLS_DIR,
	formatSkillsForPrompt,
	getLoadedSkills,
	type LoadSkillsFromDirOptions,
	type LoadSkillsResult,
	loadSkills,
	loadSkillsFromDir,
	type Skill,
	type SkillFrontmatter,
} from "./core/skills.js";
// Tools
export {
	type BashInterceptorRule,
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashTool,
	rewriteBackgroundCommand,
	checkBashInterception,
	type CompiledInterceptor,
	compileInterceptor,
	DEFAULT_BASH_INTERCEPTOR_RULES,
	allTools,
	codingTools,
	createAllTools,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	editTool,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	findTool,
	formatSize,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
	grepTool,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	lsTool,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	readTool,
	type Tool,
	type ToolName,
	type ToolsOptions,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	writeTool,
	// Hashline edit mode tools
	hashlineEditTool,
	hashlineReadTool,
	hashlineCodingTools,
	createHashlineEditTool,
	createHashlineReadTool,
	createHashlineCodingTools,
	type HashlineEditInput,
	type HashlineEditToolDetails,
	type HashlineEditToolOptions,
	type HashlineReadToolDetails,
	type HashlineReadToolInput,
	type HashlineReadToolOptions,
	// Tool compatibility registry (ADR-005)
	registerToolCompatibility,
	getToolCompatibility,
	getAllToolCompatibility,
	registerMcpToolCompatibility,
	resetToolCompatibilityRegistry,
} from "./core/tools/index.js";
export { computeEditDiff, type EditDiffError, type EditDiffResult } from "./core/tools/edit-diff.js";
export { resolveReadPath } from "./core/tools/path-utils.js";
// Main entry point
export { main } from "./main.js";
// Run modes for programmatic SDK usage
export {
	InteractiveMode,
	type InteractiveModeOptions,
	type PrintModeOptions,
	runPrintMode,
	runRpcMode,
	type ModelInfo,
	RpcClient,
	type RpcClientOptions,
	type RpcEventListener,
	type RpcCommand,
	type RpcInitResult,
	type RpcProtocolVersion,
	type RpcResponse,
	type RpcSessionState,
	type RpcV2Event,
} from "./modes/index.js";
// RPC JSONL utilities
export { attachJsonlLineReader, serializeJsonLine } from "./modes/rpc/jsonl.js";
// UI components for extensions
export {
	ArminComponent,
	AssistantMessageComponent,
	appKey,
	appKeyHint,
	BashExecutionComponent,
	BorderedLoader,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomEditor,
	CustomMessageComponent,
	DynamicBorder,
	ExtensionEditorComponent,
	ExtensionInputComponent,
	ExtensionSelectorComponent,
	editorKey,
	FooterComponent,
	keyHint,
	LoginDialogComponent,
	ModelSelectorComponent,
	OAuthSelectorComponent,
	ProviderManagerComponent,
	type RenderDiffOptions,
	rawKeyHint,
	renderDiff,
	SessionSelectorComponent,
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
	ShowImagesSelectorComponent,
	SkillInvocationMessageComponent,
	ThemeSelectorComponent,
	ThinkingSelectorComponent,
	ToolExecutionComponent,
	type ToolExecutionOptions,
	TreeSelectorComponent,
	truncateToVisualLines,
	UserMessageComponent,
	UserMessageSelectorComponent,
	type VisualTruncateResult,
} from "./modes/interactive/components/index.js";
// Theme utilities for custom tools and extensions
export {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getResolvedThemeColors,
	getThemeByName,
	getThemeExportColors,
	getLanguageFromPath,
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	highlightCode,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	setThemeInstance,
	stopThemeWatcher,
	Theme,
	type ThemeColor,
} from "./modes/interactive/theme/theme.js";
// Clipboard utilities
export { copyToClipboard } from "./utils/clipboard.js";
export { extensionForImageMimeType, readClipboardImage } from "./utils/clipboard-image.js";
export { getNewEntries, parseChangelog } from "./utils/changelog.js";
export { parseFrontmatter, stripFrontmatter } from "./utils/frontmatter.js";
export { convertToPng } from "./utils/image-convert.js";
export { detectSupportedImageMimeTypeFromFile } from "./utils/mime.js";
export { formatDimensionNote, resizeImage } from "./utils/image-resize.js";
// Shell utilities
export { getShellConfig, getShellEnv, killProcessTree, sanitizeBinaryOutput, sanitizeCommand } from "./utils/shell.js";
export { parseGitUrl } from "./utils/git.js";
export { ensureTool } from "./utils/tools-manager.js";
// Cross-platform path display
export { toPosixPath } from "./utils/path-display.js";
export type { PathMetadata as SourceInfo } from "./core/package-manager.js";
