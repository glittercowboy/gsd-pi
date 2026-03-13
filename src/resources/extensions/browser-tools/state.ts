/**
 * browser-tools — shared mutable state
 *
 * All mutable state lives behind accessor functions (get/set) so that
 * jiti-transpiled modules see updates reliably.  ES module live bindings
 * (`export let`) are not guaranteed to work under jiti's CJS shim layer.
 *
 * State is initialized to sensible defaults and can be bulk-reset via
 * `resetAllState()` (called by closeBrowser).
 */

import type { Browser, BrowserContext, Frame, Page } from "playwright";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import path from "node:path";
import {
	createActionTimeline,
	createBoundedLogPusher,
	createPageRegistry,
} from "./core.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ARTIFACT_ROOT = path.resolve(process.cwd(), ".artifacts", "browser");
export const HAR_FILENAME = "session.har";

// ---------------------------------------------------------------------------
// Type / interface definitions
// ---------------------------------------------------------------------------

export interface ConsoleEntry {
	type: string;
	text: string;
	timestamp: number;
	url: string;
	pageId: number;
}

export interface NetworkEntry {
	method: string;
	url: string;
	status: number | null;
	resourceType: string;
	timestamp: number;
	failed: boolean;
	failureText?: string;
	responseBody?: string;
	pageId: number;
}

export interface DialogEntry {
	type: string;
	message: string;
	timestamp: number;
	url: string;
	defaultValue?: string;
	accepted: boolean;
	pageId: number;
}

