/**
 * Shared next-action prompt for GSD extensions.
 *
 * Renders a consistent "step complete" UI at the end of every GSD stage:
 *
 *   ─────────────────────────────────────────
 *   ✓  Phase 1 research complete
 *
 *      [caller summary lines]
 *
 *      [optional extra content block]
 *
 *   Files written:
 *      .gsd/phases/01-foo/01-RESEARCH.md
 *
 *   › 1. Plan phase 1           ← recommended, pre-selected
 *        Create PLAN.md files for execution
 *
 *     2. Not yet
 *        Run /gsd-plan-phase 1 when ready.
 *   ─────────────────────────────────────────
 *
 * Usage:
 *
 *   const choice = await showNextAction(ctx, {
 *     title: "Phase 1 research complete",
 *     summary: ["6 libraries evaluated", "Stack: Phaser 3 + TypeScript"],
 *     files: ["/abs/path/to/01-RESEARCH.md"],
 *     extra: ["Wave 1: 01-01, 01-02  (parallel)", "Wave 2: 01-03"],
 *     actions: [
 *       { id: "plan",  label: "Plan phase 1",   description: "Create PLAN.md files for execution", recommended: true },
 *       { id: "later", label: "Discuss first",  description: "Capture constraints before planning" },
 *     ],
 *     notYetMessage: "Run /gsd-plan-phase 1 when ready.",
 *   });
 *
 *   // choice is one of the action ids, or "not_yet"
 *   if (choice === "plan") { ... }
 *
 * "Not yet" is always appended automatically as the last option.
 * Pressing Escape also resolves as "not_yet".
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { type Theme } from "@gsd/pi-coding-agent";
import { Key, matchesKey, type TUI } from "@gsd/pi-tui";
import { makeUI } from "./ui.js";

// ─── Public API ───────────────────────────────────────────────────────────────

export interface NextAction {
	/** Unique id returned when this action is chosen. */
	id: string;
	/** Short label shown in the list (e.g. "Plan phase 1"). */
	label: string;
	/** One-line description shown below the label. */
	description: string;
	/** Pre-selects this item and renders it with a (recommended) marker. At most one. */
	recommended?: boolean;
}

export interface NextActionOptions {
	/** Bold heading after the ✓ — e.g. "Phase 1 research complete". */
	title: string;
	/**
	 * Stage-specific narrative lines rendered below the title.
	 * Keep these short and informative.
	 */
	summary?: string[];
	/**
	 * Absolute paths to files that were written this step.
	 * Displayed as relative paths from cwd when possible.
	 */
	files?: string[];
	/**
	 * Optional extra content rendered between the file list and the actions.
	 * Each string is one display line — already formatted by the caller.
	 */
	extra?: string[];
	/** The action choices. "Not yet" is always appended automatically. */
	actions: NextAction[];
	/**
	 * Message shown in the "Not yet" description line.
	 * e.g. "Run /gsd-plan-phase 1 when ready."
	 */
	notYetMessage?: string;
	/**
	 * Current working directory — used to make file paths relative.
	 * Defaults to process.cwd().
	 */
	cwd?: string;
}

/**
 * Show the next-action prompt and return the chosen action id, or "not_yet".
 */
export async function showNextAction(
	ctx: ExtensionCommandContext,
	opts: NextActionOptions,
): Promise<string> {
	const cwd = opts.cwd ?? process.cwd();
	const notYetMessage = opts.notYetMessage ?? "Continue when ready.";

	const allActions: NextAction[] = [
		...opts.actions,
		{ id: "not_yet", label: "Not yet", description: notYetMessage },
	];

	const recommendedIdx = allActions.findIndex((a) => a.recommended);
	const defaultIdx = recommendedIdx >= 0 ? recommendedIdx : 0;

	const relativeFiles = (opts.files ?? []).map((f) => {
		try {
			const rel = f.startsWith(cwd) ? f.slice(cwd.length).replace(/^\//, "") : f;
			return rel || f;
		} catch {
			return f;
		}
	});

	const result = await ctx.ui.custom<string>((_tui: TUI, theme: Theme, _kb, done) => {
		let cursorIdx = defaultIdx;
		let cachedLines: string[] | undefined;

		function refresh() { cachedLines = undefined; _tui.requestRender(); }

		function handleInput(data: string) {
			if (matchesKey(data, Key.up)) { cursorIdx = Math.max(0, cursorIdx - 1); refresh(); return; }
			if (matchesKey(data, Key.down)) { cursorIdx = Math.min(allActions.length - 1, cursorIdx + 1); refresh(); return; }
			const num = parseInt(data, 10);
			if (!isNaN(num) && num >= 1 && num <= allActions.length) { done(allActions[num - 1].id); return; }
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) { done(allActions[cursorIdx].id); return; }
			if (matchesKey(data, Key.escape)) { done("not_yet"); return; }
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const ui = makeUI(theme, width);
			const lines: string[] = [];
			const push = (...rows: string[][]) => { for (const r of rows) lines.push(...r); };

			// ── Header — uses success colour to signal completion ────────────
			// Note: next-action intentionally uses "success" for its bar/title
			// to distinguish it from regular accent-coloured screens.
			push(ui.bar());
			push(ui.blank());
			push(ui.header(`  ✓  ${opts.title}`));

			// ── Summary ──────────────────────────────────────────────────────
			if (opts.summary && opts.summary.length > 0) {
				push(ui.blank());
				for (const line of opts.summary) push(ui.subtitle(`     ${line}`));
			}

			// ── Files written ─────────────────────────────────────────────────
			if (relativeFiles.length > 0) {
				push(ui.blank());
				push(ui.meta("  Files written:"));
				for (const f of relativeFiles) push(ui.meta(`     ${f}`));
			}

			// ── Extra content ─────────────────────────────────────────────────
			if (opts.extra && opts.extra.length > 0) {
				push(ui.blank());
				for (const line of opts.extra) push(ui.subtitle(`  ${line}`));
			}

			// ── Actions ───────────────────────────────────────────────────────
			push(ui.blank());
			for (let i = 0; i < allActions.length; i++) {
				const action = allActions[i];
				const isSelected = i === cursorIdx;
				const isNotYet = action.id === "not_yet";
				const tag = action.recommended ? "(recommended)" : undefined;

				if (isSelected) {
					push(ui.actionSelected(i + 1, action.label, action.description, tag));
				} else if (isNotYet) {
					push(ui.actionDim(i + 1, action.label, action.description));
				} else {
					push(ui.actionUnselected(i + 1, action.label, action.description, tag));
				}
				push(ui.blank());
			}

			// ── Footer ────────────────────────────────────────────────────────
			const numHint = allActions.map((_, i) => `${i + 1}`).join("/");
			push(ui.hints([`↑/↓ to choose`, `${numHint} to quick-select`, `enter to confirm`]));
			push(ui.bar());

			cachedLines = lines;
			return lines;
		}

		return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
	});

	// Fallback for RPC mode where ctx.ui.custom() returns undefined (#447).
	// Fall back to ctx.ui.select() which IS implemented in RPC mode.
	if (result === undefined || result === null) {
		const labels = allActions.map(a => {
			const tag = a.recommended ? " (recommended)" : "";
			return `${a.label}${tag}: ${a.description}`;
		});
		const selected = await ctx.ui.select(opts.title, labels);
		if (selected === undefined || selected === null) return "not_yet";
		const idx = labels.indexOf(selected as string);
		return idx >= 0 ? allActions[idx].id : "not_yet";
	}

	return result;
}
