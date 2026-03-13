import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@gsd/pi-ai";
import { diffCompactStates } from "../core.js";
import type { ToolDeps, CompactPageState } from "../state.js";
import {
	setLastActionBeforeState,
	setLastActionAfterState,
} from "../state.js";

// ---------------------------------------------------------------------------
// Intent definitions
// ---------------------------------------------------------------------------

const INTENTS = [
	"submit_form",
	"close_dialog",
	"primary_cta",
	"search_field",
	"next_step",
	"dismiss",
	"auth_action",
	"back_navigation",
] as const;

type Intent = (typeof INTENTS)[number];

// ---------------------------------------------------------------------------
// Scoring evaluate script — runs entirely in-browser via page.evaluate()
// ---------------------------------------------------------------------------

/**
 * Builds a self-contained IIFE string that scores candidate elements for a
 * given intent. Returns top 5 candidates sorted by score descending, each
 * with { score, selector, tag, role, name, text, reason }.
 *
 * Uses window.__pi utilities (injected via addInitScript) for element
 * metadata — no inline redeclarations.
 */
function buildIntentScoringScript(intent: string, scope?: string): string {
	const scopeSelector = JSON.stringify(scope ?? null);

	return `(() => {
	var pi = window.__pi;
	if (!pi) return { error: "window.__pi not available — browser helpers not injected" };

	var intentRaw = ${JSON.stringify(intent)};
	var normalized = intentRaw.toLowerCase().replace(/[\\s_\\-]+/g, "");
	var scopeSel = ${scopeSelector};
	var root = scopeSel ? document.querySelector(scopeSel) : document.body;
	if (!root) return { error: "Scope selector not found: " + scopeSel };

	// --- Shared helpers ---
	function textOf(el) {
		return (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 120).toLowerCase();
	}

	function clamp01(v) { return Math.max(0, Math.min(1, v)); }

	function makeCandidate(el, score, reason) {
		return {
			score: Math.round(clamp01(score) * 100) / 100,
			selector: pi.cssPath(el),
			tag: el.tagName.toLowerCase(),
			role: pi.inferRole(el) || "",
			name: pi.accessibleName(el) || "",
			text: textOf(el).slice(0, 80),
			reason: reason,
		};
	}

	function qsa(sel) { return Array.from(root.querySelectorAll(sel)); }

	function visibleEnabled(el) {
		return pi.isVisible(el) && pi.isEnabled(el);
	}

	function textMatches(el, patterns) {
		var t = textOf(el);
		var n = (pi.accessibleName(el) || "").toLowerCase();
		var combined = t + " " + n;
		for (var i = 0; i < patterns.length; i++) {
			if (combined.indexOf(patterns[i]) !== -1) return true;
		}
		return false;
	}

	function textMatchStrength(el, patterns) {
		var t = textOf(el);
		var n = (pi.accessibleName(el) || "").toLowerCase();
		var combined = t + " " + n;
		var count = 0;
		for (var i = 0; i < patterns.length; i++) {
			if (combined.indexOf(patterns[i]) !== -1) count++;
		}
		return Math.min(count / Math.max(patterns.length, 1), 1);
	}

	// --- Intent-specific scoring ---
	var candidates = [];

	if (normalized === "submitform") {
		var els = qsa('button[type="submit"], input[type="submit"], button:not([type]), button[type="button"]');
		for (var i = 0; i < els.length; i++) {
			var el = els[i];
			if (!visibleEnabled(el)) continue;
			var d1 = el.type === "submit" || el.getAttribute("type") === "submit" ? 0.35 : 0;
			var d2 = el.closest("form") ? 0.3 : 0;
			var d3 = textMatches(el, ["submit", "send", "save", "create", "add", "post", "confirm", "ok", "done", "register", "sign up", "log in"]) ? 0.2 : 0;
			var d4 = 0.15;
			var score = d1 + d2 + d3 + d4;
			var reasons = [];
			if (d1 > 0) reasons.push("submit-type");
			if (d2 > 0) reasons.push("inside-form");
			if (d3 > 0) reasons.push("text-suggests-submit");
			reasons.push("visible+enabled");
			candidates.push(makeCandidate(el, score, reasons.join(", ")));
		}
	}

	else if (normalized === "closedialog") {
		var containers = qsa('[role="dialog"], dialog, [aria-modal="true"], [role="alertdialog"]');
		for (var ci = 0; ci < containers.length; ci++) {
			var btns = containers[ci].querySelectorAll("button, a, [role='button']");
			for (var bi = 0; bi < btns.length; bi++) {
				var el = btns[bi];
				if (!visibleEnabled(el)) continue;
				var d1 = textMatches(el, ["close", "cancel", "dismiss", "×", "✕", "x", "got it", "ok", "done"]) ? 0.35 : 0;
				var ariaLbl = (el.getAttribute("aria-label") || "").toLowerCase();
				var d2 = (ariaLbl.indexOf("close") !== -1 || ariaLbl.indexOf("dismiss") !== -1) ? 0.25 : 0;
				var d3 = 0.2;
				var rect = el.getBoundingClientRect();
				var parentRect = containers[ci].getBoundingClientRect();
				var isTopRight = rect.top - parentRect.top < 60 && parentRect.right - rect.right < 60;
				var d4 = isTopRight ? 0.2 : 0;
				var score = d1 + d2 + d3 + d4;
				var reasons = [];
				if (d1 > 0) reasons.push("text-matches-close");
				if (d2 > 0) reasons.push("aria-label-close");
				reasons.push("inside-dialog");
				if (d4 > 0) reasons.push("top-right-position");
				candidates.push(makeCandidate(el, score, reasons.join(", ")));
			}
		}
	}

	else if (normalized === "primarycta") {
		var els = qsa("button, a, [role='button'], input[type='submit'], input[type='button']");
		for (var i = 0; i < els.length; i++) {
			var el = els[i];
			if (!visibleEnabled(el)) continue;
			var rect = el.getBoundingClientRect();
			var area = rect.width * rect.height;
			var d1 = clamp01(area / 12000);
			var role = pi.inferRole(el);
			var d2 = role === "button" ? 0.25 : (role === "link" ? 0.1 : 0.15);
			var isNegative = textMatches(el, ["cancel", "dismiss", "close", "skip", "no thanks", "no, thanks", "maybe later"]);
			var d3 = isNegative ? 0 : 0.2;
			var inMain = !!el.closest("main, [role='main'], article, section, .hero, .content");
			var d4 = inMain ? 0.15 : 0;
			var score = d1 + d2 + d3 + d4;
			var reasons = [];
			reasons.push("size:" + Math.round(area));
			if (d2 >= 0.25) reasons.push("button-role");
			if (d3 > 0) reasons.push("non-dismissive");
			if (d4 > 0) reasons.push("in-main-content");
			candidates.push(makeCandidate(el, score, reasons.join(", ")));
		}
	}

	else if (normalized === "searchfield") {
		var els = qsa("input, textarea, [role='searchbox'], [role='combobox'], [contenteditable='true']");
		for (var i = 0; i < els.length; i++) {
			var el = els[i];
			if (!pi.isVisible(el)) continue;
			var type = (el.getAttribute("type") || "text").toLowerCase();
			if (["hidden", "submit", "button", "reset", "image", "checkbox", "radio", "file"].indexOf(type) !== -1 && el.tagName.toLowerCase() === "input") continue;
			var d1 = type === "search" || pi.inferRole(el) === "searchbox" ? 0.4 : 0;
			var ph = (el.getAttribute("placeholder") || "").toLowerCase();
			var nm = (el.getAttribute("name") || "").toLowerCase();
			var ariaLbl = (el.getAttribute("aria-label") || "").toLowerCase();
			var combined = ph + " " + nm + " " + ariaLbl;
			var d2 = combined.indexOf("search") !== -1 || combined.indexOf("query") !== -1 || combined.indexOf("find") !== -1 ? 0.3 : 0;
			var d3 = pi.isEnabled(el) ? 0.15 : 0;
			var inHeader = !!el.closest("header, nav, [role='banner'], [role='navigation'], [role='search']");
			var d4 = inHeader ? 0.15 : 0;
			var score = d1 + d2 + d3 + d4;
			if (score < 0.1) continue;
			var reasons = [];
			if (d1 > 0) reasons.push("search-type/role");
			if (d2 > 0) reasons.push("name/placeholder-match");
			if (d3 > 0) reasons.push("enabled");
			if (d4 > 0) reasons.push("in-header/nav");
			candidates.push(makeCandidate(el, score, reasons.join(", ")));
		}
	}

	else if (normalized === "nextstep") {
		var els = qsa("button, a, [role='button'], input[type='submit'], input[type='button']");
		var patterns = ["next", "continue", "proceed", "forward", "go", "step"];
		for (var i = 0; i < els.length; i++) {
			var el = els[i];
			if (!visibleEnabled(el)) continue;
			var d1 = textMatchStrength(el, patterns) * 0.4;
			if (d1 === 0) continue;
			var role = pi.inferRole(el);
			var d2 = role === "button" ? 0.25 : 0.1;
			var d3 = 0.2;
			var isDisabled = !pi.isEnabled(el);
			var d4 = isDisabled ? 0 : 0.15;
			var score = d1 + d2 + d3 + d4;
			var reasons = [];
			reasons.push("text-match");
			if (d2 >= 0.25) reasons.push("button-role");
			reasons.push("visible");
			if (d4 > 0) reasons.push("enabled");
			candidates.push(makeCandidate(el, score, reasons.join(", ")));
		}
	}

	else if (normalized === "dismiss") {
		var els = qsa("button, a, [role='button'], [role='link']");
		var patterns = ["close", "cancel", "dismiss", "skip", "no thanks", "no, thanks", "maybe later", "not now", "×", "✕"];
		for (var i = 0; i < els.length; i++) {
			var el = els[i];
			if (!visibleEnabled(el)) continue;
			var d1 = textMatchStrength(el, patterns) * 0.35;
			if (d1 === 0) continue;
			var inOverlay = !!el.closest('[role="dialog"], dialog, [aria-modal="true"], [role="alertdialog"], .modal, .overlay, .popup, .popover, .toast, .banner');
			var d2 = inOverlay ? 0.3 : 0.05;
			var rect = el.getBoundingClientRect();
			var isEdge = rect.top < 80 || rect.right > window.innerWidth - 80;
			var d3 = isEdge ? 0.15 : 0;
			var d4 = 0.15;
			var score = d1 + d2 + d3 + d4;
			var reasons = [];
			reasons.push("text-match");
			if (d2 >= 0.3) reasons.push("inside-overlay");
			if (d3 > 0) reasons.push("edge-position");
			reasons.push("visible+enabled");
			candidates.push(makeCandidate(el, score, reasons.join(", ")));
		}
	}

	else if (normalized === "authaction") {
		var els = qsa("button, a, [role='button'], [role='link'], input[type='submit']");
		var patterns = ["log in", "login", "sign in", "signin", "sign up", "signup", "register", "create account", "join", "get started"];
		for (var i = 0; i < els.length; i++) {
			var el = els[i];
			if (!visibleEnabled(el)) continue;
			var d1 = textMatchStrength(el, patterns) * 0.4;
			if (d1 === 0) continue;
			var role = pi.inferRole(el);
			var d2 = (role === "button" || role === "link") ? 0.25 : 0.1;
			var rect = el.getBoundingClientRect();
			var inHeader = !!el.closest("header, nav, [role='banner'], [role='navigation']");
			var isProminent = inHeader || rect.top < 200;
			var d3 = isProminent ? 0.2 : 0.05;
			var d4 = 0.15;
			var score = d1 + d2 + d3 + d4;
			var reasons = [];
			reasons.push("text-match");
			if (d2 >= 0.25) reasons.push("button-or-link");
			if (d3 >= 0.2) reasons.push("prominent-position");
			reasons.push("visible+enabled");
			candidates.push(makeCandidate(el, score, reasons.join(", ")));
		}
	}

	else if (normalized === "backnavigation") {
		var els = qsa("button, a, [role='button'], [role='link']");
		var patterns = ["back", "previous", "prev", "return", "go back"];
		for (var i = 0; i < els.length; i++) {
			var el = els[i];
			if (!visibleEnabled(el)) continue;
			var d1 = textMatchStrength(el, patterns) * 0.35;
			if (d1 === 0) continue;
			var innerHtml = el.innerHTML.toLowerCase();
			var hasArrow = innerHtml.indexOf("←") !== -1 || innerHtml.indexOf("&larr") !== -1 || innerHtml.indexOf("arrow") !== -1 || innerHtml.indexOf("chevron-left") !== -1 || innerHtml.indexOf("back") !== -1;
			var d2 = hasArrow ? 0.25 : 0;
			var inNav = !!el.closest("header, nav, [role='banner'], [role='navigation'], .breadcrumb, .toolbar");
			var d3 = inNav ? 0.25 : 0.05;
			var d4 = 0.15;
			var score = d1 + d2 + d3 + d4;
			var reasons = [];
			reasons.push("text-match");
			if (d2 > 0) reasons.push("has-back-arrow/icon");
			if (d3 >= 0.25) reasons.push("in-nav/header");
			reasons.push("visible+enabled");
			candidates.push(makeCandidate(el, score, reasons.join(", ")));
		}
	}

	else {
		return { error: "Unknown intent: " + intentRaw + ". Valid: submit_form, close_dialog, primary_cta, search_field, next_step, dismiss, auth_action, back_navigation" };
	}

	// Sort by score descending, cap at 5
	candidates.sort(function(a, b) { return b.score - a.score; });
	candidates = candidates.slice(0, 5);

	return { intent: intentRaw, normalized: normalized, count: candidates.length, candidates: candidates };
})()`;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface IntentCandidate {
	score: number;
	selector: string;
	tag: string;
	role: string;
	name: string;
	text: string;
	reason: string;
}

interface IntentScoringResult {
	intent: string;
	normalized: string;
	count: number;
	candidates: IntentCandidate[];
	error?: string;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerIntentTools(pi: ExtensionAPI, deps: ToolDeps): void {

	// -----------------------------------------------------------------------
	// browser_find_best
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "browser_find_best",
		label: "Find Best",
		description:
			"Find the best-matching element for a semantic intent. Returns up to 5 scored candidates (0-1) ranked by structural position, role, text signals, and visibility. Use this to discover which element the agent should interact with for a given goal — e.g. intent=\"submit_form\" finds submit buttons, intent=\"close_dialog\" finds close/dismiss buttons inside dialogs. Each candidate includes a CSS selector usable with browser_click.",
		parameters: Type.Object({
			intent: StringEnum(INTENTS, {
				description:
					"Semantic intent: submit_form, close_dialog, primary_cta, search_field, next_step, dismiss, auth_action, back_navigation",
			}),
			scope: Type.Optional(
				Type.String({
					description:
						"CSS selector to narrow the search area. If omitted, searches the full page.",
				})
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			let actionId: number | null = null;
			let beforeState: CompactPageState | null = null;
			try {
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				beforeState = await deps.captureCompactPageState(p, {
					selectors: params.scope ? [params.scope] : [],
					includeBodyText: false,
					target,
				});
				actionId = deps.beginTrackedAction("browser_find_best", params, beforeState.url).id;

				const script = buildIntentScoringScript(params.intent, params.scope);
				const result = await target.evaluate(script) as IntentScoringResult;

				if (result.error) {
					deps.finishTrackedAction(actionId, {
						status: "error",
						error: result.error,
						beforeState,
					});
					return {
						content: [{ type: "text" as const, text: result.error }],
						details: {},
						isError: true,
					};
				}

				const afterState = await deps.captureCompactPageState(p, {
					selectors: params.scope ? [params.scope] : [],
					includeBodyText: false,
					target,
				});
				setLastActionBeforeState(beforeState);
				setLastActionAfterState(afterState);

				deps.finishTrackedAction(actionId, {
					status: "success",
					afterUrl: afterState.url,
					beforeState,
					afterState,
				});

				// Format output
				const lines: string[] = [];
				lines.push(`Intent: ${params.intent} → ${result.count} candidate(s)`);
				if (params.scope) lines.push(`Scope: ${params.scope}`);
				lines.push("");

				if (result.candidates.length === 0) {
					lines.push("No candidates found for this intent on the current page.");
				} else {
					for (let i = 0; i < result.candidates.length; i++) {
						const c = result.candidates[i];
						lines.push(`${i + 1}. **${c.score}** \`${c.selector}\``);
						lines.push(`   ${c.tag}${c.role ? ` [${c.role}]` : ""} — "${c.name || c.text}"`);
						lines.push(`   Reason: ${c.reason}`);
					}
				}

				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { intentResult: result },
				};
			} catch (err: unknown) {
				const screenshot = await deps.captureErrorScreenshot(
					(() => { try { return deps.getActivePage(); } catch { return null; } })()
				);
				const errMsg = deps.firstErrorLine(err);

				if (actionId !== null) {
					deps.finishTrackedAction(actionId, {
						status: "error",
						error: errMsg,
						beforeState: beforeState ?? undefined,
					});
				}

				const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
					{ type: "text", text: `browser_find_best failed: ${errMsg}` },
				];
				if (screenshot) {
					content.push({ type: "image", data: screenshot.data, mimeType: screenshot.mimeType });
				}
				return { content, details: {}, isError: true };
			}
		},
	});

	// -----------------------------------------------------------------------
	// browser_act
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "browser_act",
		label: "Browser Act",
		description:
			"Execute a semantic action in one call. Resolves the top candidate for the given intent (same scoring as browser_find_best), performs the action (click for buttons/links, focus for search fields), settles the page, and returns a before/after diff. Use when you know what you want to accomplish semantically — e.g. intent=\"submit_form\" finds and clicks the submit button, intent=\"close_dialog\" dismisses the dialog.",
		parameters: Type.Object({
			intent: StringEnum(INTENTS, {
				description:
					"Semantic intent: submit_form, close_dialog, primary_cta, search_field, next_step, dismiss, auth_action, back_navigation",
			}),
			scope: Type.Optional(
				Type.String({
					description:
						"CSS selector to narrow the search area. If omitted, searches the full page.",
				})
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			let actionId: number | null = null;
			let beforeState: CompactPageState | null = null;
			try {
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				beforeState = await deps.captureCompactPageState(p, {
					selectors: params.scope ? [params.scope] : [],
					includeBodyText: true,
					target,
				});
				actionId = deps.beginTrackedAction("browser_act", params, beforeState.url).id;

				// Score candidates
				const script = buildIntentScoringScript(params.intent, params.scope);
				const result = await target.evaluate(script) as IntentScoringResult;

				if (result.error) {
					deps.finishTrackedAction(actionId, {
						status: "error",
						error: result.error,
						beforeState,
					});
					return {
						content: [{ type: "text" as const, text: `browser_act failed: ${result.error}` }],
						details: {},
						isError: true,
					};
				}

				if (result.candidates.length === 0) {
					deps.finishTrackedAction(actionId, {
						status: "error",
						error: `No candidates found for intent "${params.intent}"`,
						beforeState,
					});
					return {
						content: [{
							type: "text" as const,
							text: `browser_act: No candidates found for intent "${params.intent}" on the current page. The page may not have the expected elements (e.g. no dialog for close_dialog, no form for submit_form).`,
						}],
						details: { intentResult: result },
						isError: true,
					};
				}

				// Take top candidate and execute action
				const top = result.candidates[0];
				const normalizedIntent = params.intent.toLowerCase().replace(/[\s_-]+/g, "");

				if (normalizedIntent === "searchfield") {
					// Focus instead of click for search fields
					try {
						await target.locator(top.selector).first().focus({ timeout: 5000 });
					} catch {
						// Fallback: click to focus
						await target.locator(top.selector).first().click({ timeout: 5000 });
					}
				} else {
					// Click via Playwright locator (D021)
					try {
						await target.locator(top.selector).first().click({ timeout: 5000 });
					} catch {
						// getByRole fallback from interaction.ts pattern
						const nameMatch = top.selector.match(/\[(?:aria-label|name|placeholder)="([^"]+)"\]/i);
						const roleName = nameMatch?.[1];
						let clicked = false;
						for (const role of ["button", "link", "combobox", "textbox"] as const) {
							try {
								const loc = roleName
									? target.getByRole(role, { name: new RegExp(roleName, "i") })
									: target.getByRole(role, { name: new RegExp(top.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") });
								await loc.first().click({ timeout: 3000 });
								clicked = true;
								break;
							} catch { /* try next role */ }
						}
						if (!clicked) {
							throw new Error(`Could not click top candidate "${top.selector}" for intent "${params.intent}"`);
						}
					}
				}

				// Settle after action
				await deps.settleAfterActionAdaptive(p);

				// Capture after state and diff
				const afterState = await deps.captureCompactPageState(p, {
					selectors: params.scope ? [params.scope] : [],
					includeBodyText: true,
					target,
				});
				const diff = diffCompactStates(beforeState, afterState);
				const summary = deps.formatCompactStateSummary(afterState);
				const jsErrors = deps.getRecentErrors(p.url());

				setLastActionBeforeState(beforeState);
				setLastActionAfterState(afterState);

				deps.finishTrackedAction(actionId, {
					status: "success",
					afterUrl: afterState.url,
					diffSummary: diff.summary,
					beforeState,
					afterState,
				});

				// Format output
				const lines: string[] = [];
				lines.push(`Intent: ${params.intent}`);
				lines.push(`Action: ${normalizedIntent === "searchfield" ? "focused" : "clicked"} top candidate (score: ${top.score})`);
				lines.push(`Target: \`${top.selector}\` — "${top.name || top.text}"`);
				lines.push(`Reason: ${top.reason}`);
				lines.push("");
				lines.push(`Diff:\n${deps.formatDiffText(diff)}`);
				if (jsErrors.trim()) {
					lines.push(`\nJS Errors:\n${jsErrors}`);
				}
				lines.push(`\nPage summary:\n${summary}`);

				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { intentResult: result, topCandidate: top, diff },
				};
			} catch (err: unknown) {
				const screenshot = await deps.captureErrorScreenshot(
					(() => { try { return deps.getActivePage(); } catch { return null; } })()
				);
				const errMsg = deps.firstErrorLine(err);

				if (actionId !== null) {
					deps.finishTrackedAction(actionId, {
						status: "error",
						error: errMsg,
						beforeState: beforeState ?? undefined,
					});
				}

				const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
					{ type: "text", text: `browser_act failed: ${errMsg}` },
				];
				if (screenshot) {
					content.push({ type: "image", data: screenshot.data, mimeType: screenshot.mimeType });
				}
				return { content, details: {}, isError: true };
			}
		},
	});
}
