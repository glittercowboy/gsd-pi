/**
 * Cmd+K style command picker overlay with fuzzy search.
 */

import type { ExtensionAPI, ExtensionContext, Theme, SlashCommandInfo } from "@gsd/pi-coding-agent";
import { matchesKey, fuzzyFilter, truncateToWidth } from "@gsd/pi-tui";
import { shortcutDesc } from "../shared/mod.js";

const BUILTIN_COMMANDS: Array<{ name: string; description: string }> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model" },
	{ name: "scoped-models", description: "Enable/disable models for cycling" },
	{ name: "export", description: "Export session to HTML" },
	{ name: "share", description: "Share session as GitHub gist" },
	{ name: "copy", description: "Copy last message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info" },
	{ name: "hotkeys", description: "Show keyboard shortcuts" },
	{ name: "fork", description: "Fork from a previous message" },
	{ name: "tree", description: "Navigate session tree" },
	{ name: "provider", description: "Manage provider configuration" },
	{ name: "login", description: "Login with OAuth" },
	{ name: "logout", description: "Logout from OAuth" },
	{ name: "new", description: "Start new session" },
	{ name: "compact", description: "Compact session context" },
	{ name: "resume", description: "Resume a session" },
	{ name: "reload", description: "Reload extensions and resources" },
	{ name: "thinking", description: "Set thinking level" },
	{ name: "edit-mode", description: "Toggle edit mode" },
	{ name: "quit", description: "Quit" },
];

interface CommandItem {
	name: string;
	description: string;
	source: string;
}

class CommandPickerOverlay {
	private tui: { requestRender: () => void };
	private theme: Theme;
	private onClose: () => void;
	private onSelect: (command: string) => void;
	private items: CommandItem[];
	private filteredItems: CommandItem[];
	private selectedIndex = 0;
	private query = "";
	private maxVisible = 12;
	private cachedLines?: string[];
	private cachedWidth?: number;

	constructor(
		tui: { requestRender: () => void },
		theme: Theme,
		items: CommandItem[],
		onClose: () => void,
		onSelect: (command: string) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.items = items;
		this.filteredItems = items;
		this.onClose = onClose;
		this.onSelect = onSelect;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	private applyFilter(): void {
		if (!this.query) {
			this.filteredItems = this.items;
		} else {
			this.filteredItems = fuzzyFilter(
				this.items,
				this.query,
				(item) => `${item.name} ${item.description}`,
			);
		}
		this.selectedIndex = 0;
		this.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
			return;
		}

		if (matchesKey(data, "enter")) {
			const item = this.filteredItems[this.selectedIndex];
			if (item) {
				this.onSelect(`/${item.name}`);
			}
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
			this.selectedIndex = this.selectedIndex === 0
				? this.filteredItems.length - 1
				: this.selectedIndex - 1;
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1
				? 0
				: this.selectedIndex + 1;
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.query.length > 0) {
				this.query = this.query.slice(0, -1);
				this.applyFilter();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "ctrl+u")) {
			this.query = "";
			this.applyFilter();
			this.tui.requestRender();
			return;
		}

		// Printable characters
		if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
			this.query += data;
			this.applyFilter();
			this.tui.requestRender();
			return;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme;
		const lines: string[] = [];
		const innerWidth = width - 4;

		// Title bar
		lines.push(th.bold("  Command Palette"));
		lines.push(th.fg("borderMuted", "  " + "─".repeat(Math.max(0, innerWidth))));

		// Search input
		const searchPrefix = th.fg("accent", "  / ");
		const queryDisplay = this.query || th.fg("dim", "type to search...");
		lines.push(`${searchPrefix}${queryDisplay}`);
		lines.push(th.fg("borderMuted", "  " + "─".repeat(Math.max(0, innerWidth))));

		// Results
		if (this.filteredItems.length === 0) {
			lines.push(th.fg("dim", "  No matching commands"));
		} else {
			const startIndex = Math.max(
				0,
				Math.min(
					this.selectedIndex - Math.floor(this.maxVisible / 2),
					this.filteredItems.length - this.maxVisible,
				),
			);
			const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

			for (let i = startIndex; i < endIndex; i++) {
				const item = this.filteredItems[i];
				if (!item) continue;

				const isSelected = i === this.selectedIndex;
				const prefix = isSelected ? "  → " : "    ";
				const nameStr = `/${item.name}`;
				const sourceTag = item.source !== "builtin" ? ` [${item.source}]` : "";

				const maxNameWidth = Math.min(30, innerWidth - 4);
				const truncName = truncateToWidth(nameStr, maxNameWidth, "");
				const descSpace = innerWidth - truncName.length - sourceTag.length - 4;
				const desc = item.description && descSpace > 10
					? "  " + truncateToWidth(item.description, descSpace, "")
					: "";

				if (isSelected) {
					lines.push(th.fg("accent", `${prefix}${truncName}`) + th.fg("dim", desc + sourceTag));
				} else {
					lines.push(`${prefix}${truncName}` + th.fg("dim", desc + sourceTag));
				}
			}

			if (this.filteredItems.length > this.maxVisible) {
				lines.push(th.fg("dim", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`));
			}
		}

		lines.push(th.fg("borderMuted", "  " + "─".repeat(Math.max(0, innerWidth))));
		lines.push(th.fg("dim", "  ↑↓ navigate  ⏎ select  esc close"));

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

export default function commandPicker(pi: ExtensionAPI): void {
	const openPicker = async (ctx: ExtensionContext) => {
		const commands = pi.getCommands();
		const items: CommandItem[] = [];

		// Add builtin commands
		for (const cmd of BUILTIN_COMMANDS) {
			items.push({ name: cmd.name, description: cmd.description, source: "builtin" });
		}

		// Add extension/prompt/skill commands and expand subcommands
		for (const cmd of commands) {
			const source = cmd.source === "extension" ? "ext" : cmd.source;
			items.push({
				name: cmd.name,
				description: cmd.description ?? "",
				source,
			});

			// Expand subcommands for commands that have argument completions
			const completions = pi.getCommandCompletions(cmd.name, "");
			if (completions && completions.length > 0) {
				for (const sub of completions) {
					items.push({
						name: `${cmd.name} ${sub.value}`,
						description: sub.description ?? "",
						source,
					});
				}
			}
		}

		const sourceOrder: Record<string, number> = { builtin: 0, prompt: 1, ext: 2, skill: 3 };
		items.sort((a, b) => (sourceOrder[a.source] ?? 99) - (sourceOrder[b.source] ?? 99));

		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				return new CommandPickerOverlay(
					tui,
					theme,
					items,
					() => done(),
					(command) => {
						done();
						ctx.ui.setEditorText(command);
					},
				);
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center" as const,
					width: "60%",
					maxHeight: "70%",
				},
			},
		);
	};

	pi.registerShortcut("ctrl+/", {
		description: shortcutDesc("Command palette", "/commands"),
		handler: openPicker,
	});

	pi.registerCommand("commands", {
		description: "Open command palette (fuzzy search all commands)",
		handler: async (_args, ctx) => {
			await openPicker(ctx);
		},
	});
}
