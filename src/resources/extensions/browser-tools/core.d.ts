/**
 * Type declarations for core.js — runtime-neutral helper logic for browser-tools.
 */

export interface ActionTimeline {
	limit: number;
	nextId: number;
	entries: ActionEntry[];
}

export interface ActionEntry {
	id: number;
	tool: string;
	paramsSummary: string;
	startedAt: number;
	finishedAt: number | null;
	status: string;
	beforeUrl: string;
	afterUrl: string;
	verificationSummary?: string;
	warningSummary?: string;
	diffSummary?: string;
	changed?: boolean;
	error?: string;
}

export interface ActionPartial {
	tool: string;
	paramsSummary?: string;
	startedAt?: number;
	beforeUrl?: string;
	afterUrl?: string;
	verificationSummary?: string;
	warningSummary?: string;
	diffSummary?: string;
	changed?: boolean;
	error?: string;
}

export interface ActionUpdates {
	finishedAt?: number;
	status?: string;
	afterUrl?: string;
	verificationSummary?: string;
	warningSummary?: string;
	diffSummary?: string;
	changed?: boolean;
	error?: string;
}

export interface DiffResult {
	changed: boolean;
	changes: Array<{ type: string; before: unknown; after: unknown }>;
	summary: string;
}

export interface Threshold {
	op: string;
	n: number;
}

export interface PageRegistry {
	pages: PageEntry[];
	activePageId: number | null;
	nextId: number;
}

export interface PageEntry {
	id: number;
	page: any;
	title: string;
	url: string;
	opener: number | null;
}

export interface PageListEntry {
	id: number;
	title: string;
	url: string;
	opener: number | null;
	isActive: boolean;
}

export interface SnapshotModeConfig {
	tags: string[];
	roles: string[];
	selectors: string[];
	ariaAttributes: string[];
	useInteractiveFilter: boolean;
	visibleOnly?: boolean;
	containerExpand?: boolean;
}

export interface AssertionCheckResult {
	name: string;
	passed: boolean;
	actual: unknown;
	expected: unknown;
	selector?: string;
	text?: string;
}

export interface AssertionEvaluation {
	verified: boolean;
	checks: AssertionCheckResult[];
	summary: string;
	agentHint: string;
}

export interface WaitValidationError {
	error: string;
}

export interface BatchStepResult {
	ok: boolean;
	stopReason: string | null;
	failedStepIndex: number | null;
	stepResults: unknown[];
	summary: string;
}

export interface FormattedTimeline {
	entries: Array<{
		id: number | null;
		tool: string;
		status: string;
		durationMs: number | null;
		beforeUrl: string;
		afterUrl: string;
		line: string;
	}>;
	retained: number;
	totalRecorded: number;
	bounded: boolean;
	summary: string;
}

export interface FailureHypothesis {
	hasFailures: boolean;
	categories: string[];
	summary: string;
	signals: Array<{ category: string; source: string; detail: string }>;
}

export interface SessionSummary {
	counts: {
		pages: number;
		actions: { total: number; retained: number; success: number; error: number; running: number };
		waits: { total: number; success: number; error: number; running: number };
		assertions: { total: number; passed: number; failed: number; running: number };
		consoleErrors: number;
		failedRequests: number;
		dialogs: number;
	};
	activePage: { id: number | null; title: string; url: string } | null;
	caveats: string[];
	failureHypothesis: FailureHypothesis;
	summary: string;
}

export function createActionTimeline(limit?: number): ActionTimeline;
export function beginAction(timeline: ActionTimeline, partial: ActionPartial): ActionEntry;
export function finishAction(timeline: ActionTimeline, actionId: number, updates?: ActionUpdates): ActionEntry | null;
export function findAction(timeline: ActionTimeline, actionId: number): ActionEntry | null;
export function toActionParamsSummary(params: unknown): string;
export function diffCompactStates(before: unknown, after: unknown): DiffResult;
export function includesNeedle(haystack: string, needle: string): boolean;
export function parseThreshold(value: string | null | undefined): Threshold | null;
export function meetsThreshold(count: number, threshold: Threshold): boolean;
export function getEntriesSince(
	entries: Array<{ timestamp?: number }>,
	sinceActionId: number | undefined,
	timeline: ActionTimeline,
): unknown[];
export function evaluateAssertionChecks(args: { checks: unknown[]; state: unknown }): AssertionEvaluation;
export function validateWaitParams(params: { condition: string; value?: string; threshold?: string }): WaitValidationError | null;
export function createRegionStableScript(selector: string): string;
export function createPageRegistry(): PageRegistry;
export function registryAddPage(
	registry: PageRegistry,
	info: { page: unknown; title?: string; url?: string; opener?: number | null },
): PageEntry;
export function registryRemovePage(registry: PageRegistry, pageId: number): { removed: PageEntry; newActiveId: number | null };
export function registrySetActive(registry: PageRegistry, pageId: number): void;
export function registryGetActive(registry: PageRegistry): PageEntry;
export function registryGetPage(registry: PageRegistry, pageId: number): PageEntry | null;
export function registryListPages(registry: PageRegistry): PageListEntry[];
export function createBoundedLogPusher(maxSize: number): (array: unknown[], entry: unknown) => void;
export function runBatchSteps(args: {
	steps: unknown[];
	executeStep: (step: unknown, index: number) => Promise<{ ok: boolean; [key: string]: unknown }>;
	stopOnFailure?: boolean;
}): Promise<BatchStepResult>;

export declare const SNAPSHOT_MODES: Record<string, SnapshotModeConfig>;
export function getSnapshotModeConfig(mode: string): SnapshotModeConfig | null;
export function computeContentHash(text: string): string;
export function computeStructuralSignature(tag: string, role: string, childTags: string[]): string;
export function matchFingerprint(
	stored: { contentHash?: string; structuralSignature?: string },
	candidate: { contentHash?: string; structuralSignature?: string },
): boolean;
export function formatTimelineEntries(entries?: unknown[], options?: Record<string, unknown>): FormattedTimeline;
export function buildFailureHypothesis(session?: Record<string, unknown>): FailureHypothesis;
export function summarizeBrowserSession(session?: Record<string, unknown>): SessionSummary;
