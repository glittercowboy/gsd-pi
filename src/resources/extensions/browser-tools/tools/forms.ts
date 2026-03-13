import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ToolDeps, CompactPageState } from "../state.js";
import {
	setLastActionBeforeState,
	setLastActionAfterState,
} from "../state.js";

// ---------------------------------------------------------------------------
// Form analysis evaluate callback — runs in the browser context.
// Self-contained: no external deps, no window.__pi calls.
// ---------------------------------------------------------------------------

interface FormFieldInfo {
	type: string;
	name: string;
	id: string;
	label: string;
	required: boolean;
	value: string;
	checked?: boolean;
	options?: Array<{ value: string; label: string; selected: boolean }>;
	validation: { valid: boolean; message: string };
	hidden: boolean;
	disabled: boolean;
	group?: string;
}

interface FormSubmitButton {
	tag: string;
	type: string;
	text: string;
	name: string;
	disabled: boolean;
}

interface FormAnalysisResult {
	formSelector: string;
	fields: FormFieldInfo[];
	submitButtons: FormSubmitButton[];
	fieldCount: number;
	visibleFieldCount: number;
}

/**
 * Runs inside page.evaluate(). Finds the target form, inventories all fields
 * with full label resolution, and returns a structured result.
 */
function buildFormAnalysisScript(selector?: string): string {
	// We return a string that will be evaluated in the page context.
	// This avoids serialization issues with passing functions.
	return `(() => {
		// --- helpers ---
		function isVisible(el) {
			if (!el) return false;
			const style = window.getComputedStyle(el);
			if (style.display === 'none' || style.visibility === 'hidden') return false;
			if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
			return true;
		}

		function humanizeName(name) {
			if (!name) return '';
			return name
				.replace(/([a-z])([A-Z])/g, '$1 $2')
				.replace(/[_\\-]+/g, ' ')
				.replace(/\\bid\\b/i, 'ID')
				.trim()
				.replace(/^./, c => c.toUpperCase());
		}

		function getTextContent(el) {
			if (!el) return '';
			return (el.textContent || '').trim().replace(/\\s+/g, ' ');
		}

		// --- label resolution (7-level priority chain) ---
		function resolveLabel(field) {
			// 1. aria-labelledby
			const labelledBy = field.getAttribute('aria-labelledby');
			if (labelledBy) {
				const parts = labelledBy.split(/\\s+/).map(id => {
					const el = document.getElementById(id);
					return el ? getTextContent(el) : '';
				}).filter(Boolean);
				if (parts.length) return parts.join(' ');
			}

			// 2. aria-label
			const ariaLabel = field.getAttribute('aria-label');
			if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

			// 3. label[for="id"]
			const fieldId = field.id;
			if (fieldId) {
				const labelFor = document.querySelector('label[for="' + CSS.escape(fieldId) + '"]');
				if (labelFor) {
					const text = getTextContent(labelFor);
					if (text) return text;
				}
			}

			// 4. wrapping label
			const wrappingLabel = field.closest('label');
			if (wrappingLabel) {
				// Clone and remove the field itself to get just the label text
				const clone = wrappingLabel.cloneNode(true);
				const inputs = clone.querySelectorAll('input, select, textarea');
				inputs.forEach(inp => inp.remove());
				const text = (clone.textContent || '').trim().replace(/\\s+/g, ' ');
				if (text) return text;
			}

			// 5. placeholder
			const placeholder = field.getAttribute('placeholder');
			if (placeholder && placeholder.trim()) return placeholder.trim();

			// 6. title
			const title = field.getAttribute('title');
			if (title && title.trim()) return title.trim();

			// 7. humanized name
			const name = field.getAttribute('name');
			if (name) return humanizeName(name);

			return '';
		}

		// --- form detection ---
		let form;
		const selectorArg = ${JSON.stringify(selector ?? null)};

		if (selectorArg) {
			form = document.querySelector(selectorArg);
			if (!form) return { error: 'Form not found for selector: ' + selectorArg };
		} else {
			const forms = Array.from(document.querySelectorAll('form'));
			if (forms.length === 1) {
				form = forms[0];
			} else if (forms.length > 1) {
				// Pick form with most visible inputs
				let best = null;
				let bestCount = -1;
				for (const f of forms) {
					const inputs = f.querySelectorAll('input, select, textarea');
					let visCount = 0;
					inputs.forEach(inp => { if (isVisible(inp)) visCount++; });
					if (visCount > bestCount) {
						bestCount = visCount;
						best = f;
					}
				}
				form = best;
			} else {
				form = document.body;
			}
		}

		// Build a useful selector for the form
		let formSelector = 'body';
		if (form !== document.body) {
			if (form.id) {
				formSelector = '#' + CSS.escape(form.id);
			} else if (form.getAttribute('name')) {
				formSelector = 'form[name="' + form.getAttribute('name') + '"]';
			} else if (form.getAttribute('action')) {
				formSelector = 'form[action="' + form.getAttribute('action') + '"]';
			} else {
				// nth-of-type fallback
				const allForms = Array.from(document.querySelectorAll('form'));
				const idx = allForms.indexOf(form);
				formSelector = idx >= 0 ? 'form:nth-of-type(' + (idx + 1) + ')' : 'form';
			}
		}

		// --- field inventory ---
		const fieldElements = form.querySelectorAll('input, select, textarea');
		const fields = [];

		fieldElements.forEach(field => {
			const tag = field.tagName.toLowerCase();
			const type = tag === 'select' ? 'select'
				: tag === 'textarea' ? 'textarea'
				: (field.getAttribute('type') || 'text').toLowerCase();

			// Skip submit/button/reset/image inputs — they're not data fields
			if (tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(type)) return;

			const label = resolveLabel(field);
			const name = field.getAttribute('name') || '';
			const id = field.id || '';
			const required = field.required || field.getAttribute('aria-required') === 'true';
			const hidden = type === 'hidden' || !isVisible(field);
			const disabled = field.disabled;

			// Value
			let value = '';
			if (tag === 'select') {
				const selected = field.querySelector('option:checked');
				value = selected ? selected.value : '';
			} else {
				value = field.value || '';
			}

			const info = {
				type,
				name,
				id,
				label,
				required,
				value,
				hidden,
				disabled,
				validation: {
					valid: field.validity ? field.validity.valid : true,
					message: field.validationMessage || '',
				},
			};

			// Checked state for checkboxes/radios
			if (type === 'checkbox' || type === 'radio') {
				info.checked = field.checked;
			}

			// Options for select elements
			if (tag === 'select') {
				info.options = Array.from(field.querySelectorAll('option')).map(opt => ({
					value: opt.value,
					label: opt.textContent.trim(),
					selected: opt.selected,
				}));
			}

			// Fieldset/legend group
			const fieldset = field.closest('fieldset');
			if (fieldset) {
				const legend = fieldset.querySelector('legend');
				if (legend) {
					info.group = getTextContent(legend);
				}
			}

			fields.push(info);
		});

		// --- submit buttons ---
		const submitButtons = [];
		const buttonCandidates = form.querySelectorAll('button, input[type="submit"]');
		buttonCandidates.forEach(btn => {
			const tag = btn.tagName.toLowerCase();
			const type = (btn.getAttribute('type') || (tag === 'button' ? 'submit' : '')).toLowerCase();
			// Include: explicit submit, or button without explicit type (defaults to submit)
			if (type === 'submit' || (tag === 'button' && !btn.getAttribute('type'))) {
				submitButtons.push({
					tag,
					type: type || 'submit',
					text: tag === 'input' ? (btn.value || '') : getTextContent(btn),
					name: btn.getAttribute('name') || '',
					disabled: btn.disabled,
				});
			}
		});

		const visibleFieldCount = fields.filter(f => !f.hidden).length;

		return {
			formSelector,
			fields,
			submitButtons,
			fieldCount: fields.length,
			visibleFieldCount,
		};
	})()`;
}

