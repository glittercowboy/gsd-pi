import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	diffCompactStates,
} from "../core.js";
import type { ToolDeps, CompactPageState } from "../state.js";
import {
	setLastActionBeforeState,
	setLastActionAfterState,
} from "../state.js";

export function registerNavigationTools(pi: ExtensionAPI, deps: ToolDeps): void {
	// -------------------------------------------------------------------------
	// browser_navigate
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_navigate",
		label: "Browser Navigate",
		description:
			"Open the browser (if not already open) and navigate to a URL. Waits for network idle. Returns page title and current URL. Use ONLY for visually verifying locally-running web apps (e.g. http://localhost:3000). Do NOT use for documentation sites, GitHub, search results, or any external URL — use web_search instead. Screenshots are only captured when the `screenshot` parameter is set to true.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to navigate to, e.g. http://localhost:3000" }),
			screenshot: Type.Optional(Type.Boolean({ description: "Capture and return a screenshot (default: false)", default: false })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			let actionId: number | null = null;
			let beforeState: CompactPageState | null = null;
			try {
				const { page: p } = await deps.ensureBrowser();
				beforeState = await deps.captureCompactPageState(p, { includeBodyText: true });
				actionId = deps.beginTrackedAction("browser_navigate", params, beforeState.url).id;
				await p.goto(params.url, { waitUntil: "domcontentloaded", timeout: 30000 });
				await p.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
				await new Promise(resolve => setTimeout(resolve, 300));

				const title = await p.title();
				const url = p.url();
				const viewport = p.viewportSize();
				const vpText = viewport ? `${viewport.width}x${viewport.height}` : "unknown";
				const afterState = await deps.captureCompactPageState(p, { includeBodyText: true });
				const summary = deps.formatCompactStateSummary(afterState);
				const jsErrors = deps.getRecentErrors(p.url());
				const diff = diffCompactStates(beforeState, afterState);
				setLastActionBeforeState(beforeState);
				setLastActionAfterState(afterState);
				deps.finishTrackedAction(actionId, {
					status: "success",
					afterUrl: afterState.url,
					warningSummary: jsErrors.trim() || undefined,
					diffSummary: diff.summary,
					changed: diff.changed,
					beforeState,
					afterState,
				});

				let screenshotContent: any[] = [];
				if (params.screenshot) {
					try {
						let buf = await p.screenshot({ type: "jpeg", quality: 80, scale: "css" });
						buf = await deps.constrainScreenshot(p, buf, "image/jpeg", 80);
						screenshotContent = [{ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" }];
					} catch {}
				}

				return {
					content: [
						{ type: "text", text: `Navigated to: ${url}\nTitle: ${title}\nViewport: ${vpText}\nAction: ${actionId}${jsErrors}\n\nDiff:\n${deps.formatDiffText(diff)}\n\nPage summary:\n${summary}` },
						...screenshotContent,
					],
					details: { title, url, status: "loaded", viewport: vpText, actionId, diff },
				};
			} catch (err: any) {
				if (actionId !== null) {
					deps.finishTrackedAction(actionId, { status: "error", afterUrl: deps.getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? undefined });
				}
				const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
				const content: any[] = [{ type: "text", text: `Navigation failed: ${err.message}` }];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return {
					content,
					details: { status: "error", error: err.message, actionId },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_go_back
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_go_back",
		label: "Browser Go Back",
		description: "Navigate back in browser history. Returns a compact page summary after navigation.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await deps.ensureBrowser();
				const response = await p.goBack({ waitUntil: "domcontentloaded", timeout: 10000 });

				if (!response) {
					return {
						content: [{ type: "text", text: "No previous page in history." }],
						details: {},
						isError: true,
					};
				}

				await p.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

				const title = await p.title();
				const url = p.url();
				const summary = await deps.postActionSummary(p);
				const jsErrors = deps.getRecentErrors(p.url());

				return {
					content: [{ type: "text", text: `Navigated back to: ${url}\nTitle: ${title}${jsErrors}\n\nPage summary:\n${summary}` }],
					details: { title, url },
				};
			} catch (err: any) {
				const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
				const content: any[] = [{ type: "text", text: `Go back failed: ${err.message}` }];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return { content, details: { error: err.message }, isError: true };
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_go_forward
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_go_forward",
		label: "Browser Go Forward",
		description: "Navigate forward in browser history. Returns a compact page summary after navigation.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await deps.ensureBrowser();
				const response = await p.goForward({ waitUntil: "domcontentloaded", timeout: 10000 });

				if (!response) {
					return {
						content: [{ type: "text", text: "No forward page in history." }],
						details: {},
						isError: true,
					};
				}

				await p.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

				const title = await p.title();
				const url = p.url();
				const summary = await deps.postActionSummary(p);
				const jsErrors = deps.getRecentErrors(p.url());

				return {
					content: [{ type: "text", text: `Navigated forward to: ${url}\nTitle: ${title}${jsErrors}\n\nPage summary:\n${summary}` }],
					details: { title, url },
				};
			} catch (err: any) {
				const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
				const content: any[] = [{ type: "text", text: `Go forward failed: ${err.message}` }];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return { content, details: { error: err.message }, isError: true };
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_reload
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_reload",
		label: "Browser Reload",
		description: "Reload the current page. Returns a screenshot, compact page summary, and page metadata (same shape as browser_navigate).",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await deps.ensureBrowser();
				await p.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
				await p.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

				const title = await p.title();
				const url = p.url();
				const viewport = p.viewportSize();
				const vpText = viewport ? `${viewport.width}x${viewport.height}` : "unknown";
				const summary = await deps.postActionSummary(p);
				const jsErrors = deps.getRecentErrors(p.url());

				let screenshotContent: any[] = [];
				try {
					let buf = await p.screenshot({ type: "jpeg", quality: 80, scale: "css" });
					buf = await deps.constrainScreenshot(p, buf, "image/jpeg", 80);
					screenshotContent = [{
						type: "image",
						data: buf.toString("base64"),
						mimeType: "image/jpeg",
					}];
				} catch {}

				return {
					content: [
						{
							type: "text",
							text: `Reloaded: ${url}\nTitle: ${title}\nViewport: ${vpText}${jsErrors}\n\nPage summary:\n${summary}`,
						},
						...screenshotContent,
					],
					details: { title, url, viewport: vpText },
				};
			} catch (err: any) {
				const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
				const content: any[] = [{ type: "text", text: `Reload failed: ${err.message}` }];
				if (errorShot) {
					content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
				}
				return { content, details: { error: err.message }, isError: true };
			}
		},
	});
}
