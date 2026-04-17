// Core session management

// Config paths
export { getAgentDir, VERSION } from "./config.js";
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
	AgentEndEvent,
	AgentStartEvent,
	AgentToolResult,
	AgentToolUpdateCallback,
	BashToolCallEvent,
	BeforeAgentStartEvent,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
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
	ReadToolCallEvent,
	RegisteredCommand,
	RegisteredTool,
	SessionBeforeCompactEvent,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionBeforeTreeEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionTreeEvent,
	SlashCommandInfo,
	SlashCommandSource,
	TerminalInputHandler,
	ToolCallEvent,
	ToolCallEventResult,
	ToolDefinition,
	ToolInfo,
	ToolRenderResultOptions,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
	UserBashEvent,
	UserBashEventResult,
	WidgetPlacement,
	WriteToolCallEvent,
} from "./core/extensions/index.js";
export {
	createExtensionRuntime,
	discoverAndLoadExtensions,
	ExtensionRunner,
	wrapRegisteredTool,
	wrapRegisteredTools,
} from "./core/extensions/index.js";
// Additional extension system exports from direct source (not in GSD extensions/index.js)
export type { AppKeybinding } from "./core/keybindings.js";
export type { ResolvedCommand } from "./core/extensions/types.js";
export type { SourceInfo } from "./core/source-info.js";
export {
	defineTool,
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
} from "./core/extensions/types.js";
// Footer data provider (git branch + extension statuses - data not otherwise available to extensions)
export type { ReadonlyFooterDataProvider } from "./core/footer-data-provider.js";
export { convertToLlm } from "./core/messages.js";
export { ModelRegistry } from "./core/model-registry.js";
export type {
	PackageManager,
	PathMetadata,
	ProgressCallback,
	ProgressEvent,
	ResolvedPaths,
	ResolvedResource,
} from "./core/package-manager.js";
export { DefaultPackageManager } from "./core/package-manager.js";
export type { ResourceCollision, ResourceDiagnostic, ResourceLoader } from "./core/resource-loader.js";
export { DefaultResourceLoader } from "./core/resource-loader.js";
// SDK for programmatic usage
export {
	AgentSessionRuntime,
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	type CreateAgentSessionServicesOptions,
	// Factory
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
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
export {
	type CompactionSettings,
	type ImageSettings,
	type PackageSource,
	type RetrySettings,
	SettingsManager,
} from "./core/settings-manager.js";
// Skills
export {
	formatSkillsForPrompt,
	type LoadSkillsFromDirOptions,
	type LoadSkillsResult,
	loadSkills,
	loadSkillsFromDir,
	type Skill,
	type SkillFrontmatter,
} from "./core/skills.js";
export { createSyntheticSourceInfo } from "./core/source-info.js";
// Tools
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashTool,
	bashToolDefinition,
	codingTools,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLocalBashOperations,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	editTool,
	editToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	findTool,
	findToolDefinition,
	formatSize,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
	grepTool,
	grepToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	lsTool,
	lsToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	readTool,
	readToolDefinition,
	type ToolsOptions,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	withFileMutationQueue,
	writeTool,
	writeToolDefinition,
} from "./core/tools/index.js";
// Main entry point
export { type MainOptions, main } from "./main.js";
// Run modes for programmatic SDK usage
export {
	InteractiveMode,
	type InteractiveModeOptions,
	type PrintModeOptions,
	runPrintMode,
	runRpcMode,
} from "./modes/index.js";
// UI components for extensions
export {
	ArminComponent,
	AssistantMessageComponent,
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
	FooterComponent,
	keyHint,
	keyText,
	LoginDialogComponent,
	ModelSelectorComponent,
	OAuthSelectorComponent,
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
	getLanguageFromPath,
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	highlightCode,
	initTheme,
	Theme,
	type ThemeColor,
} from "./modes/interactive/theme/theme.js";
// Clipboard utilities
export { copyToClipboard } from "./utils/clipboard.js";
export { parseFrontmatter, stripFrontmatter } from "./utils/frontmatter.js";
// Shell utilities
export { getShellConfig } from "./utils/shell.js";
// Extension sort (needed by @gsd/agent-core resource-loader)
export { sortExtensionPaths } from "./core/extensions/extension-sort.js";
// JSONL serialization utilities (needed by @gsd/agent-core headless-ui and headless-answers)
export { serializeJsonLine, attachJsonlLineReader } from "./modes/rpc/jsonl.js";
// GSD additions — symbols needed by @gsd/agent-core and @gsd/agent-modes
// Config utilities needed by @gsd/agent-core
export { getDocsPath, getExamplesPath, getReadmePath, getExportTemplateDir } from "./config.js";
// Config utilities needed by @gsd/agent-modes
export { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, getAuthPath, getDebugLogPath, getUpdateInstruction, getShareViewerUrl, getCustomThemesDir, getModelsPath } from "./config.js";
// Bash executor (now in local source in 0.67.2)
export { type BashExecutorOptions, type BashResult, executeBash, executeBashWithOperations } from "./core/bash-executor.js";
// Shell utilities needed by @gsd/agent-modes
export { getShellEnv, killProcessTree, sanitizeBinaryOutput } from "./utils/shell.js";
// Changelog utilities needed by @gsd/agent-modes
export { getChangelogPath, getNewEntries, parseChangelog } from "./utils/changelog.js";
// Git utilities needed by @gsd/agent-core
export { parseGitUrl } from "./utils/git.js";
// App keybindings type (needed by @gsd/agent-modes)
export type { AppAction } from "./core/keybindings-types.js";
// HTML export utility
export { exportFromFile } from "./core/export-html/index.js";
// Footer data provider class needed by @gsd/agent-modes
export { FooterDataProvider } from "./core/footer-data-provider.js";
// Additional symbols needed by @gsd/agent-modes
export { createCompactionSummaryMessage } from "./core/messages.js";
export type { BranchSummaryMessage, CompactionSummaryMessage, CustomMessage } from "./core/messages.js";
export { createBranchSummaryMessage, createCustomMessage } from "./core/messages.js";
export { DEFAULT_THINKING_LEVEL } from "./core/defaults.js";
export type { BashExecutionMessage } from "./core/messages.js";
export { expandPromptTemplate } from "./core/prompt-templates.js";
export type { ResourceExtensionPaths } from "./core/resource-loader.js";
export { createAllTools, allTools } from "./core/tools/index.js";
export type { Tool, ToolName } from "./core/tools/index.js";
export { findInitialModel } from "./core/model-resolver.js";
export { resolveModelScope, resolveCliModel } from "./core/model-resolver.js";
export type { ScopedModel, ResolveCliModelResult } from "./core/model-resolver.js";
export { printTimings, time } from "./core/timings.js";
export { runMigrations, showDeprecationWarnings } from "./migrations.js";
export { BUILTIN_SLASH_COMMANDS } from "./core/slash-commands.js";
export { computeEditDiff } from "./core/tools/edit-diff.js";
export type { EditDiffError, EditDiffResult } from "./core/tools/edit-diff.js";
export { resolveReadPath } from "./core/tools/path-utils.js";
export { detectSupportedImageMimeTypeFromFile } from "./utils/mime.js";
export { formatDimensionNote, resizeImage, type ImageResizeOptions, type ResizedImage } from "./utils/image-resize.js";
export { convertToPng } from "./utils/image-convert.js";
export { extensionForImageMimeType, readClipboardImage } from "./utils/clipboard-image.js";
export { ensureTool } from "./utils/tools-manager.js";
// GSD-only symbols still in @gsd/agent-core (GSD business logic, not upstream)
export { ContextualTips } from "@gsd/agent-core";
export { BlobStore, isBlobRef, parseBlobRef, externalizeImageData, resolveImageData } from "@gsd/agent-core";
export { ArtifactManager } from "@gsd/agent-core";
export { FallbackResolver, type FallbackResult } from "@gsd/agent-core";
// Theme utilities needed by @gsd/agent-modes
export {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getResolvedThemeColors,
	getThemeByName,
	getThemeExportColors,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	setThemeInstance,
	stopThemeWatcher,
	type ThemeInfo,
} from "./core/theme/theme.js";