// ---------------------------------------------------------------------------
// Post-fill validation collection — runs in browser context.
// ---------------------------------------------------------------------------

function buildPostFillValidationScript(formSelector: string): string {
	return `(() => {
		const form = ${JSON.stringify(formSelector)} === 'body'
			? document.body
			: document.querySelector(${JSON.stringify(formSelector)});
		if (!form) return { valid: false, invalidCount: 0, fields: [] };

		const fieldEls = form.querySelectorAll('input, select, textarea');
		let validCount = 0;
		let invalidCount = 0;
		const invalidFields = [];

		fieldEls.forEach(f => {
			const tag = f.tagName.toLowerCase();
			const type = tag === 'select' ? 'select'
				: tag === 'textarea' ? 'textarea'
				: (f.getAttribute('type') || 'text').toLowerCase();
			if (['submit', 'button', 'reset', 'image', 'hidden'].includes(type)) return;

			if (f.validity && !f.validity.valid) {
				invalidCount++;
				invalidFields.push({
					name: f.getAttribute('name') || f.id || type,
					message: f.validationMessage || 'Invalid',
				});
			} else {
				validCount++;
			}
		});

		return {
			valid: invalidCount === 0,
			validCount,
			invalidCount,
			invalidFields,
		};
	})()`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFormTools(pi: ExtensionAPI, deps: ToolDeps): void {
	// -----------------------------------------------------------------------
	// browser_analyze_form
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "browser_analyze_form",
		label: "Analyze Form",
		description:
			"Analyze a form on the current page and return a structured field inventory. Auto-detects the form if no selector is provided (picks the single <form>, or the form with most visible inputs, or falls back to document.body). Returns field types, labels (resolved via aria-labelledby → aria-label → label[for] → wrapping label → placeholder → title → name), values, validation state, and submit buttons.",
		parameters: Type.Object({
			selector: Type.Optional(
				Type.String({
					description:
						"CSS selector targeting the form element to analyze. If omitted, auto-detects the primary form on the page.",
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
					selectors: params.selector ? [params.selector] : [],
					includeBodyText: false,
					target,
				});
				actionId = deps.beginTrackedAction("browser_analyze_form", params, beforeState.url).id;

				const script = buildFormAnalysisScript(params.selector);
				const result = await target.evaluate(script) as FormAnalysisResult & { error?: string };

				if (result.error) {
					deps.finishTrackedAction(actionId!, {
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
					selectors: params.selector ? [params.selector] : [],
					includeBodyText: false,
					target,
				});
				setLastActionBeforeState(beforeState);
				setLastActionAfterState(afterState);

				deps.finishTrackedAction(actionId!, {
					status: "success",
					afterUrl: afterState.url,
					beforeState,
					afterState,
				});

				// Format output
				const lines: string[] = [];
				lines.push(`Form: ${result.formSelector}`);
				lines.push(`Fields: ${result.fieldCount} total, ${result.visibleFieldCount} visible`);
				lines.push(`Submit buttons: ${result.submitButtons.length}`);
				lines.push("");

				if (result.fields.length > 0) {
					lines.push("## Fields");
					for (const f of result.fields) {
						const flags: string[] = [];
						if (f.required) flags.push("required");
						if (f.hidden) flags.push("hidden");
						if (f.disabled) flags.push("disabled");
						if (f.checked !== undefined) flags.push(f.checked ? "checked" : "unchecked");
						if (!f.validation.valid) flags.push(`invalid: ${f.validation.message}`);

						const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
						const valueStr = f.value ? ` = "${f.value}"` : "";
						const labelStr = f.label || "(no label)";
						const selectorHint = f.id ? `#${f.id}` : f.name ? `[name="${f.name}"]` : f.type;
						const groupStr = f.group ? ` (group: ${f.group})` : "";

						lines.push(`- **${labelStr}** \`${f.type}\` \`${selectorHint}\`${valueStr}${flagStr}${groupStr}`);

						if (f.options && f.options.length > 0) {
							for (const opt of f.options) {
								const sel = opt.selected ? " ✓" : "";
								lines.push(`  - ${opt.label} (${opt.value})${sel}`);
							}
						}
					}
					lines.push("");
				}

				if (result.submitButtons.length > 0) {
					lines.push("## Submit Buttons");
					for (const btn of result.submitButtons) {
						const disStr = btn.disabled ? " [disabled]" : "";
						lines.push(`- "${btn.text}" \`<${btn.tag} type="${btn.type}">\`${btn.name ? ` name="${btn.name}"` : ""}${disStr}`);
					}
				}

				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { formAnalysis: result },
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
					{ type: "text", text: `browser_analyze_form failed: ${errMsg}` },
				];
				if (screenshot) {
					content.push({ type: "image", data: screenshot.data, mimeType: screenshot.mimeType });
				}

				return { content, details: {}, isError: true };
			}
		},
	});

	// -----------------------------------------------------------------------
	// browser_fill_form
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "browser_fill_form",
		label: "Fill Form",
		description:
			"Fill a form on the current page using a values mapping. Keys are field identifiers (label text, name attribute, placeholder, or aria-label). Resolves fields by label → name → placeholder → aria-label (exact first, then case-insensitive). Uses fill() for text inputs, selectOption() for selects, setChecked() for checkboxes/radios. Skips file and hidden inputs. Optionally submits the form.",
		parameters: Type.Object({
			selector: Type.Optional(
				Type.String({
					description:
						"CSS selector targeting the form element. If omitted, auto-detects the primary form.",
				})
			),
			values: Type.Record(Type.String(), Type.String(), {
				description:
					"Mapping of field identifiers to values. Keys can be label text, name, placeholder, or aria-label. Values are strings — for checkboxes use 'true'/'false' or 'on'/'off', for selects use the option label or value.",
			}),
			submit: Type.Optional(
				Type.Boolean({
					description: "If true, clicks the form's submit button after filling all fields.",
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
					selectors: params.selector ? [params.selector] : [],
					includeBodyText: false,
					target,
				});
				actionId = deps.beginTrackedAction("browser_fill_form", params, beforeState.url).id;

				// --- Detect form selector ---
				// Reuse the same detection logic as analyze_form via a lightweight evaluate
				const formSelector: string = params.selector ?? await target.evaluate(`(() => {
					const forms = Array.from(document.querySelectorAll('form'));
					if (forms.length === 1) {
						const f = forms[0];
						if (f.id) return '#' + CSS.escape(f.id);
						if (f.getAttribute('name')) return 'form[name="' + f.getAttribute('name') + '"]';
						return 'form';
					} else if (forms.length > 1) {
						let best = null;
						let bestCount = -1;
						let bestIdx = 0;
						for (let i = 0; i < forms.length; i++) {
							const inputs = forms[i].querySelectorAll('input, select, textarea');
							let vis = 0;
							inputs.forEach(inp => {
								const s = window.getComputedStyle(inp);
								if (s.display !== 'none' && s.visibility !== 'hidden') vis++;
							});
							if (vis > bestCount) { bestCount = vis; best = forms[i]; bestIdx = i; }
						}
						if (best.id) return '#' + CSS.escape(best.id);
						if (best.getAttribute('name')) return 'form[name="' + best.getAttribute('name') + '"]';
						return 'form:nth-of-type(' + (bestIdx + 1) + ')';
					}
					return 'body';
				})()`) as string;

				const formLocator = formSelector === "body"
					? target.locator("body")
					: target.locator(formSelector);

				// --- Resolve and fill each field ---
				interface MatchedField {
					key: string;
					resolvedBy: string;
					value: string;
					fieldType: string;
				}
				interface UnmatchedField {
					key: string;
					reason: string;
				}
				interface SkippedField {
					key: string;
					reason: string;
				}

				const matched: MatchedField[] = [];
				const unmatched: UnmatchedField[] = [];
				const skipped: SkippedField[] = [];

				for (const [key, value] of Object.entries(params.values)) {
					// Try to resolve the field in priority order
					let resolvedLocator: ReturnType<typeof formLocator.locator> | null = null;
					let resolvedBy = "";

					// 1. Exact label match
					try {
						const loc = formLocator.getByLabel(key, { exact: true });
						const count = await loc.count();
						if (count === 1) {
							resolvedLocator = loc;
							resolvedBy = "label (exact)";
						} else if (count > 1) {
							skipped.push({ key, reason: `Ambiguous: ${count} fields match label "${key}"` });
							continue;
						}
					} catch { /* not found, try next */ }

					// 2. Case-insensitive label match
					if (!resolvedLocator) {
						try {
							const loc = formLocator.getByLabel(key);
							const count = await loc.count();
							if (count === 1) {
								resolvedLocator = loc;
								resolvedBy = "label";
							} else if (count > 1) {
								skipped.push({ key, reason: `Ambiguous: ${count} fields match label "${key}" (case-insensitive)` });
								continue;
							}
						} catch { /* not found, try next */ }
					}

					// 3. name attribute
					if (!resolvedLocator) {
						try {
							const loc = formLocator.locator(`[name="${CSS.escape(key)}"]`);
							const count = await loc.count();
							if (count === 1) {
								resolvedLocator = loc;
								resolvedBy = "name";
							} else if (count > 1) {
								skipped.push({ key, reason: `Ambiguous: ${count} fields match name="${key}"` });
								continue;
							}
						} catch { /* not found, try next */ }
					}

					// 4. placeholder attribute (case-insensitive)
					if (!resolvedLocator) {
						try {
							const loc = formLocator.locator(`[placeholder="${key}" i]`);
							const count = await loc.count();
							if (count === 1) {
								resolvedLocator = loc;
								resolvedBy = "placeholder";
							} else if (count > 1) {
								skipped.push({ key, reason: `Ambiguous: ${count} fields match placeholder="${key}"` });
								continue;
							}
						} catch { /* not found, try next */ }
					}

					// 5. aria-label attribute (case-insensitive)
					if (!resolvedLocator) {
						try {
							const loc = formLocator.locator(`[aria-label="${key}" i]`);
							const count = await loc.count();
							if (count === 1) {
								resolvedLocator = loc;
								resolvedBy = "aria-label";
							} else if (count > 1) {
								skipped.push({ key, reason: `Ambiguous: ${count} fields match aria-label="${key}"` });
								continue;
							}
						} catch { /* not found, try next */ }
					}

					if (!resolvedLocator) {
						unmatched.push({ key, reason: "No matching field found" });
						continue;
					}

					// Determine field type
					const fieldInfo = await resolvedLocator.first().evaluate((el: Element) => {
						const tag = el.tagName.toLowerCase();
						const type = tag === "select" ? "select"
							: tag === "textarea" ? "textarea"
							: ((el as HTMLInputElement).type || "text").toLowerCase();
						const hidden = type === "hidden" ||
							(window.getComputedStyle(el).display === "none") ||
							(window.getComputedStyle(el).visibility === "hidden");
						return { tag, type, hidden };
					});

					// Skip file inputs
					if (fieldInfo.type === "file") {
						skipped.push({ key, reason: "File input — use browser_upload_file instead" });
						continue;
					}

					// Skip hidden inputs
					if (fieldInfo.hidden) {
						skipped.push({ key, reason: "Hidden input" });
						continue;
					}

					// Fill based on type
					try {
						if (fieldInfo.type === "checkbox" || fieldInfo.type === "radio") {
							const checked = value === "true" || value === "on";
							await resolvedLocator.first().setChecked(checked, { timeout: 5000 });
							matched.push({ key, resolvedBy, value: checked ? "checked" : "unchecked", fieldType: fieldInfo.type });
						} else if (fieldInfo.tag === "select") {
							// Try label first, then value
							try {
								await resolvedLocator.first().selectOption({ label: value }, { timeout: 5000 });
							} catch {
								await resolvedLocator.first().selectOption({ value }, { timeout: 5000 });
							}
							matched.push({ key, resolvedBy, value, fieldType: "select" });
						} else {
							// Text-like inputs and textarea
							await resolvedLocator.first().fill(value, { timeout: 5000 });
							matched.push({ key, resolvedBy, value, fieldType: fieldInfo.type });
						}
					} catch (fillErr: unknown) {
						const msg = fillErr instanceof Error ? fillErr.message : String(fillErr);
						skipped.push({ key, reason: `Fill failed: ${msg.split("\n")[0]}` });
					}
				}

				// --- Settle after all fills ---
				await deps.settleAfterActionAdaptive(p);

				// --- Submit if requested ---
				let submitted = false;
				if (params.submit) {
					try {
						// Find submit button in form
						const submitLoc = formLocator.locator('[type="submit"], button:not([type])').first();
						const submitExists = await submitLoc.count();
						if (submitExists > 0) {
							await submitLoc.click({ timeout: 5000 });
							await deps.settleAfterActionAdaptive(p);
							submitted = true;
						} else {
							skipped.push({ key: "_submit", reason: "No submit button found in form" });
						}
					} catch (submitErr: unknown) {
						const msg = submitErr instanceof Error ? submitErr.message : String(submitErr);
						skipped.push({ key: "_submit", reason: `Submit failed: ${msg.split("\n")[0]}` });
					}
				}

				// --- Post-fill validation state ---
				const validationSummary = await target.evaluate(
					buildPostFillValidationScript(formSelector)
				) as { valid: boolean; validCount: number; invalidCount: number; invalidFields: Array<{ name: string; message: string }> };

				const afterState = await deps.captureCompactPageState(p, {
					selectors: params.selector ? [params.selector] : [],
					includeBodyText: false,
					target,
				});
				setLastActionBeforeState(beforeState);
				setLastActionAfterState(afterState);

				deps.finishTrackedAction(actionId!, {
					status: "success",
					afterUrl: afterState.url,
					beforeState,
					afterState,
				});

				// --- Format output ---
				const lines: string[] = [];
				lines.push(`Form: ${formSelector}`);
				lines.push(`Filled: ${matched.length} | Unmatched: ${unmatched.length} | Skipped: ${skipped.length}${submitted ? " | Submitted: yes" : ""}`);
				lines.push("");

				if (matched.length > 0) {
					lines.push("## Matched");
					for (const m of matched) {
						lines.push(`- ✓ **${m.key}** → "${m.value}" (${m.fieldType}, resolved by ${m.resolvedBy})`);
					}
					lines.push("");
				}

				if (unmatched.length > 0) {
					lines.push("## Unmatched");
					for (const u of unmatched) {
						lines.push(`- ✗ **${u.key}** — ${u.reason}`);
					}
					lines.push("");
				}

				if (skipped.length > 0) {
					lines.push("## Skipped");
					for (const s of skipped) {
						lines.push(`- ⊘ **${s.key}** — ${s.reason}`);
					}
					lines.push("");
				}

				if (!validationSummary.valid) {
					lines.push("## Validation Issues");
					for (const inv of validationSummary.invalidFields) {
						lines.push(`- ${inv.name}: ${inv.message}`);
					}
				} else {
					lines.push("Validation: all fields valid ✓");
				}

				const fillResult = {
					matched,
					unmatched,
					skipped,
					submitted,
					validationSummary,
				};

				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { fillResult },
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
					{ type: "text", text: `browser_fill_form failed: ${errMsg}` },
				];
				if (screenshot) {
					content.push({ type: "image", data: screenshot.data, mimeType: screenshot.mimeType });
				}

				return { content, details: {}, isError: true };
			}
		},
	});
}
