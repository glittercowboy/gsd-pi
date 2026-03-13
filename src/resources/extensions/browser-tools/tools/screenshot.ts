import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ToolDeps } from "../state.js";

export function registerScreenshotTools(pi: ExtensionAPI, deps: ToolDeps): void {
	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description:
			"Take a screenshot of the current browser page and return it as an inline image. Uses JPEG for viewport/fullpage (smaller, configurable quality) and PNG for element crops (preserves transparency). Optionally crop to a specific element by CSS selector.",
		parameters: Type.Object({
			fullPage: Type.Optional(
				Type.Boolean({ description: "Capture the full scrollable page (default: false)" })
			),
			selector: Type.Optional(
				Type.String({
					description:
						"CSS selector of a specific element to screenshot (crops to that element's bounding box). If omitted, screenshots the entire viewport.",
				})
			),
			quality: Type.Optional(
				Type.Number({
					description:
						"JPEG quality 1-100 (default: 80). Only applies to viewport/fullpage screenshots, not element crops. Lower = smaller image.",
				})
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await deps.ensureBrowser();

				let screenshotBuffer: Buffer;
				let mimeType: string;
				const quality = params.quality ?? 80;

				if (params.selector) {
					const locator = p.locator(params.selector).first();
					screenshotBuffer = await locator.screenshot({ type: "png", scale: "css" });
					mimeType = "image/png";
				} else {
					screenshotBuffer = await p.screenshot({
						fullPage: params.fullPage ?? false,
						type: "jpeg",
						quality,
						scale: "css",
					});
					mimeType = "image/jpeg";
				}

				screenshotBuffer = await deps.constrainScreenshot(p, screenshotBuffer, mimeType, quality);

				const base64Data = screenshotBuffer.toString("base64");
				const title = await p.title();
				const url = p.url();
				const viewport = p.viewportSize();
				const vpText = viewport ? `${viewport.width}x${viewport.height}` : "unknown";
				const scope = params.selector ? `element "${params.selector}"` : params.fullPage ? "full page" : "viewport";

				return {
					content: [
						{
							type: "text",
							text: `Screenshot of ${scope}.\nPage: ${title}\nURL: ${url}\nViewport: ${vpText}`,
						},
						{
							type: "image",
							data: base64Data,
							mimeType,
						},
					],
					details: { title, url, scope, viewport: vpText },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Screenshot failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});
}
