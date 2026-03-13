import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@gsd/pi-ai";
import {
	diffCompactStates,
	evaluateAssertionChecks,
	findAction,
	runBatchSteps,
	validateWaitParams,
	createRegionStableScript,
	parseThreshold,
	includesNeedle,
} from "../core.js";
import type { ToolDeps, CompactPageState } from "../state.js";
import {
	getConsoleLogs,
	getCurrentRefMap,
	getLastActionBeforeState,
	getLastActionAfterState,
	setLastActionBeforeState,
	setLastActionAfterState,
	getActionTimeline,
} from "../state.js";

export function registerAssertionTools(pi: ExtensionAPI, deps: ToolDeps): void {
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
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				const state = await deps.collectAssertionState(p, params.checks, target);
				const result = evaluateAssertionChecks({ checks: params.checks, state });
				return {
					content: [{ type: "text", text: `Browser assert\n\n${deps.formatAssertionText(result)}` }],
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
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				const current = await deps.captureCompactPageState(p, { includeBodyText: true, target });
				let baseline: CompactPageState | null = null;
				if (params.sinceActionId) {
					const actionTimeline = getActionTimeline();
					const action = findAction(actionTimeline, params.sinceActionId) as { afterState?: CompactPageState } | null;
					baseline = action?.afterState ?? null;
				}
				if (!baseline) {
					baseline = getLastActionAfterState() ?? getLastActionBeforeState();
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
					content: [{ type: "text", text: `Browser diff\n\n${deps.formatDiffText(diff)}` }],
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
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				beforeState = await deps.captureCompactPageState(p, { includeBodyText: true, target });
				actionId = deps.beginTrackedAction("browser_batch", params, beforeState.url).id;
				const executeStep = async (step: any, index: number) => {
					const stepTarget = deps.getActiveTarget();
					try {
						switch (step.action) {
							case "navigate": {
								await p.goto(step.url, { waitUntil: "domcontentloaded", timeout: 30000 });
								await p.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
								return { ok: true, action: step.action, url: p.url() };
							}
							case "click": {
								await stepTarget.locator(step.selector).first().click({ timeout: step.timeout ?? 8000 });
								await deps.settleAfterActionAdaptive(p);
								return { ok: true, action: step.action, selector: step.selector, url: p.url() };
							}
							case "type": {
								if (step.clearFirst) {
									await stepTarget.locator(step.selector).first().fill("");
								}
								await stepTarget.locator(step.selector).first().fill(step.text ?? "", { timeout: step.timeout ?? 8000 });
								if (step.submit) await p.keyboard.press("Enter");
								await deps.settleAfterActionAdaptive(p);
								return { ok: true, action: step.action, selector: step.selector, text: step.text };
							}
							case "key_press": {
								await p.keyboard.press(step.key);
								await deps.settleAfterActionAdaptive(p, { checkFocusStability: true });
								return { ok: true, action: step.action, key: step.key };
							}
							case "wait_for": {
								const timeout = step.timeout ?? 10000;
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
									await deps.getActivePage().waitForResponse(
										(resp: any) => resp.url().includes(step.value!),
										{ timeout }
									);
								}
								else if (step.condition === "console_message") {
									const needle = step.value!;
									const startTime = Date.now();
									let found = false;
									while (Date.now() - startTime < timeout) {
										if (getConsoleLogs().find((entry) => includesNeedle(entry.text, needle))) { found = true; break; }
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
								const state = await deps.collectAssertionState(p, step.checks ?? [], stepTarget);
								const assertion = evaluateAssertionChecks({ checks: step.checks ?? [], state });
								return { ok: assertion.verified, action: step.action, summary: assertion.summary, assertion };
							}
							case "click_ref": {
								const parsedRef = deps.parseRef(step.ref);
								const currentRefMap = getCurrentRefMap();
								const node = currentRefMap[parsedRef.key];
								if (!node) throw new Error(`Unknown ref: ${step.ref}`);
								const resolved = await deps.resolveRefTarget(stepTarget, node);
								if (!resolved.ok) throw new Error(resolved.reason);
								await stepTarget.locator(resolved.selector).first().click({ timeout: step.timeout ?? 8000 });
								await deps.settleAfterActionAdaptive(p);
								return { ok: true, action: step.action, ref: step.ref };
							}
							case "fill_ref": {
								const parsedRef = deps.parseRef(step.ref);
								const currentRefMap = getCurrentRefMap();
								const node = currentRefMap[parsedRef.key];
								if (!node) throw new Error(`Unknown ref: ${step.ref}`);
								const resolved = await deps.resolveRefTarget(stepTarget, node);
								if (!resolved.ok) throw new Error(resolved.reason);
								if (step.clearFirst) await stepTarget.locator(resolved.selector).first().fill("");
								await stepTarget.locator(resolved.selector).first().fill(step.text ?? "", { timeout: step.timeout ?? 8000 });
								if (step.submit) await p.keyboard.press("Enter");
								await deps.settleAfterActionAdaptive(p);
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
				const batchEndTarget = deps.getActiveTarget();
				const afterState = await deps.captureCompactPageState(p, { includeBodyText: true, target: batchEndTarget });
				const diff = diffCompactStates(beforeState!, afterState);
				setLastActionBeforeState(beforeState!);
				setLastActionAfterState(afterState);
				deps.finishTrackedAction(actionId!, {
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
					content: [{ type: "text", text: params.finalSummaryOnly ? run.summary : `Browser batch\nAction: ${actionId}\n\n${summary}\n\nDiff:\n${deps.formatDiffText(diff)}` }],
					details: { actionId, diff, ...run },
					isError: !run.ok,
				};
			} catch (err: any) {
				if (actionId !== null) {
					deps.finishTrackedAction(actionId, { status: "error", afterUrl: deps.getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? undefined });
				}
				return {
					content: [{ type: "text", text: `Browser batch failed: ${err.message}` }],
					details: { error: err.message, actionId },
					isError: true,
				};
			}
		},
	});
}
