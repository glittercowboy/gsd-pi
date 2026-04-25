/**
 * CompactionOrchestrator - Manages manual and automatic context compaction.
 *
 * Handles:
 * - Manual compaction (user-triggered /compact)
 * - Auto-compaction when context exceeds threshold
 * - Overflow recovery when LLM returns context overflow errors
 * - Extension integration for custom compaction providers
 * - Branch summarization abort coordination
 */

import type { Agent } from "@gsd/pi-agent-core";
import type { AssistantMessage, Model } from "@gsd/pi-ai";
import { isContextOverflow } from "@gsd/pi-ai";
import {
	type CompactionResult,
	CompactionProducedNoSummaryError,
	calculateContextTokens,
	compact,
	estimateContextTokens,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.js";
import type { ExtensionRunner, SessionBeforeCompactResult } from "./extensions/index.js";
import type { ModelRegistry } from "./model-registry.js";
import { getLatestCompactionEntry } from "./session-manager.js";
import type { CompactionEntry, SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";
import type { AgentSessionEvent } from "./agent-session.js";
import { getErrorMessage } from "../utils/error.js";

/** Dependencies injected from AgentSession into CompactionOrchestrator */
export interface CompactionOrchestratorDeps {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly modelRegistry: ModelRegistry;
	getModel: () => Model<any> | undefined;
	getSessionId: () => string;
	getExtensionRunner: () => ExtensionRunner | undefined;
	emit: (event: AgentSessionEvent) => void;
	disconnectFromAgent: () => void;
	reconnectToAgent: () => void;
	abort: () => Promise<void>;
}

export class CompactionOrchestrator {
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	constructor(private readonly _deps: CompactionOrchestratorDeps) {}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** Reset overflow recovery flag (called when a new user message starts) */
	resetOverflowRecovery(): void {
		this._overflowRecoveryAttempted = false;
	}

	/** Mark overflow recovery as not needed (called on successful assistant response) */
	clearOverflowRecovery(): void {
		this._overflowRecoveryAttempted = false;
	}

	/** Get/set the branch summary abort controller (used by navigateTree) */
	get branchSummaryAbortController(): AbortController | undefined {
		return this._branchSummaryAbortController;
	}
	set branchSummaryAbortController(controller: AbortController | undefined) {
		this._branchSummaryAbortController = controller;
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		this._deps.disconnectFromAgent();
		await this._deps.abort();
		this._compactionAbortController = new AbortController();

		try {
			const model = this._deps.getModel();
			if (!model) {
				throw new Error("No model selected");
			}

			if (!this._deps.modelRegistry.isProviderRequestReady(model.provider)) {
				throw new Error(`No API key for ${model.provider}`);
			}
			// undefined for externalCli/none providers — stripped at the streamSimple boundary (model-registry.ts)
			const apiKey = await this._deps.modelRegistry.getApiKey(model, this._deps.getSessionId());

			const pathEntries = this._deps.sessionManager.getBranch();
			const settings = this._deps.settingsManager.getCompactionSettings();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;
			const extensionRunner = this._deps.getExtensionRunner();

			if (extensionRunner?.hasHandlers("session_before_compact")) {
				const result = (await extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (extensionCompaction) {
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				const result = await compact(
					preparation,
					model,
					apiKey,
					customInstructions,
					this._compactionAbortController.signal,
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this._deps.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
			const newEntries = this._deps.sessionManager.getEntries();
			const sessionContext = this._deps.sessionManager.buildSessionContext();
			this._deps.agent.replaceMessages(sessionContext.messages);

			const savedCompactionEntry = newEntries.find(
				(e) => e.type === "compaction" && e.summary === summary,
			) as CompactionEntry | undefined;

			if (extensionRunner && savedCompactionEntry) {
				await extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			return { summary, firstKeptEntryId, tokensBefore, details };
		} finally {
			this._compactionAbortController = undefined;
			this._deps.reconnectToAgent();
		}
	}

	/** Cancel in-progress compaction (manual or auto) */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/** Cancel in-progress branch summarization */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact, NO auto-retry
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	async checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<void> {
		const settings = this._deps.settingsManager.getCompactionSettings();
		if (!settings.enabled) return;

		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return;

		const model = this._deps.getModel();
		const contextWindow = model?.contextWindow ?? 0;

		const sameModel =
			model && assistantMessage.provider === model.provider && assistantMessage.model === model.id;

		const branchEntries = this._deps.sessionManager.getBranch();
		const compactionEntry = getLatestCompactionEntry(branchEntries);
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) return;

		// Case 1: Overflow - LLM returned context overflow error
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			if (this._overflowRecoveryAttempted) {
				this._deps.emit({
					type: "auto_compaction_end",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return;
			}

			this._overflowRecoveryAttempted = true;
			const messages = this._deps.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this._deps.agent.replaceMessages(messages.slice(0, -1));
			}
			await this._runAutoCompaction("overflow", true);
			return;
		}

		// Case 2: Threshold - context is getting large
		let contextTokens: number;
		if (assistantMessage.stopReason === "error") {
			const messages = this._deps.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return;
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = calculateContextTokens(assistantMessage.usage);
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			await this._runAutoCompaction("threshold", false);
		}
	}

	/** Toggle auto-compaction setting */
	setAutoCompactionEnabled(enabled: boolean): void {
		this._deps.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this._deps.settingsManager.getCompactionEnabled();
	}

	// =========================================================================
	// Private helpers
	// =========================================================================

	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<void> {
		const settings = this._deps.settingsManager.getCompactionSettings();

		this._deps.emit({ type: "auto_compaction_start", reason });
		this._autoCompactionAbortController = new AbortController();

		try {
			const model = this._deps.getModel();
			if (!model) {
				this._deps.emit({ type: "auto_compaction_end", result: undefined, aborted: false, willRetry: false });
				return;
			}

			if (!this._deps.modelRegistry.isProviderRequestReady(model.provider)) {
				this._deps.emit({ type: "auto_compaction_end", result: undefined, aborted: false, willRetry: false });
				return;
			}
			// undefined for externalCli/none providers — stripped at the streamSimple boundary (model-registry.ts)
			const apiKey = await this._deps.modelRegistry.getApiKey(model, this._deps.getSessionId());

			const pathEntries = this._deps.sessionManager.getBranch();
			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				this._deps.emit({ type: "auto_compaction_end", result: undefined, aborted: false, willRetry: false });
				return;
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;
			const extensionRunner = this._deps.getExtensionRunner();

			if (extensionRunner?.hasHandlers("session_before_compact")) {
				const extensionResult = (await extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					signal: this._autoCompactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this._deps.emit({
						type: "auto_compaction_end",
						result: undefined,
						aborted: true,
						willRetry,
					});
					this._scheduleAutoCompactionFollowup(willRetry);
					return;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (extensionCompaction) {
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				const compactResult = await compact(
					preparation,
					model,
					apiKey,
					undefined,
					this._autoCompactionAbortController.signal,
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				details = compactResult.details;
			}

			if (this._autoCompactionAbortController.signal.aborted) {
				this._deps.emit({ type: "auto_compaction_end", result: undefined, aborted: true, willRetry: false });
				return;
			}

			this._deps.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
			const newEntries = this._deps.sessionManager.getEntries();
			const sessionContext = this._deps.sessionManager.buildSessionContext();
			this._deps.agent.replaceMessages(sessionContext.messages);

			const savedCompactionEntry = newEntries.find(
				(e) => e.type === "compaction" && e.summary === summary,
			) as CompactionEntry | undefined;

			if (extensionRunner && savedCompactionEntry) {
				await extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			const result: CompactionResult = { summary, firstKeptEntryId, tokensBefore, details };
			this._deps.emit({ type: "auto_compaction_end", result, aborted: false, willRetry });
			this._scheduleAutoCompactionFollowup(willRetry);
		} catch (error) {
			// Distinguish the "no usable summary" failure (issue #4665) so the UI
			// can surface a clearer message than a generic compaction failure.
			// Either way we drop the would-be compaction entry rather than writing
			// an empty string to the session history.
			const errorMessage = error instanceof CompactionProducedNoSummaryError
				? `Compaction produced no usable summary — session history preserved as-is. (${error.message})`
				: getErrorMessage(error);
			this._deps.emit({
				type: "auto_compaction_end",
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`,
			});
		} finally {
			this._autoCompactionAbortController = undefined;
		}
	}

	private _scheduleAutoCompactionFollowup(willRetry: boolean): void {
		if (willRetry) {
			const messages = this._deps.agent.state.messages;
			const lastMsg = messages[messages.length - 1];
			if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
				this._deps.agent.replaceMessages(messages.slice(0, -1));
			}

			setTimeout(() => {
				this._deps.agent.continue().catch(() => {});
			}, 100);
			return;
		}

		if (this._deps.agent.hasQueuedMessages()) {
			setTimeout(() => {
				this._deps.agent.continue().catch(() => {});
			}, 100);
		}
	}
}
