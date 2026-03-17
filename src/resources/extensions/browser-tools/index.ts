/**
 * browser-tools — pi extension
 *
 * Gives the agent full browser interaction capabilities for verifying and testing
 * UI work without requiring a human to look at the screen.
 *
 * Key design principles:
 *  - Every action returns feedback (accessibility snapshot, screenshots on navigate)
 *  - Errors include visual debugging (screenshots on failure, surfaced JS errors)
 *  - Smart waits (domcontentloaded + best-effort settle, not blocking networkidle)
 *  - Screenshots capped at 1568px max dimension (Anthropic API limit safety)
 *  - JPEG for viewport screenshots (smaller), PNG for element crops (transparency)
 *  - Auto-handles JS dialogs (alert/confirm/prompt) to prevent page freezes
 *  - Auto-switches to new tabs (popups, target="_blank")
 *
 * Architecture:
 *  - Single shared Browser + BrowserContext + Page per session
 *  - Console, network, and dialog events buffered in memory
 *  - Browser launched headed so the user can optionally watch
 *  - Cleaned up on session_shutdown
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { Browser, BrowserContext, Frame, Page } from "playwright";
import { mkdir, stat, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import {
	beginAction,
	createActionTimeline,
	createBoundedLogPusher,
	createPageRegistry,
	diffCompactStates,
	evaluateAssertionChecks,
	finishAction,
	findAction,
	formatTimelineEntries,
	getSnapshotModeConfig,
	buildFailureHypothesis,
	summarizeBrowserSession,
	registryAddPage,
	registryGetActive,
	registryListPages,
	registryRemovePage,
	registrySetActive,
	runBatchSteps,
	SNAPSHOT_MODES,
	toActionParamsSummary,
	validateWaitParams,
	createRegionStableScript,
	parseThreshold,
	meetsThreshold,
	includesNeedle,
} from "./core.js";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let browser: Browser | null = null;
let context: BrowserContext | null = null;
const pageRegistry = createPageRegistry();
let activeFrame: Frame | null = null;
const logPusher = createBoundedLogPusher(1000);

interface ConsoleEntry {
	type: string;
	text: string;
	timestamp: number;
	url: string;
	pageId: number;
}

interface NetworkEntry {
	method: string;
	url: string;
	status: number | null;
	resourceType: string;
	timestamp: number;
	failed: boolean;
	failureText?: string;
	responseBody?: string; // Only captured for 4xx/5xx responses, truncated to 2000 chars
	pageId: number;
}

let consoleLogs: ConsoleEntry[] = [];
let networkLogs: NetworkEntry[] = [];

interface DialogEntry {
	type: string;         // "alert" | "confirm" | "prompt" | "beforeunload"
	message: string;
	timestamp: number;
	url: string;
	defaultValue?: string; // For prompt dialogs
	accepted: boolean;     // Whether we auto-accepted or dismissed
	pageId: number;
}

let dialogLogs: DialogEntry[] = [];

const pendingCriticalRequestsByPage = new WeakMap<Page, number>();

interface RefNode {
	ref: string;
	tag: string;
	role: string;
	name: string;
	selectorHints: string[];
	isVisible: boolean;
	isEnabled: boolean;
	xpathOrPath: string;
	href?: string;
	type?: string;
	path: number[];
	contentHash?: string;
	structuralSignature?: string;
	nearestHeading?: string;
	formOwnership?: string;
}

interface RefMetadata {
	url: string;
	timestamp: number;
	selectorScope?: string;
	interactiveOnly: boolean;
	limit: number;
	version: number;
	frameContext?: string; // Records which frame the snapshot was taken in (name or URL), undefined = main page
	mode?: string; // Snapshot mode used (e.g. "form", "dialog", "navigation"), undefined = no mode (legacy interactiveOnly behavior)
}

let currentRefMap: Record<string, RefNode> = {};
let refVersion = 0;
let refMetadata: RefMetadata | null = null;
const actionTimeline = createActionTimeline(60);

interface CompactSelectorState {
	exists: boolean;
	visible: boolean;
	value: string;
	checked: boolean | null;
	text: string;
}

interface CompactPageState {
	url: string;
	title: string;
	focus: string;
	headings: string[];
	bodyText: string;
	counts: {
		landmarks: number;
		buttons: number;
		links: number;
		inputs: number;
	};
	dialog: {
		count: number;
		title: string;
	};
	selectorStates: Record<string, CompactSelectorState>;
}

let lastActionBeforeState: CompactPageState | null = null;
let lastActionAfterState: CompactPageState | null = null;

const ARTIFACT_ROOT = path.resolve(process.cwd(), ".artifacts", "browser");
const HAR_FILENAME = "session.har";

interface TraceSessionState {
	startedAt: number;
	name: string;
	title?: string;
	path?: string;
}

interface HarState {
	enabled: boolean;
	configuredAtContextCreation: boolean;
	path: string | null;
	exportCount: number;
	lastExportedPath: string | null;
	lastExportedAt: number | null;
}

let sessionStartedAt: number | null = null;
let sessionArtifactDir: string | null = null;
let activeTraceSession: TraceSessionState | null = null;
let harState: HarState = {
	enabled: false,
	configuredAtContextCreation: false,
	path: null,
	exportCount: 0,
	lastExportedPath: null,
	lastExportedAt: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCriticalResourceType(resourceType: string): boolean {
	return resourceType === "document" || resourceType === "fetch" || resourceType === "xhr";
}

function updatePendingCriticalRequests(p: Page, delta: number): void {
	const current = pendingCriticalRequestsByPage.get(p) ?? 0;
	pendingCriticalRequestsByPage.set(p, Math.max(0, current + delta));
}

function getPendingCriticalRequests(p: Page): number {
	return pendingCriticalRequestsByPage.get(p) ?? 0;
}

/** Attach all event listeners to a page. Called on initial page and new tabs. */
function attachPageListeners(p: Page, pageId: number): void {
	pendingCriticalRequestsByPage.set(p, 0);

	// Console messages
	p.on("console", (msg) => {
		logPusher(consoleLogs, {
			type: msg.type(),
			text: msg.text(),
			timestamp: Date.now(),
			url: p.url(),
			pageId,
		});
	});

	// Uncaught JS errors
	p.on("pageerror", (err) => {
		logPusher(consoleLogs, {
			type: "pageerror",
			text: err.message,
			timestamp: Date.now(),
			url: p.url(),
			pageId,
		});
	});

	// Network requests — start/completed/failed
	p.on("request", (request) => {
		if (isCriticalResourceType(request.resourceType())) {
			updatePendingCriticalRequests(p, 1);
		}
	});

	p.on("requestfinished", async (request) => {
		if (isCriticalResourceType(request.resourceType())) {
			updatePendingCriticalRequests(p, -1);
		}
		try {
			const response = await request.response();
			const status = response?.status() ?? null;
			const entry: NetworkEntry = {
				method: request.method(),
				url: request.url(),
				status,
				resourceType: request.resourceType(),
				timestamp: Date.now(),
				failed: false,
				pageId,
			};
			if (response && status !== null && status >= 400) {
				try {
					const body = await response.text();
					entry.responseBody = body.slice(0, 2000);
				} catch {}
			}
			logPusher(networkLogs, entry);
		} catch {}
	});

	p.on("requestfailed", (request) => {
		if (isCriticalResourceType(request.resourceType())) {
			updatePendingCriticalRequests(p, -1);
		}
		logPusher(networkLogs, {
			method: request.method(),
			url: request.url(),
			status: null,
			resourceType: request.resourceType(),
			timestamp: Date.now(),
			failed: true,
			failureText: request.failure()?.errorText ?? "Unknown failure",
			pageId,
		});
	});

	// Auto-handle JS dialogs (alert, confirm, prompt, beforeunload)
	p.on("dialog", async (dialog) => {
		logPusher(dialogLogs, {
			type: dialog.type(),
			message: dialog.message(),
			timestamp: Date.now(),
			url: p.url(),
			defaultValue: dialog.defaultValue() || undefined,
			accepted: true,
			pageId,
		});
		// Auto-accept all dialogs to prevent page freezes
		await dialog.accept().catch(() => {});
	});

	// Frame detach handler — clears activeFrame if the selected frame detaches
	p.on("framedetached", (frame) => {
		if (activeFrame === frame) activeFrame = null;
	});

	// Page close handler — removes page from registry and handles active fallback
	p.on("close", () => {
		try {
			registryRemovePage(pageRegistry, pageId);
		} catch {
			// Page already removed (e.g. during closeBrowser)
		}
	});
}

async function ensureBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
	if (browser && context) {
		return { browser, context, page: getActivePage() };
	}

	const startedAt = ensureSessionStartedAt();
	const artifactDir = await ensureSessionArtifactDir();
	const sessionHarPath = path.join(artifactDir, HAR_FILENAME);
	harState = {
		enabled: true,
		configuredAtContextCreation: true,
		path: sessionHarPath,
		exportCount: 0,
		lastExportedPath: null,
		lastExportedAt: null,
	};

	// Lazy import so playwright is only loaded when actually needed
	const { chromium } = await import("playwright");

	const headless = process.env.GSD_BROWSER_HEADLESS === "1";
	const launchOptions: Record<string, unknown> = { headless };
	const customPath = process.env.BROWSER_PATH;
	if (customPath) launchOptions.executablePath = customPath;
	browser = await chromium.launch(launchOptions);
	context = await browser.newContext({
		deviceScaleFactor: 2,
		viewport: { width: 1280, height: 800 },
		recordHar: {
			path: sessionHarPath,
			mode: "minimal",
			content: "omit",
		},
	});
	sessionStartedAt = startedAt;
	sessionArtifactDir = artifactDir;
	const initialPage = await context.newPage();
	const pageEntry = registryAddPage(pageRegistry, {
		page: initialPage,
		title: await initialPage.title().catch(() => ""),
		url: initialPage.url(),
		opener: null,
	});
	registrySetActive(pageRegistry, pageEntry.id);
	attachPageListeners(initialPage, pageEntry.id);

	// Register new pages (popups, target="_blank", window.open) but do NOT auto-switch
	context.on("page", (newPage) => {
		// Determine opener page ID — find which registry page opened this one
		const openerPage = newPage.opener();
		let openerId: number | null = null;
		if (openerPage) {
			const openerEntry = pageRegistry.pages.find((e: any) => e.page === openerPage);
			if (openerEntry) openerId = openerEntry.id;
		}
		const entry = registryAddPage(pageRegistry, {
			page: newPage,
			title: "",
			url: newPage.url(),
			opener: openerId,
		});
		attachPageListeners(newPage, entry.id);
		// Update title once loaded
		newPage.waitForLoadState("domcontentloaded", { timeout: 5000 })
			.then(() => newPage.title())
			.then((title) => { entry.title = title; })
			.catch(() => {});
	});

	return { browser, context, page: getActivePage() };
}

/** Get the currently active page from the registry. */
function getActivePage(): Page {
	return registryGetActive(pageRegistry).page;
}

/** Get the active target — returns the selected frame if one is active, otherwise the active page. */
function getActiveTarget(): Page | Frame {
	return activeFrame ?? getActivePage();
}

/** Safe accessor for error handling — returns the active page or null if unavailable. */
function getActivePageOrNull(): Page | null {
	try {
		return getActivePage();
	} catch {
		return null;
	}
}

async function closeBrowser(): Promise<void> {
	if (browser) {
		await browser.close().catch(() => {});
	}
	browser = null;
	context = null;
	pageRegistry.pages = [];
	pageRegistry.activePageId = null;
	pageRegistry.nextId = 1;
	activeFrame = null;
	consoleLogs = [];
	networkLogs = [];
	dialogLogs = [];
	currentRefMap = {};
	refVersion = 0;
	refMetadata = null;
	lastActionBeforeState = null;
	lastActionAfterState = null;
	actionTimeline.entries = [];
	actionTimeline.nextId = 1;
	sessionStartedAt = null;
	sessionArtifactDir = null;
	activeTraceSession = null;
	harState = {
		enabled: false,
		configuredAtContextCreation: false,
		path: null,
		exportCount: 0,
		lastExportedPath: null,
		lastExportedAt: null,
	};
}

function truncateText(text: string): string {
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

function formatArtifactTimestamp(timestamp: number): string {
	return new Date(timestamp).toISOString().replace(/[:.]/g, "-");
}

async function ensureDir(dirPath: string): Promise<string> {
	await mkdir(dirPath, { recursive: true });
	return dirPath;
}

async function writeArtifactFile(filePath: string, content: string | Uint8Array): Promise<{ path: string; bytes: number }> {
	await ensureDir(path.dirname(filePath));
	await writeFile(filePath, content);
	const fileStat = await stat(filePath);
	return { path: filePath, bytes: fileStat.size };
}

async function copyArtifactFile(sourcePath: string, destinationPath: string): Promise<{ path: string; bytes: number }> {
	await ensureDir(path.dirname(destinationPath));
	await copyFile(sourcePath, destinationPath);
	const fileStat = await stat(destinationPath);
	return { path: destinationPath, bytes: fileStat.size };
}

function ensureSessionStartedAt(): number {
	if (!sessionStartedAt) sessionStartedAt = Date.now();
	return sessionStartedAt;
}

async function ensureSessionArtifactDir(): Promise<string> {
	if (sessionArtifactDir) {
		await ensureDir(sessionArtifactDir);
		return sessionArtifactDir;
	}
	const startedAt = ensureSessionStartedAt();
	sessionArtifactDir = path.join(ARTIFACT_ROOT, `${formatArtifactTimestamp(startedAt)}-session`);
	await ensureDir(sessionArtifactDir);
	return sessionArtifactDir;
}

function buildSessionArtifactPath(filename: string): string {
	if (!sessionArtifactDir) {
		throw new Error("browser session artifact directory is not initialized");
	}
	return path.join(sessionArtifactDir, filename);
}

function getActivePageMetadata() {
	const activeEntry = pageRegistry.activePageId !== null
		? pageRegistry.pages.find((entry: any) => entry.id === pageRegistry.activePageId) ?? null
		: null;
	return {
		id: activeEntry?.id ?? null,
		title: activeEntry?.title ?? "",
		url: activeEntry?.url ?? "",
	};
}

function getActiveFrameMetadata() {
	if (!activeFrame) {
		return { name: null, url: null };
	}
	return {
		name: activeFrame.name() || null,
		url: activeFrame.url() || null,
	};
}

function getSessionArtifactMetadata() {
	return {
		artifactRoot: ARTIFACT_ROOT,
		sessionStartedAt,
		sessionArtifactDir,
		activeTraceSession,
		harState: { ...harState },
		activePage: getActivePageMetadata(),
		activeFrame: getActiveFrameMetadata(),
	};
}

function sanitizeArtifactName(value: string, fallback: string): string {
	const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || fallback;
}

async function getLivePagesSnapshot() {
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
}

async function resolveAccessibilityScope(selector?: string): Promise<{ selector?: string; scope: string; source: string }> {
	if (selector?.trim()) {
		return { selector: selector.trim(), scope: `selector:${selector.trim()}`, source: "explicit_selector" };
	}
	const target = getActiveTarget();
	const dialogCount = await countOpenDialogs(target).catch(() => 0);
	if (dialogCount > 0) {
		return { selector: '[role="dialog"]:not([hidden]),dialog[open]', scope: "active dialog", source: "active_dialog" };
	}
	if (activeFrame) {
		return { selector: "body", scope: activeFrame.name() ? `active frame:${activeFrame.name()}` : "active frame", source: "active_frame" };
	}
	return { selector: "body", scope: "full page", source: "full_page" };
}

async function captureAccessibilityMarkdown(selector?: string): Promise<{ snapshot: string; scope: string; source: string }> {
	const target = getActiveTarget();
	const scopeInfo = await resolveAccessibilityScope(selector);
	const locator = target.locator(scopeInfo.selector ?? "body").first();
	const snapshot = await locator.ariaSnapshot();
	return { snapshot, scope: scopeInfo.scope, source: scopeInfo.source };
}

function beginTrackedAction(tool: string, params: unknown, beforeUrl: string) {
	return beginAction(actionTimeline, {
		tool,
		paramsSummary: toActionParamsSummary(params),
		beforeUrl,
	});
}

function finishTrackedAction(
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
	}
) {
	return finishAction(actionTimeline, actionId, updates);
}

function getSinceTimestamp(sinceActionId?: number): number {
	if (!sinceActionId) return 0;
	const action = findAction(actionTimeline, sinceActionId);
	if (!action) return 0;
	return action.startedAt ?? 0;
}

function getConsoleEntriesSince(sinceActionId?: number): ConsoleEntry[] {
	const since = getSinceTimestamp(sinceActionId);
	return consoleLogs.filter((entry) => entry.timestamp >= since);
}

function getNetworkEntriesSince(sinceActionId?: number): NetworkEntry[] {
	const since = getSinceTimestamp(sinceActionId);
	return networkLogs.filter((entry) => entry.timestamp >= since);
}

async function captureCompactPageState(
	p: Page,
	options: { selectors?: string[]; includeBodyText?: boolean; target?: Page | Frame } = {}
): Promise<CompactPageState> {
	const selectors = Array.from(new Set((options.selectors ?? []).filter(Boolean)));
	const target = options.target ?? p;
	const domState = await target.evaluate(({ selectors, includeBodyText }) => {
		const selectorStates: Record<string, CompactSelectorState> = {};
		for (const selector of selectors) {
			let el: Element | null = null;
			try {
				el = document.querySelector(selector);
			} catch {
				el = null;
			}
			if (!el) {
				selectorStates[selector] = {
					exists: false,
					visible: false,
					value: "",
					checked: null,
					text: "",
				};
				continue;
			}
			const htmlEl = el as HTMLElement;
			const style = window.getComputedStyle(htmlEl);
			const rect = htmlEl.getBoundingClientRect();
			const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
			const input = el as HTMLInputElement;
			selectorStates[selector] = {
				exists: true,
				visible,
				value:
					el instanceof HTMLInputElement ||
					el instanceof HTMLTextAreaElement ||
					el instanceof HTMLSelectElement
						? el.value
						: htmlEl.getAttribute("value") || "",
				checked: el instanceof HTMLInputElement && ["checkbox", "radio"].includes(input.type) ? input.checked : null,
				text: (htmlEl.innerText || htmlEl.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160),
			};
		}

		const focused = document.activeElement as HTMLElement | null;
		const focusedDesc = focused && focused !== document.body && focused !== document.documentElement
			? `${focused.tagName.toLowerCase()}${focused.id ? '#' + focused.id : ''}${focused.getAttribute('aria-label') ? ' "' + focused.getAttribute('aria-label') + '"' : ''}`
			: "";
		const headings = Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 5).map((h) => (h.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80));
		const dialog = document.querySelector('[role="dialog"]:not([hidden]),dialog[open]');
		const dialogTitle = dialog?.querySelector('[role="heading"],[aria-label]')?.textContent?.trim().slice(0, 80) ?? "";
		const bodyText = includeBodyText
			? (document.body?.innerText || document.body?.textContent || "").trim().replace(/\s+/g, ' ').slice(0, 4000)
			: "";
		return {
			url: window.location.href,
			title: document.title,
			focus: focusedDesc,
			headings,
			bodyText,
			counts: {
				landmarks: document.querySelectorAll('[role="main"],[role="banner"],[role="navigation"],[role="contentinfo"],[role="complementary"],[role="search"],[role="form"],[role="dialog"],[role="alert"],main,header,nav,footer,aside,section,form,dialog').length,
				buttons: document.querySelectorAll('button,[role="button"]').length,
				links: document.querySelectorAll('a[href]').length,
				inputs: document.querySelectorAll('input,textarea,select').length,
			},
			dialog: {
				count: document.querySelectorAll('[role="dialog"]:not([hidden]),dialog[open]').length,
				title: dialogTitle,
			},
			selectorStates,
		};
	}, { selectors, includeBodyText: options.includeBodyText === true });
	// URL and title always come from the Page, not the frame
	return { ...domState, url: p.url(), title: await p.title() };
}

