import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@gsd/pi-ai";
import type { ToolDeps } from "../state.js";
import {
	getConsoleLogs,
	setConsoleLogs,
	getNetworkLogs,
	setNetworkLogs,
	getDialogLogs,
	setDialogLogs,
} from "../state.js";

export function registerInspectionTools(pi: ExtensionAPI, deps: ToolDeps): void {
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
			const logs = [...getConsoleLogs()];

			if (shouldClear) {
				setConsoleLogs([]);
			}

			if (logs.length === 0) {
				return {
					content: [{ type: "text", text: "No console logs captured." }],
					details: { logs: [], count: 0 },
				};
			}

			const formatted = logs
				.map((entry) => {
					const time = new Date(entry.timestamp).toISOString().slice(11, 23);
					return `[${time}] [${entry.type.toUpperCase()}] ${entry.text}`;
				})
				.join("\n");

			const truncated = deps.truncateText(formatted);

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
			let logs = [...getNetworkLogs()];

			if (shouldClear) {
				setNetworkLogs([]);
			}

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

			const truncated = deps.truncateText(formatted);

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
			const logs = [...getDialogLogs()];

			if (shouldClear) {
				setDialogLogs([]);
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

			const truncated = deps.truncateText(formatted);

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
				await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				const result = await target.evaluate(params.expression);

				let serialized: string;
				if (result === undefined) {
					serialized = "undefined";
				} else {
					try {
						serialized = JSON.stringify(result, null, 2) ?? "undefined";
					} catch {
						serialized = `[non-serializable: ${typeof result}]`;
					}
				}

				const truncated = deps.truncateText(serialized);
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
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();

				let snapshot: string;
				if (params.selector) {
					const locator = target.locator(params.selector).first();
					snapshot = await locator.ariaSnapshot();
				} else {
					snapshot = await target.locator("body").ariaSnapshot();
				}

				const truncated = deps.truncateText(snapshot);
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
				await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				const limit = params.limit ?? 20;

				const results = await target.evaluate(({ text, role, selector, limit }) => {
					const root = selector ? document.querySelector(selector) : document.body;
					if (!root) return [];

					let candidates: Element[];
					if (role) {
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
				await deps.ensureBrowser();
				const target = deps.getActiveTarget();

				let html: string;
				if (params.selector) {
					html = await target.locator(params.selector).first().evaluate((el: Element) => el.outerHTML);
				} else {
					html = await target.content();
				}

				const truncated = deps.truncateText(html);
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
}
