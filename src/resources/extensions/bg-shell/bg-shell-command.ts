/**
 * /bg slash command registration — interactive process manager overlay and CLI subcommands.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Key } from "@gsd/pi-tui";
import { shortcutDesc } from "../shared/terminal.js";

import {
	processes,
	killProcess,
	getGroupStatus,
	cleanupAll,
} from "./process-manager.js";
import {
	generateDigest,
	getOutput,
	formatDigestText,
} from "./output-formatter.js";
import { formatUptime } from "./utilities.js";
import { BgManagerOverlay } from "./overlay.js";

import type { BgShellSharedState } from "./index.js";

export function registerBgShellCommand(pi: ExtensionAPI, state: BgShellSharedState): void {
	pi.registerCommand("bg", {
		description: "Manage background processes: /bg [list|output|kill|killall|groups] [id]",

		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["list", "output", "kill", "killall", "groups", "digest"];
			const parts = prefix.trim().split(/\s+/);

			if (parts.length <= 1) {
				return subcommands
					.filter(cmd => cmd.startsWith(parts[0] ?? ""))
					.map(cmd => ({ value: cmd, label: cmd }));
			}

			if (parts[0] === "output" || parts[0] === "kill" || parts[0] === "digest") {
				const idPrefix = parts[1] ?? "";
				return Array.from(processes.values())
					.filter(p => p.id.startsWith(idPrefix))
					.map(p => ({
						value: `${parts[0]} ${p.id}`,
						label: `${p.id} — ${p.label}`,
					}));
			}

			return [];
		},

		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0] || "list";

			if (sub === "list" || sub === "") {
				if (processes.size === 0) {
					ctx.ui.notify("No background processes.", "info");
					return;
				}

				if (!ctx.hasUI) {
					const lines = Array.from(processes.values()).map(p => {
						const statusIcon = p.alive
							? (p.status === "ready" ? "✓" : p.status === "error" ? "✗" : "⋯")
							: "○";
						const uptime = formatUptime(Date.now() - p.startedAt);
						const portInfo = p.ports.length > 0 ? ` :${p.ports.join(",")}` : "";
						return `${p.id}  ${statusIcon} ${p.status}  ${uptime}  ${p.label}  [${p.processType}]${portInfo}`;
					});
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				await ctx.ui.custom<void>(
					(tui, theme, _kb, done) => {
						return new BgManagerOverlay(tui, theme, () => {
							done();
							state.refreshWidget();
						});
					},
					{
						overlay: true,
						overlayOptions: {
							width: "60%",
							minWidth: 50,
							maxHeight: "70%",
							anchor: "center",
						},
					},
				);
				return;
			}

			if (sub === "output" || sub === "digest") {
				const id = parts[1];
				if (!id) {
					ctx.ui.notify(`Usage: /bg ${sub} <id>`, "error");
					return;
				}
				const bg = processes.get(id);
				if (!bg) {
					ctx.ui.notify(`No process with id '${id}'`, "error");
					return;
				}

				if (!ctx.hasUI) {
					if (sub === "digest") {
						const digest = generateDigest(bg);
						ctx.ui.notify(formatDigestText(bg, digest), "info");
					} else {
						const output = getOutput(bg, { stream: "both", tail: 50 });
						ctx.ui.notify(output || "(no output)", "info");
					}
					return;
				}

				await ctx.ui.custom<void>(
					(tui, theme, _kb, done) => {
						const overlay = new BgManagerOverlay(tui, theme, () => {
							done();
							state.refreshWidget();
						});
						const procs = Array.from(processes.values());
						const idx = procs.findIndex(p => p.id === id);
						if (idx >= 0) overlay.selectAndView(idx);
						return overlay;
					},
					{
						overlay: true,
						overlayOptions: {
							width: "60%",
							minWidth: 50,
							maxHeight: "70%",
							anchor: "center",
						},
					},
				);
				return;
			}

			if (sub === "kill") {
				const id = parts[1];
				if (!id) {
					ctx.ui.notify("Usage: /bg kill <id>", "error");
					return;
				}
				const bg = processes.get(id);
				if (!bg) {
					ctx.ui.notify(`No process with id '${id}'`, "error");
					return;
				}
				killProcess(id, "SIGTERM");
				await new Promise(r => setTimeout(r, 300));
				if (bg.alive) {
					killProcess(id, "SIGKILL");
					await new Promise(r => setTimeout(r, 200));
				}
				if (!bg.alive) processes.delete(id);
				ctx.ui.notify(`Killed process ${id} (${bg.label})`, "info");
				return;
			}

			if (sub === "killall") {
				const count = processes.size;
				cleanupAll();
				ctx.ui.notify(`Killed ${count} background process(es)`, "info");
				return;
			}

			if (sub === "groups") {
				const groups = new Set<string>();
				for (const p of processes.values()) {
					if (p.group) groups.add(p.group);
				}
				if (groups.size === 0) {
					ctx.ui.notify("No process groups defined.", "info");
					return;
				}
				const lines = Array.from(groups).map(g => {
					const gs = getGroupStatus(g);
					const icon = gs.healthy ? "✓" : "✗";
					const procs = gs.processes.map(p => `${p.id}(${p.status})`).join(", ");
					return `${icon} ${g}: ${procs}`;
				});
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			ctx.ui.notify("Usage: /bg [list|output|digest|kill|killall|groups] [id]", "info");
		},
	});

	// ── Ctrl+Alt+B shortcut ──────────────────────────────────────────────

	pi.registerShortcut(Key.ctrlAlt("b"), {
		description: shortcutDesc("Open background process manager", "/bg"),
		handler: async (ctx) => {
			state.latestCtx = ctx;
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					return new BgManagerOverlay(tui, theme, () => {
						done();
						state.refreshWidget();
					});
				},
				{
					overlay: true,
					overlayOptions: {
						width: "60%",
						minWidth: 50,
						maxHeight: "70%",
						anchor: "center",
					},
				},
			);
		},
	});
}
