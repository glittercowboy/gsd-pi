import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@gsd/pi-ai";
import {
	diffCompactStates,
} from "../core.js";
import type { ToolDeps, CompactPageState } from "../state.js";
import {
	setLastActionBeforeState,
	setLastActionAfterState,
} from "../state.js";
import { readFocusedDescriptor } from "../settle.js";

export function registerInteractionTools(pi: ExtensionAPI, deps: ToolDeps): void {
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
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				beforeState = await deps.captureCompactPageState(p, { selectors: params.selector ? [params.selector] : [], includeBodyText: true, target });
				actionId = deps.beginTrackedAction("browser_click", params, beforeState.url).id;
				const beforeUrl = p.url();
				const beforeHash = deps.getUrlHash(beforeUrl);
				const beforeTargetState = params.selector
					? await deps.captureClickTargetState(target, params.selector)
					: null;

				if (params.selector) {
					try {
						await target.locator(params.selector).first().click({ timeout: 5000 });
					} catch {
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

				const settle = await deps.settleAfterActionAdaptive(p);

				const afterState = await deps.captureCompactPageState(p, { selectors: params.selector ? [params.selector] : [], includeBodyText: true, target });
				const url = afterState.url;
				const hash = deps.getUrlHash(url);
				const afterTargetState = params.selector
					? await deps.captureClickTargetState(target, params.selector)
					: null;
				const targetStateChanged = !!beforeTargetState && !!afterTargetState && (
					beforeTargetState.exists !== afterTargetState.exists ||
					beforeTargetState.ariaExpanded !== afterTargetState.ariaExpanded ||
					beforeTargetState.ariaPressed !== afterTargetState.ariaPressed ||
					beforeTargetState.ariaSelected !== afterTargetState.ariaSelected ||
					beforeTargetState.open !== afterTargetState.open
				);
				const verification = deps.verificationFromChecks(
					[
						{ name: "url_changed", passed: url !== beforeUrl, value: url, expected: `!= ${beforeUrl}` },
						{ name: "hash_changed", passed: hash !== beforeHash, value: hash, expected: `!= ${beforeHash}` },
						{ name: "target_state_changed", passed: targetStateChanged, value: afterTargetState, expected: beforeTargetState },
						{ name: "dialog_open", passed: afterState.dialog.count > beforeState!.dialog.count, value: afterState.dialog.count, expected: `> ${beforeState!.dialog.count}` },
					],
					"Try a more specific selector or click a clearly interactive element."
				);
				const clickTarget = params.selector ?? `(${params.x}, ${params.y})`;
				const summary = deps.formatCompactStateSummary(afterState);
				const jsErrors = deps.getRecentErrors(p.url());
				const diff = diffCompactStates(beforeState!, afterState);
				setLastActionBeforeState(beforeState!);
				setLastActionAfterState(afterState);
				deps.finishTrackedAction(actionId!, {
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
					content: [{ type: "text", text: `Clicked: ${clickTarget}\nURL: ${url}\nAction: ${actionId}\n${deps.verificationLine(verification)}${jsErrors}\n\nDiff:\n${deps.formatDiffText(diff)}\n\nPage summary:\n${summary}` }],
					details: { target: clickTarget, url, actionId, diff, ...settle, ...verification },
				};
			} catch (err: any) {
				if (actionId !== null) {
					deps.finishTrackedAction(actionId, { status: "error", afterUrl: deps.getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? undefined });
				}
				const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
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
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				await target.dragAndDrop(params.sourceSelector, params.targetSelector, { timeout: 10000 });
				const settle = await deps.settleAfterActionAdaptive(p);

				const afterState = await deps.captureCompactPageState(p, { includeBodyText: false, target });
				const summary = deps.formatCompactStateSummary(afterState);
				const jsErrors = deps.getRecentErrors(p.url());

				return {
					content: [{
						type: "text",
						text: `Dragged "${params.sourceSelector}" → "${params.targetSelector}"${jsErrors}\n\nPage summary:\n${summary}`,
					}],
					details: { source: params.sourceSelector, target: params.targetSelector, ...settle },
				};
			} catch (err: any) {
				const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
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
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				beforeState = await deps.captureCompactPageState(p, { selectors: params.selector ? [params.selector] : [], includeBodyText: true, target });
				actionId = deps.beginTrackedAction("browser_type", params, beforeState.url).id;
				const beforeUrl = p.url();

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
						let filled = false;
						try {
							await target.locator(params.selector).first().fill(params.text, { timeout: 5000 });
							filled = true;
						} catch { /* fall through */ }

						if (!filled) {
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
					await target.locator(":focus").pressSequentially(params.text, { timeout: 10000 }).catch(() =>
						p.keyboard.type(params.text)
					);
				}

				if (params.submit) {
					await p.keyboard.press("Enter");
				}

				const settle = await deps.settleAfterActionAdaptive(p);

				const typedValue = await deps.readInputLikeValue(target, params.selector);
				const afterUrl = p.url();
				const verification = deps.verificationFromChecks(
					[
						{ name: "value_equals_expected", passed: typedValue === params.text, value: typedValue, expected: params.text },
						{ name: "value_contains_expected", passed: typeof typedValue === "string" && typedValue.includes(params.text), value: typedValue, expected: params.text },
						{ name: "url_changed_after_submit", passed: !!params.submit && afterUrl !== beforeUrl, value: afterUrl, expected: `!= ${beforeUrl}` },
					],
					"Try clearFirst=true, use a more specific selector, or set slowly=true for key-driven inputs."
				);
				const typeTarget = params.selector ? ` into "${params.selector}"` : "";
				const afterState = await deps.captureCompactPageState(p, { selectors: params.selector ? [params.selector] : [], includeBodyText: true, target });
				const summary = deps.formatCompactStateSummary(afterState);
				const jsErrors = deps.getRecentErrors(p.url());
				const diff = diffCompactStates(beforeState!, afterState);
				setLastActionBeforeState(beforeState!);
				setLastActionAfterState(afterState);
				deps.finishTrackedAction(actionId!, {
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
					content: [{ type: "text", text: `Typed "${params.text}"${typeTarget}\nAction: ${actionId}\n${deps.verificationLine(verification)}${jsErrors}\n\nDiff:\n${deps.formatDiffText(diff)}\n\nPage summary:\n${summary}` }],
					details: { text: params.text, selector: params.selector, typedValue, actionId, diff, ...settle, ...verification },
				};
			} catch (err: any) {
				if (actionId !== null) {
					deps.finishTrackedAction(actionId, { status: "error", afterUrl: deps.getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? undefined });
				}
				const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
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
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				const cleanFiles = params.files.map((f: string) => f.replace(/^@/, ""));
				await target.locator(params.selector).first().setInputFiles(cleanFiles);
				const settle = await deps.settleAfterActionAdaptive(p);

				const afterState = await deps.captureCompactPageState(p, { includeBodyText: false, target });
				const summary = deps.formatCompactStateSummary(afterState);
				const jsErrors = deps.getRecentErrors(p.url());

				return {
					content: [{
						type: "text",
						text: `Uploaded ${cleanFiles.length} file(s) to "${params.selector}": ${cleanFiles.join(", ")}${jsErrors}\n\nPage summary:\n${summary}`,
					}],
					details: { selector: params.selector, files: cleanFiles, ...settle },
				};
			} catch (err: any) {
				const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
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
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				const pixels = params.amount ?? 300;
				const delta = params.direction === "up" ? -pixels : pixels;
				await p.mouse.wheel(0, delta);

				const settle = await deps.settleAfterActionAdaptive(p);

				const scrollInfo = await target.evaluate(() => ({
					scrollY: Math.round(window.scrollY),
					scrollHeight: document.documentElement.scrollHeight,
					clientHeight: document.documentElement.clientHeight,
				}));
				const maxScroll = scrollInfo.scrollHeight - scrollInfo.clientHeight;
				const percent = maxScroll > 0 ? Math.round((scrollInfo.scrollY / maxScroll) * 100) : 0;

				const afterState = await deps.captureCompactPageState(p, { includeBodyText: false, target });
				const summary = deps.formatCompactStateSummary(afterState);
				const jsErrors = deps.getRecentErrors(p.url());

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
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				await target.locator(params.selector).first().hover({ timeout: 10000 });
				const settle = await deps.settleAfterActionAdaptive(p);

				const afterState = await deps.captureCompactPageState(p, { includeBodyText: false, target });
				const summary = deps.formatCompactStateSummary(afterState);
				const jsErrors = deps.getRecentErrors(p.url());

				return {
					content: [{ type: "text", text: `Hovering over "${params.selector}"${jsErrors}\n\nPage summary:\n${summary}` }],
					details: { selector: params.selector, ...settle },
				};
			} catch (err: any) {
				const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
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
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				beforeState = await deps.captureCompactPageState(p, { includeBodyText: true, target });
				actionId = deps.beginTrackedAction("browser_key_press", params, beforeState.url).id;
				const beforeUrl = p.url();
				const beforeFocus = await readFocusedDescriptor(target);

				await p.keyboard.press(params.key);
				const settle = await deps.settleAfterActionAdaptive(p, { checkFocusStability: true });

				const afterState = await deps.captureCompactPageState(p, { includeBodyText: true, target });
				const afterUrl = afterState.url;
				const afterFocus = await readFocusedDescriptor(target);
				const verification = deps.verificationFromChecks(
					[
						{ name: "url_changed", passed: afterUrl !== beforeUrl, value: afterUrl, expected: `!= ${beforeUrl}` },
						{ name: "focus_changed", passed: afterFocus !== beforeFocus, value: afterFocus, expected: `!= ${beforeFocus}` },
						{ name: "dialog_open", passed: afterState.dialog.count > beforeState!.dialog.count, value: afterState.dialog.count, expected: `> ${beforeState!.dialog.count}` },
					],
					"If this key should trigger UI changes, confirm focus is on the intended element first."
				);

				const summary = deps.formatCompactStateSummary(afterState);
				const jsErrors = deps.getRecentErrors(p.url());
				const diff = diffCompactStates(beforeState!, afterState);
				setLastActionBeforeState(beforeState!);
				setLastActionAfterState(afterState);
				deps.finishTrackedAction(actionId!, {
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
					content: [{ type: "text", text: `Pressed "${params.key}"\nAction: ${actionId}\n${deps.verificationLine(verification)}${jsErrors}\n\nDiff:\n${deps.formatDiffText(diff)}\n\nPage summary:\n${summary}` }],
					details: { key: params.key, beforeFocus, afterFocus, actionId, diff, ...settle, ...verification },
				};
			} catch (err: any) {
				if (actionId !== null) {
					deps.finishTrackedAction(actionId, { status: "error", afterUrl: deps.getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? undefined });
				}
				const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
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
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				beforeState = await deps.captureCompactPageState(p, { selectors: [params.selector], includeBodyText: true, target });
				actionId = deps.beginTrackedAction("browser_select_option", params, beforeState.url).id;

				let selected: string[];
				try {
					selected = await target.selectOption(params.selector, { label: params.option }, { timeout: 5000 });
				} catch {
					selected = await target.selectOption(params.selector, { value: params.option }, { timeout: 5000 });
				}

				const settle = await deps.settleAfterActionAdaptive(p);

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
				const verification = deps.verificationFromChecks(
					[
						{ name: "selected_values_include_option", passed: selectedState.selectedValues.includes(params.option), value: selectedState.selectedValues, expected: params.option },
						{ name: "selected_labels_include_option", passed: selectedState.selectedLabels.some((label) => label.toLowerCase().includes(optionNeedle)), value: selectedState.selectedLabels, expected: params.option },
					],
					"Confirm whether the target select uses option label or value, then retry with that exact text."
				);

				const afterState = await deps.captureCompactPageState(p, { selectors: [params.selector], includeBodyText: true, target });
				const summary = deps.formatCompactStateSummary(afterState);
				const jsErrors = deps.getRecentErrors(p.url());
				const diff = diffCompactStates(beforeState!, afterState);
				setLastActionBeforeState(beforeState!);
				setLastActionAfterState(afterState);
				deps.finishTrackedAction(actionId!, {
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
							text: `Selected "${params.option}" in "${params.selector}". Values: ${selected.join(", ")}\nAction: ${actionId}\n${deps.verificationLine(verification)}${jsErrors}\n\nDiff:\n${deps.formatDiffText(diff)}\n\nPage summary:\n${summary}`,
						},
					],
					details: { selector: params.selector, option: params.option, selected, selectedState, actionId, diff, ...settle, ...verification },
				};
			} catch (err: any) {
				if (actionId !== null) {
					deps.finishTrackedAction(actionId, { status: "error", afterUrl: deps.getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? undefined });
				}
				const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
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
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				beforeState = await deps.captureCompactPageState(p, { selectors: [params.selector], includeBodyText: true, target });
				actionId = deps.beginTrackedAction("browser_set_checked", params, beforeState.url).id;
				await target.locator(params.selector).first().setChecked(params.checked, { timeout: 10000 });
				const settle = await deps.settleAfterActionAdaptive(p);

				const actualChecked = await target.locator(params.selector).first().isChecked().catch(() => null);
				const verification = deps.verificationFromChecks(
					[
						{ name: "checked_state_matches", passed: actualChecked === params.checked, value: actualChecked, expected: params.checked },
					],
					"Ensure selector points to a checkbox/radio input and retry."
				);

				const state = params.checked ? "checked" : "unchecked";
				const afterState = await deps.captureCompactPageState(p, { selectors: [params.selector], includeBodyText: true, target });
				const summary = deps.formatCompactStateSummary(afterState);
				const jsErrors = deps.getRecentErrors(p.url());
				const diff = diffCompactStates(beforeState!, afterState);
				setLastActionBeforeState(beforeState!);
				setLastActionAfterState(afterState);
				deps.finishTrackedAction(actionId!, {
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
						text: `Set "${params.selector}" to ${state}\nAction: ${actionId}\n${deps.verificationLine(verification)}${jsErrors}\n\nDiff:\n${deps.formatDiffText(diff)}\n\nPage summary:\n${summary}`,
					}],
					details: { selector: params.selector, checked: params.checked, actualChecked, actionId, diff, ...settle, ...verification },
				};
			} catch (err: any) {
				if (actionId !== null) {
					deps.finishTrackedAction(actionId, { status: "error", afterUrl: deps.getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? undefined });
				}
				const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
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
				const { page: p } = await deps.ensureBrowser();

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

				await p.setViewportSize({ width: width!, height: height! });

				return {
					content: [{ type: "text", text: `Viewport set to ${label!}` }],
					details: { width: width!, height: height!, label: label! },
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
}
