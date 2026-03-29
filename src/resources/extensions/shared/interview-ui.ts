/**
 * Shared interview round UI widget.
 *
 * Used by /interview-me and /gsd-new-project.
 *
 * Renders a paged, keyboard-driven question UI with:
 * - Single-select (radio) questions
 * - Multi-select (checkbox) questions via allowMultiple: true
 * - Optional notes field (Tab to open)
 * - Review screen before submitting — shows all answers, single submit button
 * - Exit confirmation on Esc — "End interview?" with keep-going as default
 * - focusNotes dimming: checked/committed items stay visible, others dim
 *
 * Navigation:
 *   ←/→          move between questions
 *   ↑/↓          move cursor within a question's options
 *   Enter/Space  commit selection and advance
 *   Tab          open/close notes field
 *   Esc          exit confirmation overlay (keep-going is default)
 *
 * On last question, Enter advances to a review screen instead of submitting directly.
 * From the review screen:
 *   ←            back to last question
 *   Enter / →    submit all answers
 *   Esc          exit confirmation
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { type Theme } from "@gsd/pi-coding-agent";
import {
	Editor,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
} from "@gsd/pi-tui";
import { makeUI, INDENT } from "./ui.js";

// ─── Exported types ───────────────────────────────────────────────────────────

export interface QuestionOption {
	label: string;
	description: string;
}

export interface Question {
	id: string;
	header: string;
	question: string;
	options: QuestionOption[];
	/** If true, user can toggle multiple options with SPACE, confirm with ENTER */
	allowMultiple?: boolean;
}

export interface RoundResult {
	/** Always false — end is handled by showWrapUpScreen, not per-question */
	endInterview: false;
	answers: Record<string, { selected: string | string[]; notes: string }>;
}

