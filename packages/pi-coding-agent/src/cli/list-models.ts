/**
 * List available models with optional fuzzy search and discovery support
 */

import type { Api, Model } from "@gsd/pi-ai";
import { fuzzyFilter } from "@gsd/pi-tui";
import type { ModelRegistry } from "../core/model-registry.js";

export interface ListModelsOptions {
	/** Include discovered models in output */
	discover?: boolean;
	/** Search pattern for fuzzy filtering */
	searchPattern?: string;
}

/**
 * Format a number as human-readable (e.g., 200000 -> "200K", 1000000 -> "1M")
 */
function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		const millions = count / 1_000_000;
		return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
	}
	if (count >= 1_000) {
		const thousands = count / 1_000;
		return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
	}
	return count.toString();
}

/**
 * Discover models from provider APIs and print results.
 */
export async function discoverAndPrintModels(
	modelRegistry: ModelRegistry,
	provider?: string,
): Promise<void> {
	const providers = provider ? [provider] : undefined;

	console.log("Discovering models...");
	const results = await modelRegistry.discoverModels(providers);

	for (const result of results) {
		if (result.error) {
			console.log(`  ${result.provider}: error - ${result.error}`);
		} else {
			console.log(`  ${result.provider}: ${result.models.length} models found`);
		}
	}
}

/**
 * List available models, optionally filtered by search pattern.
 * Accepts either a string (backward compat) or ListModelsOptions.
 */
export async function listModels(
	modelRegistry: ModelRegistry,
	optionsOrSearch?: string | ListModelsOptions,
): Promise<void> {
	const options: ListModelsOptions =
		typeof optionsOrSearch === "string"
			? { searchPattern: optionsOrSearch }
			: optionsOrSearch ?? {};

	// If discover flag is set, run discovery first
	if (options.discover) {
		await modelRegistry.discoverModels();
	}

	// Get models — include discovered if discovery was run
	const models = options.discover
		? modelRegistry.getAllWithDiscovered()
		: modelRegistry.getAvailable();

	if (models.length === 0) {
		console.log("No models available. Set API keys in environment variables.");
		return;
	}

	// Apply fuzzy filter if search pattern provided
	let filteredModels: Model<Api>[] = models;
	if (options.searchPattern) {
		filteredModels = fuzzyFilter(models, options.searchPattern, (m) => `${m.provider} ${m.id}`);
	}

	if (filteredModels.length === 0) {
		console.log(`No models matching "${options.searchPattern}"`);
		return;
	}

	// Sort by model name descending (newest first), then provider, then id
	filteredModels.sort((a, b) => {
		const nameCmp = b.name.localeCompare(a.name);
		if (nameCmp !== 0) return nameCmp;
		const providerCmp = a.provider.localeCompare(b.provider);
		if (providerCmp !== 0) return providerCmp;
		return a.id.localeCompare(b.id);
	});

	// Calculate column widths
	const rows = filteredModels.map((m) => {
		const isDiscovered = options.discover && modelRegistry.isDiscovered(m);
		return {
			provider: m.provider,
			model: m.id,
			name: m.name,
			context: formatTokenCount(m.contextWindow),
			maxOut: formatTokenCount(m.maxTokens),
			thinking: m.reasoning ? "yes" : "no",
			images: m.input.includes("image") ? "yes" : "no",
			badge: isDiscovered ? "[discovered]" : "",
		};
	});

	const headers = {
		provider: "provider",
		model: "model",
		name: "name",
		context: "context",
		maxOut: "max-out",
		thinking: "thinking",
		images: "images",
		badge: "",
	};

	const widths = {
		provider: Math.max(headers.provider.length, ...rows.map((r) => r.provider.length)),
		model: Math.max(headers.model.length, ...rows.map((r) => r.model.length)),
		name: Math.max(headers.name.length, ...rows.map((r) => r.name.length)),
		context: Math.max(headers.context.length, ...rows.map((r) => r.context.length)),
		maxOut: Math.max(headers.maxOut.length, ...rows.map((r) => r.maxOut.length)),
		thinking: Math.max(headers.thinking.length, ...rows.map((r) => r.thinking.length)),
		images: Math.max(headers.images.length, ...rows.map((r) => r.images.length)),
	};

	// Print header
	const headerLine = [
		headers.provider.padEnd(widths.provider),
		headers.model.padEnd(widths.model),
		headers.name.padEnd(widths.name),
		headers.context.padEnd(widths.context),
		headers.maxOut.padEnd(widths.maxOut),
		headers.thinking.padEnd(widths.thinking),
		headers.images.padEnd(widths.images),
	].join("  ");
	console.log(headerLine);

	// Print rows
	for (const row of rows) {
		const line = [
			row.provider.padEnd(widths.provider),
			row.model.padEnd(widths.model),
			row.name.padEnd(widths.name),
			row.context.padEnd(widths.context),
			row.maxOut.padEnd(widths.maxOut),
			row.thinking.padEnd(widths.thinking),
			row.images.padEnd(widths.images),
			row.badge,
		]
			.join("  ")
			.trimEnd();
		console.log(line);
	}
}
