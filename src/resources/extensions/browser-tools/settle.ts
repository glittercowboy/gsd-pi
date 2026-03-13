/**
 * browser-tools — DOM settle logic
 *
 * Adaptive settling after browser actions. Polls for DOM quiet (mutation
 * counter stable, no pending critical requests, optional focus stability)
 * before returning control.
 */

import type { Frame, Page } from "playwright";
import type { AdaptiveSettleDetails, AdaptiveSettleOptions } from "./state.js";
import { getPendingCriticalRequests } from "./utils.js";

// ---------------------------------------------------------------------------
// Mutation counter (installed in-page via evaluate)
// ---------------------------------------------------------------------------

export async function ensureMutationCounter(p: Page): Promise<void> {
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

export async function readMutationCounter(p: Page): Promise<number> {
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

// ---------------------------------------------------------------------------
// Focus descriptor (for focus-stability checks)
// ---------------------------------------------------------------------------

export async function readFocusedDescriptor(target: Page | Frame): Promise<string> {
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

// ---------------------------------------------------------------------------
// Combined settle-state reader (mutation counter + focus in one evaluate)
// ---------------------------------------------------------------------------

/**
 * Reads the mutation counter and optionally the focused element descriptor
 * in a single `evaluate()` call, saving one round-trip per poll iteration.
 */
async function readSettleState(
	target: Page | Frame,
	checkFocus: boolean,
): Promise<{ mutationCount: number; focusDescriptor: string }> {
	try {
		return await target.evaluate((wantFocus: boolean) => {
			const w = window as unknown as Record<string, unknown>;
			const mutationCount = typeof w.__piMutationCounter === "number" ? (w.__piMutationCounter as number) : 0;
			if (!wantFocus) return { mutationCount, focusDescriptor: "" };
			const el = document.activeElement as HTMLElement | null;
			if (!el || el === document.body || el === document.documentElement) {
				return { mutationCount, focusDescriptor: "" };
			}
			const id = el.id ? `#${el.id}` : "";
			const role = el.getAttribute("role") || "";
			const name = (el.getAttribute("aria-label") || el.getAttribute("name") || "").trim();
			return { mutationCount, focusDescriptor: `${el.tagName.toLowerCase()}${id}|${role}|${name}` };
		}, checkFocus);
	} catch {
		return { mutationCount: 0, focusDescriptor: "" };
	}
}

// ---------------------------------------------------------------------------
// Adaptive settle
// ---------------------------------------------------------------------------

/** Threshold (ms) after which zero mutations triggers a shortened quiet window. */
const ZERO_MUTATION_THRESHOLD_MS = 60;
/** Shortened quiet window when no mutations have been observed. */
const ZERO_MUTATION_QUIET_MS = 30;

export async function settleAfterActionAdaptive(
	p: Page,
	opts: AdaptiveSettleOptions = {},
): Promise<AdaptiveSettleDetails> {
	const timeoutMs = Math.max(150, opts.timeoutMs ?? 500);
	const pollMs = Math.min(100, Math.max(20, opts.pollMs ?? 40));
	const baseQuietWindowMs = Math.max(60, opts.quietWindowMs ?? 100);
	const checkFocus = opts.checkFocusStability ?? false;

	const startedAt = Date.now();
	let polls = 0;
	let sawUrlChange = false;
	let lastActivityAt = startedAt;
	let previousUrl = p.url();
	let totalMutationsSeen = 0;
	let activeQuietWindowMs = baseQuietWindowMs;

	// Install mutation counter + read initial state in one evaluate sequence.
	// ensureMutationCounter must run first (installs the observer), then we
	// read the baseline via the combined reader.
	await ensureMutationCounter(p).catch(() => {});
	const initial = await readSettleState(p, checkFocus);
	let previousMutationCount = initial.mutationCount;
	let previousFocus = initial.focusDescriptor;

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

		// Single combined evaluate for mutation count + focus descriptor.
		const state = await readSettleState(p, checkFocus);

		if (state.mutationCount > previousMutationCount) {
			totalMutationsSeen += state.mutationCount - previousMutationCount;
			previousMutationCount = state.mutationCount;
			lastActivityAt = now;
		}

		if (checkFocus && state.focusDescriptor !== previousFocus) {
			previousFocus = state.focusDescriptor;
			lastActivityAt = now;
		}

		const pendingCritical = getPendingCriticalRequests(p);
		if (pendingCritical > 0) {
			lastActivityAt = now;
			continue;
		}

		// Zero-mutation short-circuit: after ZERO_MUTATION_THRESHOLD_MS with
		// no mutations observed at all, reduce the quiet window to settle faster.
		if (
			totalMutationsSeen === 0 &&
			now - startedAt >= ZERO_MUTATION_THRESHOLD_MS &&
			activeQuietWindowMs !== ZERO_MUTATION_QUIET_MS
		) {
			activeQuietWindowMs = ZERO_MUTATION_QUIET_MS;
		}

		if (now - lastActivityAt >= activeQuietWindowMs) {
			const usedShortcut = activeQuietWindowMs === ZERO_MUTATION_QUIET_MS && totalMutationsSeen === 0;
			return {
				settleMode: "adaptive",
				settleMs: now - startedAt,
				settleReason: usedShortcut
					? "zero_mutation_shortcut"
					: sawUrlChange
						? "url_changed_then_quiet"
						: "dom_quiet",
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
