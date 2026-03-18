/**
 * bg_shell lifecycle hook registration — session events, compaction awareness,
 * context injection, process discovery, footer widget, and periodic maintenance.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@gsd/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
} from "@gsd/pi-tui";

import {
	processes,
	pendingAlerts,
	cleanupAll,
	cleanupSessionProcesses,
	persistManifest,
	loadManifest,
	pruneDeadProcesses,
} from "./process-manager.js";
import { formatUptime, resolveBgShellPersistenceCwd } from "./utilities.js";
import { formatTokenCount } from "../shared/format-utils.js";

import type { BgShellSharedState } from "./index.js";

export function registerBgShellLifecycle(pi: ExtensionAPI, state: BgShellSharedState): void {

	function syncLatestCtxCwd(): void {
		if (!state.latestCtx) return;
		const syncedCwd = resolveBgShellPersistenceCwd(state.latestCtx.cwd);
		if (syncedCwd !== state.latestCtx.cwd) {
			state.latestCtx = { ...state.latestCtx, cwd: syncedCwd };
		}
	}

	// Clean up on session shutdown
	pi.on("session_shutdown", async () => {
		cleanupAll();
	});

	// Register signal handlers to clean up bg processes on unexpected exit (fixes #428)
	const signalCleanup = () => {
		cleanupAll();
	};
	process.on("SIGTERM", signalCleanup);
	process.on("SIGINT", signalCleanup);
	process.on("beforeExit", signalCleanup);

	// ── Compaction Awareness: Survive Context Resets ───────────────

	/** Build a compact state summary of all alive processes for context re-injection */
	function buildProcessStateAlert(reason: string): void {
		const alive = Array.from(processes.values()).filter(p => p.alive);
		if (alive.length === 0) return;

		const processSummaries = alive.map(p => {
			const portInfo = p.ports.length > 0 ? ` :${p.ports.join(",")}` : "";
			const urlInfo = p.urls.length > 0 ? ` ${p.urls[0]}` : "";
			const errInfo = p.recentErrors.length > 0 ? ` (${p.recentErrors.length} errors)` : "";
			const groupInfo = p.group ? ` [${p.group}]` : "";
			return `  - id:${p.id} "${p.label}" [${p.processType}] status:${p.status} uptime:${formatUptime(Date.now() - p.startedAt)}${portInfo}${urlInfo}${errInfo}${groupInfo}`;
		}).join("\n");

		pendingAlerts.push(
			`${reason} ${alive.length} background process(es) are still running:\n${processSummaries}\nUse bg_shell digest/output/kill with these IDs.`
		);
	}

	// After compaction, the LLM loses all memory of running processes.
	// Queue a detailed alert so the next before_agent_start injects full state.
	pi.on("session_compact", async () => {
		buildProcessStateAlert("Context was compacted.");
	});

	// Tree navigation also resets the agent's context.
	pi.on("session_tree", async () => {
		buildProcessStateAlert("Session tree was navigated.");
	});

	// Session switch resets the agent's context.
	pi.on("session_switch", async (event, ctx) => {
		state.latestCtx = ctx;
		if (event.reason === "new" && event.previousSessionFile) {
			await cleanupSessionProcesses(event.previousSessionFile);
			syncLatestCtxCwd();
			if (state.latestCtx) persistManifest(state.latestCtx.cwd);
		}
		buildProcessStateAlert("Session was switched.");
	});

	// ── Context Injection: Proactive Alerts ────────────────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		// Inject process status overview and any pending alerts
		const alerts = pendingAlerts.splice(0);
		const alive = Array.from(processes.values()).filter(p => p.alive);

		if (alerts.length === 0 && alive.length === 0) return;

		const parts: string[] = [];

		if (alerts.length > 0) {
			parts.push(`Background process alerts:\n${alerts.map(a => `  ${a}`).join("\n")}`);
		}

		if (alive.length > 0) {
			const summary = alive.map(p => {
				const status = p.status === "ready" ? "✓" : p.status === "error" ? "✗" : p.status === "starting" ? "⋯" : "?";
				const portInfo = p.ports.length > 0 ? ` :${p.ports.join(",")}` : "";
				const errInfo = p.recentErrors.length > 0 ? ` (${p.recentErrors.length} errors)` : "";
				return `  ${status} ${p.id} ${p.label}${portInfo}${errInfo}`;
			}).join("\n");
			parts.push(`Background processes:\n${summary}`);
		}

		return {
			message: {
				customType: "bg-shell-status",
				content: parts.join("\n\n"),
				display: false,
			},
		};
	});

	// ── Session Start: Discover Surviving Processes ────────────────────

	pi.on("session_start", async (_event, ctx) => {
		state.latestCtx = ctx;

		// Check for surviving processes from previous session
		const manifest = loadManifest(ctx.cwd);
		if (manifest.length > 0) {
			// Check which PIDs are still alive
			const surviving: typeof manifest = [];
			for (const entry of manifest) {
				if (entry.pid) {
					try {
						process.kill(entry.pid, 0); // Check if process exists
						surviving.push(entry);
					} catch { /* process is dead */ }
				}
			}

			if (surviving.length > 0) {
				const summary = surviving.map(s =>
					`  - ${s.id}: ${s.label} (pid ${s.pid}, type: ${s.processType}${s.group ? `, group: ${s.group}` : ""})`
				).join("\n");

				pendingAlerts.push(
					`${surviving.length} background process(es) from previous session still running:\n${summary}\n  Note: These processes are outside bg_shell's control. Kill them manually if needed.`
				);
			}
		}
	});

	// ── Live Footer ──────────────────────────────────────────────────────

	/** Whether we currently own the footer via setFooter */
	let footerActive = false;

	function buildBgStatusText(th: Theme): string {
		const alive = Array.from(processes.values()).filter(p => p.alive);
		if (alive.length === 0) return "";

		const sep = th.fg("dim", " · ");
		const items: string[] = [];
		for (const p of alive) {
			const statusIcon = p.status === "ready" ? th.fg("success", "●")
				: p.status === "error" ? th.fg("error", "●")
				: th.fg("warning", "●");
			const name = p.label.length > 14 ? p.label.slice(0, 12) + "…" : p.label;
			const portInfo = p.ports.length > 0 ? th.fg("dim", `:${p.ports[0]}`) : "";
			const errBadge = p.recentErrors.length > 0
				? th.fg("error", ` err:${p.recentErrors.length}`)
				: "";
			items.push(`${statusIcon} ${th.fg("muted", name)}${portInfo}${errBadge}`);
		}
		return items.join(sep);
	}

	/** Reference to tui for triggering re-renders when footer is active */
	let footerTui: { requestRender: () => void } | null = null;

	function refreshWidget() {
		if (!state.latestCtx?.hasUI) return;
		const alive = Array.from(processes.values()).filter(p => p.alive);

		if (alive.length === 0) {
			if (footerActive) {
				state.latestCtx.ui.setFooter(undefined);
				footerActive = false;
				footerTui = null;
			}
			return;
		}

		if (footerActive) {
			// Footer already installed — just trigger a re-render
			footerTui?.requestRender();
			return;
		}

		// Install custom footer that puts bg process info right-aligned on line 1
		footerActive = true;
		state.latestCtx.ui.setFooter((tui, th, footerData) => {
			footerTui = tui;
			const branchUnsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				render(width: number): string[] {
					// ── Line 1: pwd (branch) [session]  ...  bg status ──
					let pwd = process.cwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) {
						pwd = `~${pwd.slice(home.length)}`;
					}
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;

					const sessionName = state.latestCtx?.sessionManager?.getSessionName?.();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					const bgStatus = buildBgStatusText(th);
					const leftPwd = th.fg("dim", pwd);
					const leftWidth = visibleWidth(leftPwd);
					const rightWidth = visibleWidth(bgStatus);

					let pwdLine: string;
					const minGap = 2;
					if (bgStatus && leftWidth + minGap + rightWidth <= width) {
						const pad = " ".repeat(width - leftWidth - rightWidth);
						pwdLine = leftPwd + pad + bgStatus;
					} else if (bgStatus) {
						// Truncate pwd to make room for bg status
						const availForPwd = width - rightWidth - minGap;
						if (availForPwd > 10) {
							const truncPwd = truncateToWidth(leftPwd, availForPwd, th.fg("dim", "…"));
							const truncWidth = visibleWidth(truncPwd);
							const pad = " ".repeat(Math.max(0, width - truncWidth - rightWidth));
							pwdLine = truncPwd + pad + bgStatus;
						} else {
							pwdLine = truncateToWidth(leftPwd, width, th.fg("dim", "…"));
						}
					} else {
						pwdLine = truncateToWidth(leftPwd, width, th.fg("dim", "…"));
					}

					// ── Line 2: token stats (left) ... model (right) ──
					const ctx = state.latestCtx;
					const sm = ctx?.sessionManager;
					let totalInput = 0, totalOutput = 0;
					let totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;
					if (sm) {
						for (const entry of sm.getEntries()) {
							if (entry.type === "message" && (entry as any).message?.role === "assistant") {
								const u = (entry as any).message.usage;
								if (u) {
									totalInput += u.input || 0;
									totalOutput += u.output || 0;
									totalCacheRead += u.cacheRead || 0;
									totalCacheWrite += u.cacheWrite || 0;
									totalCost += u.cost?.total || 0;
								}
							}
						}
					}

					const contextUsage = ctx?.getContextUsage?.();
					const contextWindow = contextUsage?.contextWindow ?? ctx?.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent = contextUsage?.percent !== null ? (contextPercentValue).toFixed(1) : "?";

					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokenCount(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokenCount(totalOutput)}`);
					if (totalCacheRead) statsParts.push(`R${formatTokenCount(totalCacheRead)}`);
					if (totalCacheWrite) statsParts.push(`W${formatTokenCount(totalCacheWrite)}`);
					if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);

					const contextDisplay = contextPercent === "?"
						? `?/${formatTokenCount(contextWindow)}`
						: `${contextPercent}%/${formatTokenCount(contextWindow)}`;
					let contextStr: string;
					if (contextPercentValue > 90) {
						contextStr = th.fg("error", contextDisplay);
					} else if (contextPercentValue > 70) {
						contextStr = th.fg("warning", contextDisplay);
					} else {
						contextStr = contextDisplay;
					}
					statsParts.push(contextStr);

					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					const modelName = ctx?.model?.id || "no-model";
					let rightSide = modelName;
					if (ctx?.model?.reasoning) {
						const thinkingLevel = (ctx as any).getThinkingLevel?.() || "off";
						rightSide = thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
					}
					if (footerData.getAvailableProviderCount() > 1 && ctx?.model) {
						const withProvider = `(${ctx.model.provider}) ${rightSide}`;
						if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) {
							rightSide = withProvider;
						}
					}

					const rightSideWidth = visibleWidth(rightSide);
					let statsLine: string;
					if (statsLeftWidth + 2 + rightSideWidth <= width) {
						const pad = " ".repeat(width - statsLeftWidth - rightSideWidth);
						statsLine = statsLeft + pad + rightSide;
					} else {
						const avail = width - statsLeftWidth - 2;
						if (avail > 0) {
							const truncRight = truncateToWidth(rightSide, avail, "");
							const truncRightWidth = visibleWidth(truncRight);
							const pad = " ".repeat(Math.max(0, width - statsLeftWidth - truncRightWidth));
							statsLine = statsLeft + pad + truncRight;
						} else {
							statsLine = statsLeft;
						}
					}

					const dimStatsLeft = th.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const dimRemainder = th.fg("dim", remainder);

					const lines = [pwdLine, dimStatsLeft + dimRemainder];

					// ── Line 3 (optional): other extension statuses ──
					const extensionStatuses = footerData.getExtensionStatuses();
					// Filter out our own bg-shell status since it's already on line 1
					const otherStatuses = Array.from(extensionStatuses.entries())
						.filter(([key]) => key !== "bg-shell")
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
					if (otherStatuses.length > 0) {
						lines.push(truncateToWidth(otherStatuses.join(" "), width, th.fg("dim", "...")));
					}

					return lines;
				},
				invalidate() {},
				dispose() {
					branchUnsub();
					footerTui = null;
				},
			};
		});
	}

	// Expose refreshWidget via shared state so the command module can use it
	state.refreshWidget = refreshWidget;

	// Periodic maintenance
	const maintenanceInterval = setInterval(() => {
		pruneDeadProcesses();
		refreshWidget();
		// Persist manifest periodically
		if (state.latestCtx) {
			syncLatestCtxCwd();
			persistManifest(state.latestCtx.cwd);
		}
	}, 2000);

	// Refresh widget after agent actions and session events
	const refreshHandler = async (_event: unknown, ctx: ExtensionContext) => {
		state.latestCtx = ctx;
		refreshWidget();
	};
	pi.on("turn_end", refreshHandler as any);
	pi.on("agent_end", refreshHandler as any);
	pi.on("session_start", refreshHandler as any);
	pi.on("session_switch", refreshHandler as any);

	pi.on("tool_execution_end", async (_event, ctx) => {
		state.latestCtx = ctx;
		refreshWidget();
	});

	// Clean up on shutdown
	pi.on("session_shutdown", async () => {
		clearInterval(maintenanceInterval);
		if (state.latestCtx) {
			syncLatestCtxCwd();
			persistManifest(state.latestCtx.cwd);
		}
		cleanupAll();
	});
}
