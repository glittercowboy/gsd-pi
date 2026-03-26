// GSD Provider Fallback Resolver
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

/**
 * FallbackResolver - Cross-provider fallback when rate/quota limits are hit.
 *
 * When a provider's credentials are all exhausted, this resolver finds the next
 * available provider+model from a user-configured fallback chain. It also handles
 * restoration: checking if a higher-priority provider has recovered before each request.
 */

import type { Api, Model } from "@gsd/pi-ai";
import type { AuthStorage, UsageLimitErrorType } from "./auth-storage.js";
import type { ModelRegistry } from "./model-registry.js";
import type { FallbackChainEntry, SettingsManager } from "./settings-manager.js";

export interface FallbackResult {
	model: Model<Api>;
	chainName: string;
	reason: string;
}

export class FallbackResolver {
	constructor(
		private settingsManager: SettingsManager,
		private authStorage: AuthStorage,
		private modelRegistry: ModelRegistry,
	) {}

	/**
	 * Find the next available fallback for a model that just failed.
	 * Searches all chains for entries matching the current model's provider+id,
	 * then returns the next available entry with lower priority (higher number).
	 *
	 * @returns FallbackResult if a fallback is available, null otherwise
	 */
	async findFallback(
		currentModel: Model<Api>,
		errorType: UsageLimitErrorType,
	): Promise<FallbackResult | null> {
		const { enabled, chains } = this.settingsManager.getFallbackSettings();
		if (!enabled) return null;

		// Mark the current provider as exhausted at the provider level
		this.authStorage.markProviderExhausted(currentModel.provider, errorType);

		// Search all chains for one containing the current model
		for (const [chainName, entries] of Object.entries(chains)) {
			const currentIndex = entries.findIndex(
				(e) => e.provider === currentModel.provider && e.model === currentModel.id,
			);

			if (currentIndex === -1) continue;

			// Try entries after the current one (already sorted by priority)
			const result = await this._findAvailableInChain(chainName, entries, currentIndex + 1);
			if (result) return result;

			// Wrap around: try entries before the current one
			const wrapResult = await this._findAvailableInChain(chainName, entries, 0, currentIndex);
			if (wrapResult) return wrapResult;
		}

		return null;
	}

	/**
	 * Check if a higher-priority provider in the chain has recovered.
	 * Called before each LLM request to restore the best available provider.
	 *
	 * @returns FallbackResult if a better provider is available, null if current is best
	 */
	async checkForRestoration(currentModel: Model<Api>): Promise<FallbackResult | null> {
		const { enabled, chains } = this.settingsManager.getFallbackSettings();
		if (!enabled) return null;

		for (const [chainName, entries] of Object.entries(chains)) {
			const currentIndex = entries.findIndex(
				(e) => e.provider === currentModel.provider && e.model === currentModel.id,
			);

			if (currentIndex === -1) continue;

			// Only check entries with higher priority (lower index = higher priority)
			if (currentIndex === 0) continue; // Already at highest priority

			const result = await this._findAvailableInChain(chainName, entries, 0, currentIndex);
			if (result) {
				return {
					...result,
					reason: `${result.model.provider}/${result.model.id} recovered, restoring from fallback`,
				};
			}
		}

		return null;
	}

	/**
	 * Get the best available model from a named chain.
	 * Useful for initial model selection.
	 */
	async getBestAvailable(chainName: string): Promise<FallbackResult | null> {
		const { enabled, chains } = this.settingsManager.getFallbackSettings();
		if (!enabled) return null;

		const entries = chains[chainName];
		if (!entries || entries.length === 0) return null;

		return this._findAvailableInChain(chainName, entries, 0);
	}

	/**
	 * Find the chain(s) a model belongs to.
	 */
	findChainsForModel(provider: string, modelId: string): string[] {
		const { chains } = this.settingsManager.getFallbackSettings();
		const result: string[] = [];

		for (const [chainName, entries] of Object.entries(chains)) {
			if (entries.some((e) => e.provider === provider && e.model === modelId)) {
				result.push(chainName);
			}
		}

		return result;
	}

	/**
	 * Search a chain for the first available entry starting from startIndex.
	 */
	private async _findAvailableInChain(
		chainName: string,
		entries: FallbackChainEntry[],
		startIndex: number,
		endIndex?: number,
	): Promise<FallbackResult | null> {
		const end = endIndex ?? entries.length;

		for (let i = startIndex; i < end; i++) {
			const entry = entries[i];

			// Check provider-level backoff
			if (!this.authStorage.isProviderAvailable(entry.provider)) {
				continue;
			}

			// Check if model exists in registry
			const model = this.modelRegistry.find(entry.provider, entry.model);
			if (!model) continue;

			// Check if provider is request-ready for fallback (authMode-aware)
			if (!this.modelRegistry.isProviderRequestReady(entry.provider)) continue;

			return {
				model,
				chainName,
				reason: `falling back to ${entry.provider}/${entry.model}`,
			};
		}

		return null;
	}
}
