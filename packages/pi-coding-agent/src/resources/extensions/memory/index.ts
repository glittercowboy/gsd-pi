/**
 * Memory extraction extension.
 *
 * Automated two-phase pipeline that extracts durable knowledge from session
 * transcripts and consolidates into project-scoped memory artifacts injected
 * into future sessions.
 *
 * Lifecycle:
 * - session_start (depth 0): fire-and-forget pipeline.runStartup()
 * - before_agent_start: inject memory_summary.md into system prompt
 * - /memory command: view, clear, rebuild, stats
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@gsd/pi-coding-agent";
import { completeSimple } from "@gsd/pi-ai";
import { createHash } from "crypto";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { getFullMemory, getMemorySummary, runStartup } from "./pipeline.js";
import { MemoryStorage } from "./storage.js";

/** Encode cwd to a filesystem-safe directory name */
function encodeCwd(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

/** Get the memory directory for a project */
function getMemoryDir(cwd: string): string {
	return join(getAgentDir(), "memories", encodeCwd(cwd));
}

/** Get the database path */
function getDbPath(): string {
	return join(getAgentDir(), "agent.db");
}

let storageInstance: MemoryStorage | null = null;

async function getStorage(): Promise<MemoryStorage> {
	if (!storageInstance) {
		storageInstance = await MemoryStorage.create(getDbPath());
	}
	return storageInstance;
}

export default function memoryExtension(api: ExtensionAPI): void {
	interface MemorySettingsResolved {
		enabled: boolean;
		maxRolloutsPerStartup: number;
		maxRolloutAgeDays: number;
		minRolloutIdleHours: number;
		stage1Concurrency: number;
		summaryInjectionTokenLimit: number;
	}

	let memorySettings: MemorySettingsResolved;
	try {
		const sm = SettingsManager.create();
		memorySettings = sm.getMemorySettings();
	} catch {
		memorySettings = {
			enabled: false,
			maxRolloutsPerStartup: 64,
			maxRolloutAgeDays: 30,
			minRolloutIdleHours: 12,
			stage1Concurrency: 8,
			summaryInjectionTokenLimit: 5000,
		};
	}

	if (!memorySettings.enabled) {
		api.registerCommand("memory", {
			description: "Memory extraction pipeline (disabled - enable in settings)",
			handler: async (_args, ctx) => {
				ctx.ui.notify(
					'Memory extraction is disabled. Enable it with: settings.json \u2192 "memory": { "enabled": true }',
					"info",
				);
			},
		});
		return;
	}

	let cwd = "";
	let memoryDir = "";

	// On session start, fire-and-forget the pipeline
	api.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		memoryDir = getMemoryDir(cwd);

		if (!existsSync(memoryDir)) {
			mkdirSync(memoryDir, { recursive: true });
		}

		const sessionsDir = join(getAgentDir(), "sessions");

		// Create the LLM call function using the extension context
		const llmCall = async (
			system: string,
			user: string,
			options?: { maxTokens?: number },
		): Promise<string> => {
			const model = ctx.model;
			if (!model) {
				throw new Error("No model available for memory extraction");
			}

			const result = await completeSimple(
				model,
				{
					systemPrompt: system,
					messages: [{ role: "user" as const, content: user, timestamp: Date.now() }],
				},
				{ maxTokens: options?.maxTokens ?? 4096 },
			);

			// Extract text from the result
			const textParts = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text);
			return textParts.join("");
		};

		// Fire and forget
		runStartup(
			await getStorage(),
			{
				sessionsDir,
				memoryDir,
				cwd,
				maxRolloutsPerStartup: memorySettings.maxRolloutsPerStartup,
				maxRolloutAgeDays: memorySettings.maxRolloutAgeDays,
				minRolloutIdleHours: memorySettings.minRolloutIdleHours,
				stage1Concurrency: memorySettings.stage1Concurrency,
			},
			llmCall,
		).catch(() => {
			// Memory extraction is best-effort
		});
	});

	// Inject memory summary into system prompt
	api.on("before_agent_start", async (_event, ctx) => {
		if (!memoryDir) {
			memoryDir = getMemoryDir(ctx.cwd);
		}

		const summary = getMemorySummary(memoryDir);
		if (summary) {
			const charLimit = memorySettings.summaryInjectionTokenLimit * 4;
			const truncated =
				summary.length > charLimit
					? summary.slice(0, charLimit) + "\n[...truncated]"
					: summary;

			return {
				systemPrompt: _event.systemPrompt + "\n\n" + truncated,
			};
		}
	});

	// Register /memory command
	api.registerCommand("memory", {
		description: "View or manage extracted project memories",
		getArgumentCompletions: (prefix) => {
			const subcommands = [
				{ label: "view", description: "View current memories (default)" },
				{ label: "clear", description: "Clear all memories for this project" },
				{ label: "rebuild", description: "Re-extract all memories" },
				{ label: "stats", description: "Show pipeline statistics" },
			];
			return subcommands
				.filter((s) => s.label.startsWith(prefix))
				.map((s) => ({ value: s.label, label: s.label, description: s.description }));
		},
		handler: async (args, ctx) => {
			const subcommand = args.trim().split(/\s+/)[0] || "view";
			const projectMemoryDir = getMemoryDir(ctx.cwd);

			switch (subcommand) {
				case "view": {
					const memory = getFullMemory(projectMemoryDir);
					if (memory) {
						api.sendMessage({
							customType: "memory:view",
							content: memory,
							display: true,
						});
					} else {
						ctx.ui.notify(
							"No memories extracted yet. Memories are extracted on session startup.",
							"info",
						);
					}
					break;
				}

				case "clear": {
					const confirmed = await ctx.ui.confirm(
						"Clear Memories",
						"Delete all extracted memories for this project?",
					);
					if (confirmed) {
						(await getStorage()).clearForCwd(ctx.cwd);
						if (existsSync(projectMemoryDir)) {
							rmSync(projectMemoryDir, { recursive: true, force: true });
						}
						ctx.ui.notify("Memories cleared.", "info");
					}
					break;
				}

				case "rebuild": {
					const confirmed = await ctx.ui.confirm(
						"Rebuild Memories",
						"Re-extract all memories from session history? This may take a while.",
					);
					if (confirmed) {
						(await getStorage()).resetAllForCwd(ctx.cwd);
						if (existsSync(projectMemoryDir)) {
							rmSync(projectMemoryDir, { recursive: true, force: true });
						}
						ctx.ui.notify(
							"Memory rebuild enqueued. Extraction will run on next session startup.",
							"info",
						);
					}
					break;
				}

				case "stats": {
					const stats = (await getStorage()).getStats();
					const statsText = [
						"Memory Pipeline Statistics:",
						`  Total sessions tracked: ${stats.totalThreads}`,
						`  Pending extraction: ${stats.pendingThreads}`,
						`  Extracted: ${stats.doneThreads}`,
						`  Errors: ${stats.errorThreads}`,
						`  Stage 1 outputs: ${stats.totalStage1Outputs}`,
						`  Pending stage 1 jobs: ${stats.pendingStage1Jobs}`,
						`  Memory dir: ${projectMemoryDir}`,
						`  Memory exists: ${existsSync(join(projectMemoryDir, "MEMORY.md"))}`,
					].join("\n");
					api.sendMessage({
						customType: "memory:stats",
						content: statsText,
						display: true,
					});
					break;
				}

				default:
					ctx.ui.notify(
						`Unknown subcommand: ${subcommand}. Use: view, clear, rebuild, stats`,
						"warning",
					);
			}
		},
	});

	// Cleanup on shutdown
	api.on("session_shutdown", async () => {
		if (storageInstance) {
			storageInstance.close();
			storageInstance = null;
		}
	});
}