function formatCompactStateSummary(state: CompactPageState): string {
	const lines: string[] = [];
	lines.push(`Title: ${state.title}`);
	lines.push(`URL: ${state.url}`);
	lines.push(`Elements: ${state.counts.landmarks} landmarks, ${state.counts.buttons} buttons, ${state.counts.links} links, ${state.counts.inputs} inputs`);
	if (state.headings.length > 0) {
		lines.push("Headings: " + state.headings.map((text, index) => `H${index + 1} \"${text}\"`).join(", "));
	}
	if (state.focus) {
		lines.push(`Focused: ${state.focus}`);
	}
	if (state.dialog.title) {
		lines.push(`Active dialog: "${state.dialog.title}"`);
	}
	lines.push("Use browser_find for targeted discovery, browser_assert for verification, or browser_get_accessibility_tree for full detail.");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Post-action helpers
// ---------------------------------------------------------------------------

/** Lightweight page summary after an action. Returns ~50-150 tokens instead of full tree. */
async function postActionSummary(p: Page, target?: Page | Frame): Promise<string> {
	try {
		const state = await captureCompactPageState(p, { target });
		return formatCompactStateSummary(state);
	} catch {
		return "[summary unavailable]";
	}
}

// Anthropic API rejects images > 2000px in multi-image requests.
// Cap at 1568px (recommended optimal size) to stay well within limits.
const MAX_SCREENSHOT_DIM = 1568;

/**
 * If either dimension of the image buffer exceeds MAX_SCREENSHOT_DIM,
 * downscale proportionally using the browser's canvas (zero dependencies).
 * Returns the original buffer unchanged if already within limits.
 */
async function constrainScreenshot(
	page: Page,
	buffer: Buffer,
	mimeType: string,
	quality: number,
): Promise<Buffer> {
	let width: number;
	let height: number;

	if (mimeType === "image/png") {
		width = buffer.readUInt32BE(16);
		height = buffer.readUInt32BE(20);
	} else {
		width = 0;
		height = 0;
		for (let i = 0; i < buffer.length - 8; i++) {
			if (buffer[i] === 0xff && (buffer[i + 1] === 0xc0 || buffer[i + 1] === 0xc2)) {
				height = buffer.readUInt16BE(i + 5);
				width = buffer.readUInt16BE(i + 7);
				break;
			}
		}
	}

	if (width <= MAX_SCREENSHOT_DIM && height <= MAX_SCREENSHOT_DIM) {
		return buffer;
	}

	const b64 = buffer.toString("base64");
	const result = await page.evaluate(
		async ({ b64, mime, maxDim, q }) => {
			const img = new Image();
			await new Promise<void>((resolve, reject) => {
				img.onload = () => resolve();
				img.onerror = reject;
				img.src = `data:${mime};base64,${b64}`;
			});
			const scale = Math.min(maxDim / img.width, maxDim / img.height);
			const w = Math.round(img.width * scale);
			const h = Math.round(img.height * scale);
			const canvas = document.createElement("canvas");
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(img, 0, 0, w, h);
			return canvas.toDataURL(mime, q / 100);
		},
		{ b64, mime: mimeType, maxDim: MAX_SCREENSHOT_DIM, q: quality },
	);

	const resizedB64 = result.split(",")[1];
	return Buffer.from(resizedB64, "base64");
}

/** Capture a JPEG screenshot for error debugging. Returns base64 or null. */
async function captureErrorScreenshot(p: Page | null): Promise<{ data: string; mimeType: string } | null> {
    if (!p) return null;
    try {
        let buf = await p.screenshot({ type: "jpeg", quality: 60, scale: "css" });
        buf = await constrainScreenshot(p, buf, "image/jpeg", 60);
        return { data: buf.toString("base64"), mimeType: "image/jpeg" };
    } catch {
        return null;
    }
}

/**
 * Compact, action-relevant warnings for the current page origin.
 * Full diagnostics stay pull-based via browser_get_console_logs/network_logs/dialog_logs.
 */
function getRecentErrors(pageUrl: string): string {
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
	const sameOrigin = (url: string): boolean => !pageOrigin || toOrigin(url) === pageOrigin;

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

	const jsWarnings = consoleLogs
		.filter((e) => (e.type === "error" || e.type === "pageerror") && e.timestamp >= since && sameOrigin(e.url))
		.map((e) => e.text.slice(0, 120));
	if (jsWarnings.length > 0) {
		parts.push("JS: " + summarize(jsWarnings, 2).join(" | "));
	}

	const actionableStatus = new Set([401, 403, 404, 408, 409, 422, 429]);
	const actionableTypes = new Set(["document", "fetch", "xhr", "script"]);
	const netWarnings = networkLogs
		.filter((e) => e.timestamp >= since && sameOrigin(e.url))
		.filter((e) => {
			if (e.failed) return actionableTypes.has(e.resourceType);
			if (e.status === null) return false;
			if (e.status >= 500) return true;
			return actionableStatus.has(e.status) && actionableTypes.has(e.resourceType);
		})
		.map((e) => {
			if (e.failed) return `${e.method} ${e.resourceType} FAILED`;
			return `${e.method} ${e.resourceType} ${e.status}`;
		});
	if (netWarnings.length > 0) {
		parts.push("Network: " + summarize(netWarnings, 2).join(" | "));
	}

	const dialogWarnings = dialogLogs
		.filter((e) => e.timestamp >= since && sameOrigin(e.url))
		.map((e) => `${e.type}: ${e.message.slice(0, 80)}`);
	if (dialogWarnings.length > 0) {
		parts.push("Dialogs: " + summarize(dialogWarnings, 1).join(" | "));
	}

	if (parts.length === 0) return "";
	return `\n\nWarnings: ${parts.join("; ")}\nUse browser_get_console_logs/browser_get_network_logs for full diagnostics.`;
}

interface AdaptiveSettleOptions {
	timeoutMs?: number;
	pollMs?: number;
	quietWindowMs?: number;
	checkFocusStability?: boolean;
}

interface AdaptiveSettleDetails {
	settleMode: "adaptive";
	settleMs: number;
	settleReason: "dom_quiet" | "url_changed_then_quiet" | "timeout_fallback";
	settlePolls: number;
}

async function ensureMutationCounter(p: Page): Promise<void> {
	await p.evaluate(() => {
		const key = "__piMutationCounter" as const;
		const installedKey = "__piMutationCounterInstalled" as const;
		const w = window as unknown as Record<string, unknown>;
		if (typeof w[key] !== "number") w[key] = 0;
		if (w[installedKey]) return;
		const observer = new MutationObserver(() => {
			const current = typeof w[key] === "number" ? (w[key] as number) : 0;
			w[key] = current + 1;
		});
		observer.observe(document.documentElement || document.body, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true,
		});
		w[installedKey] = true;
	});
}

async function readMutationCounter(p: Page): Promise<number> {
	try {
		return await p.evaluate(() => {
			const w = window as unknown as Record<string, unknown>;
			const value = w.__piMutationCounter;
			return typeof value === "number" ? value : 0;
		});
	} catch {
		return 0;
	}
}

async function readFocusedDescriptor(target: Page | Frame): Promise<string> {
	try {
		return await target.evaluate(() => {
			const el = document.activeElement as HTMLElement | null;
			if (!el || el === document.body || el === document.documentElement) return "";
			const id = el.id ? `#${el.id}` : "";
			const role = el.getAttribute("role") || "";
			const name = (el.getAttribute("aria-label") || el.getAttribute("name") || "").trim();
			return `${el.tagName.toLowerCase()}${id}|${role}|${name}`;
		});
	} catch {
		return "";
	}
}

async function settleAfterActionAdaptive(
	p: Page,
	opts: AdaptiveSettleOptions = {}
): Promise<AdaptiveSettleDetails> {
	const timeoutMs = Math.max(150, opts.timeoutMs ?? 500);
	const pollMs = Math.min(100, Math.max(20, opts.pollMs ?? 40));
	const quietWindowMs = Math.max(60, opts.quietWindowMs ?? 100);
	const checkFocus = opts.checkFocusStability ?? false;

	const startedAt = Date.now();
	let polls = 0;
	let sawUrlChange = false;
	let lastActivityAt = startedAt;
	let previousUrl = p.url();

	await ensureMutationCounter(p).catch(() => {});
	let previousMutationCount = await readMutationCounter(p);
	let previousFocus = checkFocus ? await readFocusedDescriptor(p) : "";

	while (Date.now() - startedAt < timeoutMs) {
		await new Promise((resolve) => setTimeout(resolve, pollMs));
		polls += 1;
		const now = Date.now();

		const currentUrl = p.url();
		if (currentUrl !== previousUrl) {
			sawUrlChange = true;
			previousUrl = currentUrl;
			lastActivityAt = now;
		}

		const currentMutationCount = await readMutationCounter(p);
		if (currentMutationCount > previousMutationCount) {
			previousMutationCount = currentMutationCount;
			lastActivityAt = now;
		}

		if (checkFocus) {
			const currentFocus = await readFocusedDescriptor(p);
			if (currentFocus !== previousFocus) {
				previousFocus = currentFocus;
				lastActivityAt = now;
			}
		}

		const pendingCritical = getPendingCriticalRequests(p);
		if (pendingCritical > 0) {
			lastActivityAt = now;
			continue;
		}

		if (now - lastActivityAt >= quietWindowMs) {
			return {
				settleMode: "adaptive",
				settleMs: now - startedAt,
				settleReason: sawUrlChange ? "url_changed_then_quiet" : "dom_quiet",
				settlePolls: polls,
			};
		}
	}

	return {
		settleMode: "adaptive",
		settleMs: Date.now() - startedAt,
		settleReason: "timeout_fallback",
		settlePolls: polls,
	};
}

interface ParsedRefSpec {
	key: string;
	version: number | null;
	display: string;
}

