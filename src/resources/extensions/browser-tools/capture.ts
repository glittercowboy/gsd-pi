/**
 * browser-tools — page state capture
 *
 * Functions for capturing compact page state, screenshots, and summaries.
 * Used by tool implementations for post-action feedback.
 */

import type { Frame, Page } from "playwright";

// sharp is an optional native dependency. Load it lazily so that the extension
// can still be loaded on platforms where sharp is unavailable (e.g. bunx on
// Raspberry Pi). constrainScreenshot falls back to returning the raw buffer
// when sharp is not installed, which means screenshots won't be resized but
// the tool remains functional.
let _sharp: typeof import("sharp") | null | undefined;
async function getSharp(): Promise<typeof import("sharp") | null> {
	if (_sharp !== undefined) return _sharp;
	try {
		_sharp = (await import("sharp")).default;
	} catch {
		_sharp = null;
	}
	return _sharp;
}
import type { CompactPageState, CompactSelectorState } from "./state.js";
import { formatCompactStateSummary } from "./utils.js";

// Anthropic vision: 1568px is the recommended optimal width. Height is capped
// generously at 8000px so tall full-page screenshots remain readable rather
// than being squished into a square constraint.
//
// Override via environment variables:
//   SCREENSHOT_MAX_WIDTH=0   → uncap width (use raw resolution)
//   SCREENSHOT_MAX_HEIGHT=0  → uncap height
//   SCREENSHOT_FORMAT=png    → lossless PNG for all viewport/fullpage screenshots
//   SCREENSHOT_QUALITY=100   → max JPEG quality (1-100, default 80)
const MAX_SCREENSHOT_WIDTH = parseScreenshotDimension(process.env.SCREENSHOT_MAX_WIDTH, 1568);
const MAX_SCREENSHOT_HEIGHT = parseScreenshotDimension(process.env.SCREENSHOT_MAX_HEIGHT, 8000);

/** Parse a dimension env var: positive int = that value, 0 = Infinity (uncapped), absent/invalid = default. */
function parseScreenshotDimension(value: string | undefined, fallback: number): number {
	if (value === undefined || value === "") return fallback;
	const n = parseInt(value, 10);
	if (isNaN(n) || n < 0) return fallback;
	if (n === 0) return Infinity;
	return n;
}

/** Return the user-configured screenshot format override, or null for default behavior. */
export function getScreenshotFormatOverride(): "png" | "jpeg" | null {
	const fmt = process.env.SCREENSHOT_FORMAT?.toLowerCase();
	if (fmt === "png") return "png";
	if (fmt === "jpeg" || fmt === "jpg") return "jpeg";
	return null;
}

/** Return the user-configured default JPEG quality, or the provided fallback. */
export function getScreenshotQualityDefault(fallback: number): number {
	const q = process.env.SCREENSHOT_QUALITY;
	if (q === undefined || q === "") return fallback;
	const n = parseInt(q, 10);
	if (isNaN(n) || n < 1 || n > 100) return fallback;
	return n;
}

// ---------------------------------------------------------------------------
// Compact page state capture
// ---------------------------------------------------------------------------

export async function captureCompactPageState(
	p: Page,
	options: { selectors?: string[]; includeBodyText?: boolean; target?: Page | Frame } = {},
): Promise<CompactPageState> {
	const selectors = Array.from(new Set((options.selectors ?? []).filter(Boolean)));
	const target = options.target ?? p;
	const domState = await target.evaluate(({ selectors, includeBodyText }) => {
		const selectorStates: Record<string, {
			exists: boolean;
			visible: boolean;
			value: string;
			checked: boolean | null;
			text: string;
		}> = {};
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

// ---------------------------------------------------------------------------
// Post-action summary
// ---------------------------------------------------------------------------

/** Lightweight page summary after an action. Returns ~50-150 tokens instead of full tree. */
export async function postActionSummary(p: Page, target?: Page | Frame): Promise<string> {
	try {
		const state = await captureCompactPageState(p, { target });
		return formatCompactStateSummary(state);
	} catch {
		return "[summary unavailable]";
	}
}

// ---------------------------------------------------------------------------
// Screenshot helpers
// ---------------------------------------------------------------------------

/**
 * Constrain screenshot dimensions for the Anthropic vision API.
 * Width is capped at 1568px (optimal) and height at 8000px, each
 * independently, using `fit: "inside"` so aspect ratio is preserved.
 * Small images are never upscaled.
 *
 * `page` parameter is retained for ToolDeps signature stability (D008)
 * but is no longer used — all processing is server-side via sharp.
 */
export async function constrainScreenshot(
	_page: Page,
	buffer: Buffer,
	mimeType: string,
	quality: number,
): Promise<Buffer> {
	const sharp = await getSharp();
	if (!sharp) return buffer;

	const meta = await sharp(buffer).metadata();
	const width = meta.width;
	const height = meta.height;

	if (width === undefined || height === undefined) return buffer;
	if (width <= MAX_SCREENSHOT_WIDTH && height <= MAX_SCREENSHOT_HEIGHT) return buffer;

	const resizer = sharp(buffer).resize(MAX_SCREENSHOT_WIDTH, MAX_SCREENSHOT_HEIGHT, {
		fit: "inside",
		withoutEnlargement: true,
	});

	if (mimeType === "image/png") {
		return Buffer.from(await resizer.png().toBuffer());
	}
	return Buffer.from(await resizer.jpeg({ quality }).toBuffer());
}

/** Capture a JPEG screenshot for error debugging. Returns base64 or null. */
export async function captureErrorScreenshot(p: Page | null): Promise<{ data: string; mimeType: string } | null> {
	if (!p) return null;
	try {
		let buf = await p.screenshot({ type: "jpeg", quality: 60, scale: "css" });
		buf = await constrainScreenshot(p, buf, "image/jpeg", 60);
		return { data: buf.toString("base64"), mimeType: "image/jpeg" };
	} catch {
		return null;
	}
}
