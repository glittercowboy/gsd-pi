// GSD2 — Ollama Extension: First-class local LLM support
/**
 * Ollama Extension
 *
 * Auto-detects a running Ollama instance, discovers locally pulled models,
 * and registers them as a first-class provider. No configuration required —
 * if Ollama is running, models appear automatically.
 *
 * Features:
 * - Auto-discovery of local models via /api/tags
 * - Capability detection (vision, reasoning, context window)
 * - /ollama slash commands for model management
 * - ollama_manage tool for LLM-driven model operations
 * - Zero-cost model registration (local inference)
 *
 * Respects OLLAMA_HOST env var for non-default endpoints.
 */

import { importExtensionModule, type ExtensionAPI } from "@gsd/pi-coding-agent";
import type { OpenAICompletionsCompat } from "@gsd/pi-ai";
import * as client from "./ollama-client.js";
import { discoverModels, getOllamaOpenAIBaseUrl } from "./ollama-discovery.js";
import { registerOllamaCommands } from "./ollama-commands.js";

/** Default compat settings for Ollama models via OpenAI-compat endpoint */
const OLLAMA_COMPAT: OpenAICompletionsCompat = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: false,
	maxTokensField: "max_tokens",
	supportsStore: false,
};

let toolsPromise: Promise<void> | null = null;

async function registerOllamaTools(pi: ExtensionAPI): Promise<void> {
	if (!toolsPromise) {
		toolsPromise = (async () => {
			const { registerOllamaTool } = await importExtensionModule<
				typeof import("./ollama-tool.js")
			>(import.meta.url, "./ollama-tool.js");
			registerOllamaTool(pi);
		})().catch((error) => {
			toolsPromise = null;
			throw error;
		});
	}
	return toolsPromise;
}

/** Track whether we've registered models so we can clean up on shutdown */
let providerRegistered = false;

/**
 * Probe Ollama and register discovered models.
 * Safe to call multiple times — re-discovers and re-registers.
 */
async function probeAndRegister(pi: ExtensionAPI): Promise<boolean> {
	const running = await client.isRunning();
	if (!running) {
		if (providerRegistered) {
			pi.unregisterProvider("ollama");
			providerRegistered = false;
		}
		return false;
	}

	const models = await discoverModels();
	if (models.length === 0) return true; // Running but no models pulled

	const baseUrl = getOllamaOpenAIBaseUrl();

	pi.registerProvider("ollama", {
		authMode: "apiKey",
		apiKey: "ollama", // Ollama ignores auth keys; dummy value avoids the streamSimple requirement for authMode:"none"
		baseUrl,
		api: "openai-completions",
		isReady: () => true,
		models: models.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			compat: OLLAMA_COMPAT,
		})),
	});

	providerRegistered = true;
	return true;
}

export default function ollama(pi: ExtensionAPI) {
	// Register slash commands immediately (they check Ollama availability themselves)
	registerOllamaCommands(pi);

	pi.on("session_start", async (_event, ctx) => {
		// Register tool (deferred to avoid blocking startup)
		if (ctx.hasUI) {
			void registerOllamaTools(pi).catch((error) => {
				ctx.ui.notify(
					`Ollama tool failed to load: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			});
		} else {
			await registerOllamaTools(pi);
		}

		// Async probe — don't block startup
		probeAndRegister(pi)
			.then((found) => {
				if (found && ctx.hasUI) {
					ctx.ui.setStatus("ollama", "Ollama");
				}
			})
			.catch(() => {
				// Silently ignore probe failures
			});
	});

	pi.on("session_shutdown", async () => {
		if (providerRegistered) {
			pi.unregisterProvider("ollama");
			providerRegistered = false;
		}
		toolsPromise = null;
	});
}