export interface WrapUpResult {
	/** true = wrap up and write file, false = keep going */
	satisfied: boolean;
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface InterviewRoundOptions {
	/**
	 * Optional progress string shown in the header — e.g. "Batch 2/3  •  12 asked".
	 * Caller formats it however makes sense for their context.
	 * If omitted, no progress line is shown.
	 */
	progress?: string;
	/**
	 * Label for the review screen header. Defaults to "Review your answers".
	 */
	reviewHeadline?: string;
	/**
	 * Label for the Esc-confirm overlay header. Defaults to "End interview?".
	 */
	exitHeadline?: string;
	/**
	 * Text for the "exit" hint shown in the review screen footer and exit confirm overlay.
	 * Defaults to "end interview".
	 */
	exitLabel?: string;
}

export interface WrapUpOptions {
	/**
	 * Optional progress string shown below the headline — e.g. "12 questions answered so far".
	 * Caller formats it however makes sense for their context.
	 * If omitted, no progress line is shown.
	 */
	progress?: string;
	/** Caller-specific text for the wrap-up screen headline */
	headline: string;
	/** Label for the "keep going" option (shown first — safe default) */
	keepGoingLabel: string;
	/** Label for the "I'm satisfied" option (shown second) */
	satisfiedLabel: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OTHER_OPTION_LABEL = "None of the above";
const OTHER_OPTION_DESCRIPTION = "Select to type your own answer.";

// ─── Wrap-up screen ───────────────────────────────────────────────────────────

export async function showWrapUpScreen(
	opts: WrapUpOptions,
	ctx: ExtensionCommandContext,
): Promise<WrapUpResult> {
	return ctx.ui.custom<WrapUpResult>((tui: TUI, theme: Theme, _kb, done) => {
		// 0 = "Keep going", 1 = "I'm satisfied" — default to satisfied (1)
		let cursorIdx = 1;
		let cachedLines: string[] | undefined;

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function handleInput(data: string) {
			if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) { cursorIdx = 1; refresh(); return; }
			if (matchesKey(data, Key.down) || matchesKey(data, Key.right)) { cursorIdx = 0; refresh(); return; }
			if (data === "1") { done({ satisfied: true }); return; }
			if (data === "2") { done({ satisfied: false }); return; }
			// Esc = "keep going" (the safe/non-destructive default)
			if (matchesKey(data, Key.escape)) { done({ satisfied: false }); return; }
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
				done({ satisfied: cursorIdx === 1 });
				return;
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const ui = makeUI(theme, width);
			const lines: string[] = [];
			const push = (...rows: string[][]) => { for (const r of rows) lines.push(...r); };

			push(ui.bar(), ui.blank(), ui.header(`  ${opts.headline}`), ui.blank());
			if (opts.progress) push(ui.meta(`  ${opts.progress}`), ui.blank());

			if (cursorIdx === 1) {
				push(ui.actionSelected(1, opts.satisfiedLabel, "Wrap up now and generate the output."));
			} else {
				push(ui.actionUnselected(1, opts.satisfiedLabel, "Wrap up now and generate the output."));
			}
			push(ui.blank());
			if (cursorIdx === 0) {
				push(ui.actionSelected(2, opts.keepGoingLabel, "Continue with another batch of questions."));
			} else {
				push(ui.actionUnselected(2, opts.keepGoingLabel, "Continue with another batch of questions."));
			}
			push(
				ui.blank(),
				ui.hints(["↑/↓ to choose", "1/2 to quick-select", "enter to confirm"]),
				ui.bar(),
			);

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => { cachedLines = undefined; },
			handleInput,
		};
	});
}

// ─── Interview round ──────────────────────────────────────────────────────────

export async function showInterviewRound(
	questions: Question[],
	opts: InterviewRoundOptions,
	ctx: ExtensionCommandContext,
): Promise<RoundResult> {
	return ctx.ui.custom<RoundResult>((tui: TUI, theme: Theme, _kb, done) => {

		interface QuestionState {
			cursorIndex: number;
			committedIndex: number | null;
			checkedIndices: Set<number>;
			notes: string;
			notesVisible: boolean;
		}

		const states: QuestionState[] = questions.map(() => ({
			cursorIndex: 0,
			committedIndex: null,
			checkedIndices: new Set(),
			notes: "",
			notesVisible: false,
		}));

		const isMultiQuestion = questions.length > 1;
		let currentIdx = 0;
		let focusNotes = false;
		let showingReview = false;
		let showingExitConfirm = false;
		let exitCursor = 0; // 0 = keep going (default), 1 = end interview
		let cachedLines: string[] | undefined;

		// Editor is created once; editorTheme comes from the design system
		const editorRef = { current: null as Editor | null };

		function getEditor(): Editor {
			if (!editorRef.current) {
				editorRef.current = new Editor(tui, makeUI(theme, 80).editorTheme);
			}
			return editorRef.current;
		}

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function isMultiSelect(qIdx: number): boolean {
			return !!questions[qIdx].allowMultiple;
		}

		function totalOpts(qIdx: number): number {
			return questions[qIdx].options.length + 1;
		}

		function noneOrDoneIdx(qIdx: number): number {
			return questions[qIdx].options.length;
		}

		function saveEditorToState() {
			states[currentIdx].notes = getEditor().getExpandedText().trim();
		}

		function loadStateToEditor() {
			getEditor().setText(states[currentIdx].notes);
		}

		function isQuestionAnswered(idx: number): boolean {
			if (isMultiSelect(idx)) return states[idx].checkedIndices.size > 0;
			return states[idx].committedIndex !== null;
		}

		function allAnswered(): boolean {
			return questions.every((_, i) => isQuestionAnswered(i));
		}

		function switchQuestion(newIdx: number) {
			if (newIdx === currentIdx) return;
			saveEditorToState();
			currentIdx = newIdx;
			loadStateToEditor();
			focusNotes = states[currentIdx].notesVisible && states[currentIdx].notes.length > 0;
			refresh();
		}

		function buildResult(): RoundResult {
			const answers: Record<string, { selected: string | string[]; notes: string }> = {};
			for (let i = 0; i < questions.length; i++) {
				const q = questions[i];
				const st = states[i];
				const notes = st.notes.trim();

				if (isMultiSelect(i)) {
					const sorted = Array.from(st.checkedIndices).sort((a, b) => a - b);
					const selected = sorted.map((idx) => q.options[idx].label);
					if (selected.length > 0 || notes) answers[q.id] = { selected, notes };
				} else {
					if (st.committedIndex === null && !notes) continue;
					let selected = OTHER_OPTION_LABEL;
					if (st.committedIndex !== null) {
						const idx = st.committedIndex;
						if (idx < q.options.length) selected = q.options[idx].label;
						else if (idx === noneOrDoneIdx(i)) selected = OTHER_OPTION_LABEL;
					}
					answers[q.id] = { selected, notes };
				}
			}
			return { endInterview: false, answers };
		}

		function submit() {
			saveEditorToState();
			done(buildResult());
		}

		function goNextOrSubmit() {
			if (!isMultiSelect(currentIdx)) {
				states[currentIdx].committedIndex = states[currentIdx].cursorIndex;
			}

			// Auto-open the notes field when "None of the above" is selected
			// so the user can immediately provide a free-text explanation
			// instead of being trapped in a re-asking loop (bug #2715).
			if (!isMultiSelect(currentIdx) && states[currentIdx].cursorIndex === noneOrDoneIdx(currentIdx)) {
				states[currentIdx].notesVisible = true;
				focusNotes = true;
				loadStateToEditor();
				refresh();
				return;
			}

			if (isMultiQuestion && currentIdx < questions.length - 1) {
				let next = currentIdx + 1;
				for (let i = 0; i < questions.length; i++) {
					const candidate = (currentIdx + 1 + i) % questions.length;
					if (!isQuestionAnswered(candidate)) { next = candidate; break; }
				}
				switchQuestion(next);
			} else if (allAnswered()) {
				saveEditorToState();
				showingReview = true;
				refresh();
			}
		}

		// ── Input handler ────────────────────────────────────────────────────

		function handleInput(data: string) {
			// ── Exit confirmation overlay ──────────────────────────────────
			if (showingExitConfirm) {
				if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) { exitCursor = 0; refresh(); return; }
				if (matchesKey(data, Key.down) || matchesKey(data, Key.right)) { exitCursor = 1; refresh(); return; }
				if (data === "1") { showingExitConfirm = false; refresh(); return; }
				if (data === "2") { done({ endInterview: false, answers: {} }); return; }
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
					if (exitCursor === 0) { showingExitConfirm = false; refresh(); }
					else { done({ endInterview: false, answers: {} }); }
					return;
				}
				if (matchesKey(data, Key.escape)) { showingExitConfirm = false; refresh(); return; }
				return;
			}

			// ── Review screen ────────────────────────────────────────────
			if (showingReview) {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
					showingReview = false;
					switchQuestion(questions.length - 1);
					return;
				}
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.right) || matchesKey(data, Key.space)) {
					submit();
					return;
				}
				return;
			}

			const st = states[currentIdx];
			const optCount = totalOpts(currentIdx);
			const multiSel = isMultiSelect(currentIdx);

			// ── Esc → exit confirmation ──────────────────────────────────
			if (matchesKey(data, Key.escape)) {
				if (focusNotes) {
					saveEditorToState();
					focusNotes = false;
					st.notesVisible = st.notes.length > 0;
					refresh();
				} else {
					showingExitConfirm = true;
					exitCursor = 0;
					refresh();
				}
				return;
			}

			// ── Notes mode ───────────────────────────────────────────────
			if (focusNotes) {
				if (matchesKey(data, Key.tab)) {
					saveEditorToState();
					focusNotes = false;
					st.notesVisible = st.notes.length > 0;
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					saveEditorToState();
					focusNotes = false;
					if (!multiSel && st.committedIndex === null) st.committedIndex = noneOrDoneIdx(currentIdx);
					goNextOrSubmit();
					return;
				}
				getEditor().handleInput(data);
				refresh();
				return;
			}

			// ── Multi-question navigation ────────────────────────────────
			if (isMultiQuestion) {
				if (matchesKey(data, Key.left)) { switchQuestion((currentIdx - 1 + questions.length) % questions.length); return; }
				if (matchesKey(data, Key.right)) { switchQuestion((currentIdx + 1) % questions.length); return; }
			}

			// ── Cursor navigation ────────────────────────────────────────
			if (matchesKey(data, Key.up)) { st.cursorIndex = (st.cursorIndex - 1 + optCount) % optCount; refresh(); return; }
			if (matchesKey(data, Key.down)) { st.cursorIndex = (st.cursorIndex + 1) % optCount; refresh(); return; }

			if (multiSel) {
				const doneI = noneOrDoneIdx(currentIdx);
				if (matchesKey(data, Key.space)) {
					if (st.cursorIndex < doneI) {
						if (st.checkedIndices.has(st.cursorIndex)) st.checkedIndices.delete(st.cursorIndex);
						else st.checkedIndices.add(st.cursorIndex);
						refresh();
					}
					return;
				}
				if (matchesKey(data, Key.enter)) { goNextOrSubmit(); return; }
				if (matchesKey(data, Key.tab)) { st.notesVisible = true; focusNotes = true; loadStateToEditor(); refresh(); return; }
			} else {
				if (data.length === 1 && data >= "1" && data <= "9") {
					const idx = parseInt(data, 10) - 1;
					if (idx < optCount) { st.cursorIndex = idx; st.committedIndex = idx; goNextOrSubmit(); return; }
				}
				if (matchesKey(data, Key.space)) { st.committedIndex = st.cursorIndex; refresh(); return; }
				if (matchesKey(data, Key.tab)) { st.notesVisible = true; focusNotes = true; loadStateToEditor(); refresh(); return; }
				if (matchesKey(data, Key.enter)) { goNextOrSubmit(); return; }
			}
		}

		// ── Review screen ────────────────────────────────────────────────

		function renderReviewScreen(width: number): string[] {
			const ui = makeUI(theme, width);
			const lines: string[] = [];
			const push = (...rows: string[][]) => { for (const r of rows) lines.push(...r); };

			push(ui.bar(), ui.blank(), ui.header(`  ${opts.reviewHeadline ?? "Review your answers"}`), ui.blank());

			for (let i = 0; i < questions.length; i++) {
				const q = questions[i];
				const st = states[i];

				push(ui.subtitle(`  ${q.question}`));

				if (isMultiSelect(i)) {
					const selected = Array.from(st.checkedIndices).sort((a, b) => a - b).map((idx) => q.options[idx].label);
					for (const label of selected) push(ui.answer(`    ${INDENT.cursor}${label}`));
				} else {
					let label = OTHER_OPTION_LABEL;
					if (st.committedIndex !== null && st.committedIndex < q.options.length) {
						label = q.options[st.committedIndex].label;
					}
					push(ui.answer(`    ${INDENT.cursor}${label}`));
				}

				if (st.notes) push(ui.note(`${INDENT.note}note: ${st.notes}`));
				push(ui.blank());
			}

			push(
				ui.actionSelected(0, "Submit answers"),
				ui.blank(),
				ui.hints(["← to go back and edit", "enter to submit", `esc to ${opts.exitLabel ?? "end interview"}`]),
				ui.bar(),
			);

			return lines;
		}

		// ── Exit confirm screen ──────────────────────────────────────────

		function renderExitConfirm(width: number): string[] {
			const ui = makeUI(theme, width);
			const lines: string[] = [];
			const push = (...rows: string[][]) => { for (const r of rows) lines.push(...r); };

			push(
				ui.bar(),
				ui.blank(),
				ui.header(`  ${opts.exitHeadline ?? "End interview?"}`),
				ui.blank(),
				ui.subtitle("  Answers from this batch won't be saved."),
				ui.blank(),
			);

			const keepGoingLabel = "Keep going";
			const exitActionLabel = opts.exitLabel
				? opts.exitLabel.charAt(0).toUpperCase() + opts.exitLabel.slice(1)
				: "End interview";
			if (exitCursor === 0) {
				push(ui.actionSelected(1, keepGoingLabel, "Return and keep going."));
			} else {
				push(ui.actionUnselected(1, keepGoingLabel, "Return and keep going."));
			}
			push(ui.blank());
			if (exitCursor === 1) {
				push(ui.actionSelected(2, exitActionLabel, "Exit and discard this batch of answers."));
			} else {
				push(ui.actionUnselected(2, exitActionLabel, "Exit and discard this batch of answers."));
			}
			push(
				ui.blank(),
				ui.hints(["↑/↓ to choose", "1/2 to quick-select", "enter to confirm"]),
				ui.bar(),
			);

			return lines;
		}

		// ── Main render ──────────────────────────────────────────────────

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			if (showingExitConfirm) { cachedLines = renderExitConfirm(width); return cachedLines; }
			if (showingReview) { cachedLines = renderReviewScreen(width); return cachedLines; }

			const ui = makeUI(theme, width);
			const lines: string[] = [];
			const push = (...rows: string[][]) => { for (const r of rows) lines.push(...r); };

			const q = questions[currentIdx];
			const st = states[currentIdx];
			const multiSel = isMultiSelect(currentIdx);

			push(ui.bar());

			// ── Progress header ────────────────────────────────────────────
			if (isMultiQuestion) {
				const unanswered = questions.filter((_, i) => !isQuestionAnswered(i)).length;
				const answeredSet = new Set(questions.map((_, i) => i).filter(i => isQuestionAnswered(i)));
				push(ui.questionTabs(questions.map(q => q.header), currentIdx, answeredSet));
				push(ui.blank());
				const progressParts = [
					opts.progress,
					`Question ${currentIdx + 1}/${questions.length}`,
					unanswered > 0 ? `${unanswered} unanswered` : null,
				].filter(Boolean).join("  •  ");
				if (progressParts) push(ui.meta(`  ${progressParts}`));
				push(ui.blank());
			} else {
				if (opts.progress) push(ui.meta(`  ${opts.progress}`), ui.blank());
			}

			// ── Question text ──────────────────────────────────────────────
			push(ui.question(` ${q.question}`));
			if (multiSel) push(ui.meta("  (Select all that apply)"));
			push(ui.blank());

			// ── Options ───────────────────────────────────────────────────
			for (let i = 0; i < q.options.length; i++) {
				const opt = q.options[i];
				const isCursor = i === st.cursorIndex;

				if (multiSel) {
					const isChecked = st.checkedIndices.has(i);
					if (isCursor && !focusNotes) push(ui.checkboxSelected(opt.label, opt.description, isChecked));
					else push(ui.checkboxUnselected(opt.label, opt.description, isChecked, focusNotes));
				} else {
					const isCommitted = i === st.committedIndex;
					if (isCursor && !focusNotes) {
						push(ui.optionSelected(i + 1, opt.label, opt.description, isCommitted));
					} else {
						push(ui.optionUnselected(i + 1, opt.label, opt.description, { isCommitted, isFocusDimmed: focusNotes }));
					}
				}
			}

			// ── None / Done slot ───────────────────────────────────────────
			const ndIdx = noneOrDoneIdx(currentIdx);
			const ndCursor = ndIdx === st.cursorIndex;

			if (multiSel) {
				push(ui.blank());
				if (ndCursor && !focusNotes) push(ui.doneSelected());
				else push(ui.doneUnselected());
			} else {
				const ndCommitted = ndIdx === st.committedIndex;
				if (ndCursor && !focusNotes) {
					push(ui.slotSelected(OTHER_OPTION_LABEL, OTHER_OPTION_DESCRIPTION, ndCommitted));
				} else {
					push(ui.slotUnselected(OTHER_OPTION_LABEL, OTHER_OPTION_DESCRIPTION, { isCommitted: ndCommitted, isFocusDimmed: focusNotes }));
				}
			}

			// ── Notes area ─────────────────────────────────────────────────
			if (st.notesVisible || focusNotes) {
				push(ui.blank(), ui.notesLabel(focusNotes));
				if (focusNotes) {
					for (const line of getEditor().render(width - 2)) lines.push(truncateToWidth(` ${line}`, width));
				} else if (st.notes) {
					push(ui.notesText(st.notes));
				}
			}

			// ── Footer hints ───────────────────────────────────────────────
			push(ui.blank());
			const isLast = !isMultiQuestion || currentIdx === questions.length - 1;
			const hints: string[] = [];
			if (focusNotes) {
				hints.push("enter to confirm");
				hints.push("tab or esc to close notes");
			} else if (multiSel) {
				hints.push("space to toggle");
				if (isMultiQuestion) hints.push("←/→ navigate questions");
				hints.push("tab to add notes");
				hints.push(isLast && allAnswered() ? "enter to review" : "enter to next");
			} else {
				hints.push("tab to add notes");
				if (isMultiQuestion) hints.push("←/→ navigate");
				hints.push(isLast && allAnswered() ? "enter to review" : "enter to next");
			}
			hints.push("esc to exit");
			push(ui.hints(hints), ui.bar());

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => { cachedLines = undefined; },
			handleInput,
		};
	});
}