function parseRef(input: string): ParsedRefSpec {
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

function formatVersionedRef(version: number, key: string): string {
	return `@v${version}:${key}`;
}

function staleRefGuidance(refDisplay: string, reason: string): string {
	return `Ref ${refDisplay} could not be resolved (${reason}). The ref is likely stale after DOM/navigation changes. Call browser_snapshot_refs again to refresh refs.`;
}

interface VerificationCheck {
	name: string;
	passed: boolean;
	value?: unknown;
	expected?: unknown;
}

interface VerificationResult {
	verified: boolean;
	checks: VerificationCheck[];
	verificationSummary: string;
	retryHint?: string;
}

interface ClickTargetStateSnapshot {
	exists: boolean;
	ariaExpanded: string | null;
	ariaPressed: string | null;
	ariaSelected: string | null;
	open: boolean | null;
}

function verificationFromChecks(checks: VerificationCheck[], retryHint?: string): VerificationResult {
	const passedChecks = checks.filter((check) => check.passed).map((check) => check.name);
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

function verificationLine(verification: VerificationResult): string {
	return `Verification: ${verification.verificationSummary}`;
}

interface BrowserAssertionCheckInput {
	kind: string;
	selector?: string;
	text?: string;
	value?: string;
	checked?: boolean;
	sinceActionId?: number;
}

async function collectAssertionState(
	p: Page,
	checks: BrowserAssertionCheckInput[],
	target?: Page | Frame
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
	actionTimeline: ReturnType<typeof createActionTimeline>;
}> {
	const selectors = checks.map((check) => check.selector).filter((value): value is string => !!value);
	const compactState = await captureCompactPageState(p, { selectors, includeBodyText: true, target });
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
		allConsoleEntries: consoleLogs,
		allNetworkEntries: networkLogs,
		actionTimeline: actionTimeline,
	};
}

function formatAssertionText(result: ReturnType<typeof evaluateAssertionChecks>): string {
	const lines = [result.summary];
	for (const check of result.checks.slice(0, 8)) {
		lines.push(`- ${check.passed ? "PASS" : "FAIL"} ${check.name}: expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(check.actual)}`);
	}
	lines.push(`Hint: ${result.agentHint}`);
	return lines.join("\n");
}

function formatDiffText(diff: ReturnType<typeof diffCompactStates>): string {
	const lines = [diff.summary];
	for (const change of diff.changes.slice(0, 8)) {
		lines.push(`- ${change.type}: ${JSON.stringify(change.before ?? null)} → ${JSON.stringify(change.after ?? null)}`);
	}
	return lines.join("\n");
}

function getUrlHash(url: string): string {
	try {
		return new URL(url).hash || "";
	} catch {
		return "";
	}
}

async function countOpenDialogs(target: Page | Frame): Promise<number> {
	try {
		return await target.evaluate(() =>
			document.querySelectorAll('[role="dialog"]:not([hidden]),dialog[open]').length
		);
	} catch {
		return 0;
	}
}

async function captureClickTargetState(target: Page | Frame, selector: string): Promise<ClickTargetStateSnapshot> {
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
				open: el instanceof HTMLDialogElement ? el.open : el.getAttribute("open") !== null,
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

async function readInputLikeValue(target: Page | Frame, selector?: string): Promise<string | null> {
	try {
		return await target.evaluate((sel) => {
			const resolveTarget = (): Element | null => {
				if (sel) return document.querySelector(sel);
				const active = document.activeElement;
				if (!active || active === document.body || active === document.documentElement) return null;
				return active;
			};

			const target = resolveTarget();
			if (!target) return null;
			if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
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

function firstErrorLine(err: unknown): string {
	const message = typeof err === "object" && err && "message" in err
		? String((err as { message?: unknown }).message ?? "")
		: String(err ?? "unknown error");
	return message.split("\n")[0] || "unknown error";
}

async function buildRefSnapshot(
	target: Page | Frame,
	options: { selector?: string; interactiveOnly: boolean; limit: number; mode?: string }
): Promise<Array<Omit<RefNode, "ref">>> {
	// Resolve mode config in Node context and serialize it as plain data for the evaluate callback
	const modeConfig = options.mode ? getSnapshotModeConfig(options.mode) : null;
	return await target.evaluate(({ selector, interactiveOnly, limit, modeConfig: mc }) => {
		const root = selector ? document.querySelector(selector) : document.body;
		if (!root) {
			throw new Error(`Selector scope not found: ${selector}`);
		}

		// djb2 hash — must match the algorithm in core.js computeContentHash/computeStructuralSignature
		const simpleHash = (str: string): string => {
			if (!str) return "0";
			let h = 5381;
			for (let i = 0; i < str.length; i++) {
				h = ((h << 5) - h + str.charCodeAt(i)) | 0;
			}
			return (h >>> 0).toString(16);
		};

		const interactiveRoles = new Set([
			"button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "slider", "spinbutton",
		]);

		const isVisible = (el: Element): boolean => {
			const style = window.getComputedStyle(el as HTMLElement);
			if (style.display === "none" || style.visibility === "hidden") return false;
			const rect = (el as HTMLElement).getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		};

		const isEnabled = (el: Element): boolean => {
			const htmlEl = el as HTMLElement;
			const disabledAttr = htmlEl.getAttribute("disabled") !== null;
			const ariaDisabled = (htmlEl.getAttribute("aria-disabled") || "").toLowerCase() === "true";
			return !disabledAttr && !ariaDisabled;
		};

		const inferRole = (el: Element): string => {
			const explicit = (el.getAttribute("role") || "").trim();
			if (explicit) return explicit;
			const tag = el.tagName.toLowerCase();
			if (tag === "a" && el.getAttribute("href")) return "link";
			if (tag === "button") return "button";
			if (tag === "select") return "combobox";
			if (tag === "textarea") return "textbox";
			if (tag === "input") {
				const type = (el.getAttribute("type") || "text").toLowerCase();
				if (["button", "submit", "reset"].includes(type)) return "button";
				if (type === "checkbox") return "checkbox";
				if (type === "radio") return "radio";
				if (type === "search") return "searchbox";
				return "textbox";
			}
			return "";
		};

		const accessibleName = (el: Element): string => {
			const ariaLabel = el.getAttribute("aria-label")?.trim();
			if (ariaLabel) return ariaLabel;
			const labelledBy = el.getAttribute("aria-labelledby")?.trim();
			if (labelledBy) {
				const text = labelledBy
					.split(/\s+/)
					.map((id) => document.getElementById(id)?.textContent?.trim() || "")
					.join(" ")
					.trim();
				if (text) return text;
			}
			const htmlEl = el as HTMLElement;
			const placeholder = htmlEl.getAttribute("placeholder")?.trim();
			if (placeholder) return placeholder;
			const alt = htmlEl.getAttribute("alt")?.trim();
			if (alt) return alt;
			const value = (htmlEl as HTMLInputElement).value?.trim();
			if (value) return value.slice(0, 80);
			return (htmlEl.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
		};

		const isInteractiveEl = (el: Element): boolean => {
			const tag = el.tagName.toLowerCase();
			const role = inferRole(el);
			if (["button", "input", "select", "textarea", "summary", "option"].includes(tag)) return true;
			if (tag === "a" && !!el.getAttribute("href")) return true;
			if (interactiveRoles.has(role)) return true;
			const tabindex = (el as HTMLElement).tabIndex;
			if (tabindex >= 0) return true;
			if ((el as HTMLElement).isContentEditable) return true;
			return false;
		};

		const cssPath = (el: Element): string => {
			const htmlEl = el as HTMLElement;
			if (htmlEl.id) return `#${CSS.escape(htmlEl.id)}`;
			const parts: string[] = [];
			let current: Element | null = el;
			while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
				const tag = current.tagName.toLowerCase();
				let part = tag;
				const parent = current.parentElement;
				if (parent) {
					const siblings = Array.from(parent.children).filter((c) => c.tagName === current!.tagName);
					if (siblings.length > 1) {
						const idx = siblings.indexOf(current) + 1;
						part += `:nth-of-type(${idx})`;
					}
				}
				parts.unshift(part);
				current = current.parentElement;
			}
			return `body > ${parts.join(" > ")}`;
		};

		const domPath = (el: Element): number[] => {
			const path: number[] = [];
			let current: Element | null = el;
			while (current && current !== document.documentElement) {
				const parent = current.parentElement;
				if (!parent) break;
				const idx = Array.from(parent.children).indexOf(current);
				path.unshift(idx);
				current = parent;
			}
			return path;
		};

		const selectorHints = (el: Element): string[] => {
			const hints: string[] = [];
			const htmlEl = el as HTMLElement;
			if (htmlEl.id) hints.push(`#${CSS.escape(htmlEl.id)}`);
			const nameAttr = htmlEl.getAttribute("name");
			if (nameAttr) hints.push(`${el.tagName.toLowerCase()}[name="${CSS.escape(nameAttr)}"]`);
			const aria = htmlEl.getAttribute("aria-label");
			if (aria) hints.push(`${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`);
			const placeholder = htmlEl.getAttribute("placeholder");
			if (placeholder) hints.push(`${el.tagName.toLowerCase()}[placeholder="${CSS.escape(placeholder)}"]`);
			const cls = Array.from(el.classList).slice(0, 2);
			if (cls.length > 0) hints.push(`${el.tagName.toLowerCase()}.${cls.map((c) => CSS.escape(c)).join(".")}`);
			hints.push(cssPath(el));
			return Array.from(new Set(hints)).slice(0, 6);
		};

		// Mode-based element matching — used when a snapshot mode config is provided
		const matchesMode = (el: Element, cfg: { tags: string[]; roles: string[]; selectors: string[]; ariaAttributes: string[] }): boolean => {
			const tag = el.tagName.toLowerCase();
			if (cfg.tags.length > 0 && cfg.tags.includes(tag)) return true;
			const role = inferRole(el);
			if (cfg.roles.length > 0 && cfg.roles.includes(role)) return true;
			for (const sel of cfg.selectors) {
				try { if (el.matches(sel)) return true; } catch { /* invalid selector, skip */ }
			}
			for (const attr of cfg.ariaAttributes) {
				if (el.hasAttribute(attr)) return true;
			}
			return false;
		};

		let elements = Array.from(root.querySelectorAll("*"));

		if (mc) {
			// Mode takes precedence over interactiveOnly
			if (mc.visibleOnly) {
				// visible_only mode: include all elements that are visible
				elements = elements.filter((el) => isVisible(el));
			} else if (mc.useInteractiveFilter) {
				// interactive mode: reuse existing isInteractiveEl
				elements = elements.filter((el) => isInteractiveEl(el));
			} else if (mc.containerExpand) {
				// Container-expanding modes (dialog, errors): match containers, then include
				// all interactive children of those containers, plus the containers themselves
				const containers: Element[] = [];
				const directMatches: Element[] = [];
				for (const el of elements) {
					if (matchesMode(el, mc)) {
						// Check if this is a container element (has children)
						const childEls = el.querySelectorAll("*");
						if (childEls.length > 0) {
							containers.push(el);
						} else {
							directMatches.push(el);
						}
					}
				}
				// Collect container elements + all interactive children inside containers
				const result = new Set<Element>(directMatches);
				for (const container of containers) {
					result.add(container);
					const children = Array.from(container.querySelectorAll("*"));
					for (const child of children) {
						if (isInteractiveEl(child)) result.add(child);
					}
				}
				elements = Array.from(result);
			} else {
				// Standard mode filtering by tag/role/selector/ariaAttribute
				elements = elements.filter((el) => matchesMode(el, mc));
			}
		} else if (!interactiveOnly) {
			if (root instanceof Element) elements.unshift(root);
		} else {
			elements = elements.filter((el) => isInteractiveEl(el));
		}

		const seen = new Set<Element>();
		const unique = elements.filter((el) => {
			if (seen.has(el)) return false;
			seen.add(el);
			return true;
		});

		// Fingerprint helpers — computed for each element in the snapshot
		const computeNearestHeading = (el: Element): string => {
			const headingTags = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
			// Walk up ancestors looking for heading or preceding-sibling heading
			let current: Element | null = el;
			while (current && current !== document.body) {
				// Check preceding siblings of current
				let sib: Element | null = current.previousElementSibling;
				while (sib) {
					if (headingTags.has(sib.tagName) || sib.getAttribute("role") === "heading") {
						return (sib.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
					}
					sib = sib.previousElementSibling;
				}
				// Check if the parent itself is a heading (unlikely but possible)
				const parent = current.parentElement;
				if (parent && (headingTags.has(parent.tagName) || parent.getAttribute("role") === "heading")) {
					return (parent.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
				}
				current = parent;
			}
			return "";
		};

		const computeFormOwnership = (el: Element): string => {
			// Check form attribute (explicit form association)
			const formAttr = el.getAttribute("form");
			if (formAttr) return formAttr;
			// Walk up ancestors looking for <form>
			let current: Element | null = el.parentElement;
			while (current && current !== document.body) {
				if (current.tagName === "FORM") {
					return (current as HTMLFormElement).id || (current as HTMLFormElement).name || "form";
				}
				current = current.parentElement;
			}
			return "";
		};

		return unique.slice(0, limit).map((el) => {
			const tag = el.tagName.toLowerCase();
			const role = inferRole(el);
			const textContent = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200);
			const childTags = Array.from(el.children).map((c) => c.tagName.toLowerCase());

			return {
				tag,
				role,
				name: accessibleName(el),
				selectorHints: selectorHints(el),
				isVisible: isVisible(el),
				isEnabled: isEnabled(el),
				xpathOrPath: cssPath(el),
				href: el.getAttribute("href") || undefined,
				type: el.getAttribute("type") || undefined,
				path: domPath(el),
				contentHash: simpleHash(textContent),
				structuralSignature: simpleHash(`${tag}|${role}|${childTags.join(",")}`),
				nearestHeading: computeNearestHeading(el),
				formOwnership: computeFormOwnership(el),
			};
		});
	}, { ...options, modeConfig });
}

async function resolveRefTarget(
	target: Page | Frame,
	node: RefNode
): Promise<{ ok: true; selector: string } | { ok: false; reason: string }> {
	return await target.evaluate((refNode) => {
		const cssPath = (el: Element): string => {
			const htmlEl = el as HTMLElement;
			if (htmlEl.id) return `#${CSS.escape(htmlEl.id)}`;
			const parts: string[] = [];
			let current: Element | null = el;
			while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
				const tag = current.tagName.toLowerCase();
				let part = tag;
				const parent = current.parentElement;
				if (parent) {
					const siblings = Array.from(parent.children).filter((c) => c.tagName === current!.tagName);
					if (siblings.length > 1) {
						const idx = siblings.indexOf(current) + 1;
						part += `:nth-of-type(${idx})`;
					}
				}
				parts.unshift(part);
				current = current.parentElement;
			}
			return `body > ${parts.join(" > ")}`;
		};

		// djb2 hash — must match the algorithm in core.js and buildRefSnapshot
		const simpleHash = (str: string): string => {
			if (!str) return "0";
			let h = 5381;
			for (let i = 0; i < str.length; i++) {
				h = ((h << 5) - h + str.charCodeAt(i)) | 0;
			}
			return (h >>> 0).toString(16);
		};

		const byPath = (): Element | null => {
			let current: Element | null = document.documentElement;
			for (const idx of refNode.path || []) {
				if (!current || idx < 0 || idx >= current.children.length) return null;
				current = current.children[idx] as Element;
			}
			return current;
		};

		const nodeName = (el: Element): string => {
			return (
				el.getAttribute("aria-label")?.trim() ||
				(el as HTMLInputElement).value?.trim() ||
				el.getAttribute("placeholder")?.trim() ||
				(el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80)
			);
		};

		// Tier 1: path-based resolution
		const pathEl = byPath();
		if (pathEl && pathEl.tagName.toLowerCase() === refNode.tag) {
			return { ok: true as const, selector: cssPath(pathEl) };
		}

		// Tier 2: selector hints
		for (const hint of refNode.selectorHints || []) {
			try {
				const el = document.querySelector(hint);
				if (!el) continue;
				if (el.tagName.toLowerCase() !== refNode.tag) continue;
				return { ok: true as const, selector: cssPath(el) };
			} catch {
				// ignore malformed selector hint
			}
		}

		// Tier 3: role + name match
		const candidates = Array.from(document.querySelectorAll(refNode.tag));
		const target = candidates.find((el) => {
			const role = el.getAttribute("role") || "";
			const name = nodeName(el);
			const roleMatch = !refNode.role || role === refNode.role;
			const nameMatch = !!refNode.name && name.toLowerCase() === refNode.name.toLowerCase();
			return roleMatch && nameMatch;
		});
		if (target) {
			return { ok: true as const, selector: cssPath(target) };
		}

		// Tier 4: structural signature + content hash fingerprint matching
		if (refNode.contentHash && refNode.structuralSignature) {
			const fpMatches: Element[] = [];
			for (const candidate of candidates) {
				const tag = candidate.tagName.toLowerCase();
				const role = candidate.getAttribute("role") || "";
				const textContent = (candidate.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200);
				const childTags = Array.from(candidate.children).map((c) => c.tagName.toLowerCase());
				const candidateContentHash = simpleHash(textContent);
				const candidateStructSig = simpleHash(`${tag}|${role}|${childTags.join(",")}`);
				if (candidateContentHash === refNode.contentHash && candidateStructSig === refNode.structuralSignature) {
					fpMatches.push(candidate);
				}
			}
			if (fpMatches.length === 1) {
				return { ok: true as const, selector: cssPath(fpMatches[0]) };
			}
			if (fpMatches.length > 1) {
				return { ok: false as const, reason: "multiple fingerprint matches — ambiguous" };
			}
		}

		return { ok: false as const, reason: "element not found in current DOM" };
	}, node);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Notify on load
	// Browser tools announce via tool errors if playwright is missing — no need for startup noise

	// Clean up on exit
	pi.on("session_shutdown", async () => {
		await closeBrowser();
	});

	// -------------------------------------------------------------------------
	// browser_navigate
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_navigate",
		label: "Browser Navigate",
		description:
			"Open the browser (if not already open) and navigate to a URL. Waits for network idle. Returns page title and current URL. Use ONLY for visually verifying locally-running web apps (e.g. http://localhost:3000). Do NOT use for documentation sites, GitHub, search results, or any external URL — use web_search instead.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to navigate to, e.g. http://localhost:3000" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			let actionId: number | null = null;
			let beforeState: CompactPageState | null = null;
			try {
				const { page: p } = await ensureBrowser();
				beforeState = await captureCompactPageState(p, { includeBodyText: true });
				actionId = beginTrackedAction("browser_navigate", params, beforeState.url).id;
				// Fast load + best-effort network settle (won't hang on WebSockets/polling)
				await p.goto(params.url, { waitUntil: "domcontentloaded", timeout: 30000 });
				await p.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
				await new Promise(resolve => setTimeout(resolve, 300));

				const title = await p.title();
				const url = p.url();
				const viewport = p.viewportSize();
				const vpText = viewport ? `${viewport.width}x${viewport.height}` : "unknown";
				const summary = await postActionSummary(p);
				const jsErrors = getRecentErrors(p.url());
				const afterState = await captureCompactPageState(p, { includeBodyText: true });
				const diff = diffCompactStates(beforeState, afterState);
				lastActionBeforeState = beforeState;
				lastActionAfterState = afterState;
				finishTrackedAction(actionId, {
					status: "success",
					afterUrl: afterState.url,
					warningSummary: jsErrors.trim() || undefined,
					diffSummary: diff.summary,
					changed: diff.changed,
					beforeState,
					afterState,
				});

				let screenshotContent: any[] = [];
				try {
					let buf = await p.screenshot({ type: "jpeg", quality: 80, scale: "css" });
					buf = await constrainScreenshot(p, buf, "image/jpeg", 80);
					screenshotContent = [{ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" }];
				} catch {}

				return {
					content: [
						{ type: "text", text: `Navigated to: ${url}\nTitle: ${title}\nViewport: ${vpText}\nAction: ${actionId}${jsErrors}\n\nDiff:\n${formatDiffText(diff)}\n\nPage summary:\n${summary}` },
						...screenshotContent,
					],
					details: { title, url, status: "loaded", viewport: vpText, actionId, diff },
				};
			} catch (err: any) {
				if (actionId !== null) {
					finishTrackedAction(actionId, { status: "error", afterUrl: getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? undefined });
				}
				const errorShot = await captureErrorScreenshot(getActivePageOrNull());
				const content: any[] = [{ type: "text", text: `Navigation failed: ${err.message}` }];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return {
					content,
					details: { status: "error", error: err.message, actionId },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_go_back
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_go_back",
		label: "Browser Go Back",
		description: "Navigate back in browser history. Returns a compact page summary after navigation.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await ensureBrowser();
				const response = await p.goBack({ waitUntil: "domcontentloaded", timeout: 10000 });

				if (!response) {
					return {
						content: [{ type: "text", text: "No previous page in history." }],
						details: {},
						isError: true,
					};
				}

				await p.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

				const title = await p.title();
				const url = p.url();
				const summary = await postActionSummary(p);
				const jsErrors = getRecentErrors(p.url());

				return {
					content: [{ type: "text", text: `Navigated back to: ${url}\nTitle: ${title}${jsErrors}\n\nPage summary:\n${summary}` }],
					details: { title, url },
				};
			} catch (err: any) {
				const errorShot = await captureErrorScreenshot(getActivePageOrNull());
				const content: any[] = [{ type: "text", text: `Go back failed: ${err.message}` }];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return { content, details: { error: err.message }, isError: true };
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_go_forward
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_go_forward",
		label: "Browser Go Forward",
		description: "Navigate forward in browser history. Returns a compact page summary after navigation.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await ensureBrowser();
				const response = await p.goForward({ waitUntil: "domcontentloaded", timeout: 10000 });

				if (!response) {
					return {
						content: [{ type: "text", text: "No forward page in history." }],
						details: {},
						isError: true,
					};
				}

				await p.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

				const title = await p.title();
				const url = p.url();
				const summary = await postActionSummary(p);
				const jsErrors = getRecentErrors(p.url());

				return {
					content: [{ type: "text", text: `Navigated forward to: ${url}\nTitle: ${title}${jsErrors}\n\nPage summary:\n${summary}` }],
					details: { title, url },
				};
			} catch (err: any) {
				const errorShot = await captureErrorScreenshot(getActivePageOrNull());
				const content: any[] = [{ type: "text", text: `Go forward failed: ${err.message}` }];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return { content, details: { error: err.message }, isError: true };
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_reload
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_reload",
		label: "Browser Reload",
		description: "Reload the current page. Returns a screenshot, compact page summary, and page metadata (same shape as browser_navigate).", 
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await ensureBrowser();
				await p.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
				await p.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

				const title = await p.title();
				const url = p.url();
				const viewport = p.viewportSize();
				const vpText = viewport ? `${viewport.width}x${viewport.height}` : "unknown";
				const summary = await postActionSummary(p);
				const jsErrors = getRecentErrors(p.url());

				// Include screenshot like navigate does
				let screenshotContent: any[] = [];
				try {
					let buf = await p.screenshot({ type: "jpeg", quality: 80, scale: "css" });
					buf = await constrainScreenshot(p, buf, "image/jpeg", 80);
					screenshotContent = [{
						type: "image",
						data: buf.toString("base64"),
						mimeType: "image/jpeg",
					}];
				} catch {}

				return {
					content: [
						{
							type: "text",
							text: `Reloaded: ${url}\nTitle: ${title}\nViewport: ${vpText}${jsErrors}\n\nPage summary:\n${summary}`,
						},
						...screenshotContent,
					],
					details: { title, url, viewport: vpText },
				};
			} catch (err: any) {
				const errorShot = await captureErrorScreenshot(getActivePageOrNull());
				const content: any[] = [{ type: "text", text: `Reload failed: ${err.message}` }];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return { content, details: { error: err.message }, isError: true };
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_screenshot
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description:
			"Take a screenshot of the current browser page and return it as an inline image. Uses JPEG for viewport/fullpage (smaller, configurable quality) and PNG for element crops (preserves transparency). Optionally crop to a specific element by CSS selector.",
		parameters: Type.Object({
			fullPage: Type.Optional(
				Type.Boolean({ description: "Capture the full scrollable page (default: false)" })
			),
			selector: Type.Optional(
				Type.String({
					description:
						"CSS selector of a specific element to screenshot (crops to that element's bounding box). If omitted, screenshots the entire viewport.",
				})
			),
			quality: Type.Optional(
				Type.Number({
					description:
						"JPEG quality 1-100 (default: 80). Only applies to viewport/fullpage screenshots, not element crops. Lower = smaller image.",
				})
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await ensureBrowser();

				let screenshotBuffer: Buffer;
				let mimeType: string;
				const quality = params.quality ?? 80;

				if (params.selector) {
					// Element screenshots: keep PNG (may have transparency)
					const locator = p.locator(params.selector).first();
					screenshotBuffer = await locator.screenshot({ type: "png", scale: "css" });
					mimeType = "image/png";
				} else {
					// Viewport/fullpage: use JPEG (3-5x smaller, fine for AI analysis)
					screenshotBuffer = await p.screenshot({
						fullPage: params.fullPage ?? false,
						type: "jpeg",
						quality,
						scale: "css",
					});
					mimeType = "image/jpeg";
				}

				// Downscale if dimensions exceed API limit (1568px max)
				screenshotBuffer = await constrainScreenshot(p, screenshotBuffer, mimeType, quality);

				const base64Data = screenshotBuffer.toString("base64");
				const title = await p.title();
				const url = p.url();
				const viewport = p.viewportSize();
				const vpText = viewport ? `${viewport.width}x${viewport.height}` : "unknown";
				const scope = params.selector ? `element "${params.selector}"` : params.fullPage ? "full page" : "viewport";

				return {
					content: [
						{
							type: "text",
							text: `Screenshot of ${scope}.\nPage: ${title}\nURL: ${url}\nViewport: ${vpText}`,
						},
						{
							type: "image",
							data: base64Data,
							mimeType,
						},
					],
					details: { title, url, scope, viewport: vpText },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Screenshot failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_click
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_click",
		label: "Browser Click",
		description:
			"Click an element on the page by CSS selector or by x,y coordinates. Returns a compact page summary plus lightweight verification details after clicking. Provide either selector or both x and y. Prefer selector over coordinates — selectors are more reliable because they handle shadow DOM via getByRole fallbacks. Use coordinates only when you have no other option.", 
		parameters: Type.Object({
			selector: Type.Optional(
				Type.String({ description: "CSS selector of the element to click. The tool will try getByRole fallbacks if the CSS selector fails (handles shadow DOM)." })
			),
			x: Type.Optional(Type.Number({ description: "X coordinate to click" })),
			y: Type.Optional(Type.Number({ description: "Y coordinate to click" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			let actionId: number | null = null;
			let beforeState: CompactPageState | null = null;
			try {
				const { page: p } = await ensureBrowser();
				const target = getActiveTarget();
				beforeState = await captureCompactPageState(p, { selectors: params.selector ? [params.selector] : [], includeBodyText: true, target });
				actionId = beginTrackedAction("browser_click", params, beforeState.url).id;
				const beforeUrl = p.url();
				const beforeHash = getUrlHash(beforeUrl);
				const beforeDialogCount = await countOpenDialogs(target);
				const beforeTargetState = params.selector
					? await captureClickTargetState(target, params.selector)
					: null;

				if (params.selector) {
					// Try CSS selector first (5s). If it times out or the element is in
					// shadow DOM (e.g. Google search), fall back to getByRole which
					// pierces shadow DOM automatically.
					try {
						await target.locator(params.selector).first().click({ timeout: 5000 });
					} catch {
						// Extract accessible name hint from the selector if present
						const nameMatch = params.selector.match(/\[(?:aria-label|name|placeholder)="([^"]+)"\]/i);
						const roleName = nameMatch?.[1];
						let clicked = false;
						for (const role of ["combobox", "searchbox", "textbox", "button", "link"] as const) {
							try {
								const loc = roleName
									? target.getByRole(role, { name: new RegExp(roleName, "i") })
									: target.getByRole(role);
								await loc.first().click({ timeout: 3000 });
								clicked = true;
								break;
							} catch { /* try next role */ }
						}
						if (!clicked) {
							// Absolute last resort: coordinate click (mouse is page-level)
							if (params.x !== undefined && params.y !== undefined) {
								await p.mouse.click(params.x, params.y);
							} else {
								throw new Error(`Could not click selector "${params.selector}" — element not found (shadow DOM?)`);
							}
						}
					}
				} else if (params.x !== undefined && params.y !== undefined) {
					await p.mouse.click(params.x, params.y);
				} else {
					return {
						content: [
							{
								type: "text",
								text: "Must provide either selector or both x and y coordinates",
							},
						],
						details: {},
						isError: true,
					};
				}

				const settle = await settleAfterActionAdaptive(p);

				const url = p.url();
				const hash = getUrlHash(url);
				const afterDialogCount = await countOpenDialogs(target);
				const afterTargetState = params.selector
					? await captureClickTargetState(target, params.selector)
					: null;
				const targetStateChanged = !!beforeTargetState && !!afterTargetState && (
					beforeTargetState.exists !== afterTargetState.exists ||
					beforeTargetState.ariaExpanded !== afterTargetState.ariaExpanded ||
					beforeTargetState.ariaPressed !== afterTargetState.ariaPressed ||
					beforeTargetState.ariaSelected !== afterTargetState.ariaSelected ||
					beforeTargetState.open !== afterTargetState.open
				);
				const verification = verificationFromChecks(
					[
						{ name: "url_changed", passed: url !== beforeUrl, value: url, expected: `!= ${beforeUrl}` },
						{ name: "hash_changed", passed: hash !== beforeHash, value: hash, expected: `!= ${beforeHash}` },
						{ name: "target_state_changed", passed: targetStateChanged, value: afterTargetState, expected: beforeTargetState },
						{ name: "dialog_open", passed: afterDialogCount > beforeDialogCount, value: afterDialogCount, expected: `> ${beforeDialogCount}` },
					],
					"Try a more specific selector or click a clearly interactive element."
				);
				const clickTarget = params.selector ?? `(${params.x}, ${params.y})`;
				const summary = await postActionSummary(p, target);
				const jsErrors = getRecentErrors(p.url());
				const afterState = await captureCompactPageState(p, { selectors: params.selector ? [params.selector] : [], includeBodyText: true, target });
				const diff = diffCompactStates(beforeState!, afterState);
				lastActionBeforeState = beforeState!;
				lastActionAfterState = afterState;
				finishTrackedAction(actionId!, {
					status: "success",
					afterUrl: afterState.url,
					verificationSummary: verification.verificationSummary,
					warningSummary: jsErrors.trim() || undefined,
					diffSummary: diff.summary,
					changed: diff.changed,
					beforeState: beforeState!,
					afterState,
				});

				return {
					content: [{ type: "text", text: `Clicked: ${clickTarget}\nURL: ${url}\nAction: ${actionId}\n${verificationLine(verification)}${jsErrors}\n\nDiff:\n${formatDiffText(diff)}\n\nPage summary:\n${summary}` }],
					details: { target: clickTarget, url, actionId, diff, ...settle, ...verification },
				};
			} catch (err: any) {
				if (actionId !== null) {
					finishTrackedAction(actionId, { status: "error", afterUrl: getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? undefined });
				}
				const errorShot = await captureErrorScreenshot(getActivePageOrNull());
				const content: any[] = [{ type: "text", text: `Click failed: ${err.message}` }];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return {
					content,
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_drag
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_drag",
		label: "Browser Drag",
		description:
			"Drag an element and drop it onto another element. Use for sortable lists, kanban boards, sliders, and any drag-and-drop UI.",
		parameters: Type.Object({
			sourceSelector: Type.String({
				description: "CSS selector of the element to drag",
			}),
			targetSelector: Type.String({
				description: "CSS selector of the element to drop onto",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await ensureBrowser();
				const target = getActiveTarget();
				await target.dragAndDrop(params.sourceSelector, params.targetSelector, { timeout: 10000 });
				const settle = await settleAfterActionAdaptive(p);

				const summary = await postActionSummary(p, target);
				const jsErrors = getRecentErrors(p.url());

				return {
					content: [{
						type: "text",
						text: `Dragged "${params.sourceSelector}" → "${params.targetSelector}"${jsErrors}\n\nPage summary:\n${summary}`,
					}],
					details: { source: params.sourceSelector, target: params.targetSelector, ...settle },
				};
			} catch (err: any) {
				const errorShot = await captureErrorScreenshot(getActivePageOrNull());
				const content: any[] = [{ type: "text", text: `Drag failed: ${err.message}` }];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return { content, details: { error: err.message }, isError: true };
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_type
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_type",
		label: "Browser Type",
		description:
			"Type text into an input element. By default uses atomic fill (clears and sets value instantly). Use 'slowly' for character-by-character typing when you need to trigger key handlers (e.g. search autocomplete). Use 'submit' to press Enter after typing. Returns a compact page summary plus lightweight verification details. IMPORTANT: Always provide a selector — do NOT rely on coordinate clicks to focus an input before calling this. CSS attribute selectors like combobox[aria-label='X'] work for most inputs; for shadow DOM inputs (e.g. Google Search), the tool automatically tries getByRole fallbacks.",
		parameters: Type.Object({
			text: Type.String({ description: "Text to type" }),
			selector: Type.Optional(
				Type.String({ description: "CSS selector of the input to type into (clicks it first). Examples: 'input[name=q]', 'textarea', 'combobox[aria-label=\"Search\"]'. The tool will try getByRole fallbacks if the CSS selector fails." })
			),
			clearFirst: Type.Optional(
				Type.Boolean({
					description:
						"Clear the input's existing value before typing (default: false). Use this when replacing existing text.",
				})
			),
			submit: Type.Optional(
				Type.Boolean({
					description: "Press Enter after typing to submit the form (default: false).",
				})
			),
			slowly: Type.Optional(
				Type.Boolean({
					description:
						"Type one character at a time instead of filling atomically. Use when you need to trigger key handlers (e.g. search autocomplete). Default: false.",
				})
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			let actionId: number | null = null;
			let beforeState: CompactPageState | null = null;
			try {
				const { page: p } = await ensureBrowser();
				const target = getActiveTarget();
				beforeState = await captureCompactPageState(p, { selectors: params.selector ? [params.selector] : [], includeBodyText: true, target });
				actionId = beginTrackedAction("browser_type", params, beforeState.url).id;
				const beforeUrl = p.url();

				/** Helper: use getByRole fallbacks when CSS selector fails (shadow DOM etc.) */
				async function focusViaRole(selector: string): Promise<boolean> {
					const nameMatch = selector.match(/\[(?:aria-label|name|placeholder)="([^"]+)"\]/i);
					const roleName = nameMatch?.[1];
					for (const role of ["combobox", "searchbox", "textbox"] as const) {
						try {
							const loc = roleName
								? target.getByRole(role, { name: new RegExp(roleName, "i") })
								: target.getByRole(role);
							await loc.first().click({ timeout: 3000 });
							return true;
						} catch { /* try next */ }
					}
					return false;
				}

				if (params.selector) {
					if (params.slowly) {
						// Character-by-character with shadow DOM fallback
						let focused = false;
						try {
							await target.locator(params.selector).first().click({ timeout: 5000 });
							focused = true;
						} catch {
							focused = await focusViaRole(params.selector);
						}
						if (!focused) throw new Error(`Could not focus selector "${params.selector}"`);
						if (params.clearFirst) {
							await p.keyboard.press("Control+A");
							await p.keyboard.press("Delete");
						}
						await p.keyboard.type(params.text);
					} else {
						// 1. Try atomic fill (fast path — replaces value without triggering key events)
						let filled = false;
						try {
							await target.locator(params.selector).first().fill(params.text, { timeout: 5000 });
							filled = true;
						} catch { /* fall through */ }

						if (!filled) {
							// 2. Try fill via getByRole (pierces shadow DOM)
							const nameMatch = params.selector.match(/\[(?:aria-label|name|placeholder)="([^"]+)"\]/i);
							const roleName = nameMatch?.[1];
							for (const role of ["combobox", "searchbox", "textbox"] as const) {
								try {
									const loc = roleName
										? target.getByRole(role, { name: new RegExp(roleName, "i") })
										: target.getByRole(role);
									await loc.first().fill(params.text, { timeout: 3000 });
									filled = true;
									break;
								} catch { /* try next */ }
							}
						}

						if (!filled) {
							// 3. Click to focus (with shadow DOM fallback) then pressSequentially
							// pressSequentially is more reliable than keyboard.type for complex inputs
							let focused = false;
							try {
								await target.locator(params.selector).first().click({ timeout: 5000 });
								focused = true;
							} catch {
								focused = await focusViaRole(params.selector);
							}
							if (!focused) throw new Error(`Could not focus selector "${params.selector}"`);
							if (params.clearFirst) {
								await p.keyboard.press("Control+A");
								await p.keyboard.press("Delete");
							}
							await target.locator(":focus").pressSequentially(params.text, { timeout: 5000 }).catch(() =>
								p.keyboard.type(params.text)
							);
						} else if (params.clearFirst) {
							// fill() already replaced the value; clearFirst is a no-op here
						}
					}
				} else {
					// No selector — check something is actually focused before typing
					const hasFocus = await target.evaluate(() => {
						const el = document.activeElement;
						return !!(el && el !== document.body && el !== document.documentElement);
					});
					if (!hasFocus) {
						return {
							content: [{ type: "text", text: "Type failed: no element is focused. Use browser_click to focus an input first, or provide a selector." }],
							details: { error: "no focused element" },
							isError: true,
						};
					}
					// Use pressSequentially via the focused element for reliability
					await target.locator(":focus").pressSequentially(params.text, { timeout: 10000 }).catch(() =>
						p.keyboard.type(params.text)
					);
				}

				if (params.submit) {
					await p.keyboard.press("Enter");
				}

				const settle = await settleAfterActionAdaptive(p);

				const typedValue = await readInputLikeValue(target, params.selector);
				const afterUrl = p.url();
				const verification = verificationFromChecks(
					[
						{ name: "value_equals_expected", passed: typedValue === params.text, value: typedValue, expected: params.text },
						{ name: "value_contains_expected", passed: typeof typedValue === "string" && typedValue.includes(params.text), value: typedValue, expected: params.text },
						{ name: "url_changed_after_submit", passed: !!params.submit && afterUrl !== beforeUrl, value: afterUrl, expected: `!= ${beforeUrl}` },
					],
					"Try clearFirst=true, use a more specific selector, or set slowly=true for key-driven inputs."
				);
				const typeTarget = params.selector ? ` into "${params.selector}"` : "";
				const summary = await postActionSummary(p, target);
				const jsErrors = getRecentErrors(p.url());
				const afterState = await captureCompactPageState(p, { selectors: params.selector ? [params.selector] : [], includeBodyText: true, target });
				const diff = diffCompactStates(beforeState!, afterState);
				lastActionBeforeState = beforeState!;
				lastActionAfterState = afterState;
				finishTrackedAction(actionId!, {
					status: "success",
					afterUrl: afterState.url,
					verificationSummary: verification.verificationSummary,
					warningSummary: jsErrors.trim() || undefined,
					diffSummary: diff.summary,
					changed: diff.changed,
					beforeState: beforeState!,
					afterState,
				});

				return {
					content: [{ type: "text", text: `Typed "${params.text}"${typeTarget}\nAction: ${actionId}\n${verificationLine(verification)}${jsErrors}\n\nDiff:\n${formatDiffText(diff)}\n\nPage summary:\n${summary}` }],
					details: { text: params.text, selector: params.selector, typedValue, actionId, diff, ...settle, ...verification },
				};
			} catch (err: any) {
				if (actionId !== null) {
					finishTrackedAction(actionId, { status: "error", afterUrl: getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? undefined });
				}
				const errorShot = await captureErrorScreenshot(getActivePageOrNull());
				const content: any[] = [{ type: "text", text: `Type failed: ${err.message}` }];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return {
					content,
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_upload_file
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_upload_file",
		label: "Browser Upload File",
		description:
			"Set files on a file input element. The selector must target an <input type=\"file\"> element. Accepts one or more absolute file paths.",
		parameters: Type.Object({
			selector: Type.String({
				description: 'CSS selector targeting the <input type="file"> element',
			}),
			files: Type.Array(Type.String({ description: "Absolute path to a file" }), {
				description: "One or more file paths to upload",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await ensureBrowser();
				const target = getActiveTarget();
				// Strip leading @ (some models add it to paths)
				const cleanFiles = params.files.map((f: string) => f.replace(/^@/, ""));
				await target.locator(params.selector).first().setInputFiles(cleanFiles);
				const settle = await settleAfterActionAdaptive(p);

				const summary = await postActionSummary(p, target);
				const jsErrors = getRecentErrors(p.url());

				return {
					content: [{
						type: "text",
						text: `Uploaded ${cleanFiles.length} file(s) to "${params.selector}": ${cleanFiles.join(", ")}${jsErrors}\n\nPage summary:\n${summary}`,
					}],
					details: { selector: params.selector, files: cleanFiles, ...settle },
				};
			} catch (err: any) {
				const errorShot = await captureErrorScreenshot(getActivePageOrNull());
				const content: any[] = [{ type: "text", text: `Upload failed: ${err.message}` }];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return { content, details: { error: err.message }, isError: true };
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_scroll
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_scroll",
		label: "Browser Scroll",
		description: "Scroll the page up or down by a given number of pixels. Returns scroll position (px and percentage) and an accessibility snapshot of the visible content.",
		parameters: Type.Object({
			direction: StringEnum(["up", "down"] as const),
			amount: Type.Optional(
				Type.Number({ description: "Pixels to scroll (default: 300)" })
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await ensureBrowser();
				const target = getActiveTarget();
				const pixels = params.amount ?? 300;
				const delta = params.direction === "up" ? -pixels : pixels;
				await p.mouse.wheel(0, delta);

				const settle = await settleAfterActionAdaptive(p);

				const scrollInfo = await target.evaluate(() => ({
					scrollY: Math.round(window.scrollY),
					scrollHeight: document.documentElement.scrollHeight,
					clientHeight: document.documentElement.clientHeight,
				}));
				const maxScroll = scrollInfo.scrollHeight - scrollInfo.clientHeight;
				const percent = maxScroll > 0 ? Math.round((scrollInfo.scrollY / maxScroll) * 100) : 0;

				const summary = await postActionSummary(p, target);
				const jsErrors = getRecentErrors(p.url());

				return {
					content: [
						{
							type: "text",
							text: `Scrolled ${params.direction} by ${pixels}px\n` +
								  `Position: ${scrollInfo.scrollY}px / ${scrollInfo.scrollHeight}px (${percent}% down)\n` +
								  `Viewport height: ${scrollInfo.clientHeight}px${jsErrors}\n\nPage summary:\n${summary}`,
						},
					],
					details: { direction: params.direction, amount: pixels, ...scrollInfo, percent, ...settle },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Scroll failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_get_console_logs
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_get_console_logs",
		label: "Browser Console Logs",
		description:
			"Get all buffered browser console logs and JavaScript errors captured since the last clear. Each entry includes timestamp and page URL. Note: JS errors are also auto-surfaced in interaction tool responses — use this for the full log.",
		parameters: Type.Object({
			clear: Type.Optional(
				Type.Boolean({
					description: "Clear the buffer after returning logs (default: true)",
				})
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const shouldClear = params.clear !== false;
			const logs = [...consoleLogs];

			if (shouldClear) {
				consoleLogs = [];
			}

			if (logs.length === 0) {
				return {
					content: [{ type: "text", text: "No console logs captured." }],
					details: { logs: [], count: 0 },
				};
			}

			const formatted = logs
				.map((entry) => {
					const time = new Date(entry.timestamp).toISOString().slice(11, 23); // HH:mm:ss.SSS
					return `[${time}] [${entry.type.toUpperCase()}] ${entry.text}`;
				})
				.join("\n");

			const truncated = truncateText(formatted);

			return {
				content: [
					{
						type: "text",
						text: `${logs.length} console log(s):\n\n${truncated}`,
					},
				],
				details: { logs, count: logs.length },
			};
		},
	});

	// -------------------------------------------------------------------------
	// browser_get_network_logs
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_get_network_logs",
		label: "Browser Network Logs",
		description:
			"Get buffered network requests and responses. Shows method, URL, status code, and resource type for all requests. Includes response body for failed requests (4xx/5xx). Use to debug API failures, CORS issues, missing resources, and auth problems.",
		parameters: Type.Object({
			clear: Type.Optional(
				Type.Boolean({
					description: "Clear the buffer after returning logs (default: true)",
				})
			),
			filter: Type.Optional(
				StringEnum(["all", "errors", "fetch-xhr"] as const)
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const shouldClear = params.clear !== false;
			let logs = [...networkLogs];

			if (shouldClear) {
				networkLogs = [];
			}

			// Apply filter
			if (params.filter === "errors") {
				logs = logs.filter(e => e.failed || (e.status !== null && e.status >= 400));
			} else if (params.filter === "fetch-xhr") {
				logs = logs.filter(e => e.resourceType === "fetch" || e.resourceType === "xhr");
			}

			if (logs.length === 0) {
				return {
					content: [{ type: "text", text: "No network requests captured." }],
					details: { logs: [], count: 0 },
				};
			}

			const formatted = logs
				.map((entry) => {
					const time = new Date(entry.timestamp).toISOString().slice(11, 23);
					const status = entry.failed
						? `FAILED (${entry.failureText})`
						: `${entry.status}`;
					let line = `[${time}] ${entry.method} ${entry.url} → ${status} (${entry.resourceType})`;
					if (entry.responseBody) {
						line += `\n  Response: ${entry.responseBody}`;
					}
					return line;
				})
				.join("\n");

			const truncated = truncateText(formatted);

			return {
				content: [
					{
						type: "text",
						text: `${logs.length} network request(s):\n\n${truncated}`,
					},
				],
				details: { count: logs.length },
			};
		},
	});

	// -------------------------------------------------------------------------
	// browser_get_dialog_logs
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_get_dialog_logs",
		label: "Browser Dialog Logs",
		description:
			"Get buffered JavaScript dialog events (alert, confirm, prompt, beforeunload). Dialogs are auto-accepted to prevent page freezes. Use this to see what dialogs appeared and their messages.",
		parameters: Type.Object({
			clear: Type.Optional(
				Type.Boolean({
					description: "Clear the buffer after returning logs (default: true)",
				})
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const shouldClear = params.clear !== false;
			const logs = [...dialogLogs];

			if (shouldClear) {
				dialogLogs = [];
			}

			if (logs.length === 0) {
				return {
					content: [{ type: "text", text: "No dialog events captured." }],
					details: { logs: [], count: 0 },
				};
			}

			const formatted = logs
				.map((entry) => {
					const time = new Date(entry.timestamp).toISOString().slice(11, 23);
					let line = `[${time}] ${entry.type}: "${entry.message}"`;
					if (entry.defaultValue) {
						line += ` (default: "${entry.defaultValue}")`;
					}
					line += ` → auto-accepted`;
					return line;
				})
				.join("\n");

			const truncated = truncateText(formatted);

			return {
				content: [
					{
						type: "text",
						text: `${logs.length} dialog(s):\n\n${truncated}`,
					},
				],
				details: { logs, count: logs.length },
			};
		},
	});

	// -------------------------------------------------------------------------
	// browser_evaluate
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_evaluate",
		label: "Browser Evaluate",
		description:
			"Execute a JavaScript expression in the browser context and return the result. Useful for reading DOM state, checking values, etc.",
		parameters: Type.Object({
			expression: Type.String({
				description: "JavaScript expression to evaluate in the page context",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				await ensureBrowser();
				const target = getActiveTarget();
				const result = await target.evaluate(params.expression);

				// Serialize result — handle undefined, null, circular refs, and non-JSON types
				let serialized: string;
				if (result === undefined) {
					serialized = "undefined";
				} else {
					try {
						serialized = JSON.stringify(result, null, 2) ?? "undefined";
					} catch {
						// Circular or non-serializable (e.g. window.open() returns a Window ref)
						serialized = `[non-serializable: ${typeof result}]`;
					}
				}

				const truncated = truncateText(serialized);
				return {
					content: [{ type: "text", text: truncated }],
					details: { expression: params.expression },
				};
			} catch (err: any) {
				return {
					content: [
						{
							type: "text",
							text: `Evaluation failed: ${err.message}`,
						},
					],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_close
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_close",
		label: "Browser Close",
		description: "Close the browser and clean up all resources.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				await closeBrowser();
				return {
					content: [{ type: "text", text: "Browser closed." }],
					details: {},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Close failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_trace_start
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_trace_start",
		label: "Browser Trace Start",
		description: "Start a Playwright trace for the current browser session and persist trace metadata under the session artifact directory.",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Optional short trace session name for artifact filenames." })),
			title: Type.Optional(Type.String({ description: "Optional trace title recorded in metadata." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { context: browserContext } = await ensureBrowser();
				if (activeTraceSession) {
					return {
						content: [{ type: "text", text: `Trace already active: ${activeTraceSession.name}` }],
						details: { error: "trace_already_active", activeTraceSession, ...getSessionArtifactMetadata() },
						isError: true,
					};
				}
				const startedAt = Date.now();
				const name = (params.name?.trim() || `trace-${formatArtifactTimestamp(startedAt)}`).replace(/[^a-zA-Z0-9._-]+/g, "-");
				await browserContext.tracing.start({ screenshots: true, snapshots: true, sources: true, title: params.title ?? name });
				activeTraceSession = { startedAt, name, title: params.title ?? name };
				return {
					content: [{ type: "text", text: `Trace started: ${name}\nSession dir: ${sessionArtifactDir}` }],
					details: { activeTraceSession, ...getSessionArtifactMetadata() },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Trace start failed: ${err.message}` }],
					details: { error: err.message, ...getSessionArtifactMetadata() },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_trace_stop
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_trace_stop",
		label: "Browser Trace Stop",
		description: "Stop the active Playwright trace and write the trace zip to disk under the session artifact directory.",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Optional artifact basename override for the trace zip." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { context: browserContext } = await ensureBrowser();
				if (!activeTraceSession) {
					return {
						content: [{ type: "text", text: "No active trace session to stop." }],
						details: { error: "trace_not_active", ...getSessionArtifactMetadata() },
						isError: true,
					};
				}
				const traceSession = activeTraceSession;
				const traceName = (params.name?.trim() || traceSession.name).replace(/[^a-zA-Z0-9._-]+/g, "-");
				const tracePath = buildSessionArtifactPath(`${traceName}.trace.zip`);
				await browserContext.tracing.stop({ path: tracePath });
				const fileStat = await stat(tracePath);
				activeTraceSession = null;
				return {
					content: [{ type: "text", text: `Trace stopped: ${tracePath}` }],
					details: {
						path: tracePath,
						bytes: fileStat.size,
						elapsedMs: Date.now() - traceSession.startedAt,
						traceName,
						...getSessionArtifactMetadata(),
					},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Trace stop failed: ${err.message}` }],
					details: { error: err.message, ...getSessionArtifactMetadata() },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_export_har
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_export_har",
		label: "Browser Export HAR",
		description: "Export the truthfully recorded session HAR from disk to a stable artifact path and return compact metadata.",
		parameters: Type.Object({
			filename: Type.Optional(Type.String({ description: "Optional destination filename within the session artifact directory." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				await ensureBrowser();
				if (!harState.enabled || !harState.configuredAtContextCreation || !harState.path) {
					return {
						content: [{ type: "text", text: "HAR export unavailable: HAR recording was not enabled at browser context creation." }],
						details: { error: "har_not_enabled", ...getSessionArtifactMetadata() },
						isError: true,
					};
				}
				const sourcePath = harState.path;
				const destinationName = (params.filename?.trim() || `export-${HAR_FILENAME}`).replace(/[^a-zA-Z0-9._-]+/g, "-");
				const destinationPath = buildSessionArtifactPath(destinationName);
				const exportResult = sourcePath === destinationPath
					? { path: sourcePath, bytes: (await stat(sourcePath)).size }
					: await copyArtifactFile(sourcePath, destinationPath);
				harState = {
					...harState,
					exportCount: harState.exportCount + 1,
					lastExportedPath: exportResult.path,
					lastExportedAt: Date.now(),
				};
				return {
					content: [{ type: "text", text: `HAR exported: ${exportResult.path}` }],
					details: { path: exportResult.path, bytes: exportResult.bytes, ...getSessionArtifactMetadata() },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `HAR export failed: ${err.message}` }],
					details: { error: err.message, ...getSessionArtifactMetadata() },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_timeline
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_timeline",
		label: "Browser Timeline",
		description: "Return a compact structured summary of the tracked browser action timeline and optional on-disk export path.",
		parameters: Type.Object({
			writeToDisk: Type.Optional(Type.Boolean({ description: "Write the timeline JSON to disk under the session artifact directory." })),
			filename: Type.Optional(Type.String({ description: "Optional JSON filename when writeToDisk is true." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				await ensureBrowser();
				const timeline = formatTimelineEntries(actionTimeline.entries, {
					limit: actionTimeline.limit,
					totalActions: actionTimeline.nextId - 1,
				});
				let artifact: { path: string; bytes: number } | null = null;
				if (params.writeToDisk) {
					const filename = (params.filename?.trim() || "timeline.json").replace(/[^a-zA-Z0-9._-]+/g, "-");
					artifact = await writeArtifactFile(buildSessionArtifactPath(filename), JSON.stringify(timeline, null, 2));
				}
				return {
					content: [{ type: "text", text: artifact ? `${timeline.summary}\nArtifact: ${artifact.path}` : timeline.summary }],
					details: { ...timeline, artifact, ...getSessionArtifactMetadata() },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Timeline failed: ${err.message}` }],
					details: { error: err.message, ...getSessionArtifactMetadata() },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_session_summary
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_session_summary",
		label: "Browser Session Summary",
		description: "Return a compact structured summary of the current browser session, including pages, actions, waits/assertions, bounded-history caveats, and trace/HAR state.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				await ensureBrowser();
				const pages = await getLivePagesSnapshot();
				const baseSummary = summarizeBrowserSession({
					timeline: actionTimeline,
					totalActions: actionTimeline.nextId - 1,
					pages,
					activePageId: pageRegistry.activePageId,
					activeFrame: getActiveFrameMetadata(),
					consoleEntries: consoleLogs,
					networkEntries: networkLogs,
					dialogEntries: dialogLogs,
					consoleLimit: 1000,
					networkLimit: 1000,
					dialogLimit: 1000,
					sessionStartedAt,
					now: Date.now(),
				});
				const failureHypothesis = buildFailureHypothesis({
					timeline: actionTimeline,
					consoleEntries: consoleLogs,
					networkEntries: networkLogs,
					dialogEntries: dialogLogs,
				});
				const traceState = activeTraceSession
					? { status: "active", ...activeTraceSession }
					: { status: "inactive", lastTracePath: sessionArtifactDir ? buildSessionArtifactPath("*.trace.zip") : null };
				const harSummary = {
					enabled: harState.enabled,
					configuredAtContextCreation: harState.configuredAtContextCreation,
					path: harState.path,
					exportCount: harState.exportCount,
					lastExportedPath: harState.lastExportedPath,
					lastExportedAt: harState.lastExportedAt,
				};
				return {
					content: [{ type: "text", text: `${baseSummary.summary}\nFailure hypothesis: ${failureHypothesis}` }],
					details: {
						...baseSummary,
						failureHypothesis,
						trace: traceState,
						har: harSummary,
						...getSessionArtifactMetadata(),
					},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Session summary failed: ${err.message}` }],
					details: { error: err.message, ...getSessionArtifactMetadata() },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_debug_bundle
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_debug_bundle",
		label: "Browser Debug Bundle",
		description: "Write a timestamped debug bundle to disk with screenshot, logs, timeline, pages, session summary, and accessibility output, then return compact paths and counts.",
		parameters: Type.Object({
			selector: Type.Optional(Type.String({ description: "Optional CSS selector to scope the accessibility snapshot before fallback behavior applies." })),
			name: Type.Optional(Type.String({ description: "Optional short bundle name suffix for the output directory." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await ensureBrowser();
				const startedAt = Date.now();
				const sessionDir = await ensureSessionArtifactDir();
				const bundleDir = path.join(ARTIFACT_ROOT, `${formatArtifactTimestamp(startedAt)}-${sanitizeArtifactName(params.name ?? "debug-bundle", "debug-bundle")}`);
				await ensureDir(bundleDir);
				const pages = await getLivePagesSnapshot();
				const timeline = formatTimelineEntries(actionTimeline.entries, {
					limit: actionTimeline.limit,
					totalActions: actionTimeline.nextId - 1,
				});
				const sessionSummary = summarizeBrowserSession({
					timeline: actionTimeline,
					totalActions: actionTimeline.nextId - 1,
					pages,
					activePageId: pageRegistry.activePageId,
					activeFrame: getActiveFrameMetadata(),
					consoleEntries: consoleLogs,
					networkEntries: networkLogs,
					dialogEntries: dialogLogs,
					consoleLimit: 1000,
					networkLimit: 1000,
					dialogLimit: 1000,
					sessionStartedAt,
					now: Date.now(),
				});
				const failureHypothesis = buildFailureHypothesis({
					timeline: actionTimeline,
					consoleEntries: consoleLogs,
					networkEntries: networkLogs,
					dialogEntries: dialogLogs,
				});
				const accessibility = await captureAccessibilityMarkdown(params.selector);
				const screenshotPath = path.join(bundleDir, "screenshot.jpg");
				await p.screenshot({ path: screenshotPath, type: "jpeg", quality: 80, fullPage: false });
				const screenshotStat = await stat(screenshotPath);
				const artifacts = {
					screenshot: { path: screenshotPath, bytes: screenshotStat.size },
					console: await writeArtifactFile(path.join(bundleDir, "console.json"), JSON.stringify(consoleLogs, null, 2)),
					network: await writeArtifactFile(path.join(bundleDir, "network.json"), JSON.stringify(networkLogs, null, 2)),
					dialog: await writeArtifactFile(path.join(bundleDir, "dialog.json"), JSON.stringify(dialogLogs, null, 2)),
					timeline: await writeArtifactFile(path.join(bundleDir, "timeline.json"), JSON.stringify(timeline, null, 2)),
					summary: await writeArtifactFile(path.join(bundleDir, "summary.json"), JSON.stringify({
						...sessionSummary,
						failureHypothesis,
						trace: activeTraceSession,
						har: harState,
						sessionArtifactDir: sessionDir,
					}, null, 2)),
					pages: await writeArtifactFile(path.join(bundleDir, "pages.json"), JSON.stringify(pages, null, 2)),
					accessibility: await writeArtifactFile(path.join(bundleDir, "accessibility.md"), accessibility.snapshot),
				};
				return {
					content: [{ type: "text", text: `Debug bundle written: ${bundleDir}\n${sessionSummary.summary}\nFailure hypothesis: ${failureHypothesis}` }],
					details: {
						bundleDir,
						artifacts,
						accessibilityScope: accessibility.scope,
						accessibilitySource: accessibility.source,
						counts: {
							console: consoleLogs.length,
							network: networkLogs.length,
							dialog: dialogLogs.length,
							actions: timeline.count,
							pages: pages.length,
						},
						elapsedMs: Date.now() - startedAt,
						summary: sessionSummary,
						failureHypothesis,
						...getSessionArtifactMetadata(),
					},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Debug bundle failed: ${err.message}` }],
					details: { error: err.message, ...getSessionArtifactMetadata() },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_assert
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_assert",
		label: "Browser Assert",
		description:
			"Run one or more explicit browser assertions and return structured PASS/FAIL results. Prefer this for verification instead of inferring success from prose summaries.",
		promptGuidelines: [
			"Prefer browser_assert for browser verification instead of inferring success from summaries.",
			"When finishing UI work, explicit browser assertions should usually be the final verification step.",
			"Use checks for URL, text, selector state, value, and browser diagnostics whenever those signals are available.",
		],
		parameters: Type.Object({
			checks: Type.Array(
				Type.Object({
					kind: Type.String({ description: "Assertion kind, e.g. url_contains, text_visible, selector_visible, value_equals, no_console_errors, no_failed_requests, request_url_seen, response_status, console_message_matches, network_count, console_count, no_console_errors_since, no_failed_requests_since" }),
					selector: Type.Optional(Type.String()),
					text: Type.Optional(Type.String()),
					value: Type.Optional(Type.String()),
					checked: Type.Optional(Type.Boolean()),
					sinceActionId: Type.Optional(Type.Number()),
				})
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await ensureBrowser();
				const target = getActiveTarget();
				const state = await collectAssertionState(p, params.checks, target);
				const result = evaluateAssertionChecks({ checks: params.checks, state });
				return {
					content: [{ type: "text", text: `Browser assert\n\n${formatAssertionText(result)}` }],
					details: { ...result, url: state.url, title: state.title },
					isError: !result.verified,
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Browser assert failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_diff
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_diff",
		label: "Browser Diff",
		description:
			"Report meaningful browser-state changes. By default compares the current page to the most recent tracked action state. Use this to understand what changed after a click, submit, or navigation.",
		promptGuidelines: [
			"Use browser_diff after ambiguous or high-impact actions when you need to know what changed.",
			"Prefer browser_diff over requesting a broad new page inspection when the question is change detection.",
		],
		parameters: Type.Object({
			sinceActionId: Type.Optional(Type.Number({ description: "Optional action id to diff against. Uses that action's stored after-state when available." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await ensureBrowser();
				const target = getActiveTarget();
				const current = await captureCompactPageState(p, { includeBodyText: true, target });
				let baseline: CompactPageState | null = null;
				if (params.sinceActionId) {
					const action = findAction(actionTimeline, params.sinceActionId) as { afterState?: CompactPageState } | null;
					baseline = action?.afterState ?? null;
				}
				if (!baseline) {
					baseline = lastActionAfterState ?? lastActionBeforeState;
				}
				if (!baseline) {
					return {
						content: [{ type: "text", text: "Browser diff unavailable: no prior tracked browser state exists yet." }],
						details: { changed: false, changes: [], summary: "No prior tracked state" },
						isError: true,
					};
				}
				const diff = diffCompactStates(baseline, current);
				return {
					content: [{ type: "text", text: `Browser diff\n\n${formatDiffText(diff)}` }],
					details: diff,
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Browser diff failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_batch
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_batch",
		label: "Browser Batch",
		description:
			"Execute multiple explicit browser steps in one call. Prefer this for obvious action sequences like click → type → wait → assert to reduce round trips and token usage.",
		promptGuidelines: [
			"If the next 2-5 browser actions are obvious and low-risk, prefer browser_batch over multiple tiny browser calls.",
			"Use browser_batch for explicit sequences like click → type → submit → wait → assert.",
			"Keep browser_batch steps explicit; do not use it as a speculative planner.",
		],
		parameters: Type.Object({
			steps: Type.Array(
				Type.Object({
					action: StringEnum(["navigate", "click", "type", "key_press", "wait_for", "assert", "click_ref", "fill_ref"] as const),
					selector: Type.Optional(Type.String()),
					text: Type.Optional(Type.String()),
					url: Type.Optional(Type.String()),
					key: Type.Optional(Type.String()),
					condition: Type.Optional(Type.String()),
					value: Type.Optional(Type.String()),
					threshold: Type.Optional(Type.String()),
					timeout: Type.Optional(Type.Number()),
					clearFirst: Type.Optional(Type.Boolean()),
					submit: Type.Optional(Type.Boolean()),
					ref: Type.Optional(Type.String()),
					checks: Type.Optional(Type.Array(Type.Object({
						kind: Type.String({ description: "Assertion kind, e.g. url_contains, text_visible, selector_visible, value_equals, no_console_errors, no_failed_requests, request_url_seen, response_status, console_message_matches, network_count, console_count, no_console_errors_since, no_failed_requests_since" }),
						selector: Type.Optional(Type.String()),
						text: Type.Optional(Type.String()),
						value: Type.Optional(Type.String()),
						checked: Type.Optional(Type.Boolean()),
						sinceActionId: Type.Optional(Type.Number()),
					}))),
				})
			),
			stopOnFailure: Type.Optional(Type.Boolean({ description: "Stop after the first failing step (default: true)." })),
			finalSummaryOnly: Type.Optional(Type.Boolean({ description: "Return only the compact final batch summary in content while keeping step results in details." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			let actionId: number | null = null;
			let beforeState: CompactPageState | null = null;
			try {
				const { page: p } = await ensureBrowser();
				const target = getActiveTarget();
				beforeState = await captureCompactPageState(p, { includeBodyText: true, target });
				actionId = beginTrackedAction("browser_batch", params, beforeState.url).id;
				const executeStep = async (step: any, index: number) => {
					// Re-resolve target each step — frame selection may change during batch
					const stepTarget = getActiveTarget();
					try {
						switch (step.action) {
							case "navigate": {
								// Navigation is always page-level
								await p.goto(step.url, { waitUntil: "domcontentloaded", timeout: 30000 });
								await p.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
								return { ok: true, action: step.action, url: p.url() };
							}
							case "click": {
								await stepTarget.locator(step.selector).first().click({ timeout: step.timeout ?? 8000 });
								await settleAfterActionAdaptive(p);
								return { ok: true, action: step.action, selector: step.selector, url: p.url() };
							}
							case "type": {
								if (step.clearFirst) {
									await stepTarget.locator(step.selector).first().fill("");
								}
								await stepTarget.locator(step.selector).first().fill(step.text ?? "", { timeout: step.timeout ?? 8000 });
								if (step.submit) await p.keyboard.press("Enter");
								await settleAfterActionAdaptive(p);
								return { ok: true, action: step.action, selector: step.selector, text: step.text };
							}
							case "key_press": {
								// Keyboard is page-level
								await p.keyboard.press(step.key);
								await settleAfterActionAdaptive(p, { checkFocusStability: true });
								return { ok: true, action: step.action, key: step.key };
							}
							case "wait_for": {
								const timeout = step.timeout ?? 10000;
								// Validate params for all conditions
								const waitValidation = validateWaitParams({ condition: step.condition, value: step.value, threshold: step.threshold });
								if (waitValidation) throw new Error(waitValidation.error);

								if (step.condition === "selector_visible") await stepTarget.waitForSelector(step.value, { state: "visible", timeout });
								else if (step.condition === "selector_hidden") await stepTarget.waitForSelector(step.value, { state: "hidden", timeout });
								else if (step.condition === "url_contains") await p.waitForURL((url) => url.toString().includes(step.value), { timeout });
								else if (step.condition === "network_idle") await p.waitForLoadState("networkidle", { timeout });
								else if (step.condition === "delay") await new Promise((resolve) => setTimeout(resolve, parseInt(step.value ?? "1000", 10)));
								else if (step.condition === "text_visible") {
									await stepTarget.waitForFunction(
										(needle: string) => (document.body?.innerText ?? "").toLowerCase().includes(needle.toLowerCase()),
										step.value!,
										{ timeout }
									);
								}
								else if (step.condition === "text_hidden") {
									await stepTarget.waitForFunction(
										(needle: string) => !(document.body?.innerText ?? "").toLowerCase().includes(needle.toLowerCase()),
										step.value!,
										{ timeout }
									);
								}
								else if (step.condition === "request_completed") {
									await getActivePage().waitForResponse(
										(resp: any) => resp.url().includes(step.value!),
										{ timeout }
									);
								}
								else if (step.condition === "console_message") {
									const needle = step.value!;
									const startTime = Date.now();
									let found = false;
									while (Date.now() - startTime < timeout) {
										if (consoleLogs.find((entry) => includesNeedle(entry.text, needle))) { found = true; break; }
										await new Promise((resolve) => setTimeout(resolve, 100));
									}
									if (!found) throw new Error(`Timed out waiting for console message matching "${needle}" (${timeout}ms)`);
								}
								else if (step.condition === "element_count") {
									const threshold = parseThreshold(step.threshold ?? ">=1");
									if (!threshold) throw new Error(`element_count threshold is malformed: "${step.threshold}"`);
									const selector = step.value!;
									const op = threshold.op;
									const n = threshold.n;
									await stepTarget.waitForFunction(
										({ selector, op, n }: { selector: string; op: string; n: number }) => {
											const count = document.querySelectorAll(selector).length;
											switch (op) {
												case ">=": return count >= n;
												case "<=": return count <= n;
												case "==": return count === n;
												case ">": return count > n;
												case "<": return count < n;
												default: return false;
											}
										},
										{ selector, op, n },
										{ timeout }
									);
								}
								else if (step.condition === "region_stable") {
									const script = createRegionStableScript(step.value!);
									await stepTarget.waitForFunction(script, undefined, { timeout, polling: 200 });
								}
								else throw new Error(`Unsupported wait condition: ${step.condition}`);
								return { ok: true, action: step.action, condition: step.condition, value: step.value };
							}
							case "assert": {
								const state = await collectAssertionState(p, step.checks ?? [], stepTarget);
								const assertion = evaluateAssertionChecks({ checks: step.checks ?? [], state });
								return { ok: assertion.verified, action: step.action, summary: assertion.summary, assertion };
							}
							case "click_ref": {
								const parsedRef = parseRef(step.ref);
								const node = currentRefMap[parsedRef.key];
								if (!node) throw new Error(`Unknown ref: ${step.ref}`);
								const resolved = await resolveRefTarget(stepTarget, node);
								if (!resolved.ok) throw new Error(resolved.reason);
								await stepTarget.locator(resolved.selector).first().click({ timeout: step.timeout ?? 8000 });
								await settleAfterActionAdaptive(p);
								return { ok: true, action: step.action, ref: step.ref };
							}
							case "fill_ref": {
								const parsedRef = parseRef(step.ref);
								const node = currentRefMap[parsedRef.key];
								if (!node) throw new Error(`Unknown ref: ${step.ref}`);
								const resolved = await resolveRefTarget(stepTarget, node);
								if (!resolved.ok) throw new Error(resolved.reason);
								if (step.clearFirst) await stepTarget.locator(resolved.selector).first().fill("");
								await stepTarget.locator(resolved.selector).first().fill(step.text ?? "", { timeout: step.timeout ?? 8000 });
								if (step.submit) await p.keyboard.press("Enter");
								await settleAfterActionAdaptive(p);
								return { ok: true, action: step.action, ref: step.ref, text: step.text };
							}
							default:
								throw new Error(`Unsupported batch action: ${step.action}`);
						}
					} catch (err: any) {
						return { ok: false, action: step.action, index, message: err.message };
					}
				};
				const run = await runBatchSteps({
					steps: params.steps,
					executeStep,
					stopOnFailure: params.stopOnFailure !== false,
				});
				// Re-resolve target at end of batch since steps may have changed frame selection
				const batchEndTarget = getActiveTarget();
				const afterState = await captureCompactPageState(p, { includeBodyText: true, target: batchEndTarget });
				const diff = diffCompactStates(beforeState!, afterState);
				lastActionBeforeState = beforeState!;
				lastActionAfterState = afterState;
				finishTrackedAction(actionId!, {
					status: run.ok ? "success" : "error",
					afterUrl: afterState.url,
					diffSummary: diff.summary,
					changed: diff.changed,
					error: run.ok ? undefined : run.summary,
					beforeState: beforeState!,
					afterState,
				});
				const summary = `${run.summary}\n${run.stepResults.map((step: any, index: number) => `- ${index + 1}. ${step.action}: ${step.ok ? "PASS" : "FAIL"}${step.message ? ` (${step.message})` : ""}`).join("\n")}`;
				return {
					content: [{ type: "text", text: params.finalSummaryOnly ? run.summary : `Browser batch\nAction: ${actionId}\n\n${summary}\n\nDiff:\n${formatDiffText(diff)}` }],
					details: { actionId, diff, ...run },
					isError: !run.ok,
				};
			} catch (err: any) {
				if (actionId !== null) {
					finishTrackedAction(actionId, { status: "error", afterUrl: getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? undefined });
				}
				return {
					content: [{ type: "text", text: `Browser batch failed: ${err.message}` }],
					details: { error: err.message, actionId },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_get_accessibility_tree
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_get_accessibility_tree",
		label: "Browser Accessibility Tree",
		description:
			"Get the accessibility tree of the current page as structured text. Shows roles, names, labels, values, and states of all interactive elements. Use this to understand page structure before clicking — it reveals buttons, inputs, links, and their labels without needing to guess CSS selectors or coordinates. Much more reliable than inspecting the DOM directly.",
		parameters: Type.Object({
			selector: Type.Optional(
				Type.String({
					description:
						"Scope the accessibility tree to a specific element by CSS selector (e.g. 'main', 'form', '#modal'). If omitted, returns the full page tree.",
				})
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await ensureBrowser();
				const target = getActiveTarget();

				// Use Playwright's aria snapshot which gives a structured YAML-like representation
				let snapshot: string;
				if (params.selector) {
					const locator = target.locator(params.selector).first();
					snapshot = await locator.ariaSnapshot();
				} else {
					snapshot = await target.locator("body").ariaSnapshot();
				}

				const truncated = truncateText(snapshot);
				const scope = params.selector ? `element "${params.selector}"` : "full page";
				const viewport = p.viewportSize();
				const vpText = viewport ? `${viewport.width}x${viewport.height}` : "unknown";

				return {
					content: [
						{
							type: "text",
							text: `Accessibility tree for ${scope} (viewport: ${vpText}):\n\n${truncated}`,
						},
					],
					details: { scope, snapshot, viewport: vpText },
				};
			} catch (err: any) {
				return {
					content: [
						{
							type: "text",
							text: `Accessibility tree failed: ${err.message}`,
						},
					],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_find
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_find",
		label: "Browser Find",
		description:
			"Find elements on the page by text content, ARIA role, or CSS selector. Returns only the matched nodes as a compact accessibility snapshot — far cheaper than browser_get_accessibility_tree. Use this after any action to locate a specific button, input, heading, or link before clicking it.",
		promptGuidelines: [
			"Use browser_find for cheap targeted discovery before requesting the full accessibility tree.",
			"Prefer browser_find when you need one button, input, heading, dialog, or alert rather than a full-page structure dump.",
		],
		parameters: Type.Object({
			text: Type.Optional(
				Type.String({
					description: "Find elements whose visible text contains this string (case-insensitive).",
				})
			),
			role: Type.Optional(
				Type.String({
					description: "ARIA role to filter by, e.g. 'button', 'link', 'heading', 'textbox', 'dialog', 'alert'.",
				})
			),
			selector: Type.Optional(
				Type.String({
					description: "CSS selector to scope the search. If omitted, searches the full page.",
				})
			),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of results to return (default: 20).",
				})
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				await ensureBrowser();
				const target = getActiveTarget();
				const limit = params.limit ?? 20;

				const results = await target.evaluate(({ text, role, selector, limit }) => {
					const root = selector ? document.querySelector(selector) : document.body;
					if (!root) return [];

					// Collect candidate elements
					let candidates: Element[];
					if (role) {
						// Query by ARIA role (native + explicit)
						const roleMap: Record<string, string> = {
							button: 'button,[role="button"]',
							link: 'a[href],[role="link"]',
							heading: 'h1,h2,h3,h4,h5,h6,[role="heading"]',
							textbox: 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]),textarea,[role="textbox"]',
							checkbox: 'input[type="checkbox"],[role="checkbox"]',
							radio: 'input[type="radio"],[role="radio"]',
							combobox: 'select,[role="combobox"]',
							dialog: 'dialog,[role="dialog"]',
							alert: '[role="alert"]',
							navigation: 'nav,[role="navigation"]',
							listitem: 'li,[role="listitem"]',
						};
						const cssForRole = roleMap[role.toLowerCase()] ?? `[role="${role}"]`;
						candidates = Array.from(root.querySelectorAll(cssForRole));
					} else {
						candidates = Array.from(root.querySelectorAll('*'));
					}

					// Filter by text if provided
					if (text) {
						const lower = text.toLowerCase();
						candidates = candidates.filter(el =>
							(el.textContent ?? "").toLowerCase().includes(lower) ||
							(el.getAttribute("aria-label") ?? "").toLowerCase().includes(lower) ||
							(el.getAttribute("placeholder") ?? "").toLowerCase().includes(lower) ||
							(el.getAttribute("value") ?? "").toLowerCase().includes(lower)
						);
					}

					return candidates.slice(0, limit).map(el => {
						const tag = el.tagName.toLowerCase();
						const id = el.id ? `#${el.id}` : "";
						const classes = Array.from(el.classList).slice(0, 2).map(c => `.${c}`).join("");
						const ariaLabel = el.getAttribute("aria-label") ?? "";
						const placeholder = el.getAttribute("placeholder") ?? "";
						const textContent = (el.textContent ?? "").trim().slice(0, 80);
						const role = el.getAttribute("role") ?? "";
						const type = el.getAttribute("type") ?? "";
						const href = el.getAttribute("href") ?? "";
						const value = (el as HTMLInputElement).value ?? "";

						return { tag, id, classes, ariaLabel, placeholder, textContent, role, type, href, value };
					});
				}, { text: params.text, role: params.role, selector: params.selector, limit });

				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No elements found matching the criteria." }],
						details: { count: 0 },
					};
				}

				const lines = results.map((r: any) => {
					const parts: string[] = [`${r.tag}${r.id}${r.classes}`];
					if (r.role) parts.push(`role="${r.role}"`);
					if (r.type) parts.push(`type="${r.type}"`);
					if (r.ariaLabel) parts.push(`aria-label="${r.ariaLabel}"`);
					if (r.placeholder) parts.push(`placeholder="${r.placeholder}"`);
					if (r.href) parts.push(`href="${r.href.slice(0, 60)}"`);
					if (r.value) parts.push(`value="${r.value.slice(0, 40)}"`);
					if (r.textContent && !r.ariaLabel) parts.push(`"${r.textContent}"`);
					return "  " + parts.join(" ");
				});

				const criteria: string[] = [];
				if (params.role) criteria.push(`role="${params.role}"`);
				if (params.text) criteria.push(`text="${params.text}"`);
				if (params.selector) criteria.push(`within="${params.selector}"`);

				return {
					content: [
						{
							type: "text",
							text: `Found ${results.length} element(s) [${criteria.join(", ")}]:\n${lines.join("\n")}`,
						},
					],
					details: { count: results.length, results },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Find failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_snapshot_refs
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_snapshot_refs",
		label: "Browser Snapshot Refs",
		description:
			"Capture a compact inventory of interactive elements and assign deterministic versioned refs (@vN:e1, @vN:e2, ...). Use these refs with browser_click_ref, browser_fill_ref, and browser_hover_ref.",
		parameters: Type.Object({
			selector: Type.Optional(
				Type.String({
					description: "Optional CSS selector scope for the snapshot (e.g. 'main', 'form', '#modal').",
				})
			),
			interactiveOnly: Type.Optional(
				Type.Boolean({
					description: "Include only interactive elements (default: true).",
				})
			),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of elements to include (default: 40).",
				})
			),
			mode: Type.Optional(
				Type.String({
					description: "Semantic snapshot mode that pre-filters elements by category. When set, overrides interactiveOnly. Modes: interactive, form, dialog, navigation, errors, headings, visible_only.",
				})
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await ensureBrowser();
				const target = getActiveTarget();

				// Validate mode if provided
				const mode = params.mode;
				if (mode !== undefined) {
					const modeConfig = getSnapshotModeConfig(mode);
					if (!modeConfig) {
						const validModes = Object.keys(SNAPSHOT_MODES).join(", ");
						return {
							content: [{ type: "text", text: `Unknown snapshot mode: "${mode}". Valid modes: ${validModes}` }],
							details: { error: `Unknown mode: ${mode}`, validModes: Object.keys(SNAPSHOT_MODES) },
							isError: true,
						};
					}
				}

				const interactiveOnly = params.interactiveOnly !== false;
				const limit = Math.max(1, Math.min(200, Math.floor(params.limit ?? 40)));
				const rawNodes = await buildRefSnapshot(target, {
					selector: params.selector,
					interactiveOnly,
					limit,
					mode,
				});

				refVersion += 1;
				const nextMap: Record<string, RefNode> = {};
				for (let i = 0; i < rawNodes.length; i += 1) {
					const ref = `e${i + 1}`;
					nextMap[ref] = { ref, ...rawNodes[i] };
				}
				currentRefMap = nextMap;
				// Record frame context when snapshot taken inside a frame
				const frameCtx = activeFrame ? (activeFrame.name() || activeFrame.url()) : undefined;
				refMetadata = {
					url: p.url(),
					timestamp: Date.now(),
					selectorScope: params.selector,
					interactiveOnly,
					limit,
					version: refVersion,
					frameContext: frameCtx,
					mode,
				};

				if (rawNodes.length === 0) {
					return {
						content: [{
							type: "text",
							text: "No elements found for ref snapshot (try interactiveOnly=false or a wider selector scope).",
						}],
						details: {
							count: 0,
							version: refVersion,
							metadata: refMetadata,
							refs: {},
						},
					};
				}

				const versionedRefs: Record<string, RefNode> = {};
				const lines = Object.values(nextMap).map((node) => {
					const versionedRef = formatVersionedRef(refVersion, node.ref);
					versionedRefs[versionedRef] = node;
					const parts: string[] = [versionedRef, node.role || node.tag];
					if (node.name) parts.push(`"${node.name}"`);
					if (node.href) parts.push(`href="${node.href.slice(0, 80)}"`);
					if (!node.isVisible) parts.push("(hidden)");
					if (!node.isEnabled) parts.push("(disabled)");
					return parts.join(" ");
				});

				const modeLabel = mode ? `Mode: ${mode}\n` : "";
				return {
					content: [{
						type: "text",
						text:
							`Ref snapshot v${refVersion} (${rawNodes.length} element(s))\n` +
							`URL: ${p.url()}\n` +
							`Scope: ${params.selector ?? "body"}\n` +
							modeLabel +
							`Use versioned refs exactly as shown (e.g. @v${refVersion}:e1).\n\n` +
							lines.join("\n"),
					}],
					details: {
						count: rawNodes.length,
						version: refVersion,
						metadata: refMetadata,
						refs: nextMap,
						versionedRefs,
					},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Snapshot refs failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_get_ref
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_get_ref",
		label: "Browser Get Ref",
		description: "Inspect stored metadata for one deterministic element ref (prefer versioned format, e.g. @v3:e1).",
		parameters: Type.Object({
			ref: Type.String({ description: "Reference id, preferably versioned (e.g. '@v3:e1')." }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const parsedRef = parseRef(params.ref);
			if (parsedRef.version !== null && refMetadata && parsedRef.version !== refMetadata.version) {
				return {
					content: [{ type: "text", text: staleRefGuidance(parsedRef.display, `snapshot version mismatch (have v${refMetadata.version})`) }],
					details: { error: "ref_stale", ref: parsedRef.display, expectedVersion: refMetadata.version, receivedVersion: parsedRef.version },
					isError: true,
				};
			}

			const node = currentRefMap[parsedRef.key];
			if (!node) {
				return {
					content: [{ type: "text", text: staleRefGuidance(parsedRef.display, "ref not found") }],
					details: { error: "ref_not_found", ref: parsedRef.display, metadata: refMetadata },
					isError: true,
				};
			}

			const versionedRef = formatVersionedRef(refMetadata?.version ?? refVersion, node.ref);
			return {
				content: [{
					type: "text",
					text: `${versionedRef}: ${node.role || node.tag}${node.name ? ` "${node.name}"` : ""}\nVisible: ${node.isVisible}\nEnabled: ${node.isEnabled}\nPath: ${node.xpathOrPath}`,
				}],
				details: { ref: versionedRef, node, metadata: refMetadata },
			};
		},
	});

	// -------------------------------------------------------------------------
	// browser_click_ref
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_click_ref",
		label: "Browser Click Ref",
		description: "Click a previously snapshotted element by deterministic versioned ref (e.g. @v3:e2).",
		parameters: Type.Object({
			ref: Type.String({ description: "Reference id in versioned format, e.g. '@v3:e2'." }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const parsedRef = parseRef(params.ref);
			const requestedRef = parsedRef.display;
			try {
				const { page: p } = await ensureBrowser();
				const target = getActiveTarget();
				if (parsedRef.version === null) {
					return {
						content: [{ type: "text", text: `Unversioned ref ${requestedRef} is ambiguous. Use a versioned ref (e.g. @v${refMetadata?.version ?? refVersion}:e1) from browser_snapshot_refs.` }],
						details: { error: "ref_unversioned", ref: requestedRef, metadata: refMetadata },
						isError: true,
					};
				}
				if (refMetadata && parsedRef.version !== refMetadata.version) {
					return {
						content: [{ type: "text", text: staleRefGuidance(requestedRef, `snapshot version mismatch (have v${refMetadata.version})`) }],
						details: { error: "ref_stale", ref: requestedRef, expectedVersion: refMetadata.version, receivedVersion: parsedRef.version },
						isError: true,
					};
				}
				const ref = parsedRef.key;
				const node = currentRefMap[ref];
				if (!node) {
					return {
						content: [{ type: "text", text: staleRefGuidance(requestedRef, "ref not found") }],
						details: { error: "ref_not_found", ref: requestedRef, metadata: refMetadata },
						isError: true,
					};
				}
				if (refMetadata?.url && refMetadata.url !== p.url()) {
					return {
						content: [{ type: "text", text: staleRefGuidance(requestedRef, "URL changed since snapshot") }],
						details: { error: "ref_stale", ref: requestedRef, snapshotUrl: refMetadata.url, currentUrl: p.url() },
						isError: true,
					};
				}

				const resolved = await resolveRefTarget(target, node);
				if (!resolved.ok) {
					const reason = (resolved as { ok: false; reason: string }).reason;
					return {
						content: [{ type: "text", text: staleRefGuidance(requestedRef, reason) }],
						details: { error: "ref_stale", ref: requestedRef, reason },
						isError: true,
					};
				}

				const beforeUrl = p.url();
				const beforeHash = getUrlHash(beforeUrl);
				const beforeDialogCount = await countOpenDialogs(target);
				const beforeTargetState = await captureClickTargetState(target, resolved.selector);
				await target.locator(resolved.selector).first().click({ timeout: 8000 });
				const settle = await settleAfterActionAdaptive(p);

				const afterUrl = p.url();
				const afterHash = getUrlHash(afterUrl);
				const afterDialogCount = await countOpenDialogs(target);
				const afterTargetState = await captureClickTargetState(target, resolved.selector);
				const targetStateChanged =
					beforeTargetState.exists !== afterTargetState.exists ||
					beforeTargetState.ariaExpanded !== afterTargetState.ariaExpanded ||
					beforeTargetState.ariaPressed !== afterTargetState.ariaPressed ||
					beforeTargetState.ariaSelected !== afterTargetState.ariaSelected ||
					beforeTargetState.open !== afterTargetState.open;
				const verification = verificationFromChecks(
					[
						{ name: "url_changed", passed: afterUrl !== beforeUrl, value: afterUrl, expected: `!= ${beforeUrl}` },
						{ name: "hash_changed", passed: afterHash !== beforeHash, value: afterHash, expected: `!= ${beforeHash}` },
						{ name: "target_state_changed", passed: targetStateChanged, value: afterTargetState, expected: beforeTargetState },
						{ name: "dialog_open", passed: afterDialogCount > beforeDialogCount, value: afterDialogCount, expected: `> ${beforeDialogCount}` },
					],
					"Ref may now point to an inert element. Refresh refs with browser_snapshot_refs and retry."
				);

				const summary = await postActionSummary(p, target);
				const jsErrors = getRecentErrors(p.url());
				const versionedRef = formatVersionedRef(refMetadata?.version ?? refVersion, node.ref);
				return {
					content: [{
						type: "text",
						text: `Clicked ${versionedRef} (${node.role || node.tag}${node.name ? ` "${node.name}"` : ""})\n${verificationLine(verification)}${jsErrors}\n\nPage summary:\n${summary}`,
					}],
					details: { ref: versionedRef, selector: resolved.selector, url: p.url(), ...settle, ...verification },
				};
			} catch (err: any) {
				const errorShot = await captureErrorScreenshot(getActivePageOrNull());
				const reason = firstErrorLine(err);
				const content: any[] = [
					{ type: "text", text: staleRefGuidance(requestedRef, `action failed: ${reason}`) },
					{ type: "text", text: `Click ref failed: ${err.message}` },
				];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return {
					content,
					details: { error: err.message, ref: requestedRef, hint: "Run browser_snapshot_refs to refresh refs." },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_hover_ref
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_hover_ref",
		label: "Browser Hover Ref",
		description: "Hover a previously snapshotted element by deterministic versioned ref (e.g. @v3:e4).",
		parameters: Type.Object({
			ref: Type.String({ description: "Reference id in versioned format, e.g. '@v3:e4'." }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const parsedRef = parseRef(params.ref);
			const requestedRef = parsedRef.display;
			try {
				const { page: p } = await ensureBrowser();
				const target = getActiveTarget();
				if (parsedRef.version === null) {
					return {
						content: [{ type: "text", text: `Unversioned ref ${requestedRef} is ambiguous. Use a versioned ref (e.g. @v${refMetadata?.version ?? refVersion}:e1) from browser_snapshot_refs.` }],
						details: { error: "ref_unversioned", ref: requestedRef, metadata: refMetadata },
						isError: true,
					};
				}
				if (refMetadata && parsedRef.version !== refMetadata.version) {
					return {
						content: [{ type: "text", text: staleRefGuidance(requestedRef, `snapshot version mismatch (have v${refMetadata.version})`) }],
						details: { error: "ref_stale", ref: requestedRef, expectedVersion: refMetadata.version, receivedVersion: parsedRef.version },
						isError: true,
					};
				}
				const ref = parsedRef.key;
				const node = currentRefMap[ref];
				if (!node) {
					return {
						content: [{ type: "text", text: staleRefGuidance(requestedRef, "ref not found") }],
						details: { error: "ref_not_found", ref: requestedRef, metadata: refMetadata },
						isError: true,
					};
				}
				if (refMetadata?.url && refMetadata.url !== p.url()) {
					return {
						content: [{ type: "text", text: staleRefGuidance(requestedRef, "URL changed since snapshot") }],
						details: { error: "ref_stale", ref: requestedRef, snapshotUrl: refMetadata.url, currentUrl: p.url() },
						isError: true,
					};
				}

				const resolved = await resolveRefTarget(target, node);
				if (!resolved.ok) {
					const reason = (resolved as { ok: false; reason: string }).reason;
					return {
						content: [{ type: "text", text: staleRefGuidance(requestedRef, reason) }],
						details: { error: "ref_stale", ref: requestedRef, reason },
						isError: true,
					};
				}

				await target.locator(resolved.selector).first().hover({ timeout: 8000 });
				const settle = await settleAfterActionAdaptive(p);

				const summary = await postActionSummary(p, target);
				const jsErrors = getRecentErrors(p.url());
				const versionedRef = formatVersionedRef(refMetadata?.version ?? refVersion, node.ref);
				return {
					content: [{
						type: "text",
						text: `Hovered ${versionedRef} (${node.role || node.tag}${node.name ? ` "${node.name}"` : ""})${jsErrors}\n\nPage summary:\n${summary}`,
					}],
					details: { ref: versionedRef, selector: resolved.selector, url: p.url(), ...settle },
				};
			} catch (err: any) {
				const errorShot = await captureErrorScreenshot(getActivePageOrNull());
				const reason = firstErrorLine(err);
				const content: any[] = [
					{ type: "text", text: staleRefGuidance(requestedRef, `action failed: ${reason}`) },
					{ type: "text", text: `Hover ref failed: ${err.message}` },
				];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return {
					content,
					details: { error: err.message, ref: requestedRef, hint: "Run browser_snapshot_refs to refresh refs." },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_fill_ref
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_fill_ref",
		label: "Browser Fill Ref",
		description: "Fill/type text into an input-like element by deterministic versioned ref (e.g. @v3:e1).",
		parameters: Type.Object({
			ref: Type.String({ description: "Reference id in versioned format, e.g. '@v3:e1'." }),
			text: Type.String({ description: "Text to enter." }),
			clearFirst: Type.Optional(
				Type.Boolean({ description: "Clear existing value first (default: false)." })
			),
			submit: Type.Optional(
				Type.Boolean({ description: "Press Enter after typing (default: false)." })
			),
			slowly: Type.Optional(
				Type.Boolean({ description: "Type character-by-character (default: false)." })
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const parsedRef = parseRef(params.ref);
			const requestedRef = parsedRef.display;
			try {
				const { page: p } = await ensureBrowser();
				const target = getActiveTarget();
				if (parsedRef.version === null) {
					return {
						content: [{ type: "text", text: `Unversioned ref ${requestedRef} is ambiguous. Use a versioned ref (e.g. @v${refMetadata?.version ?? refVersion}:e1) from browser_snapshot_refs.` }],
						details: { error: "ref_unversioned", ref: requestedRef, metadata: refMetadata },
						isError: true,
					};
				}
				if (refMetadata && parsedRef.version !== refMetadata.version) {
					return {
						content: [{ type: "text", text: staleRefGuidance(requestedRef, `snapshot version mismatch (have v${refMetadata.version})`) }],
						details: { error: "ref_stale", ref: requestedRef, expectedVersion: refMetadata.version, receivedVersion: parsedRef.version },
						isError: true,
					};
				}
				const ref = parsedRef.key;
				const node = currentRefMap[ref];
				if (!node) {
					return {
						content: [{ type: "text", text: staleRefGuidance(requestedRef, "ref not found") }],
						details: { error: "ref_not_found", ref: requestedRef, metadata: refMetadata },
						isError: true,
					};
				}
				if (refMetadata?.url && refMetadata.url !== p.url()) {
					return {
						content: [{ type: "text", text: staleRefGuidance(requestedRef, "URL changed since snapshot") }],
						details: { error: "ref_stale", ref: requestedRef, snapshotUrl: refMetadata.url, currentUrl: p.url() },
						isError: true,
					};
				}

				const resolved = await resolveRefTarget(target, node);
				if (!resolved.ok) {
					const reason = (resolved as { ok: false; reason: string }).reason;
					return {
						content: [{ type: "text", text: staleRefGuidance(requestedRef, reason) }],
						details: { error: "ref_stale", ref: requestedRef, reason },
						isError: true,
					};
				}

				const locator = target.locator(resolved.selector).first();
				const beforeUrl = p.url();
				if (params.slowly) {
					await locator.click({ timeout: 8000 });
					if (params.clearFirst) {
						await p.keyboard.press("Control+A");
						await p.keyboard.press("Delete");
					}
					await p.keyboard.type(params.text);
				} else {
					if (params.clearFirst) {
						await locator.fill("");
					}
					await locator.fill(params.text, { timeout: 8000 });
				}
				if (params.submit) {
					await p.keyboard.press("Enter");
				}
				const settle = await settleAfterActionAdaptive(p);

				const filledValue = await readInputLikeValue(target, resolved.selector);
				const afterUrl = p.url();
				const verification = verificationFromChecks(
					[
						{ name: "value_equals_expected", passed: filledValue === params.text, value: filledValue, expected: params.text },
						{ name: "value_contains_expected", passed: typeof filledValue === "string" && filledValue.includes(params.text), value: filledValue, expected: params.text },
						{ name: "url_changed_after_submit", passed: !!params.submit && afterUrl !== beforeUrl, value: afterUrl, expected: `!= ${beforeUrl}` },
					],
					"Try refreshing refs and confirm this ref still targets an input-like element."
				);

				const summary = await postActionSummary(p, target);
				const jsErrors = getRecentErrors(p.url());
				const versionedRef = formatVersionedRef(refMetadata?.version ?? refVersion, node.ref);
				return {
					content: [{
						type: "text",
						text: `Filled ${versionedRef} (${node.role || node.tag}${node.name ? ` "${node.name}"` : ""}) with "${params.text}"\n${verificationLine(verification)}${jsErrors}\n\nPage summary:\n${summary}`,
					}],
					details: { ref: versionedRef, selector: resolved.selector, url: p.url(), filledValue, ...settle, ...verification },
				};
			} catch (err: any) {
				const errorShot = await captureErrorScreenshot(getActivePageOrNull());
				const reason = firstErrorLine(err);
				const content: any[] = [
					{ type: "text", text: staleRefGuidance(requestedRef, `action failed: ${reason}`) },
					{ type: "text", text: `Fill ref failed: ${err.message}` },
				];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return {
					content,
					details: { error: err.message, ref: requestedRef, hint: "Run browser_snapshot_refs to refresh refs." },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_wait_for
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_wait_for",
		label: "Browser Wait For",
		description:
			"Wait for a condition before continuing. Use after actions that trigger async updates — data fetches, route changes, animations, loading spinners. Choose the appropriate condition: 'selector_visible' waits for an element to appear, 'selector_hidden' waits for it to disappear, 'url_contains' waits for the URL to match, 'network_idle' waits for all network requests to finish, 'delay' waits a fixed number of milliseconds, 'text_visible' waits for text to appear in the page body, 'text_hidden' waits for text to disappear from the page body, 'request_completed' waits for a network response whose URL contains the given substring, 'console_message' waits for a console log message containing the given substring, 'element_count' waits for the number of elements matching the CSS selector in 'value' to satisfy the 'threshold' expression (e.g. '>=3', '==0', '<5'), 'region_stable' waits for the DOM region matching the CSS selector in 'value' to stop changing.",
		parameters: Type.Object({
			condition: StringEnum([
				"selector_visible",
				"selector_hidden",
				"url_contains",
				"network_idle",
				"delay",
				"text_visible",
				"text_hidden",
				"request_completed",
				"console_message",
				"element_count",
				"region_stable",
			] as const),
			value: Type.Optional(
				Type.String({
					description:
						"For selector_visible/selector_hidden/element_count/region_stable: CSS selector. For url_contains/request_completed: URL substring. For text_visible/text_hidden/console_message: text substring. For delay: milliseconds as a string (e.g. '1000'). Not used for network_idle.",
				})
			),
			threshold: Type.Optional(
				Type.String({
					description:
						"Threshold expression for element_count (e.g. '>=3', '==0', '<5', or bare '3' which defaults to >=). Only used with element_count condition.",
				})
			),
			timeout: Type.Optional(
				Type.Number({
					description: "Maximum milliseconds to wait before failing (default: 10000)",
				})
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await ensureBrowser();
				const target = getActiveTarget();
				const timeout = params.timeout ?? 10000;

				// Validate params for all conditions using shared validator
				const validation = validateWaitParams({ condition: params.condition, value: params.value, threshold: (params as any).threshold });
				if (validation) {
					return {
						content: [{ type: "text", text: validation.error }],
						details: { error: validation.error, condition: params.condition },
						isError: true,
					};
				}

				switch (params.condition) {
					case "selector_visible": {
						if (!params.value) {
							return {
								content: [{ type: "text", text: "selector_visible requires a value (CSS selector)" }],
								details: {},
								isError: true,
							};
						}
						await target.waitForSelector(params.value, { state: "visible", timeout });
						return {
							content: [{ type: "text", text: `Element "${params.value}" is now visible` }],
							details: { condition: params.condition, value: params.value },
						};
					}

					case "selector_hidden": {
						if (!params.value) {
							return {
								content: [{ type: "text", text: "selector_hidden requires a value (CSS selector)" }],
								details: {},
								isError: true,
							};
						}
						await target.waitForSelector(params.value, { state: "hidden", timeout });
						return {
							content: [{ type: "text", text: `Element "${params.value}" is now hidden` }],
							details: { condition: params.condition, value: params.value },
						};
					}

					case "url_contains": {
						if (!params.value) {
							return {
								content: [{ type: "text", text: "url_contains requires a value (URL substring)" }],
								details: {},
								isError: true,
							};
						}
						await p.waitForURL((url) => url.toString().includes(params.value!), { timeout });
						return {
							content: [{ type: "text", text: `URL now contains "${params.value}". Current URL: ${p.url()}` }],
							details: { condition: params.condition, value: params.value, url: p.url() },
						};
					}

					case "network_idle": {
						await p.waitForLoadState("networkidle", { timeout });
						return {
							content: [{ type: "text", text: "Network is idle" }],
							details: { condition: params.condition },
						};
					}

					case "delay": {
						const ms = parseInt(params.value ?? "1000", 10);
						if (isNaN(ms)) {
							return {
								content: [{ type: "text", text: "delay requires a numeric value (milliseconds)" }],
								details: {},
								isError: true,
							};
						}
						await new Promise((resolve) => setTimeout(resolve, ms));
						return {
							content: [{ type: "text", text: `Waited ${ms}ms` }],
							details: { condition: params.condition, ms },
						};
					}

					case "text_visible": {
						await target.waitForFunction(
							(needle: string) => {
								const body = document.body?.innerText ?? "";
								return body.toLowerCase().includes(needle.toLowerCase());
							},
							params.value!,
							{ timeout }
						);
						return {
							content: [{ type: "text", text: `Text "${params.value}" is now visible on the page` }],
							details: { condition: params.condition, value: params.value },
						};
					}

					case "text_hidden": {
						await target.waitForFunction(
							(needle: string) => {
								const body = document.body?.innerText ?? "";
								return !body.toLowerCase().includes(needle.toLowerCase());
							},
							params.value!,
							{ timeout }
						);
						return {
							content: [{ type: "text", text: `Text "${params.value}" is no longer visible on the page` }],
							details: { condition: params.condition, value: params.value },
						};
					}

					case "request_completed": {
						// waitForResponse is Page-only (not available on Frame)
						const response = await getActivePage().waitForResponse(
							(resp) => resp.url().includes(params.value!),
							{ timeout }
						);
						return {
							content: [{ type: "text", text: `Request completed: ${response.url()} (status ${response.status()})` }],
							details: { condition: params.condition, value: params.value, url: response.url(), status: response.status() },
						};
					}

					case "console_message": {
						// Poll consoleLogs array — no Playwright built-in for this
						const needle = params.value!;
						const startTime = Date.now();
						while (Date.now() - startTime < timeout) {
							const match = consoleLogs.find((entry) => includesNeedle(entry.text, needle));
							if (match) {
								return {
									content: [{ type: "text", text: `Console message matching "${needle}" found: "${match.text}"` }],
									details: { condition: params.condition, value: needle, matchedText: match.text, matchedType: match.type },
								};
							}
							await new Promise((resolve) => setTimeout(resolve, 100));
						}
						throw new Error(`Timed out waiting for console message matching "${needle}" (${timeout}ms)`);
					}

					case "element_count": {
						const threshold = parseThreshold((params as any).threshold ?? ">=1");
						if (!threshold) {
							return {
								content: [{ type: "text", text: `element_count threshold is malformed: "${(params as any).threshold}"` }],
								details: { error: "malformed threshold", condition: params.condition },
								isError: true,
							};
						}
						const selector = params.value!;
						const op = threshold.op;
						const n = threshold.n;
						await target.waitForFunction(
							({ selector, op, n }: { selector: string; op: string; n: number }) => {
								const count = document.querySelectorAll(selector).length;
								switch (op) {
									case ">=": return count >= n;
									case "<=": return count <= n;
									case "==": return count === n;
									case ">": return count > n;
									case "<": return count < n;
									default: return false;
								}
							},
							{ selector, op, n },
							{ timeout }
						);
						return {
							content: [{ type: "text", text: `Element count for "${selector}" satisfies ${op}${n}` }],
							details: { condition: params.condition, value: selector, threshold: `${op}${n}` },
						};
					}

					case "region_stable": {
						const script = createRegionStableScript(params.value!);
						await target.waitForFunction(script, undefined, { timeout, polling: 200 });
						return {
							content: [{ type: "text", text: `Region "${params.value}" is now stable` }],
							details: { condition: params.condition, value: params.value },
						};
					}
				}
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Wait failed: ${err.message}` }],
					details: { error: err.message, condition: params.condition, value: params.value },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_hover
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_hover",
		label: "Browser Hover",
		description:
			"Move the mouse over an element to trigger hover states — reveals tooltips, dropdown menus, CSS :hover effects, and other hover-dependent UI. Returns a compact page summary showing the resulting hover state.", 
		parameters: Type.Object({
			selector: Type.String({
				description: "CSS selector of the element to hover over",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await ensureBrowser();
				const target = getActiveTarget();
				await target.locator(params.selector).first().hover({ timeout: 10000 });
				const settle = await settleAfterActionAdaptive(p);

				const summary = await postActionSummary(p, target);
				const jsErrors = getRecentErrors(p.url());

				return {
					content: [{ type: "text", text: `Hovering over "${params.selector}"${jsErrors}\n\nPage summary:\n${summary}` }],
					details: { selector: params.selector, ...settle },
				};
			} catch (err: any) {
				const errorShot = await captureErrorScreenshot(getActivePageOrNull());
				const content: any[] = [{ type: "text", text: `Hover failed: ${err.message}` }];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return {
					content,
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_key_press
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_key_press",
		label: "Browser Key Press",
		description:
			"Press a keyboard key or key combination. Returns a compact page summary plus lightweight verification details after the key press. Use for: submitting forms (Enter), closing modals (Escape), navigating focusable elements (Tab / Shift+Tab), operating dropdowns and menus (ArrowDown, ArrowUp, Space), copying/pasting (Meta+C, Meta+V). Key names follow the DOM KeyboardEvent key convention.", 
		parameters: Type.Object({
			key: Type.String({
				description:
					"Key or combination to press, e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'Space', 'Meta+A', 'Shift+Tab', 'Control+Enter'",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			let actionId: number | null = null;
			let beforeState: CompactPageState | null = null;
			try {
				const { page: p } = await ensureBrowser();
				const target = getActiveTarget();
				beforeState = await captureCompactPageState(p, { includeBodyText: true, target });
				actionId = beginTrackedAction("browser_key_press", params, beforeState.url).id;
				const beforeUrl = p.url();
				const beforeFocus = await readFocusedDescriptor(target);
				const beforeDialogCount = await countOpenDialogs(target);

				await p.keyboard.press(params.key);
				const settle = await settleAfterActionAdaptive(p, { checkFocusStability: true });

				const afterUrl = p.url();
				const afterFocus = await readFocusedDescriptor(target);
				const afterDialogCount = await countOpenDialogs(target);
				const verification = verificationFromChecks(
					[
						{ name: "url_changed", passed: afterUrl !== beforeUrl, value: afterUrl, expected: `!= ${beforeUrl}` },
						{ name: "focus_changed", passed: afterFocus !== beforeFocus, value: afterFocus, expected: `!= ${beforeFocus}` },
						{ name: "dialog_open", passed: afterDialogCount > beforeDialogCount, value: afterDialogCount, expected: `> ${beforeDialogCount}` },
					],
					"If this key should trigger UI changes, confirm focus is on the intended element first."
				);

				const summary = await postActionSummary(p, target);
				const jsErrors = getRecentErrors(p.url());
				const afterState = await captureCompactPageState(p, { includeBodyText: true, target });
				const diff = diffCompactStates(beforeState!, afterState);
				lastActionBeforeState = beforeState!;
				lastActionAfterState = afterState;
				finishTrackedAction(actionId!, {
					status: "success",
					afterUrl: afterState.url,
					verificationSummary: verification.verificationSummary,
					warningSummary: jsErrors.trim() || undefined,
					diffSummary: diff.summary,
					changed: diff.changed,
					beforeState: beforeState!,
					afterState,
				});

				return {
					content: [{ type: "text", text: `Pressed "${params.key}"\nAction: ${actionId}\n${verificationLine(verification)}${jsErrors}\n\nDiff:\n${formatDiffText(diff)}\n\nPage summary:\n${summary}` }],
					details: { key: params.key, beforeFocus, afterFocus, actionId, diff, ...settle, ...verification },
				};
			} catch (err: any) {
				if (actionId !== null) {
					finishTrackedAction(actionId, { status: "error", afterUrl: getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? undefined });
				}
				const errorShot = await captureErrorScreenshot(getActivePageOrNull());
				const content: any[] = [{ type: "text", text: `Key press failed: ${err.message}` }];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return {
					content,
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_select_option
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_select_option",
		label: "Browser Select Option",
		description:
			"Select an option from a <select> dropdown element by its visible label or value. Returns a compact page summary plus lightweight verification details. For custom-built dropdowns use browser_click to open them then browser_click to pick the option.", 
		parameters: Type.Object({
			selector: Type.String({
				description: "CSS selector targeting the <select> element",
			}),
			option: Type.String({
				description:
					"The option to select — can be the visible label text or the value attribute. Will try label first, then value.",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			let actionId: number | null = null;
			let beforeState: CompactPageState | null = null;
			try {
				const { page: p } = await ensureBrowser();
				const target = getActiveTarget();
				beforeState = await captureCompactPageState(p, { selectors: [params.selector], includeBodyText: true, target });
				actionId = beginTrackedAction("browser_select_option", params, beforeState.url).id;

				let selected: string[];
				try {
					selected = await target.selectOption(params.selector, { label: params.option }, { timeout: 5000 });
				} catch {
					selected = await target.selectOption(params.selector, { value: params.option }, { timeout: 5000 });
				}

				const settle = await settleAfterActionAdaptive(p);

				const selectedState = await target.locator(params.selector).first().evaluate((el) => {
					if (!(el instanceof HTMLSelectElement)) {
						return { selectedValues: [] as string[], selectedLabels: [] as string[] };
					}
					const selectedOptions = Array.from(el.selectedOptions || []);
					return {
						selectedValues: selectedOptions.map((opt) => opt.value),
						selectedLabels: selectedOptions.map((opt) => (opt.textContent || "").trim()),
					};
				});
				const optionNeedle = params.option.toLowerCase();
				const verification = verificationFromChecks(
					[
						{ name: "selected_values_include_option", passed: selectedState.selectedValues.includes(params.option), value: selectedState.selectedValues, expected: params.option },
						{ name: "selected_labels_include_option", passed: selectedState.selectedLabels.some((label) => label.toLowerCase().includes(optionNeedle)), value: selectedState.selectedLabels, expected: params.option },
					],
					"Confirm whether the target select uses option label or value, then retry with that exact text."
				);

				const summary = await postActionSummary(p, target);
				const jsErrors = getRecentErrors(p.url());
				const afterState = await captureCompactPageState(p, { selectors: [params.selector], includeBodyText: true, target });
				const diff = diffCompactStates(beforeState!, afterState);
				lastActionBeforeState = beforeState!;
				lastActionAfterState = afterState;
				finishTrackedAction(actionId!, {
					status: "success",
					afterUrl: afterState.url,
					verificationSummary: verification.verificationSummary,
					warningSummary: jsErrors.trim() || undefined,
					diffSummary: diff.summary,
					changed: diff.changed,
					beforeState: beforeState!,
					afterState,
				});

				return {
					content: [
						{
							type: "text",
							text: `Selected "${params.option}" in "${params.selector}". Values: ${selected.join(", ")}\nAction: ${actionId}\n${verificationLine(verification)}${jsErrors}\n\nDiff:\n${formatDiffText(diff)}\n\nPage summary:\n${summary}`,
						},
					],
					details: { selector: params.selector, option: params.option, selected, selectedState, actionId, diff, ...settle, ...verification },
				};
			} catch (err: any) {
				if (actionId !== null) {
					finishTrackedAction(actionId, { status: "error", afterUrl: getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? undefined });
				}
				const errorShot = await captureErrorScreenshot(getActivePageOrNull());
				const content: any[] = [{ type: "text", text: `Select option failed: ${err.message}` }];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return {
					content,
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_set_checked
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_set_checked",
		label: "Browser Set Checked",
		description:
			"Check or uncheck a checkbox or radio button. More reliable than clicking for form elements where you need a specific state.",
		parameters: Type.Object({
			selector: Type.String({
				description: "CSS selector targeting the checkbox or radio input",
			}),
			checked: Type.Boolean({
				description: "true to check, false to uncheck",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			let actionId: number | null = null;
			let beforeState: CompactPageState | null = null;
			try {
				const { page: p } = await ensureBrowser();
				const target = getActiveTarget();
				beforeState = await captureCompactPageState(p, { selectors: [params.selector], includeBodyText: true, target });
				actionId = beginTrackedAction("browser_set_checked", params, beforeState.url).id;
				await target.locator(params.selector).first().setChecked(params.checked, { timeout: 10000 });
				const settle = await settleAfterActionAdaptive(p);

				const actualChecked = await target.locator(params.selector).first().isChecked().catch(() => null);
				const verification = verificationFromChecks(
					[
						{ name: "checked_state_matches", passed: actualChecked === params.checked, value: actualChecked, expected: params.checked },
					],
					"Ensure selector points to a checkbox/radio input and retry."
				);

				const state = params.checked ? "checked" : "unchecked";
				const summary = await postActionSummary(p, target);
				const jsErrors = getRecentErrors(p.url());
				const afterState = await captureCompactPageState(p, { selectors: [params.selector], includeBodyText: true, target });
				const diff = diffCompactStates(beforeState!, afterState);
				lastActionBeforeState = beforeState!;
				lastActionAfterState = afterState;
				finishTrackedAction(actionId!, {
					status: "success",
					afterUrl: afterState.url,
					verificationSummary: verification.verificationSummary,
					warningSummary: jsErrors.trim() || undefined,
					diffSummary: diff.summary,
					changed: diff.changed,
					beforeState: beforeState!,
					afterState,
				});

				return {
					content: [{
						type: "text",
						text: `Set "${params.selector}" to ${state}\nAction: ${actionId}\n${verificationLine(verification)}${jsErrors}\n\nDiff:\n${formatDiffText(diff)}\n\nPage summary:\n${summary}`,
					}],
					details: { selector: params.selector, checked: params.checked, actualChecked, actionId, diff, ...settle, ...verification },
				};
			} catch (err: any) {
				if (actionId !== null) {
					finishTrackedAction(actionId, { status: "error", afterUrl: getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? undefined });
				}
				const errorShot = await captureErrorScreenshot(getActivePageOrNull());
				const content: any[] = [{ type: "text", text: `Set checked failed: ${err.message}` }];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return { content, details: { error: err.message }, isError: true };
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_set_viewport
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_set_viewport",
		label: "Browser Set Viewport",
		description:
			"Resize the browser viewport to test responsive layouts at different screen sizes. Use presets for common breakpoints or specify exact pixel dimensions. Essential for verifying mobile/tablet/desktop layouts.",
		parameters: Type.Object({
			preset: Type.Optional(
				StringEnum(["mobile", "tablet", "desktop", "wide"] as const)
				// mobile: 390×844 (iPhone 14), tablet: 768×1024 (iPad), desktop: 1280×800, wide: 1920×1080
			),
			width: Type.Optional(
				Type.Number({ description: "Custom viewport width in pixels (requires height too)" })
			),
			height: Type.Optional(
				Type.Number({ description: "Custom viewport height in pixels (requires width too)" })
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await ensureBrowser();

				let width: number;
				let height: number;
				let label: string;

				if (params.preset) {
					switch (params.preset) {
						case "mobile":
							width = 390;
							height = 844;
							label = "mobile (390×844)";
							break;
						case "tablet":
							width = 768;
							height = 1024;
							label = "tablet (768×1024)";
							break;
						case "desktop":
							width = 1280;
							height = 800;
							label = "desktop (1280×800)";
							break;
						case "wide":
							width = 1920;
							height = 1080;
							label = "wide (1920×1080)";
							break;
					}
				} else if (params.width !== undefined && params.height !== undefined) {
					width = params.width;
					height = params.height;
					label = `custom (${width}×${height})`;
				} else {
					return {
						content: [
							{
								type: "text",
								text: "Provide either a preset (mobile/tablet/desktop/wide) or both width and height.",
							},
						],
						details: {},
						isError: true,
					};
				}

				await p.setViewportSize({ width, height });

				return {
					content: [{ type: "text", text: `Viewport set to ${label}` }],
					details: { width, height, label },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Set viewport failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_get_page_source
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_get_page_source",
		label: "Browser Page Source",
		description:
			"Get the current HTML source of the page (or a specific element). Use when you need to inspect the actual DOM structure — verify semantic HTML, check that elements rendered correctly, debug why a selector isn't matching, or audit accessibility markup. Output is truncated for large pages.",
		parameters: Type.Object({
			selector: Type.Optional(
				Type.String({
					description:
						"CSS selector to scope the output to a specific element (e.g. 'main', 'form', '#app'). If omitted, returns the full page HTML.",
				})
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				await ensureBrowser();
				const target = getActiveTarget();

				let html: string;
				if (params.selector) {
					html = await target.locator(params.selector).first().evaluate((el: Element) => el.outerHTML);
				} else {
					html = await target.content();
				}

				const truncated = truncateText(html);
				const scope = params.selector ? `element "${params.selector}"` : "full page";

				return {
					content: [
						{
							type: "text",
							text: `HTML source of ${scope}:\n\n${truncated}`,
						},
					],
					details: { scope },
				};
			} catch (err: any) {
				return {
					content: [
						{
							type: "text",
							text: `Get page source failed: ${err.message}`,
						},
					],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_list_pages
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_list_pages",
		label: "Browser List Pages",
		description:
			"List all open browser pages/tabs with their IDs, titles, URLs, and active status. Use to see what pages are available before switching.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				await ensureBrowser();
				// Update titles/URLs from live pages before listing
				for (const entry of pageRegistry.pages) {
					try {
						entry.title = await entry.page.title();
						entry.url = entry.page.url();
					} catch {
						// Page may have been closed
					}
				}
				const pages = registryListPages(pageRegistry);
				if (pages.length === 0) {
					return {
						content: [{ type: "text", text: "No pages open." }],
						details: { pages: [], count: 0 },
					};
				}
				const lines = pages.map((p: any) => {
					const active = p.isActive ? " ← active" : "";
					const opener = p.opener !== null ? ` (opener: ${p.opener})` : "";
					return `  [${p.id}] ${p.title || "(untitled)"} — ${p.url}${opener}${active}`;
				});
				return {
					content: [{ type: "text", text: `${pages.length} page(s):\n${lines.join("\n")}` }],
					details: { pages, count: pages.length },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `List pages failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_switch_page
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_switch_page",
		label: "Browser Switch Page",
		description:
			"Switch the active browser page/tab by page ID. Use browser_list_pages to see available IDs. Clears any active frame selection.",
		parameters: Type.Object({
			id: Type.Number({ description: "Page ID to switch to (from browser_list_pages)" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				await ensureBrowser();
				registrySetActive(pageRegistry, params.id);
				activeFrame = null;
				const entry = registryGetActive(pageRegistry);
				// Bring the page to front
				await entry.page.bringToFront();
				const title = await entry.page.title().catch(() => "");
				const url = entry.page.url();
				entry.title = title;
				entry.url = url;
				return {
					content: [{ type: "text", text: `Switched to page ${params.id}: ${title || "(untitled)"} — ${url}` }],
					details: { id: params.id, title, url },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Switch page failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_close_page
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_close_page",
		label: "Browser Close Page",
		description:
			"Close a specific browser page/tab by ID. Cannot close the last remaining page. The page's close event triggers automatic registry cleanup and active-page fallback.",
		parameters: Type.Object({
			id: Type.Number({ description: "Page ID to close (from browser_list_pages)" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				await ensureBrowser();
				if (pageRegistry.pages.length <= 1) {
					return {
						content: [{ type: "text", text: `Cannot close the last remaining page. Use browser_close to close the entire browser.` }],
						details: { error: "last_page", pageCount: pageRegistry.pages.length },
						isError: true,
					};
				}
				const entry = pageRegistry.pages.find((e: any) => e.id === params.id);
				if (!entry) {
					const available = pageRegistry.pages.map((e: any) => e.id);
					return {
						content: [{ type: "text", text: `Page ${params.id} not found. Available page IDs: [${available.join(", ")}].` }],
						details: { error: "not_found", available },
						isError: true,
					};
				}
				// Close the Playwright page — this fires the "close" event handler
				// which calls registryRemovePage and handles active-page fallback
				await entry.page.close();
				// Clear active frame if it belonged to the closed page
				activeFrame = null;
				// Refresh the page list
				for (const remaining of pageRegistry.pages) {
					try {
						remaining.title = await remaining.page.title();
						remaining.url = remaining.page.url();
					} catch {}
				}
				const pages = registryListPages(pageRegistry);
				const lines = pages.map((p: any) => {
					const active = p.isActive ? " ← active" : "";
					return `  [${p.id}] ${p.title || "(untitled)"} — ${p.url}${active}`;
				});
				return {
					content: [{ type: "text", text: `Closed page ${params.id}. ${pages.length} page(s) remaining:\n${lines.join("\n")}` }],
					details: { closedId: params.id, pages, count: pages.length },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Close page failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_list_frames
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_list_frames",
		label: "Browser List Frames",
		description:
			"List all frames in the active page, including the main frame and any iframes. Shows frame name, URL, and parent frame name. Use before browser_select_frame to identify available frames.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				await ensureBrowser();
				const p = getActivePage();
				const frames = p.frames();
				const mainFrame = p.mainFrame();
				const frameList = frames.map((f, index) => {
					const isMain = f === mainFrame;
					const parentName = f.parentFrame()?.name() || (f.parentFrame() === mainFrame ? "main" : "");
					return {
						index,
						name: f.name() || (isMain ? "main" : `(unnamed-${index})`),
						url: f.url(),
						isMain,
						parentName: isMain ? null : (parentName || "main"),
						isActive: f === activeFrame,
					};
				});
				const lines = frameList.map((f) => {
					const main = f.isMain ? " [main]" : "";
					const active = f.isActive ? " ← selected" : "";
					const parent = f.parentName ? ` (parent: ${f.parentName})` : "";
					return `  [${f.index}] "${f.name}" — ${f.url}${main}${parent}${active}`;
				});
				const activeInfo = activeFrame ? `Active frame: "${activeFrame.name() || "(unnamed)"}"` : "No frame selected (operating on main page)";
				return {
					content: [{ type: "text", text: `${frameList.length} frame(s) in active page:\n${lines.join("\n")}\n\n${activeInfo}` }],
					details: { frames: frameList, count: frameList.length, activeFrame: activeFrame?.name() ?? null },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `List frames failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_select_frame
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_select_frame",
		label: "Browser Select Frame",
		description:
			"Select a frame within the active page to operate on. Find frames by name, URL pattern, or index. Pass null or \"main\" to reset back to the main page frame. Once a frame is selected, tools like browser_evaluate, browser_find, and browser_click will operate within that frame (after T03 migration).",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Frame name to select. Use 'main' or 'null' to reset to main frame." })),
			urlPattern: Type.Optional(Type.String({ description: "URL substring to match against frame URLs." })),
			index: Type.Optional(Type.Number({ description: "Frame index from browser_list_frames." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				await ensureBrowser();
				const p = getActivePage();
				const frames = p.frames();

				// Reset to main frame
				if (params.name === "main" || params.name === "null" || params.name === null) {
					activeFrame = null;
					return {
						content: [{ type: "text", text: "Reset to main page frame. Tools will operate on the main page." }],
						details: { activeFrame: null },
					};
				}

				// Find frame by name
				if (params.name) {
					const frame = frames.find((f) => f.name() === params.name);
					if (!frame) {
						const available = frames.map((f, i) => `[${i}] "${f.name() || "(unnamed)"}" — ${f.url()}`);
						return {
							content: [{ type: "text", text: `Frame with name "${params.name}" not found.\nAvailable frames:\n  ${available.join("\n  ")}` }],
							details: { error: "frame_not_found", available },
							isError: true,
						};
					}
					activeFrame = frame;
					return {
						content: [{ type: "text", text: `Selected frame "${frame.name()}" — ${frame.url()}` }],
						details: { name: frame.name(), url: frame.url() },
					};
				}

				// Find frame by URL pattern
				if (params.urlPattern) {
					const frame = frames.find((f) => f.url().includes(params.urlPattern!));
					if (!frame) {
						const available = frames.map((f, i) => `[${i}] "${f.name() || "(unnamed)"}" — ${f.url()}`);
						return {
							content: [{ type: "text", text: `No frame URL matches "${params.urlPattern}".\nAvailable frames:\n  ${available.join("\n  ")}` }],
							details: { error: "frame_not_found", available },
							isError: true,
						};
					}
					activeFrame = frame;
					return {
						content: [{ type: "text", text: `Selected frame "${frame.name() || "(unnamed)"}" — ${frame.url()}` }],
						details: { name: frame.name(), url: frame.url() },
					};
				}

				// Find frame by index
				if (params.index !== undefined) {
					if (params.index < 0 || params.index >= frames.length) {
						return {
							content: [{ type: "text", text: `Frame index ${params.index} out of range. ${frames.length} frame(s) available (0-${frames.length - 1}).` }],
							details: { error: "index_out_of_range", count: frames.length },
							isError: true,
						};
					}
					const frame = frames[params.index];
					activeFrame = frame;
					return {
						content: [{ type: "text", text: `Selected frame [${params.index}] "${frame.name() || "(unnamed)"}" — ${frame.url()}` }],
						details: { index: params.index, name: frame.name(), url: frame.url() },
					};
				}

				// No selection criteria provided
				return {
					content: [{ type: "text", text: "Provide name, urlPattern, or index to select a frame. Use name='main' to reset to main frame." }],
					details: { error: "no_criteria" },
					isError: true,
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Select frame failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});
}
