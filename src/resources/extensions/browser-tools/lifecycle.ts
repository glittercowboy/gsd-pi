/**
 * browser-tools — browser lifecycle management
 *
 * Manages the shared Browser + BrowserContext + Page singleton.
 * Injects EVALUATE_HELPERS_SOURCE via context.addInitScript() so that
 * page.evaluate() callbacks can reference window.__pi.* utilities.
 */

import type { Browser, BrowserContext, Frame, Page } from "playwright";
import path from "node:path";
import {
	registryAddPage,
	registryGetActive,
	registryRemovePage,
	registrySetActive,
} from "./core.js";
import {
	getBrowser,
	setBrowser,
	getContext,
	setContext,
	pageRegistry,
	getActiveFrame,
	setActiveFrame,
	logPusher,
	getConsoleLogs,
	getNetworkLogs,
	getDialogLogs,
	getPendingCriticalRequestsByPage,
	setHarState,
	resetAllState,
	HAR_FILENAME,
	type ConsoleEntry,
	type NetworkEntry,
} from "./state.js";
import {
	isCriticalResourceType,
	updatePendingCriticalRequests,
	ensureSessionStartedAt,
	ensureSessionArtifactDir,
} from "./utils.js";
import { EVALUATE_HELPERS_SOURCE } from "./evaluate-helpers.js";

// ---------------------------------------------------------------------------
// Page event wiring
// ---------------------------------------------------------------------------

/** Attach all event listeners to a page. Called on initial page and new tabs. */
export function attachPageListeners(p: Page, pageId: number): void {
	const pendingMap = getPendingCriticalRequestsByPage();
	pendingMap.set(p, 0);

	const consoleLogs = getConsoleLogs();
	const networkLogs = getNetworkLogs();
	const dialogLogs = getDialogLogs();

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
		if (getActiveFrame() === frame) setActiveFrame(null);
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

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------

export async function ensureBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
	const existingBrowser = getBrowser();
	const existingContext = getContext();
	if (existingBrowser && existingContext) {
		return { browser: existingBrowser, context: existingContext, page: getActivePage() };
	}

	const startedAt = ensureSessionStartedAt();
	const artifactDir = await ensureSessionArtifactDir();
	const sessionHarPath = path.join(artifactDir, HAR_FILENAME);
	setHarState({
		enabled: true,
		configuredAtContextCreation: true,
		path: sessionHarPath,
		exportCount: 0,
		lastExportedPath: null,
		lastExportedAt: null,
	});

	// Lazy import so playwright is only loaded when actually needed
	const { chromium } = await import("playwright");

	const launchOptions: Record<string, unknown> = { headless: false };
	const customPath = process.env.BROWSER_PATH;
	if (customPath) launchOptions.executablePath = customPath;
	const browser = await chromium.launch(launchOptions);
	const context = await browser.newContext({
		deviceScaleFactor: 2,
		viewport: { width: 1280, height: 800 },
		recordHar: {
			path: sessionHarPath,
			mode: "minimal",
			content: "omit",
		},
	});

	// Inject shared browser-side utilities into every new page/frame
	await context.addInitScript(EVALUATE_HELPERS_SOURCE);

	setBrowser(browser);
	setContext(context);

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
export function getActivePage(): Page {
	return registryGetActive(pageRegistry).page;
}

/** Get the active target — returns the selected frame if one is active, otherwise the active page. */
export function getActiveTarget(): Page | Frame {
	return getActiveFrame() ?? getActivePage();
}

/** Safe accessor for error handling — returns the active page or null if unavailable. */
export function getActivePageOrNull(): Page | null {
	try {
		return getActivePage();
	} catch {
		return null;
	}
}

export async function closeBrowser(): Promise<void> {
	const browser = getBrowser();
	if (browser) {
		await browser.close().catch(() => {});
	}
	resetAllState();
}
