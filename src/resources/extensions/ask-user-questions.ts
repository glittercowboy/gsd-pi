/**
 * Request User Input — LLM tool for asking the user questions
 *
 * Thin wrapper around the shared interview-ui. The LLM presents 1-3
 * questions with 2-3 options each. Each question can be single-select (default)
 * or multi-select (allowMultiple: true). A free-form "None of the above" option
 * is added automatically to single-select questions.
 *
 * Based on: https://github.com/openai/codex (codex-rs/core/src/tools/handlers/ask_user_questions.rs)
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { sanitizeError } from "./shared/sanitize.js";
import { Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	showInterviewRound,
	type Question,
	type QuestionOption,
	type RoundResult,
} from "./shared/tui.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LocalResultDetails {
	remote?: false;
	questions: Question[];
	response: RoundResult | null;
	cancelled: boolean;
}

interface RemoteResultDetails {
	remote: true;
	channel: string;
	timed_out: boolean;
	promptId?: string;
	threadUrl?: string;
	status?: string;
	questions?: Question[];
	response?: RoundResult;
	error?: boolean;
}

type AskUserQuestionsDetails = LocalResultDetails | RemoteResultDetails;

// ─── Schema ───────────────────────────────────────────────────────────────────

const OptionSchema = Type.Object({
	label: Type.String({ description: "User-facing label (1-5 words)" }),
	description: Type.String({ description: "One short sentence explaining impact/tradeoff if selected" }),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional markdown content shown in a side-by-side preview panel when this option is highlighted. Use for showing code samples, config snippets, or detailed explanations. Keep under ~20 lines — longer content is truncated.",
		}),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable identifier for mapping answers (snake_case)" }),
	header: Type.String({ description: "Short header label shown in the UI (12 or fewer chars)" }),
	question: Type.String({ description: "Single-sentence prompt shown to the user" }),
	options: Type.Array(OptionSchema, {
		description:
			'Provide 2-3 mutually exclusive choices for single-select, or any number for multi-select. Put the recommended option first and suffix its label with "(Recommended)". Each option can include an optional "preview" field with markdown content shown in a side panel. Do not include an "Other" option for single-select; the client adds a free-form "None of the above" option automatically.',
	}),
	allowMultiple: Type.Optional(
		Type.Boolean({
			description:
				"If true, the user can select multiple options using SPACE to toggle and ENTER to confirm. No 'None of the above' option is added. Default: false.",
		}),
	),
});

const AskUserQuestionsParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "Questions to show the user. Prefer 1 and do not exceed 3.",
	}),
});

// ─── Per-turn deduplication ──────────────────────────────────────────────────
// Prevents duplicate question dispatches (especially to remote channels like
// Discord) when the LLM calls ask_user_questions multiple times with the same
// questions in a single turn. Keyed by full canonicalized payload (id, header,
// question, options, allowMultiple) — not just IDs — so that calls with the
// same IDs but different text/options are treated as distinct.

import { createHash } from "node:crypto";

interface CachedResult {
	content: { type: "text"; text: string }[];
	details: AskUserQuestionsDetails;
}

const turnCache = new Map<string, CachedResult>();

/** @internal Exported for testing only. */
export function questionSignature(questions: Question[]): string {
	const canonical = questions
		.map((q) => ({
			id: q.id,
			header: q.header,
			question: q.question,
			options: (q.options || []).map((o) => ({ label: o.label, description: o.description })),
			allowMultiple: !!q.allowMultiple,
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

/** Reset the dedup cache. Called on session boundaries. */
export function resetAskUserQuestionsCache(): void {
	turnCache.clear();
}

// ─── Race helper ─────────────────────────────────────────────────────────────

interface RaceableResult {
	content: { type: "text"; text: string }[];
	details?: unknown;
}

/**
 * Race a remote channel dispatch against the local TUI. The first to produce
 * a valid (non-error, non-timeout) result wins. The loser is cancelled via
 * the shared AbortController.
 *
 * If the local TUI responds first, the remote poll is aborted (the message
 * stays in Discord/Slack but polling stops). If remote responds first, the
 * local TUI prompt is cancelled.
 *
 * Returns null only when both sides fail or are cancelled.
 */
async function raceRemoteAndLocal(
	startRemote: () => Promise<RaceableResult | null>,
	startLocal: () => Promise<RoundResult | null | undefined>,
	controller: AbortController,
	questions: Question[],
): Promise<RaceableResult | null> {
	// Wrap local TUI result into the same shape as remote results
	const localPromise = startLocal().then((result): RaceableResult | null => {
		if (!result || Object.keys(result.answers).length === 0) return null;
		return {
			content: [{ type: "text" as const, text: formatForLLM(result) }],
			details: { questions, response: result, cancelled: false } satisfies LocalResultDetails,
		};
	}).catch(() => null);

	const remotePromise = startRemote().then((result): RaceableResult | null => {
		if (!result) return null;
		const details = result.details as Record<string, unknown> | undefined;
		// Treat timeouts and errors as non-wins — let the local TUI win instead
		if (details?.timed_out || details?.error) return null;
		return result;
	}).catch(() => null);

	// Race: first non-null result wins
	const winner = await Promise.race([
		localPromise.then((r) => r ? { source: "local" as const, result: r } : null),
		remotePromise.then((r) => r ? { source: "remote" as const, result: r } : null),
	]);

	if (winner) {
		// Cancel the loser
		controller.abort();
		return winner.result;
	}

	// First to resolve was null — wait for the other
	const [localResult, remoteResult] = await Promise.all([localPromise, remotePromise]);
	controller.abort();
	return localResult ?? remoteResult;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OTHER_OPTION_LABEL = "None of the above";

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: AskUserQuestionsDetails } {
	return {
		content: [{ type: "text", text: sanitizeError(message) }],
		details: { questions, response: null, cancelled: true },
	};
}

/** Convert the shared RoundResult into the JSON the LLM expects. */
function formatForLLM(result: RoundResult): string {
	const answers: Record<string, { answers: string[] }> = {};
	for (const [id, answer] of Object.entries(result.answers)) {
		const list: string[] = [];
		if (Array.isArray(answer.selected)) {
			list.push(...answer.selected);
		} else {
			list.push(answer.selected);
		}
		if (answer.notes) {
			list.push(`user_note: ${answer.notes}`);
		}
		answers[id] = { answers: list };
	}
	return JSON.stringify({ answers });
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function AskUserQuestions(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_questions",
		label: "Request User Input",
		description:
			"Request user input for one to three short questions and wait for the response. Single-select questions have 2-3 mutually exclusive options with a free-form 'None of the above' added automatically. Multi-select questions (allowMultiple: true) let the user toggle multiple options with SPACE and confirm with ENTER. Options can include an optional 'preview' field with markdown content shown in a side-by-side panel when highlighted.",
		promptGuidelines: [
			"Use ask_user_questions when you need the user to choose between concrete alternatives before proceeding.",
			"Keep questions to 1 when possible; never exceed 3.",
			"For single-select: each question must have 2-3 options. Put the recommended option first with '(Recommended)' suffix. Do not include an 'Other' or 'None of the above' option - the client adds one automatically.",
			"For multi-select: set allowMultiple: true. The user can pick any number of options. No 'None of the above' is added.",
			"When options involve code patterns, config choices, or architecture decisions, add a 'preview' field with markdown content (code blocks, lists, headers, etc.). The preview renders in a side-by-side panel when the option is highlighted.",
			"Preview content is rendered in a fixed-height panel (max ~20 lines visible). Keep previews concise — show the most relevant snippet, not exhaustive examples. Longer content is truncated with a '+N lines hidden' indicator.",
		],
		parameters: AskUserQuestionsParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// ── Per-turn dedup: return cached result for identical question sets ──
			const sig = questionSignature(params.questions);
			const cached = turnCache.get(sig);
			if (cached) {
				return {
					content: [{ type: "text" as const, text: cached.content[0].text + "\n(Returned cached answer — this question set was already asked this turn.)" }],
					details: cached.details,
				};
			}

			// Validation
			if (params.questions.length === 0 || params.questions.length > 3) {
				return errorResult("Error: questions must contain 1-3 items", params.questions);
			}

			for (const q of params.questions) {
				if (!q.options || q.options.length === 0) {
					return errorResult(
						`Error: ask_user_questions requires non-empty options for every question (question "${q.id}" has none)`,
						params.questions,
					);
				}
			}

			// ── Routing: race remote + local, remote-only, or local-only ────────
			const { tryRemoteQuestions, isRemoteConfigured } = await import("./remote-questions/manager.js");
			const hasRemote = isRemoteConfigured();

			// Case 1: Both remote and local UI available — race them.
			// The first response wins; the loser is cancelled via AbortController.
			if (hasRemote && ctx.hasUI) {
				const raceController = new AbortController();
				// Merge the parent signal so external cancellation propagates.
				const onParentAbort = () => raceController.abort();
				signal?.addEventListener("abort", onParentAbort, { once: true });
				const raceSignal = raceController.signal;

				const raceResult = await raceRemoteAndLocal(
					() => tryRemoteQuestions(params.questions, raceSignal),
					() => showInterviewRound(params.questions, { signal: raceSignal }, ctx as any),
					raceController,
					params.questions,
				);

				signal?.removeEventListener("abort", onParentAbort);

				if (raceResult) {
					const details = raceResult.details as Record<string, unknown> | undefined;
					if (details && !details.timed_out && !details.error && !details.cancelled) {
						turnCache.set(sig, raceResult as unknown as CachedResult);
					}
					return { ...raceResult, details: raceResult.details as unknown };
				}
				// Both sides failed/cancelled — fall through to error
				return errorResult("ask_user_questions: no response received from local UI or remote channel", params.questions);
			}

			// Case 2: Remote configured but no local UI (headless) — remote only.
			if (hasRemote && !ctx.hasUI) {
				const remoteResult = await tryRemoteQuestions(params.questions, signal);
				if (remoteResult) {
					const remoteDetails = remoteResult.details as Record<string, unknown> | undefined;
					if (remoteDetails && !remoteDetails.timed_out && !remoteDetails.error) {
						turnCache.set(sig, remoteResult as unknown as CachedResult);
					}
					return { ...remoteResult, details: remoteResult.details as unknown };
				}
				return errorResult("Error: remote channel configured but returned no result", params.questions);
			}

			// Case 3: No remote — local UI only.
			if (!ctx.hasUI) {
				return errorResult("Error: UI not available (non-interactive mode)", params.questions);
			}

			// Delegate to shared interview UI
			const result = await showInterviewRound(params.questions, {}, ctx as any);

			// RPC mode fallback: custom() returns undefined, so showInterviewRound
			// may return undefined. Fall back to sequential ctx.ui.select() calls.
			if (!result) {
				const answers: Record<string, { answers: string[] }> = {};
				for (const q of params.questions) {
					const options = q.options.map((o) => o.label);
					if (!q.allowMultiple) {
						options.push(OTHER_OPTION_LABEL);
					}
					const selected = await ctx.ui.select(
						`${q.header}: ${q.question}`,
						options,
						{ signal, ...(q.allowMultiple ? { allowMultiple: true } : {}) },
					);
					if (selected === undefined) {
						return errorResult("ask_user_questions was cancelled", params.questions);
					}

					// When the user picks "None of the above" on a single-select
					// question, prompt for a free-text explanation so they are not
					// trapped in a re-asking loop (bug #2715).
					let freeTextNote = "";
					const selectedStr = Array.isArray(selected) ? selected[0] : selected;
					if (!q.allowMultiple && selectedStr === OTHER_OPTION_LABEL) {
						const note = await ctx.ui.input(
							`${q.header}: Please explain in your own words`,
							"Type your answer here…",
						);
						if (note) {
							freeTextNote = note;
						}
					}

					const answerList = Array.isArray(selected) ? selected : [selected];
					if (freeTextNote) {
						answerList.push(`user_note: ${freeTextNote}`);
					}
					answers[q.id] = { answers: answerList };
				}
				const roundResult: RoundResult = {
					endInterview: false,
					answers: Object.fromEntries(
						Object.entries(answers).map(([id, a]) => [
							id,
							{ selected: a.answers.length === 1 ? a.answers[0] : a.answers, notes: "" },
						]),
					),
				};
				const fallbackResult = {
					content: [{ type: "text" as const, text: JSON.stringify({ answers }) }],
					details: {
						questions: params.questions,
						response: roundResult,
						cancelled: false,
					} satisfies LocalResultDetails,
				};
				turnCache.set(sig, fallbackResult);
				return fallbackResult;
			}

			// Check if cancelled (empty answers = user exited)
			const hasAnswers = Object.keys(result.answers).length > 0;
			if (!hasAnswers) {
				return {
					content: [{ type: "text", text: "ask_user_questions was cancelled before receiving a response" }],
					details: { questions: params.questions, response: null, cancelled: true } satisfies LocalResultDetails,
				};
			}

			const successResult = {
				content: [{ type: "text" as const, text: formatForLLM(result) }],
				details: { questions: params.questions, response: result, cancelled: false } satisfies LocalResultDetails,
			};
			turnCache.set(sig, successResult);
			return successResult;
		},

		// ─── Rendering ────────────────────────────────────────────────────────

		renderCall(args, theme) {
			const qs = (args.questions as Question[]) || [];
			let text = theme.fg("toolTitle", theme.bold("ask_user_questions "));
			text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);
			if (qs.length > 0) {
				const headers = qs.map((q) => q.header).join(", ");
				text += theme.fg("dim", ` (${headers})`);
			}
			const previewCount = qs.reduce(
				(acc, q) => acc + (q.options || []).filter((o: QuestionOption) => o.preview).length,
				0,
			);
			if (previewCount > 0) {
				text += theme.fg("accent", ` [${previewCount} preview${previewCount !== 1 ? "s" : ""}]`);
			}
			for (const q of qs) {
				const multiSel = !!q.allowMultiple;
				text += `\n  ${theme.fg("text", q.question)}`;
				const optLabels = multiSel
					? (q.options || []).map((o: QuestionOption) => o.label)
					: [...(q.options || []).map((o: QuestionOption) => o.label), OTHER_OPTION_LABEL];
				const prefix = multiSel ? "☐" : "";
				const numbered = optLabels.map((l, i) => `${prefix}${i + 1}. ${l}`).join(", ");
				text += `\n  ${theme.fg("dim", numbered)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserQuestionsDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			// Remote channel result (discriminated on details.remote === true)
			if (details.remote) {
				if (details.timed_out) {
					return new Text(
						`${theme.fg("warning", `${details.channel} — timed out`)}${details.threadUrl ? theme.fg("dim", ` ${details.threadUrl}`) : ""}`,
						0,
						0,
					);
				}

				const questions = (details.questions ?? []) as Question[];
				const lines: string[] = [];
				lines.push(theme.fg("dim", details.channel));
				if (details.response) {
					for (const q of questions) {
						const answer = details.response.answers[q.id];
						if (!answer) {
							lines.push(`${theme.fg("accent", q.header)}: ${theme.fg("dim", "(no answer)")}`);
							continue;
						}
						const selected = answer.selected;
						const answerText = Array.isArray(selected)
							? (selected.length > 0 ? selected.join(", ") : "(custom)")
							: (selected || "(custom)");
						let line = `${theme.fg("success", "✓ ")}${theme.fg("accent", q.header)}: ${answerText}`;
						if (answer.notes) {
							line += ` ${theme.fg("muted", `[note: ${answer.notes}]`)}`;
						}
						lines.push(line);
					}
				}
				return new Text(lines.join("\n"), 0, 0);
			}

			if (details.cancelled || !details.response) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			const lines: string[] = [];
			for (const q of details.questions) {
				const answer = (details.response as RoundResult).answers[q.id];
				if (!answer) {
					lines.push(`${theme.fg("accent", q.header)}: ${theme.fg("dim", "(no answer)")}`);
					continue;
				}
				const selected = answer.selected;
				const notes = answer.notes;
				const multiSel = !!q.allowMultiple;
				const answerText = multiSel && Array.isArray(selected)
					? selected.join(", ")
					: (Array.isArray(selected) ? selected[0] : selected) ?? "(no answer)";
				let line = `${theme.fg("success", "✓ ")}${theme.fg("accent", q.header)}: ${answerText}`;
				if (notes) {
					line += ` ${theme.fg("muted", `[note: ${notes}]`)}`;
				}
				lines.push(line);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
