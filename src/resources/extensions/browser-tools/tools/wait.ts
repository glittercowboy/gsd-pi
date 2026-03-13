import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@gsd/pi-ai";
import {
	validateWaitParams,
	createRegionStableScript,
	parseThreshold,
	includesNeedle,
} from "../core.js";
import type { ToolDeps } from "../state.js";
import {
	getConsoleLogs,
} from "../state.js";

export function registerWaitTools(pi: ExtensionAPI, deps: ToolDeps): void {
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
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				const timeout = params.timeout ?? 10000;

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
						const response = await deps.getActivePage().waitForResponse(
							(resp) => resp.url().includes(params.value!),
							{ timeout }
						);
						return {
							content: [{ type: "text", text: `Request completed: ${response.url()} (status ${response.status()})` }],
							details: { condition: params.condition, value: params.value, url: response.url(), status: response.status() },
						};
					}

					case "console_message": {
						const needle = params.value!;
						const startTime = Date.now();
						while (Date.now() - startTime < timeout) {
							const match = getConsoleLogs().find((entry) => includesNeedle(entry.text, needle));
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
}
