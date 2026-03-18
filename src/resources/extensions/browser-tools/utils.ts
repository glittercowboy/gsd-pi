/**
 * browser-tools — Node-side utility functions
 *
 * All functions that were helpers in index.ts but run in Node (not browser).
 * They import state accessors from ./state.ts — never raw module-level variables.
 */

import type { Frame, Page } from "playwright";
import { mkdir, stat, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@gsd/pi-coding-agent";
import {
	beginAction,
	finishAction,
	findAction,
	toActionParamsSummary,
	registryListPages,
} from "./core.js";
import {
	ARTIFACT_ROOT,
	getActiveFrame,
	getActiveTraceSession,
	getConsoleLogs,
	getDialogLogs,
	getHarState,
	getNetworkLogs,
	getSessionArtifactDir,
	getSessionStartedAt,
	setSessionArtifactDir,
	setSessionStartedAt,
	pageRegistry,
	actionTimeline,
	getPendingCriticalRequestsByPage,
	getLastActionBeforeState,
	getLastActionAfterState,
	setLastActionBeforeState,
	setLastActionAfterState,
	type ConsoleEntry,
	type NetworkEntry,
	type CompactPageState,
	type CompactSelectorState,
	type ClickTargetStateSnapshot,
	type BrowserVerificationCheck,
	type BrowserVerificationResult,
	type BrowserAssertionCheckInput,
	type AdaptiveSettleOptions,
	type AdaptiveSettleDetails,
	type ParsedRefSpec,
} from "./state.js";

// ---------------------------------------------------------------------------
// Text truncation
// ---------------------------------------------------------------------------

export function truncateText(text: string): string {
	const result = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (result.truncated) {
		return (
			result.content +
			`\n\n[Output truncated: ${result.outputLines}/${result.totalLines} lines shown]`
		);
	}
	return result.content;
}

// ---------------------------------------------------------------------------
// Artifact helpers
// ---------------------------------------------------------------------------

export function formatArtifactTimestamp(timestamp: number): string {
	return new Date(timestamp).toISOString().replace(/[:.]/g, "-");
}

export async function ensureDir(dirPath: string): Promise<string> {
	await mkdir(dirPath, { recursive: true });
	return dirPath;
}

export async function writeArtifactFile(
	filePath: string,
	content: string | Uint8Array,
): Promise<{ path: string; bytes: number }> {
	await ensureDir(path.dirname(filePath));
	await writeFile(filePath, content);
	const fileStat = await stat(filePath);
	return { path: filePath, bytes: fileStat.size };
}

export async function copyArtifactFile(
	sourcePath: string,
	destinationPath: string,
): Promise<{ path: string; bytes: number }> {
	await ensureDir(path.dirname(destinationPath));
	await copyFile(sourcePath, destinationPath);
	const fileStat = await stat(destinationPath);
	return { path: destinationPath, bytes: fileStat.size };
}

export function ensureSessionStartedAt(): number {
	let t = getSessionStartedAt();
	if (!t) {
		t = Date.now();
		setSessionStartedAt(t);
	}
	return t;
}

export async function ensureSessionArtifactDir(): Promise<string> {
	const existing = getSessionArtifactDir();
	if (existing) {
		await ensureDir(existing);
		return existing;
	}
	const startedAt = ensureSessionStartedAt();
	const dir = path.join(ARTIFACT_ROOT, `${formatArtifactTimestamp(startedAt)}-session`);
	setSessionArtifactDir(dir);
	await ensureDir(dir);
	return dir;
}

export function buildSessionArtifactPath(filename: string): string {
	const dir = getSessionArtifactDir();
	if (!dir) {
		throw new Error("browser session artifact directory is not initialized");
	}
	return path.join(dir, filename);
}

export function getActivePageMetadata() {
	const registry = pageRegistry;
	const activeEntry =
		registry.activePageId !== null
			? registry.pages.find((entry: any) => entry.id === registry.activePageId) ?? null
			: null;
	return {
		id: activeEntry?.id ?? null,
		title: activeEntry?.title ?? "",
		url: activeEntry?.url ?? "",
	};
}

export function getActiveFrameMetadata() {
	const frame = getActiveFrame();
	if (!frame) {
		return { name: null, url: null };
	}
	return {
		name: frame.name() || null,
		url: frame.url() || null,
	};
}

export function getSessionArtifactMetadata() {
	return {
		artifactRoot: ARTIFACT_ROOT,
		sessionStartedAt: getSessionStartedAt(),
		sessionArtifactDir: getSessionArtifactDir(),
		activeTraceSession: getActiveTraceSession(),
		harState: { ...getHarState() },
		activePage: getActivePageMetadata(),
		activeFrame: getActiveFrameMetadata(),
	};
}

export function sanitizeArtifactName(value: string, fallback: string): string {
	const sanitized = value
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || fallback;
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

/**
 * getLivePagesSnapshot requires ensureBrowser (circular) — it will be
 * wired in via ToolDeps. This is a factory that takes ensureBrowser.
 */
export function createGetLivePagesSnapshot(
	ensureBrowser: () => Promise<{ page: Page }>,
) {
	return async function getLivePagesSnapshot() {
		await ensureBrowser();
		for (const entry of pageRegistry.pages) {
			try {
				entry.title = await entry.page.title();
				entry.url = entry.page.url();
			} catch {
				// Page may have been closed between snapshots.
			}
		}
		return registryListPages(pageRegistry);
	};
}

export async function resolveAccessibilityScope(
	selector?: string,
): Promise<{ selector?: string; scope: string; source: string }> {
	if (selector?.trim()) {
		return {
			selector: selector.trim(),
			scope: `selector:${selector.trim()}`,
			source: "explicit_selector",
		};
	}
	const frame = getActiveFrame();
	// We need getActiveTarget for dialog check, but that requires page access.
	// For non-frame scoping, the caller must handle dialog detection separately
	// if needed. Here we handle the frame case and fall through to full_page.
	if (frame) {
		return {
			selector: "body",
			scope: frame.name()
				? `active frame:${frame.name()}`
				: "active frame",
			source: "active_frame",
		};
	}
	return { selector: "body", scope: "full page", source: "full_page" };
}

/**
 * captureAccessibilityMarkdown — needs access to the active target.
 * Accepts the target (Page | Frame) so it doesn't need to pull from state.
 */
export async function captureAccessibilityMarkdown(
	target: Page | Frame,
	selector?: string,
): Promise<{ snapshot: string; scope: string; source: string }> {
	const scopeInfo = await resolveAccessibilityScope(selector);
	const locator = target.locator(scopeInfo.selector ?? "body").first();
	const snapshot = await locator.ariaSnapshot();
	return { snapshot, scope: scopeInfo.scope, source: scopeInfo.source };
}

// ---------------------------------------------------------------------------
// Critical request tracking
// ---------------------------------------------------------------------------

export function isCriticalResourceType(resourceType: string): boolean {
	return resourceType === "document" || resourceType === "fetch" || resourceType === "xhr";
}

export function updatePendingCriticalRequests(p: Page, delta: number): void {
	const map = getPendingCriticalRequestsByPage();
	const current = map.get(p) ?? 0;
	map.set(p, Math.max(0, current + delta));
}

export function getPendingCriticalRequests(p: Page): number {
	return getPendingCriticalRequestsByPage().get(p) ?? 0;
}

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

export function verificationFromChecks(
	checks: BrowserVerificationCheck[],
	retryHint?: string,
): BrowserVerificationResult {
	const passedChecks = checks
		.filter((check) => check.passed)
		.map((check) => check.name);
	const verified = passedChecks.length > 0;
	return {
		verified,
		checks,
		verificationSummary: verified
			? `PASS (${passedChecks.join(", ")})`
			: "SOFT-FAIL (no observable state change)",
		retryHint: verified ? undefined : retryHint,
	};
}

export function verificationLine(verification: BrowserVerificationResult): string {
	return `Verification: ${verification.verificationSummary}`;
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

export async function collectAssertionState(
	p: Page,
	checks: BrowserAssertionCheckInput[],
	captureCompactPageState: (
		p: Page,
		options?: { selectors?: string[]; includeBodyText?: boolean; target?: Page | Frame },
	) => Promise<CompactPageState>,
	target?: Page | Frame,
): Promise<{
	url: string;
	title: string;
	bodyText: string;
	focus: string;
	selectorStates: Record<string, CompactSelectorState>;
	consoleEntries: ConsoleEntry[];
	networkEntries: NetworkEntry[];
	allConsoleEntries: ConsoleEntry[];
	allNetworkEntries: NetworkEntry[];
	actionTimeline: typeof actionTimeline;
}> {
	const selectors = checks
		.map((check) => check.selector)
		.filter((value): value is string => !!value);
	const compactState = await captureCompactPageState(p, {
		selectors,
		includeBodyText: true,
		target,
	});
	const sinceActionId = checks.reduce<number | undefined>((max, check) => {
		if (check.sinceActionId === undefined) return max;
		if (max === undefined) return check.sinceActionId;
		return Math.max(max, check.sinceActionId);
	}, undefined);
	return {
		url: compactState.url,
		title: compactState.title,
		bodyText: compactState.bodyText,
		focus: compactState.focus,
		selectorStates: compactState.selectorStates,
		consoleEntries: getConsoleEntriesSince(sinceActionId),
		networkEntries: getNetworkEntriesSince(sinceActionId),
		allConsoleEntries: getConsoleLogs(),
		allNetworkEntries: getNetworkLogs(),
		actionTimeline,
	};
}

export function formatAssertionText(
	result: ReturnType<typeof import("./core.js").evaluateAssertionChecks>,
): string {
	const lines = [result.summary];
	for (const check of result.checks.slice(0, 8)) {
		lines.push(
			`- ${check.passed ? "PASS" : "FAIL"} ${check.name}: expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(check.actual)}`,
		);
	}
	lines.push(`Hint: ${result.agentHint}`);
	return lines.join("\n");
}

export function formatDiffText(
	diff: ReturnType<typeof import("./core.js").diffCompactStates>,
): string {
	const lines = [diff.summary];
	for (const change of diff.changes.slice(0, 8)) {
		lines.push(
			`- ${change.type}: ${JSON.stringify(change.before ?? null)} → ${JSON.stringify(change.after ?? null)}`,
		);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// URL / dialog helpers
// ---------------------------------------------------------------------------

export function getUrlHash(url: string): string {
	try {
		return new URL(url).hash || "";
	} catch {
		return "";
	}
}

export async function countOpenDialogs(target: Page | Frame): Promise<number> {
	try {
		return await target.evaluate(() =>
			document.querySelectorAll('[role="dialog"]:not([hidden]),dialog[open]')
				.length,
		);
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Click / input helpers
// ---------------------------------------------------------------------------

export async function captureClickTargetState(
	target: Page | Frame,
	selector: string,
): Promise<ClickTargetStateSnapshot> {
	try {
		return await target.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement | null;
			if (!el) {
				return {
					exists: false,
					ariaExpanded: null,
					ariaPressed: null,
					ariaSelected: null,
					open: null,
				};
			}
			return {
				exists: true,
				ariaExpanded: el.getAttribute("aria-expanded"),
				ariaPressed: el.getAttribute("aria-pressed"),
				ariaSelected: el.getAttribute("aria-selected"),
				open:
					el instanceof HTMLDialogElement
						? el.open
						: el.getAttribute("open") !== null,
			};
		}, selector);
	} catch {
		return {
			exists: false,
			ariaExpanded: null,
			ariaPressed: null,
			ariaSelected: null,
			open: null,
		};
	}
}

export async function readInputLikeValue(
	target: Page | Frame,
	selector?: string,
): Promise<string | null> {
	try {
		return await target.evaluate((sel) => {
			const resolveTarget = (): Element | null => {
				if (sel) return document.querySelector(sel);
				const active = document.activeElement;
				if (
					!active ||
					active === document.body ||
					active === document.documentElement
				)
					return null;
				return active;
			};

			const target = resolveTarget();
			if (!target) return null;
			if (
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement
			) {
				return target.value;
			}
			if (target instanceof HTMLSelectElement) {
				return target.value;
			}
			if ((target as HTMLElement).isContentEditable) {
				return (target.textContent ?? "").trim();
			}
			return (target as HTMLElement).getAttribute("value");
		}, selector);
	} catch {
		return null;
	}
}

export function firstErrorLine(err: unknown): string {
	const message =
		typeof err === "object" && err && "message" in err
			? String((err as { message?: unknown }).message ?? "")
			: String(err ?? "unknown error");
	return message.split("\n")[0] || "unknown error";
}

// ---------------------------------------------------------------------------
// Action tracking
// ---------------------------------------------------------------------------

export function beginTrackedAction(
	tool: string,
	params: unknown,
	beforeUrl: string,
) {
	return beginAction(actionTimeline, {
		tool,
		paramsSummary: toActionParamsSummary(params),
		beforeUrl,
	});
}

export function finishTrackedAction(
	actionId: number,
	updates: {
		status: "success" | "error";
		afterUrl?: string;
		verificationSummary?: string;
		warningSummary?: string;
		diffSummary?: string;
		changed?: boolean;
		error?: string;
		beforeState?: CompactPageState;
		afterState?: CompactPageState;
	},
) {
	return finishAction(actionTimeline, actionId, updates);
}

export function getSinceTimestamp(sinceActionId?: number): number {
	if (!sinceActionId) return 0;
	const action = findAction(actionTimeline, sinceActionId);
	if (!action) return 0;
	return action.startedAt ?? 0;
}

export function getConsoleEntriesSince(sinceActionId?: number): ConsoleEntry[] {
	const since = getSinceTimestamp(sinceActionId);
	return getConsoleLogs().filter((entry) => entry.timestamp >= since);
}

export function getNetworkEntriesSince(sinceActionId?: number): NetworkEntry[] {
	const since = getSinceTimestamp(sinceActionId);
	return getNetworkLogs().filter((entry) => entry.timestamp >= since);
}

// ---------------------------------------------------------------------------
// Error summary
// ---------------------------------------------------------------------------

export function getRecentErrors(pageUrl: string): string {
	const parts: string[] = [];
	const now = Date.now();
	const since = now - 12_000;

	const toOrigin = (url: string): string | null => {
		try {
			return new URL(url).origin;
		} catch {
			return null;
		}
	};
	const pageOrigin = toOrigin(pageUrl);
	const sameOrigin = (url: string): boolean =>
		!pageOrigin || toOrigin(url) === pageOrigin;

	const summarize = (items: string[], max: number): string[] => {
		const counts = new Map<string, number>();
		const order: string[] = [];
		for (const item of items) {
			if (!counts.has(item)) order.push(item);
			counts.set(item, (counts.get(item) ?? 0) + 1);
		}
		return order.slice(0, max).map((item) => {
			const count = counts.get(item) ?? 1;
			return count > 1 ? `${item} (x${count})` : item;
		});
	};

	const consoleLogs = getConsoleLogs();
	const jsWarnings = consoleLogs
		.filter(
			(e) =>
				(e.type === "error" || e.type === "pageerror") &&
				e.timestamp >= since &&
				sameOrigin(e.url),
		)
		.map((e) => e.text.slice(0, 120));
	if (jsWarnings.length > 0) {
		parts.push("JS: " + summarize(jsWarnings, 2).join(" | "));
	}

	const actionableStatus = new Set([401, 403, 404, 408, 409, 422, 429]);
	const actionableTypes = new Set(["document", "fetch", "xhr", "script"]);
	const networkLogs = getNetworkLogs();
	const netWarnings = networkLogs
		.filter((e) => e.timestamp >= since && sameOrigin(e.url))
		.filter((e) => {
			if (e.failed) return actionableTypes.has(e.resourceType);
			if (e.status === null) return false;
			if (e.status >= 500) return true;
			return (
				actionableStatus.has(e.status) &&
				actionableTypes.has(e.resourceType)
			);
		})
		.map((e) => {
			if (e.failed) return `${e.method} ${e.resourceType} FAILED`;
			return `${e.method} ${e.resourceType} ${e.status}`;
		});
	if (netWarnings.length > 0) {
		parts.push("Network: " + summarize(netWarnings, 2).join(" | "));
	}

	const dialogLogs = getDialogLogs();
	const dialogWarnings = dialogLogs
		.filter((e) => e.timestamp >= since && sameOrigin(e.url))
		.map((e) => `${e.type}: ${e.message.slice(0, 80)}`);
	if (dialogWarnings.length > 0) {
		parts.push("Dialogs: " + summarize(dialogWarnings, 1).join(" | "));
	}

	if (parts.length === 0) return "";
	return `\n\nWarnings: ${parts.join("; ")}\nUse browser_get_console_logs/browser_get_network_logs for full diagnostics.`;
}

// ---------------------------------------------------------------------------
// Ref helpers (parsing / formatting — no browser evaluate)
// ---------------------------------------------------------------------------

export function parseRef(input: string): ParsedRefSpec {
	const trimmed = input.trim().toLowerCase();
	const token = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
	const versioned = token.match(/^v(\d+):(e\d+)$/);
	if (versioned) {
		const version = parseInt(versioned[1], 10);
		const key = versioned[2];
		return { key, version, display: `@v${version}:${key}` };
	}
	return { key: token, version: null, display: `@${token}` };
}

export function formatVersionedRef(version: number, key: string): string {
	return `@v${version}:${key}`;
}

export function staleRefGuidance(refDisplay: string, reason: string): string {
	return `Ref ${refDisplay} could not be resolved (${reason}). The ref is likely stale after DOM/navigation changes. Call browser_snapshot_refs again to refresh refs.`;
}

// ---------------------------------------------------------------------------
// Compact state summary formatting
// ---------------------------------------------------------------------------

export function formatCompactStateSummary(state: CompactPageState): string {
	const lines: string[] = [];
	lines.push(`Title: ${state.title}`);
	lines.push(`URL: ${state.url}`);
	lines.push(
		`Elements: ${state.counts.landmarks} landmarks, ${state.counts.buttons} buttons, ${state.counts.links} links, ${state.counts.inputs} inputs`,
	);
	if (state.headings.length > 0) {
		lines.push(
			"Headings: " +
				state.headings
					.map((text, index) => `H${index + 1} \"${text}\"`)
					.join(", "),
		);
	}
	if (state.focus) {
		lines.push(`Focused: ${state.focus}`);
	}
	if (state.dialog.title) {
		lines.push(`Active dialog: "${state.dialog.title}"`);
	}
	lines.push(
		"Use browser_find for targeted discovery, browser_assert for verification, or browser_get_accessibility_tree for full detail.",
	);
	return lines.join("\n");
}
