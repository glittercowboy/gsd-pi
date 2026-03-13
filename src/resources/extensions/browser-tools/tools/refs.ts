import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	getSnapshotModeConfig,
	SNAPSHOT_MODES,
} from "../core.js";
import type { ToolDeps, RefNode } from "../state.js";
import {
	getActiveFrame,
	getCurrentRefMap,
	setCurrentRefMap,
	getRefVersion,
	setRefVersion,
	getRefMetadata,
	setRefMetadata,
} from "../state.js";

export function registerRefTools(pi: ExtensionAPI, deps: ToolDeps): void {
	// -------------------------------------------------------------------------
	// browser_snapshot_refs
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_snapshot_refs",
		label: "Browser Snapshot Refs",
		description:
			"Capture a compact inventory of interactive elements and assign deterministic versioned refs (@vN:e1, @vN:e2, ...). Use these refs with browser_click_ref, browser_fill_ref, and browser_hover_ref.",
		parameters: Type.Object({
			selector: Type.Optional(
				Type.String({
					description: "Optional CSS selector scope for the snapshot (e.g. 'main', 'form', '#modal').",
				})
			),
			interactiveOnly: Type.Optional(
				Type.Boolean({
					description: "Include only interactive elements (default: true).",
				})
			),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of elements to include (default: 40).",
				})
			),
			mode: Type.Optional(
				Type.String({
					description: "Semantic snapshot mode that pre-filters elements by category. When set, overrides interactiveOnly. Modes: interactive, form, dialog, navigation, errors, headings, visible_only.",
				})
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();

				const mode = params.mode;
				if (mode !== undefined) {
					const modeConfig = getSnapshotModeConfig(mode);
					if (!modeConfig) {
						const validModes = Object.keys(SNAPSHOT_MODES).join(", ");
						return {
							content: [{ type: "text", text: `Unknown snapshot mode: "${mode}". Valid modes: ${validModes}` }],
							details: { error: `Unknown mode: ${mode}`, validModes: Object.keys(SNAPSHOT_MODES) },
							isError: true,
						};
					}
				}

				const interactiveOnly = params.interactiveOnly !== false;
				const limit = Math.max(1, Math.min(200, Math.floor(params.limit ?? 40)));
				const rawNodes = await deps.buildRefSnapshot(target, {
					selector: params.selector,
					interactiveOnly,
					limit,
					mode,
				});

				const newVersion = getRefVersion() + 1;
				setRefVersion(newVersion);
				const nextMap: Record<string, RefNode> = {};
				for (let i = 0; i < rawNodes.length; i += 1) {
					const ref = `e${i + 1}`;
					nextMap[ref] = { ref, ...rawNodes[i] };
				}
				setCurrentRefMap(nextMap);
				const activeFrame = getActiveFrame();
				const frameCtx = activeFrame ? (activeFrame.name() || activeFrame.url()) : undefined;
				setRefMetadata({
					url: p.url(),
					timestamp: Date.now(),
					selectorScope: params.selector,
					interactiveOnly,
					limit,
					version: newVersion,
					frameContext: frameCtx,
					mode,
				});

				if (rawNodes.length === 0) {
					return {
						content: [{
							type: "text",
							text: "No elements found for ref snapshot (try interactiveOnly=false or a wider selector scope).",
						}],
						details: {
							count: 0,
							version: newVersion,
							metadata: getRefMetadata(),
							refs: {},
						},
					};
				}

				const versionedRefs: Record<string, RefNode> = {};
				const lines = Object.values(nextMap).map((node) => {
					const versionedRef = deps.formatVersionedRef(newVersion, node.ref);
					versionedRefs[versionedRef] = node;
					const parts: string[] = [versionedRef, node.role || node.tag];
					if (node.name) parts.push(`"${node.name}"`);
					if (node.href) parts.push(`href="${node.href.slice(0, 80)}"`);
					if (!node.isVisible) parts.push("(hidden)");
					if (!node.isEnabled) parts.push("(disabled)");
					return parts.join(" ");
				});

				const modeLabel = mode ? `Mode: ${mode}\n` : "";
				return {
					content: [{
						type: "text",
						text:
							`Ref snapshot v${newVersion} (${rawNodes.length} element(s))\n` +
							`URL: ${p.url()}\n` +
							`Scope: ${params.selector ?? "body"}\n` +
							modeLabel +
							`Use versioned refs exactly as shown (e.g. @v${newVersion}:e1).\n\n` +
							lines.join("\n"),
					}],
					details: {
						count: rawNodes.length,
						version: newVersion,
						metadata: getRefMetadata(),
						refs: nextMap,
						versionedRefs,
					},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Snapshot refs failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_get_ref
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_get_ref",
		label: "Browser Get Ref",
		description: "Inspect stored metadata for one deterministic element ref (prefer versioned format, e.g. @v3:e1).",
		parameters: Type.Object({
			ref: Type.String({ description: "Reference id, preferably versioned (e.g. '@v3:e1')." }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const parsedRef = deps.parseRef(params.ref);
			const refMetadata = getRefMetadata();
			const refVersion = getRefVersion();
			if (parsedRef.version !== null && refMetadata && parsedRef.version !== refMetadata.version) {
				return {
					content: [{ type: "text", text: deps.staleRefGuidance(parsedRef.display, `snapshot version mismatch (have v${refMetadata.version})`) }],
					details: { error: "ref_stale", ref: parsedRef.display, expectedVersion: refMetadata.version, receivedVersion: parsedRef.version },
					isError: true,
				};
			}

			const currentRefMap = getCurrentRefMap();
			const node = currentRefMap[parsedRef.key];
			if (!node) {
				return {
					content: [{ type: "text", text: deps.staleRefGuidance(parsedRef.display, "ref not found") }],
					details: { error: "ref_not_found", ref: parsedRef.display, metadata: refMetadata },
					isError: true,
				};
			}

			const versionedRef = deps.formatVersionedRef(refMetadata?.version ?? refVersion, node.ref);
			return {
				content: [{
					type: "text",
					text: `${versionedRef}: ${node.role || node.tag}${node.name ? ` "${node.name}"` : ""}\nVisible: ${node.isVisible}\nEnabled: ${node.isEnabled}\nPath: ${node.xpathOrPath}`,
				}],
				details: { ref: versionedRef, node, metadata: refMetadata },
			};
		},
	});

	// -------------------------------------------------------------------------
	// browser_click_ref
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_click_ref",
		label: "Browser Click Ref",
		description: "Click a previously snapshotted element by deterministic versioned ref (e.g. @v3:e2).",
		parameters: Type.Object({
			ref: Type.String({ description: "Reference id in versioned format, e.g. '@v3:e2'." }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const parsedRef = deps.parseRef(params.ref);
			const requestedRef = parsedRef.display;
			try {
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				const refMetadata = getRefMetadata();
				const refVersion = getRefVersion();
				if (parsedRef.version === null) {
					return {
						content: [{ type: "text", text: `Unversioned ref ${requestedRef} is ambiguous. Use a versioned ref (e.g. @v${refMetadata?.version ?? refVersion}:e1) from browser_snapshot_refs.` }],
						details: { error: "ref_unversioned", ref: requestedRef, metadata: refMetadata },
						isError: true,
					};
				}
				if (refMetadata && parsedRef.version !== refMetadata.version) {
					return {
						content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, `snapshot version mismatch (have v${refMetadata.version})`) }],
						details: { error: "ref_stale", ref: requestedRef, expectedVersion: refMetadata.version, receivedVersion: parsedRef.version },
						isError: true,
					};
				}
				const currentRefMap = getCurrentRefMap();
				const ref = parsedRef.key;
				const node = currentRefMap[ref];
				if (!node) {
					return {
						content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, "ref not found") }],
						details: { error: "ref_not_found", ref: requestedRef, metadata: refMetadata },
						isError: true,
					};
				}
				if (refMetadata?.url && refMetadata.url !== p.url()) {
					return {
						content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, "URL changed since snapshot") }],
						details: { error: "ref_stale", ref: requestedRef, snapshotUrl: refMetadata.url, currentUrl: p.url() },
						isError: true,
					};
				}

				const resolved = await deps.resolveRefTarget(target, node);
				if (!resolved.ok) {
					const reason = (resolved as { ok: false; reason: string }).reason;
					return {
						content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, reason) }],
						details: { error: "ref_stale", ref: requestedRef, reason },
						isError: true,
					};
				}

				const beforeState = await deps.captureCompactPageState(p, { includeBodyText: true, target });
				const beforeUrl = beforeState.url;
				const beforeHash = deps.getUrlHash(beforeUrl);
				const beforeTargetState = await deps.captureClickTargetState(target, resolved.selector);
				await target.locator(resolved.selector).first().click({ timeout: 8000 });
				const settle = await deps.settleAfterActionAdaptive(p);

				const afterState = await deps.captureCompactPageState(p, { includeBodyText: true, target });
				const afterUrl = afterState.url;
				const afterHash = deps.getUrlHash(afterUrl);
				const afterTargetState = await deps.captureClickTargetState(target, resolved.selector);
				const targetStateChanged =
					beforeTargetState.exists !== afterTargetState.exists ||
					beforeTargetState.ariaExpanded !== afterTargetState.ariaExpanded ||
					beforeTargetState.ariaPressed !== afterTargetState.ariaPressed ||
					beforeTargetState.ariaSelected !== afterTargetState.ariaSelected ||
					beforeTargetState.open !== afterTargetState.open;
				const verification = deps.verificationFromChecks(
					[
						{ name: "url_changed", passed: afterUrl !== beforeUrl, value: afterUrl, expected: `!= ${beforeUrl}` },
						{ name: "hash_changed", passed: afterHash !== beforeHash, value: afterHash, expected: `!= ${beforeHash}` },
						{ name: "target_state_changed", passed: targetStateChanged, value: afterTargetState, expected: beforeTargetState },
						{ name: "dialog_open", passed: afterState.dialog.count > beforeState.dialog.count, value: afterState.dialog.count, expected: `> ${beforeState.dialog.count}` },
					],
					"Ref may now point to an inert element. Refresh refs with browser_snapshot_refs and retry."
				);

				const summary = deps.formatCompactStateSummary(afterState);
				const jsErrors = deps.getRecentErrors(p.url());
				const versionedRef = deps.formatVersionedRef(refMetadata?.version ?? refVersion, node.ref);
				return {
					content: [{
						type: "text",
						text: `Clicked ${versionedRef} (${node.role || node.tag}${node.name ? ` "${node.name}"` : ""})\n${deps.verificationLine(verification)}${jsErrors}\n\nPage summary:\n${summary}`,
					}],
					details: { ref: versionedRef, selector: resolved.selector, url: p.url(), ...settle, ...verification },
				};
			} catch (err: any) {
				const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
				const reason = deps.firstErrorLine(err);
				const content: any[] = [
					{ type: "text", text: deps.staleRefGuidance(requestedRef, `action failed: ${reason}`) },
					{ type: "text", text: `Click ref failed: ${err.message}` },
				];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return {
					content,
					details: { error: err.message, ref: requestedRef, hint: "Run browser_snapshot_refs to refresh refs." },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_hover_ref
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_hover_ref",
		label: "Browser Hover Ref",
		description: "Hover a previously snapshotted element by deterministic versioned ref (e.g. @v3:e4).",
		parameters: Type.Object({
			ref: Type.String({ description: "Reference id in versioned format, e.g. '@v3:e4'." }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const parsedRef = deps.parseRef(params.ref);
			const requestedRef = parsedRef.display;
			try {
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				const refMetadata = getRefMetadata();
				const refVersion = getRefVersion();
				if (parsedRef.version === null) {
					return {
						content: [{ type: "text", text: `Unversioned ref ${requestedRef} is ambiguous. Use a versioned ref (e.g. @v${refMetadata?.version ?? refVersion}:e1) from browser_snapshot_refs.` }],
						details: { error: "ref_unversioned", ref: requestedRef, metadata: refMetadata },
						isError: true,
					};
				}
				if (refMetadata && parsedRef.version !== refMetadata.version) {
					return {
						content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, `snapshot version mismatch (have v${refMetadata.version})`) }],
						details: { error: "ref_stale", ref: requestedRef, expectedVersion: refMetadata.version, receivedVersion: parsedRef.version },
						isError: true,
					};
				}
				const currentRefMap = getCurrentRefMap();
				const ref = parsedRef.key;
				const node = currentRefMap[ref];
				if (!node) {
					return {
						content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, "ref not found") }],
						details: { error: "ref_not_found", ref: requestedRef, metadata: refMetadata },
						isError: true,
					};
				}
				if (refMetadata?.url && refMetadata.url !== p.url()) {
					return {
						content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, "URL changed since snapshot") }],
						details: { error: "ref_stale", ref: requestedRef, snapshotUrl: refMetadata.url, currentUrl: p.url() },
						isError: true,
					};
				}

				const resolved = await deps.resolveRefTarget(target, node);
				if (!resolved.ok) {
					const reason = (resolved as { ok: false; reason: string }).reason;
					return {
						content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, reason) }],
						details: { error: "ref_stale", ref: requestedRef, reason },
						isError: true,
					};
				}

				await target.locator(resolved.selector).first().hover({ timeout: 8000 });
				const settle = await deps.settleAfterActionAdaptive(p);

				const afterState = await deps.captureCompactPageState(p, { includeBodyText: false, target });
				const summary = deps.formatCompactStateSummary(afterState);
				const jsErrors = deps.getRecentErrors(p.url());
				const versionedRef = deps.formatVersionedRef(refMetadata?.version ?? refVersion, node.ref);
				return {
					content: [{
						type: "text",
						text: `Hovered ${versionedRef} (${node.role || node.tag}${node.name ? ` "${node.name}"` : ""})${jsErrors}\n\nPage summary:\n${summary}`,
					}],
					details: { ref: versionedRef, selector: resolved.selector, url: p.url(), ...settle },
				};
			} catch (err: any) {
				const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
				const reason = deps.firstErrorLine(err);
				const content: any[] = [
					{ type: "text", text: deps.staleRefGuidance(requestedRef, `action failed: ${reason}`) },
					{ type: "text", text: `Hover ref failed: ${err.message}` },
				];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return {
					content,
					details: { error: err.message, ref: requestedRef, hint: "Run browser_snapshot_refs to refresh refs." },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_fill_ref
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_fill_ref",
		label: "Browser Fill Ref",
		description: "Fill/type text into an input-like element by deterministic versioned ref (e.g. @v3:e1).",
		parameters: Type.Object({
			ref: Type.String({ description: "Reference id in versioned format, e.g. '@v3:e1'." }),
			text: Type.String({ description: "Text to enter." }),
			clearFirst: Type.Optional(
				Type.Boolean({ description: "Clear existing value first (default: false)." })
			),
			submit: Type.Optional(
				Type.Boolean({ description: "Press Enter after typing (default: false)." })
			),
			slowly: Type.Optional(
				Type.Boolean({ description: "Type character-by-character (default: false)." })
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const parsedRef = deps.parseRef(params.ref);
			const requestedRef = parsedRef.display;
			try {
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				const refMetadata = getRefMetadata();
				const refVersion = getRefVersion();
				if (parsedRef.version === null) {
					return {
						content: [{ type: "text", text: `Unversioned ref ${requestedRef} is ambiguous. Use a versioned ref (e.g. @v${refMetadata?.version ?? refVersion}:e1) from browser_snapshot_refs.` }],
						details: { error: "ref_unversioned", ref: requestedRef, metadata: refMetadata },
						isError: true,
					};
				}
				if (refMetadata && parsedRef.version !== refMetadata.version) {
					return {
						content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, `snapshot version mismatch (have v${refMetadata.version})`) }],
						details: { error: "ref_stale", ref: requestedRef, expectedVersion: refMetadata.version, receivedVersion: parsedRef.version },
						isError: true,
					};
				}
				const currentRefMap = getCurrentRefMap();
				const ref = parsedRef.key;
				const node = currentRefMap[ref];
				if (!node) {
					return {
						content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, "ref not found") }],
						details: { error: "ref_not_found", ref: requestedRef, metadata: refMetadata },
						isError: true,
					};
				}
				if (refMetadata?.url && refMetadata.url !== p.url()) {
					return {
						content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, "URL changed since snapshot") }],
						details: { error: "ref_stale", ref: requestedRef, snapshotUrl: refMetadata.url, currentUrl: p.url() },
						isError: true,
					};
				}

				const resolved = await deps.resolveRefTarget(target, node);
				if (!resolved.ok) {
					const reason = (resolved as { ok: false; reason: string }).reason;
					return {
						content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, reason) }],
						details: { error: "ref_stale", ref: requestedRef, reason },
						isError: true,
					};
				}

				const locator = target.locator(resolved.selector).first();
				const beforeUrl = p.url();
				if (params.slowly) {
					await locator.click({ timeout: 8000 });
					if (params.clearFirst) {
						await p.keyboard.press("Control+A");
						await p.keyboard.press("Delete");
					}
					await p.keyboard.type(params.text);
				} else {
					if (params.clearFirst) {
						await locator.fill("");
					}
					await locator.fill(params.text, { timeout: 8000 });
				}
				if (params.submit) {
					await p.keyboard.press("Enter");
				}
				const settle = await deps.settleAfterActionAdaptive(p);

				const filledValue = await deps.readInputLikeValue(target, resolved.selector);
				const afterUrl = p.url();
				const verification = deps.verificationFromChecks(
					[
						{ name: "value_equals_expected", passed: filledValue === params.text, value: filledValue, expected: params.text },
						{ name: "value_contains_expected", passed: typeof filledValue === "string" && filledValue.includes(params.text), value: filledValue, expected: params.text },
						{ name: "url_changed_after_submit", passed: !!params.submit && afterUrl !== beforeUrl, value: afterUrl, expected: `!= ${beforeUrl}` },
					],
					"Try refreshing refs and confirm this ref still targets an input-like element."
				);

				const afterState = await deps.captureCompactPageState(p, { includeBodyText: true, target });
				const summary = deps.formatCompactStateSummary(afterState);
				const jsErrors = deps.getRecentErrors(p.url());
				const versionedRef = deps.formatVersionedRef(refMetadata?.version ?? refVersion, node.ref);
				return {
					content: [{
						type: "text",
						text: `Filled ${versionedRef} (${node.role || node.tag}${node.name ? ` "${node.name}"` : ""}) with "${params.text}"\n${deps.verificationLine(verification)}${jsErrors}\n\nPage summary:\n${summary}`,
					}],
					details: { ref: versionedRef, selector: resolved.selector, url: p.url(), filledValue, ...settle, ...verification },
				};
			} catch (err: any) {
				const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
				const reason = deps.firstErrorLine(err);
				const content: any[] = [
					{ type: "text", text: deps.staleRefGuidance(requestedRef, `action failed: ${reason}`) },
					{ type: "text", text: `Fill ref failed: ${err.message}` },
				];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return {
					content,
					details: { error: err.message, ref: requestedRef, hint: "Run browser_snapshot_refs to refresh refs." },
					isError: true,
				};
			}
		},
	});
}
