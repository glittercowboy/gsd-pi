// GSD2 — LLM-callable Ollama management tool
/**
 * Registers an ollama_manage tool that the LLM can call to interact
 * with the local Ollama instance — list models, pull new ones, check status.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
import * as client from "./ollama-client.js";
import { discoverModels, formatModelForDisplay } from "./ollama-discovery.js";
import { formatModelSize } from "./model-capabilities.js";

interface OllamaToolDetails {
	action: string;
	model?: string;
	modelCount?: number;
	durationMs: number;
	error?: string;
}

export function registerOllamaTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ollama_manage",
		label: "Ollama",
		description:
			"Manage local Ollama models. List available models, pull new ones, " +
			"check Ollama status, or see running models and resource usage. " +
			"Use this when you need a specific local model that isn't available yet.",
		promptSnippet: "Manage local Ollama models (list, pull, status, ps)",
		promptGuidelines: [
			"Use 'list' to see what models are available locally before trying to use one.",
			"Use 'pull' to download a model that isn't available yet.",
			"Use 'remove' to delete a local model that is no longer needed.",
			"Use 'show' to get detailed info about a model (parameters, quantization, families).",
			"Use 'status' to check if Ollama is running.",
			"Use 'ps' to see which models are loaded in memory and VRAM usage.",
			"Common models: llama3.1:8b, qwen2.5-coder:7b, deepseek-r1:8b, codestral:22b",
		],
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("list"),
					Type.Literal("pull"),
					Type.Literal("remove"),
					Type.Literal("show"),
					Type.Literal("status"),
					Type.Literal("ps"),
				],
				{ description: "Action to perform" },
			),
			model: Type.Optional(
				Type.String({ description: "Model name (required for pull)" }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const startTime = Date.now();
			const { action, model } = params;

			try {
				switch (action) {
					case "status": {
						const running = await client.isRunning();
						if (!running) {
							return {
								content: [{ type: "text", text: "Ollama is not running. It needs to be started with 'ollama serve'." }],
								details: { action, durationMs: Date.now() - startTime } as OllamaToolDetails,
							};
						}
						const version = await client.getVersion();
						return {
							content: [{ type: "text", text: `Ollama${version ? ` v${version}` : ""} is running at ${client.getOllamaHost()}` }],
							details: { action, durationMs: Date.now() - startTime } as OllamaToolDetails,
						};
					}

					case "list": {
						const running = await client.isRunning();
						if (!running) {
							return {
								content: [{ type: "text", text: "Ollama is not running." }],
								isError: true,
								details: { action, durationMs: Date.now() - startTime, error: "not_running" } as OllamaToolDetails,
							};
						}

						const models = await discoverModels();
						if (models.length === 0) {
							return {
								content: [{ type: "text", text: "No models available. Pull one with action='pull'." }],
								details: { action, modelCount: 0, durationMs: Date.now() - startTime } as OllamaToolDetails,
							};
						}

						const lines = models.map((m) => formatModelForDisplay(m));
						return {
							content: [{ type: "text", text: `Available models:\n${lines.join("\n")}` }],
							details: { action, modelCount: models.length, durationMs: Date.now() - startTime } as OllamaToolDetails,
						};
					}

					case "pull": {
						if (!model) {
							return {
								content: [{ type: "text", text: "Error: 'model' parameter is required for pull action." }],
								isError: true,
								details: { action, durationMs: Date.now() - startTime, error: "missing_model" } as OllamaToolDetails,
							};
						}

						const running = await client.isRunning();
						if (!running) {
							return {
								content: [{ type: "text", text: "Ollama is not running." }],
								isError: true,
								details: { action, model, durationMs: Date.now() - startTime, error: "not_running" } as OllamaToolDetails,
							};
						}

						let lastStatus = "";
						await client.pullModel(model, (progress) => {
							if (progress.total && progress.completed) {
								const pct = Math.floor((progress.completed / progress.total) * 100);
								const status = `Pulling ${model}... ${pct}%`;
								if (status !== lastStatus) {
									lastStatus = status;
									onUpdate?.({ content: [{ type: "text", text: status }], details: { action, model, durationMs: Date.now() - startTime } as OllamaToolDetails });
								}
							} else if (progress.status && progress.status !== lastStatus) {
								lastStatus = progress.status;
								onUpdate?.({ content: [{ type: "text", text: `${model}: ${progress.status}` }], details: { action, model, durationMs: Date.now() - startTime } as OllamaToolDetails });
							}
						}, signal);

						return {
							content: [{ type: "text", text: `Successfully pulled ${model}` }],
							details: { action, model, durationMs: Date.now() - startTime } as OllamaToolDetails,
						};
					}

					case "ps": {
						const running = await client.isRunning();
						if (!running) {
							return {
								content: [{ type: "text", text: "Ollama is not running." }],
								isError: true,
								details: { action, durationMs: Date.now() - startTime, error: "not_running" } as OllamaToolDetails,
							};
						}

						const ps = await client.getRunningModels();
						if (!ps.models || ps.models.length === 0) {
							return {
								content: [{ type: "text", text: "No models currently loaded in memory." }],
								details: { action, modelCount: 0, durationMs: Date.now() - startTime } as OllamaToolDetails,
							};
						}

						const lines = ps.models.map((m) => {
							const vram = m.size_vram > 0 ? `${formatModelSize(m.size_vram)} VRAM` : "CPU";
							return `${m.name} — ${formatModelSize(m.size)} total, ${vram}`;
						});

						return {
							content: [{ type: "text", text: `Loaded models:\n${lines.join("\n")}` }],
							details: { action, modelCount: ps.models.length, durationMs: Date.now() - startTime } as OllamaToolDetails,
						};
					}

					case "remove": {
						if (!model) {
							return {
								content: [{ type: "text", text: "Error: 'model' parameter is required for remove action." }],
								isError: true,
								details: { action, durationMs: Date.now() - startTime, error: "missing_model" } as OllamaToolDetails,
							};
						}

						const running = await client.isRunning();
						if (!running) {
							return {
								content: [{ type: "text", text: "Ollama is not running." }],
								isError: true,
								details: { action, model, durationMs: Date.now() - startTime, error: "not_running" } as OllamaToolDetails,
							};
						}

						await client.deleteModel(model);
						return {
							content: [{ type: "text", text: `Successfully removed ${model}` }],
							details: { action, model, durationMs: Date.now() - startTime } as OllamaToolDetails,
						};
					}

					case "show": {
						if (!model) {
							return {
								content: [{ type: "text", text: "Error: 'model' parameter is required for show action." }],
								isError: true,
								details: { action, durationMs: Date.now() - startTime, error: "missing_model" } as OllamaToolDetails,
							};
						}

						const running = await client.isRunning();
						if (!running) {
							return {
								content: [{ type: "text", text: "Ollama is not running." }],
								isError: true,
								details: { action, model, durationMs: Date.now() - startTime, error: "not_running" } as OllamaToolDetails,
							};
						}

						const info = await client.showModel(model);
						const details = info.details;
						const infoLines = [
							`Model: ${model}`,
							`Family: ${details.family}`,
							`Parameters: ${details.parameter_size}`,
							`Quantization: ${details.quantization_level}`,
							`Format: ${details.format}`,
						];
						if (details.families?.length) {
							infoLines.push(`Families: ${details.families.join(", ")}`);
						}
						if (info.parameters) {
							infoLines.push(`\nModelfile parameters:\n${info.parameters}`);
						}

						return {
							content: [{ type: "text", text: infoLines.join("\n") }],
							details: { action, model, durationMs: Date.now() - startTime } as OllamaToolDetails,
						};
					}

					default:
						return {
							content: [{ type: "text", text: `Unknown action: ${action}` }],
							isError: true,
							details: { action, durationMs: Date.now() - startTime, error: "unknown_action" } as OllamaToolDetails,
						};
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Ollama error: ${msg}` }],
					isError: true,
					details: { action, model, durationMs: Date.now() - startTime, error: msg } as OllamaToolDetails,
				};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("ollama "));
			text += theme.fg("accent", args.action);
			if (args.model) {
				text += theme.fg("dim", ` ${args.model}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial, expanded }, theme) {
			const d = result.details as OllamaToolDetails | undefined;

			if (isPartial) return new Text(theme.fg("warning", "Working..."), 0, 0);
			if ((result as any).isError || d?.error) {
				return new Text(theme.fg("error", `Error: ${d?.error ?? "unknown"}`), 0, 0);
			}

			let text = theme.fg("success", d?.action ?? "done");
			if (d?.modelCount !== undefined) {
				text += theme.fg("dim", ` (${d.modelCount} models)`);
			}
			text += theme.fg("dim", ` ${d?.durationMs ?? 0}ms`);

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const preview = content.text.split("\n").slice(0, 10).join("\n");
					text += "\n\n" + theme.fg("dim", preview);
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