export interface RefNode {
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

export interface RefMetadata {
	url: string;
	timestamp: number;
	selectorScope?: string;
	interactiveOnly: boolean;
	limit: number;
	version: number;
	frameContext?: string;
	mode?: string;
}

export interface CompactSelectorState {
	exists: boolean;
	visible: boolean;
	value: string;
	checked: boolean | null;
	text: string;
}

export interface CompactPageState {
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

export interface TraceSessionState {
	startedAt: number;
	name: string;
	title?: string;
	path?: string;
}

export interface HarState {
	enabled: boolean;
	configuredAtContextCreation: boolean;
	path: string | null;
	exportCount: number;
	lastExportedPath: string | null;
	lastExportedAt: number | null;
}

export interface ClickTargetStateSnapshot {
	exists: boolean;
	ariaExpanded: string | null;
	ariaPressed: string | null;
	ariaSelected: string | null;
	open: boolean | null;
}

export interface VerificationCheck {
	name: string;
	passed: boolean;
	value?: unknown;
	expected?: unknown;
}

export interface VerificationResult {
	verified: boolean;
	checks: VerificationCheck[];
	verificationSummary: string;
	retryHint?: string;
}

export interface AdaptiveSettleOptions {
	timeoutMs?: number;
	pollMs?: number;
	quietWindowMs?: number;
	checkFocusStability?: boolean;
}

export interface AdaptiveSettleDetails {
	settleMode: "adaptive";
	settleMs: number;
	settleReason: "dom_quiet" | "url_changed_then_quiet" | "timeout_fallback" | "zero_mutation_shortcut";
	settlePolls: number;
}

export interface ParsedRefSpec {
	key: string;
	version: number | null;
	display: string;
}

export interface BrowserAssertionCheckInput {
	kind: string;
	selector?: string;
	text?: string;
	value?: string;
	checked?: boolean;
	sinceActionId?: number;
}

// ---------------------------------------------------------------------------
// Mutable state variables — accessed only via get/set functions
// ---------------------------------------------------------------------------

// 1. browser
let _browser: Browser | null = null;
export function getBrowser(): Browser | null { return _browser; }
export function setBrowser(b: Browser | null): void { _browser = b; }

// 2. context
let _context: BrowserContext | null = null;
export function getContext(): BrowserContext | null { return _context; }
export function setContext(c: BrowserContext | null): void { _context = c; }

// 3. pageRegistry (object with internal state — export the instance directly + getter)
export const pageRegistry = createPageRegistry();
export function getPageRegistry() { return pageRegistry; }

// 4. activeFrame
let _activeFrame: Frame | null = null;
export function getActiveFrame(): Frame | null { return _activeFrame; }
export function setActiveFrame(f: Frame | null): void { _activeFrame = f; }

// 5. logPusher (bounded log push function — stateless utility, export directly)
export const logPusher = createBoundedLogPusher(1000);

// 6. consoleLogs
let _consoleLogs: ConsoleEntry[] = [];
export function getConsoleLogs(): ConsoleEntry[] { return _consoleLogs; }
export function setConsoleLogs(logs: ConsoleEntry[]): void { _consoleLogs = logs; }

// 7. networkLogs
let _networkLogs: NetworkEntry[] = [];
export function getNetworkLogs(): NetworkEntry[] { return _networkLogs; }
export function setNetworkLogs(logs: NetworkEntry[]): void { _networkLogs = logs; }

// 8. dialogLogs
let _dialogLogs: DialogEntry[] = [];
export function getDialogLogs(): DialogEntry[] { return _dialogLogs; }
export function setDialogLogs(logs: DialogEntry[]): void { _dialogLogs = logs; }

// 9. pendingCriticalRequestsByPage (WeakMap — can't be reassigned, just cleared by replacing)
let _pendingCriticalRequestsByPage = new WeakMap<Page, number>();
export function getPendingCriticalRequestsByPage(): WeakMap<Page, number> { return _pendingCriticalRequestsByPage; }
export function resetPendingCriticalRequestsByPage(): void { _pendingCriticalRequestsByPage = new WeakMap(); }

// 10. currentRefMap
let _currentRefMap: Record<string, RefNode> = {};
export function getCurrentRefMap(): Record<string, RefNode> { return _currentRefMap; }
export function setCurrentRefMap(m: Record<string, RefNode>): void { _currentRefMap = m; }

// 11. refVersion
let _refVersion = 0;
export function getRefVersion(): number { return _refVersion; }
export function setRefVersion(v: number): void { _refVersion = v; }

// 12. refMetadata
let _refMetadata: RefMetadata | null = null;
export function getRefMetadata(): RefMetadata | null { return _refMetadata; }
export function setRefMetadata(m: RefMetadata | null): void { _refMetadata = m; }

// 13. actionTimeline (object with internal state)
export const actionTimeline = createActionTimeline(60);
export function getActionTimeline() { return actionTimeline; }

// 14. lastActionBeforeState
let _lastActionBeforeState: CompactPageState | null = null;
export function getLastActionBeforeState(): CompactPageState | null { return _lastActionBeforeState; }
export function setLastActionBeforeState(s: CompactPageState | null): void { _lastActionBeforeState = s; }

// 15. lastActionAfterState
let _lastActionAfterState: CompactPageState | null = null;
export function getLastActionAfterState(): CompactPageState | null { return _lastActionAfterState; }
export function setLastActionAfterState(s: CompactPageState | null): void { _lastActionAfterState = s; }

// 16. sessionStartedAt
let _sessionStartedAt: number | null = null;
export function getSessionStartedAt(): number | null { return _sessionStartedAt; }
export function setSessionStartedAt(t: number | null): void { _sessionStartedAt = t; }

// 17. sessionArtifactDir
let _sessionArtifactDir: string | null = null;
export function getSessionArtifactDir(): string | null { return _sessionArtifactDir; }
export function setSessionArtifactDir(d: string | null): void { _sessionArtifactDir = d; }

// 18a. activeTraceSession
let _activeTraceSession: TraceSessionState | null = null;
export function getActiveTraceSession(): TraceSessionState | null { return _activeTraceSession; }
export function setActiveTraceSession(t: TraceSessionState | null): void { _activeTraceSession = t; }

// 18b. harState
const DEFAULT_HAR_STATE: HarState = {
	enabled: false,
	configuredAtContextCreation: false,
	path: null,
	exportCount: 0,
	lastExportedPath: null,
	lastExportedAt: null,
};
let _harState: HarState = { ...DEFAULT_HAR_STATE };
export function getHarState(): HarState { return _harState; }
export function setHarState(h: HarState): void { _harState = h; }

// ---------------------------------------------------------------------------
// resetAllState — mirrors closeBrowser()'s reset logic
// ---------------------------------------------------------------------------

export function resetAllState(): void {
	_browser = null;
	_context = null;
	pageRegistry.pages = [];
	pageRegistry.activePageId = null;
	pageRegistry.nextId = 1;
	_activeFrame = null;
	_consoleLogs = [];
	_networkLogs = [];
	_dialogLogs = [];
	_pendingCriticalRequestsByPage = new WeakMap();
	_currentRefMap = {};
	_refVersion = 0;
	_refMetadata = null;
	_lastActionBeforeState = null;
	_lastActionAfterState = null;
	actionTimeline.entries = [];
	actionTimeline.nextId = 1;
	_sessionStartedAt = null;
	_sessionArtifactDir = null;
	_activeTraceSession = null;
	_harState = { ...DEFAULT_HAR_STATE };
}

// ---------------------------------------------------------------------------
// ToolDeps — interface that tool registration functions consume
// ---------------------------------------------------------------------------

/**
 * Bundles the infrastructure functions that tool registration files need.
 * Built once in the index.ts orchestrator and passed to each register* function.
 */
export interface ToolDeps {
	// Lifecycle
	ensureBrowser: () => Promise<{ browser: Browser; context: BrowserContext; page: Page }>;
	closeBrowser: () => Promise<void>;
	getActivePage: () => Page;
	getActiveTarget: () => Page | Frame;
	getActivePageOrNull: () => Page | null;

