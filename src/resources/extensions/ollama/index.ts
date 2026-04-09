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
import * as client from "./ollama-client.js";
import { discoverModels } from "./ollama-discovery.js";
import { registerOllamaCommands } from "./ollama-commands.js";
import { streamOllamaChat } from "./ollama-chat-provider.js";

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

	const baseUrl = client.getOllamaHost();

	// Use authMode "apiKey" with a dummy key (#3440).
	// authMode "none" requires a custom streamSimple handler, but Ollama uses
	// the standard OpenAI-compatible streaming endpoint. Ollama ignores the
	// Authorization header so the dummy key is harmless.
	pi.registerProvider("ollama", {
		authMode: "apiKey",
		apiKey: "ollama",
		baseUrl,
		api: "ollama-chat",
		streamSimple: streamOllamaChat,
		isReady: () => true,
		models: models.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			providerOptions: (m.ollamaOptions ?? {}) as Record<string, unknown>,
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

		// In headless/auto mode, await the probe so the fallback resolver can
		// see Ollama before the first LLM call (#3531 race condition).
		// In interactive mode, keep it async for fast startup.
		if (!ctx.hasUI) {
			try {
				await probeAndRegister(pi);
			} catch { /* non-fatal */ }
		} else {
			probeAndRegister(pi)
				.then((found) => {
					if (found) ctx.ui.setStatus("ollama", "Ollama");
				})
				.catch(() => {});
		}
	});

	pi.on("session_shutdown", async () => {
		if (providerRegistered) {
			pi.unregisterProvider("ollama");
			providerRegistered = false;
		}
		toolsPromise = null;
	});
}
