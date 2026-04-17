/**
 * Contextual tips system — shows non-intrusive, session-scoped hints
 * when user behavior suggests they'd benefit from knowing a feature.
 *
 * Each tip fires at most `maxShows` times per session. Tips are
 * evaluated in order; the first match wins per input event.
 */

// ─── Tip definitions ─────────────────────────────────────────────────────────

export interface TipContext {
	/** The raw input text the user submitted */
	input: string;
	/** Whether the agent is currently streaming */
	isStreaming: boolean;
	/** Current thinking level (e.g. "off", "low", "high", "xhigh") */
	thinkingLevel?: string;
	/** Number of `!` (included) bash commands run this session */
	bashIncludedCount: number;
	/** Approximate context usage percentage (0–100), if known */
	contextPercent?: number;
}

export interface Tip {
	id: string;
	/** Maximum times this tip is shown per session */
	maxShows: number;
	/** Returns the tip message if the tip should fire, or null to skip */
	evaluate: (ctx: TipContext) => string | null;
}

// Shell commands that obviously run locally and don't need the LLM.
// Intentionally conservative — these are unambiguous filesystem/info commands.
const LOCAL_SHELL_COMMANDS = new Set([
	"ls",
	"ll",
	"la",
	"pwd",
	"cd",
	"dir",
	"cat",
	"head",
	"tail",
	"wc",
	"file",
	"which",
	"whoami",
	"echo",
	"date",
	"tree",
	"find",
	"grep",
	"rg",
	"clear",
	"env",
	"df",
	"du",
	"uname",
	"hostname",
	"mkdir",
	"rm",
	"cp",
	"mv",
	"touch",
	"chmod",
	"less",
	"more",
	"sort",
	"uniq",
	"sed",
	"awk",
	"curl",
	"wget",
	"tar",
	"zip",
	"unzip",
	"git",
	"docker",
	"npm",
	"npx",
	"yarn",
	"pnpm",
	"node",
	"python",
	"python3",
	"pip",
	"pip3",
	"make",
	"cargo",
	"go",
	"ruby",
	"brew",
]);

/**
 * Extract the first token from input, ignoring leading whitespace.
 * Returns lowercase for case-insensitive matching.
 */
function firstToken(input: string): string {
	const trimmed = input.trimStart();
	const spaceIdx = trimmed.search(/\s/);
	const token = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
	return token.toLowerCase();
}

/**
 * Check if input looks like a bare shell command (no !, //, or slash prefix).
 */
function looksLikeShellCommand(input: string): boolean {
	const trimmed = input.trimStart();
	// Already prefixed — user knows what they're doing
	if (trimmed.startsWith("!") || trimmed.startsWith("/")) return false;
	// Multi-line or very long inputs are probably prompts
	if (trimmed.includes("\n") || trimmed.length > 120) return false;
	return LOCAL_SHELL_COMMANDS.has(firstToken(trimmed));
}

const TIPS: Tip[] = [
	// 1. Shell command reminder
	{
		id: "shell-command-prefix",
		maxShows: 2,
		evaluate(ctx) {
			if (!looksLikeShellCommand(ctx.input)) return null;
			const cmd = firstToken(ctx.input);
			return `Tip: "${cmd}" looks like a shell command. Prefix with ! to run locally, or !! to run without using tokens.`;
		},
	},

	// 2. Large paste warning
	{
		id: "large-paste",
		maxShows: 2,
		evaluate(ctx) {
			if (ctx.input.length < 2000) return null;
			// Slash commands and bash prefixes are intentional
			if (ctx.input.trimStart().startsWith("/") || ctx.input.trimStart().startsWith("!")) return null;
			return "Tip: Large inputs consume many tokens. Consider saving to a file and asking the agent to read it.";
		},
	},

	// 3. Thinking level awareness
	{
		id: "thinking-level-high",
		maxShows: 1,
		evaluate(ctx) {
			const level = ctx.thinkingLevel?.toLowerCase();
			if (level !== "high" && level !== "xhigh") return null;
			// Only fire for short, simple-looking inputs (likely simple questions)
			const trimmed = ctx.input.trim();
			if (trimmed.length > 80 || trimmed.includes("\n")) return null;
			// Don't fire on slash or bash commands
			if (trimmed.startsWith("/") || trimmed.startsWith("!")) return null;
			return `Tip: Thinking is set to ${level}. Use Ctrl+T to lower it for simple questions — saves tokens.`;
		},
	},

	// 4. Double-bang reminder
	{
		id: "double-bang-reminder",
		maxShows: 2,
		evaluate(ctx) {
			// Fire after user has run 3+ included (!) bash commands
			if (ctx.bashIncludedCount < 3) return null;
			// Only trigger on a ! command (not !!)
			const trimmed = ctx.input.trimStart();
			if (!trimmed.startsWith("!") || trimmed.startsWith("!!")) return null;
			return "Tip: Use !! instead of ! to keep command output out of agent context and save tokens.";
		},
	},

	// 5. Compaction nudge
	{
		id: "compaction-nudge",
		maxShows: 1,
		evaluate(ctx) {
			if (ctx.contextPercent === undefined || ctx.contextPercent < 70) return null;
			// Don't nag on slash/bash
			const trimmed = ctx.input.trimStart();
			if (trimmed.startsWith("/") || trimmed.startsWith("!")) return null;
			return "Tip: Context is getting full. Use /compact to summarize the conversation and free up space.";
		},
	},
];

// ─── Session-scoped tracker ──────────────────────────────────────────────────

export class ContextualTips {
	/** Map of tip ID → number of times shown this session */
	private showCounts = new Map<string, number>();
	/** Track ! bash commands for double-bang reminder */
	private _bashIncludedCount = 0;

	/** Increment the bash-included counter. Call when user runs ! (not !!) command. */
	recordBashIncluded(): void {
		this._bashIncludedCount++;
	}

	get bashIncludedCount(): number {
		return this._bashIncludedCount;
	}

	/**
	 * Evaluate all tips against the current input context.
	 * Returns the first matching tip message, or null if none apply.
	 */
	evaluate(ctx: Omit<TipContext, "bashIncludedCount">): string | null {
		const fullCtx: TipContext = {
			...ctx,
			bashIncludedCount: this._bashIncludedCount,
		};

		for (const tip of TIPS) {
			const shown = this.showCounts.get(tip.id) ?? 0;
			if (shown >= tip.maxShows) continue;

			const message = tip.evaluate(fullCtx);
			if (message) {
				this.showCounts.set(tip.id, shown + 1);
				return message;
			}
		}

		return null;
	}

	/** Reset all counters (e.g. on new session). */
	reset(): void {
		this.showCounts.clear();
		this._bashIncludedCount = 0;
	}
}