	// Page event wiring
	attachPageListeners: (p: Page, pageId: number) => void;

	// Capture & summary
	captureCompactPageState: (
		p: Page,
		options?: { selectors?: string[]; includeBodyText?: boolean; target?: Page | Frame }
	) => Promise<CompactPageState>;
	postActionSummary: (p: Page, target?: Page | Frame) => Promise<string>;
	formatCompactStateSummary: (state: CompactPageState) => string;
	constrainScreenshot: (page: Page, buffer: Buffer, mimeType: string, quality: number) => Promise<Buffer>;
	captureErrorScreenshot: (p: Page | null) => Promise<{ data: string; mimeType: string } | null>;
	getRecentErrors: (pageUrl: string) => string;

	// Settle
	settleAfterActionAdaptive: (p: Page, opts?: AdaptiveSettleOptions) => Promise<AdaptiveSettleDetails>;
	ensureMutationCounter: (p: Page) => Promise<void>;

	// Refs
	buildRefSnapshot: (
		target: Page | Frame,
		options: { selector?: string; interactiveOnly: boolean; limit: number; mode?: string }
	) => Promise<Array<Omit<RefNode, "ref">>>;
	resolveRefTarget: (
		target: Page | Frame,
		node: RefNode
	) => Promise<{ ok: true; selector: string } | { ok: false; reason: string }>;
	parseRef: (input: string) => ParsedRefSpec;
	formatVersionedRef: (version: number, key: string) => string;
	staleRefGuidance: (refDisplay: string, reason: string) => string;

	// Action tracking
	beginTrackedAction: (tool: string, params: unknown, beforeUrl: string) => ReturnType<typeof import("./core.js").beginAction>;
	finishTrackedAction: (
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
	) => ReturnType<typeof import("./core.js").finishAction>;

	// Utilities (forwarded from utils.ts)
	truncateText: (text: string) => string;
	verificationFromChecks: (checks: VerificationCheck[], retryHint?: string) => VerificationResult;
	verificationLine: (verification: VerificationResult) => string;
	collectAssertionState: (
		p: Page,
		checks: BrowserAssertionCheckInput[],
		target?: Page | Frame
	) => Promise<Record<string, unknown>>;
	formatAssertionText: (result: ReturnType<typeof import("./core.js").evaluateAssertionChecks>) => string;
	formatDiffText: (diff: ReturnType<typeof import("./core.js").diffCompactStates>) => string;
	getUrlHash: (url: string) => string;
	captureClickTargetState: (target: Page | Frame, selector: string) => Promise<ClickTargetStateSnapshot>;
	readInputLikeValue: (target: Page | Frame, selector?: string) => Promise<string | null>;
	firstErrorLine: (err: unknown) => string;
	captureAccessibilityMarkdown: (selector?: string) => Promise<{ snapshot: string; scope: string; source: string }>;
	resolveAccessibilityScope: (selector?: string) => Promise<{ selector?: string; scope: string; source: string }>;
	getLivePagesSnapshot: () => Promise<ReturnType<typeof import("./core.js").registryListPages>>;
	getSinceTimestamp: (sinceActionId?: number) => number;
	getConsoleEntriesSince: (sinceActionId?: number) => ConsoleEntry[];
	getNetworkEntriesSince: (sinceActionId?: number) => NetworkEntry[];
	writeArtifactFile: (filePath: string, content: string | Uint8Array) => Promise<{ path: string; bytes: number }>;
	copyArtifactFile: (sourcePath: string, destinationPath: string) => Promise<{ path: string; bytes: number }>;
	ensureSessionArtifactDir: () => Promise<string>;
	buildSessionArtifactPath: (filename: string) => string;
	getSessionArtifactMetadata: () => Record<string, unknown>;
	sanitizeArtifactName: (value: string, fallback: string) => string;
	formatArtifactTimestamp: (timestamp: number) => string;
}
