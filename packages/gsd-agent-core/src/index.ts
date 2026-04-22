// @gsd/agent-core public API
// Named exports only — no `export *` (per CORE-07)

export {
	createAgentSession,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	CredentialCooldownError,
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	type PromptTemplate,
	readOnlyTools,
} from "./sdk.js";
export {
	AgentSession,
	parseSkillBlock,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type ParsedSkillBlock,
	type PromptOptions,
	type SessionStats,
	type SessionStateChangeReason,
} from "./agent-session.js";
export { CompactionOrchestrator } from "./compaction-orchestrator.js";
export { executeBash, executeBashWithOperations, importExtensionModule, sanitizeCommand, type BashExecutorOptions, type BashResult } from "./bash-executor.js";
export { buildSystemPrompt, type BuildSystemPromptOptions } from "./system-prompt.js";
export { prepareLifecycleHooks, runLifecycleHooks, type PackageLifecycleHooksOptions, type PrepareLifecycleHooksOptions, type LifecycleHooksRunResult, type LifecycleHooksTarget } from "./lifecycle-hooks.js";
export { ArtifactManager } from "./artifact-manager.js";
export { BlobStore, isBlobRef, parseBlobRef, externalizeImageData, resolveImageData, type BlobPutResult } from "./blob-store.js";
// Additional exports needed by @gsd/pi-coding-agent internal files
export { FallbackResolver, type FallbackResult } from "./fallback-resolver.js";
export { KeybindingsManager, type AppAction, type KeyAction, type KeybindingsConfig } from "./keybindings.js";
export { ContextualTips, type TipContext } from "./contextual-tips.js";
// export-html utilities (moved from pi-coding-agent in CORE-01)
export { exportFromFile } from "./export-html/index.js";
// Compaction exports needed by @gsd/pi-coding-agent
export {
	type BranchPreparation,
	type BranchSummaryResult,
	type CollectEntriesResult,
	type CompactionResult,
	type CutPointResult,
	calculateContextTokens,
	chunkMessages,
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
} from "./compaction/index.js";
