import { type Component, truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import type { AgentSession } from "../../../core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { theme } from "../theme/theme.js";
import { providerDisplayName } from "./model-selector.js";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts (similar to web-ui)
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Format a cost value for compact display.
 * Uses fewer decimal places for larger amounts.
 * @internal Exported for testing only.
 */
export function formatPromptCost(cost: number): string {
	if (cost < 0.001) return `$${cost.toFixed(4)}`;
	if (cost < 0.01) return `$${cost.toFixed(3)}`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;

	constructor(
		private session: AgentSession,
		private footerData: ReadonlyFooterDataProvider,
	) {}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const state = this.session.state;

		const usageTotals = this.session.sessionManager.getUsageTotals();
		const totalInput = usageTotals.input;
		const totalOutput = usageTotals.output;
		const totalCacheRead = usageTotals.cacheRead;
		const totalCacheWrite = usageTotals.cacheWrite;
		const totalCost = usageTotals.cost;

		// Use activeInferenceModel during streaming to show the model actually
		// being used, not the configured model which may have been switched mid-turn.
		const displayModel = state.activeInferenceModel ?? state.model;

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? displayModel?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Replace home directory with ~
		let pwd = process.cwd();
		const home = process.env.HOME || process.env.USERPROFILE;
		if (home && pwd.startsWith(home)) {
			pwd = `~${pwd.slice(home.length)}`;
		}

		// Add git branch if available
		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Add session name if set
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		// Build stats line as separate groups joined by a dim middle-dot separator
		const sep = ` ${theme.fg("dim", "\u00B7")} `;

		// Group 1: token I/O
		const tokenGroup: string[] = [];
		if (totalInput) tokenGroup.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) tokenGroup.push(`↓${formatTokens(totalOutput)}`);

		// Group 2: cache metrics
		const cacheGroup: string[] = [];
		if (totalCacheRead) cacheGroup.push(`cr:${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) cacheGroup.push(`cw:${formatTokens(totalCacheWrite)}`);

		// Group 3: cost
		const costGroup: string[] = [];
		const usingSubscription = displayModel ? this.session.modelRegistry.isUsingOAuth(displayModel) : false;
		if (totalCost || usingSubscription) {
			const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			costGroup.push(costStr);
		}

		// Per-prompt cost annotation (opt-in via show_token_cost preference, #1515)
		if (process.env.GSD_SHOW_TOKEN_COST === "1") {
			const lastTurnCost = this.session.getLastTurnCost();
			if (lastTurnCost > 0) {
				costGroup.push(`(last: ${formatPromptCost(lastTurnCost)})`);
			}
		}

		// Group 4: context percentage (colorized)
		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}

		// Assemble groups: items within a group are space-separated,
		// groups are separated by a dim middle-dot
		const groups: string[] = [];
		if (tokenGroup.length > 0) groups.push(tokenGroup.join(" "));
		if (cacheGroup.length > 0) groups.push(cacheGroup.join(" "));
		if (costGroup.length > 0) groups.push(costGroup.join(" "));
		groups.push(contextPercentStr);

		let statsLeft = groups.join(sep);

		// Add model name on the right side, plus thinking level if model supports it
		const modelName = displayModel?.id || "no-model";

		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;

		// Add thinking level indicator if model supports reasoning
		let rightSideWithoutProvider = modelName;
		if (displayModel?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			rightSideWithoutProvider =
				thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
		}

		// Prepend the provider in parentheses if there are multiple providers and there's enough room
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && displayModel) {
			rightSide = `(${providerDisplayName(displayModel.provider)}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				// Too wide, fall back
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				// Not enough space for right side at all
				statsLine = statsLeft;
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, dimStatsLeft + dimRemainder];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Match the rest of the footer styling: extension statuses should render
			// in the same dim color as pwd/stats, with a dim ellipsis on truncation.
			lines.push(truncateToWidth(theme.fg("dim", statusLine), width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
