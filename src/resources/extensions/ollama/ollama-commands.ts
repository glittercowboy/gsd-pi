// GSD2 — Ollama slash commands

/**
 * Registers /ollama slash commands for managing local Ollama models.
 *
 * Commands:
 *   /ollama          — Show status (running?, version, loaded models)
 *   /ollama list     — List all available local models with sizes
 *   /ollama pull     — Pull a model with progress
 *   /ollama remove   — Delete a local model
 *   /ollama ps       — Show running models and resource usage
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Text } from "@gsd/pi-tui";
import * as client from "./ollama-client.js";
import { discoverModels, formatModelForDisplay } from "./ollama-discovery.js";
import { formatModelSize } from "./model-capabilities.js";

export function registerOllamaCommands(pi: ExtensionAPI): void {
	pi.registerCommand("ollama", {
		description: "Manage local Ollama models — list | pull | remove | ps",
		async handler(args, ctx) {
			const parts = (args ?? "").trim().split(/\s+/);
			const subcommand = parts[0] || "status";
			const modelArg = parts.slice(1).join(" ");

			switch (subcommand) {
				case "status":
					return await handleStatus(ctx);
				case "list":
				case "ls":
					return await handleList(ctx);
				case "pull":
					return await handlePull(modelArg, ctx);
				case "remove":
				case "rm":
				case "delete":
					return await handleRemove(modelArg, ctx);
				case "ps":
					return await handlePs(ctx);
				default:
					ctx.ui.notify(
						`Unknown subcommand: ${subcommand}. Use: status, list, pull, remove, ps`,
						"warning",
					);
			}
		},
	});
}

async function handleStatus(ctx: any): Promise<void> {
	const running = await client.isRunning();
	if (!running) {
		ctx.ui.notify(
			"Ollama is not running. Install from https://ollama.com and run 'ollama serve'",
			"warning",
		);
		return;
	}

	const version = await client.getVersion();
	const lines: string[] = [];
	lines.push(`Ollama${version ? ` v${version}` : ""} — running (${client.getOllamaHost()})`);

	// Show loaded models
	try {
		const ps = await client.getRunningModels();
		if (ps.models && ps.models.length > 0) {
			lines.push("");
			lines.push("Loaded:");
			for (const m of ps.models) {
				const vram = m.size_vram > 0 ? formatModelSize(m.size_vram) + " VRAM" : "CPU";
				const expiresAt = new Date(m.expires_at);
				const idleMs = expiresAt.getTime() - Date.now();
				const idleMin = Math.max(0, Math.floor(idleMs / 60000));
				lines.push(`  ${m.name}  ${vram}  expires in ${idleMin}m`);
			}
		}
	} catch {
		// ps endpoint may not be available on older versions
	}

	// Show available models
	try {
		const models = await discoverModels();
		if (models.length > 0) {
			lines.push("");
			lines.push("Available:");
			for (const m of models) {
				lines.push(`  ${formatModelForDisplay(m)}`);
			}
		} else {
			lines.push("");
			lines.push("No models pulled. Use /ollama pull <model> to get started.");
		}
	} catch (err) {
		lines.push("");
		lines.push(`Error listing models: ${err instanceof Error ? err.message : String(err)}`);
	}

	await ctx.ui.custom(
		(tui: any, theme: any, _kb: any, done: (r: undefined) => void) => {
			const text = new Text(lines.map((l) => theme.fg("fg", l)).join("\n"), 0, 0);
			setTimeout(() => done(undefined), 0);
			return text;
		},
	);
}

async function handleList(ctx: any): Promise<void> {
	const running = await client.isRunning();
	if (!running) {
		ctx.ui.notify("Ollama is not running", "warning");
		return;
	}

	const models = await discoverModels();
	if (models.length === 0) {
		ctx.ui.notify("No models available. Use /ollama pull <model> to download one.", "info");
		return;
	}

	const lines = ["Local Ollama models:", ""];
	for (const m of models) {
		lines.push(`  ${formatModelForDisplay(m)}`);
	}

	await ctx.ui.custom(
		(tui: any, theme: any, _kb: any, done: (r: undefined) => void) => {
			const text = new Text(lines.map((l) => theme.fg("fg", l)).join("\n"), 0, 0);
			setTimeout(() => done(undefined), 0);
			return text;
		},
	);
}

async function handlePull(modelName: string, ctx: any): Promise<void> {
	if (!modelName) {
		ctx.ui.notify("Usage: /ollama pull <model> (e.g. /ollama pull llama3.1:8b)", "warning");
		return;
	}

	const running = await client.isRunning();
	if (!running) {
		ctx.ui.notify("Ollama is not running", "warning");
		return;
	}

	ctx.ui.setWidget("ollama-pull", [`Pulling ${modelName}...`]);

	try {
		let lastPercent = -1;
		await client.pullModel(modelName, (progress) => {
			if (progress.total && progress.completed) {
				const percent = Math.floor((progress.completed / progress.total) * 100);
				if (percent !== lastPercent) {
					lastPercent = percent;
					const completed = formatModelSize(progress.completed);
					const total = formatModelSize(progress.total);
					ctx.ui.setWidget("ollama-pull", [
						`Pulling ${modelName}... ${percent}% (${completed} / ${total})`,
					]);
				}
			} else if (progress.status) {
				ctx.ui.setWidget("ollama-pull", [`${modelName}: ${progress.status}`]);
			}
		});

		ctx.ui.setWidget("ollama-pull", undefined);
		ctx.ui.notify(`${modelName} pulled successfully`, "success");
	} catch (err) {
		ctx.ui.setWidget("ollama-pull", undefined);
		ctx.ui.notify(
			`Failed to pull ${modelName}: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

async function handleRemove(modelName: string, ctx: any): Promise<void> {
	if (!modelName) {
		ctx.ui.notify("Usage: /ollama remove <model>", "warning");
		return;
	}

	const running = await client.isRunning();
	if (!running) {
		ctx.ui.notify("Ollama is not running", "warning");
		return;
	}

	const confirmed = await ctx.ui.confirm(
		"Delete model",
		`Are you sure you want to delete ${modelName}?`,
	);

	if (!confirmed) return;

	try {
		await client.deleteModel(modelName);
		ctx.ui.notify(`${modelName} deleted`, "success");
	} catch (err) {
		ctx.ui.notify(
			`Failed to delete ${modelName}: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

async function handlePs(ctx: any): Promise<void> {
	const running = await client.isRunning();
	if (!running) {
		ctx.ui.notify("Ollama is not running", "warning");
		return;
	}

	try {
		const ps = await client.getRunningModels();
		if (!ps.models || ps.models.length === 0) {
			ctx.ui.notify("No models currently loaded in memory", "info");
			return;
		}

		const lines = ["Running models:", ""];
		for (const m of ps.models) {
			const vram = m.size_vram > 0 ? formatModelSize(m.size_vram) + " VRAM" : "CPU only";
			const totalSize = formatModelSize(m.size);
			const expiresAt = new Date(m.expires_at);
			const idleMs = expiresAt.getTime() - Date.now();
			const idleMin = Math.max(0, Math.floor(idleMs / 60000));
			lines.push(`  ${m.name}  ${totalSize}  ${vram}  expires in ${idleMin}m`);
		}

		await ctx.ui.custom(
			(tui: any, theme: any, _kb: any, done: (r: undefined) => void) => {
				const text = new Text(lines.map((l) => theme.fg("fg", l)).join("\n"), 0, 0);
				setTimeout(() => done(undefined), 0);
				return text;
			},
		);
	} catch (err) {
		ctx.ui.notify(
			`Failed to get running models: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}
