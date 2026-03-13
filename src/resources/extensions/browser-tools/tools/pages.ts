import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	registryGetActive,
	registryListPages,
	registrySetActive,
} from "../core.js";
import type { ToolDeps } from "../state.js";
import {
	getPageRegistry,
	getActiveFrame,
	setActiveFrame,
} from "../state.js";

export function registerPageTools(pi: ExtensionAPI, deps: ToolDeps): void {
	// -------------------------------------------------------------------------
	// browser_list_pages
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_list_pages",
		label: "Browser List Pages",
		description:
			"List all open browser pages/tabs with their IDs, titles, URLs, and active status. Use to see what pages are available before switching.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				await deps.ensureBrowser();
				const pageRegistry = getPageRegistry();
				for (const entry of pageRegistry.pages) {
					try {
						entry.title = await entry.page.title();
						entry.url = entry.page.url();
					} catch {
						// Page may have been closed
					}
				}
				const pages = registryListPages(pageRegistry);
				if (pages.length === 0) {
					return {
						content: [{ type: "text", text: "No pages open." }],
						details: { pages: [], count: 0 },
					};
				}
				const lines = pages.map((p: any) => {
					const active = p.isActive ? " ← active" : "";
					const opener = p.opener !== null ? ` (opener: ${p.opener})` : "";
					return `  [${p.id}] ${p.title || "(untitled)"} — ${p.url}${opener}${active}`;
				});
				return {
					content: [{ type: "text", text: `${pages.length} page(s):\n${lines.join("\n")}` }],
					details: { pages, count: pages.length },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `List pages failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_switch_page
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_switch_page",
		label: "Browser Switch Page",
		description:
			"Switch the active browser page/tab by page ID. Use browser_list_pages to see available IDs. Clears any active frame selection.",
		parameters: Type.Object({
			id: Type.Number({ description: "Page ID to switch to (from browser_list_pages)" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				await deps.ensureBrowser();
				const pageRegistry = getPageRegistry();
				registrySetActive(pageRegistry, params.id);
				setActiveFrame(null);
				const entry = registryGetActive(pageRegistry);
				await entry.page.bringToFront();
				const title = await entry.page.title().catch(() => "");
				const url = entry.page.url();
				entry.title = title;
				entry.url = url;
				return {
					content: [{ type: "text", text: `Switched to page ${params.id}: ${title || "(untitled)"} — ${url}` }],
					details: { id: params.id, title, url },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Switch page failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_close_page
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_close_page",
		label: "Browser Close Page",
		description:
			"Close a specific browser page/tab by ID. Cannot close the last remaining page. The page's close event triggers automatic registry cleanup and active-page fallback.",
		parameters: Type.Object({
			id: Type.Number({ description: "Page ID to close (from browser_list_pages)" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				await deps.ensureBrowser();
				const pageRegistry = getPageRegistry();
				if (pageRegistry.pages.length <= 1) {
					return {
						content: [{ type: "text", text: `Cannot close the last remaining page. Use browser_close to close the entire browser.` }],
						details: { error: "last_page", pageCount: pageRegistry.pages.length },
						isError: true,
					};
				}
				const entry = pageRegistry.pages.find((e: any) => e.id === params.id);
				if (!entry) {
					const available = pageRegistry.pages.map((e: any) => e.id);
					return {
						content: [{ type: "text", text: `Page ${params.id} not found. Available page IDs: [${available.join(", ")}].` }],
						details: { error: "not_found", available },
						isError: true,
					};
				}
				await entry.page.close();
				setActiveFrame(null);
				for (const remaining of pageRegistry.pages) {
					try {
						remaining.title = await remaining.page.title();
						remaining.url = remaining.page.url();
					} catch {}
				}
				const pages = registryListPages(pageRegistry);
				const lines = pages.map((p: any) => {
					const active = p.isActive ? " ← active" : "";
					return `  [${p.id}] ${p.title || "(untitled)"} — ${p.url}${active}`;
				});
				return {
					content: [{ type: "text", text: `Closed page ${params.id}. ${pages.length} page(s) remaining:\n${lines.join("\n")}` }],
					details: { closedId: params.id, pages, count: pages.length },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Close page failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_list_frames
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_list_frames",
		label: "Browser List Frames",
		description:
			"List all frames in the active page, including the main frame and any iframes. Shows frame name, URL, and parent frame name. Use before browser_select_frame to identify available frames.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				await deps.ensureBrowser();
				const p = deps.getActivePage();
				const frames = p.frames();
				const mainFrame = p.mainFrame();
				const activeFrame = getActiveFrame();
				const frameList = frames.map((f, index) => {
					const isMain = f === mainFrame;
					const parentName = f.parentFrame()?.name() || (f.parentFrame() === mainFrame ? "main" : "");
					return {
						index,
						name: f.name() || (isMain ? "main" : `(unnamed-${index})`),
						url: f.url(),
						isMain,
						parentName: isMain ? null : (parentName || "main"),
						isActive: f === activeFrame,
					};
				});
				const lines = frameList.map((f) => {
					const main = f.isMain ? " [main]" : "";
					const active = f.isActive ? " ← selected" : "";
					const parent = f.parentName ? ` (parent: ${f.parentName})` : "";
					return `  [${f.index}] "${f.name}" — ${f.url}${main}${parent}${active}`;
				});
				const activeInfo = activeFrame ? `Active frame: "${activeFrame.name() || "(unnamed)"}"` : "No frame selected (operating on main page)";
				return {
					content: [{ type: "text", text: `${frameList.length} frame(s) in active page:\n${lines.join("\n")}\n\n${activeInfo}` }],
					details: { frames: frameList, count: frameList.length, activeFrame: activeFrame?.name() ?? null },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `List frames failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_select_frame
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_select_frame",
		label: "Browser Select Frame",
		description:
			"Select a frame within the active page to operate on. Find frames by name, URL pattern, or index. Pass null or \"main\" to reset back to the main page frame. Once a frame is selected, tools like browser_evaluate, browser_find, and browser_click will operate within that frame (after T03 migration).",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Frame name to select. Use 'main' or 'null' to reset to main frame." })),
			urlPattern: Type.Optional(Type.String({ description: "URL substring to match against frame URLs." })),
			index: Type.Optional(Type.Number({ description: "Frame index from browser_list_frames." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				await deps.ensureBrowser();
				const p = deps.getActivePage();
				const frames = p.frames();

				if (params.name === "main" || params.name === "null" || params.name === null) {
					setActiveFrame(null);
					return {
						content: [{ type: "text", text: "Reset to main page frame. Tools will operate on the main page." }],
						details: { activeFrame: null },
					};
				}

				if (params.name) {
					const frame = frames.find((f) => f.name() === params.name);
					if (!frame) {
						const available = frames.map((f, i) => `[${i}] "${f.name() || "(unnamed)"}" — ${f.url()}`);
						return {
							content: [{ type: "text", text: `Frame with name "${params.name}" not found.\nAvailable frames:\n  ${available.join("\n  ")}` }],
							details: { error: "frame_not_found", available },
							isError: true,
						};
					}
					setActiveFrame(frame);
					return {
						content: [{ type: "text", text: `Selected frame "${frame.name()}" — ${frame.url()}` }],
						details: { name: frame.name(), url: frame.url() },
					};
				}

				if (params.urlPattern) {
					const frame = frames.find((f) => f.url().includes(params.urlPattern!));
					if (!frame) {
						const available = frames.map((f, i) => `[${i}] "${f.name() || "(unnamed)"}" — ${f.url()}`);
						return {
							content: [{ type: "text", text: `No frame URL matches "${params.urlPattern}".\nAvailable frames:\n  ${available.join("\n  ")}` }],
							details: { error: "frame_not_found", available },
							isError: true,
						};
					}
					setActiveFrame(frame);
					return {
						content: [{ type: "text", text: `Selected frame "${frame.name() || "(unnamed)"}" — ${frame.url()}` }],
						details: { name: frame.name(), url: frame.url() },
					};
				}

				if (params.index !== undefined) {
					if (params.index < 0 || params.index >= frames.length) {
						return {
							content: [{ type: "text", text: `Frame index ${params.index} out of range. ${frames.length} frame(s) available (0-${frames.length - 1}).` }],
							details: { error: "index_out_of_range", count: frames.length },
							isError: true,
						};
					}
					const frame = frames[params.index];
					setActiveFrame(frame);
					return {
						content: [{ type: "text", text: `Selected frame [${params.index}] "${frame.name() || "(unnamed)"}" — ${frame.url()}` }],
						details: { index: params.index, name: frame.name(), url: frame.url() },
					};
				}

				return {
					content: [{ type: "text", text: "Provide name, urlPattern, or index to select a frame. Use name='main' to reset to main frame." }],
					details: { error: "no_criteria" },
					isError: true,
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Select frame failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});
}
