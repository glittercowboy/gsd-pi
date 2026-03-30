/**
 * mac-tools — pi extension
 *
 * Gives the agent macOS automation capabilities via a Swift CLI that interfaces
 * with Accessibility APIs, NSWorkspace, and CGWindowList.
 *
 * Architecture:
 *  - Swift CLI (`swift-cli/`) handles all macOS API calls
 *  - JSON protocol: stdin `{ command, params }` → stdout `{ success, data?, error? }`
 *  - TS extension invokes CLI per-command via execFileSync
 *  - Mtime-based compilation caching: recompiles only when source files change
 *  - All Swift debug output goes to stderr; only JSON on stdout
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { StringEnum } from "@gsd/pi-ai";
import { Type } from "@sinclair/typebox";
import { execFileSync } from "node:child_process";
import { statSync, readdirSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const EXTENSION_DIR = path.dirname(new URL(import.meta.url).pathname);
const SWIFT_CLI_DIR = path.join(EXTENSION_DIR, "swift-cli");
const SOURCES_DIR = path.join(SWIFT_CLI_DIR, "Sources");
const BINARY_PATH = path.join(SWIFT_CLI_DIR, ".build", "release", "mac-agent");
const PACKAGE_SWIFT = path.join(SWIFT_CLI_DIR, "Package.swift");

// ---------------------------------------------------------------------------
// Compilation caching
// ---------------------------------------------------------------------------

/** Get the latest mtime (ms) across all Swift source files and Package.swift. */
function getSourceMtime(): number {
	let latest = 0;
	// Check Package.swift
	try {
		latest = Math.max(latest, statSync(PACKAGE_SWIFT).mtimeMs);
	} catch (err) { if (process.env.GSD_DEBUG) console.error("[mac-tools] stat Package.swift failed:", (err as Error).message); }
	// Check all files in Sources/
	try {
		const files = readdirSync(SOURCES_DIR);
		for (const f of files) {
			try {
				const mt = statSync(path.join(SOURCES_DIR, f)).mtimeMs;
				if (mt > latest) latest = mt;
			} catch (err) { if (process.env.GSD_DEBUG) console.error(`[mac-tools] stat Sources/${f} failed:`, (err as Error).message); }
		}
	} catch (err) { if (process.env.GSD_DEBUG) console.error("[mac-tools] readdir Sources/ failed:", (err as Error).message); }
	return latest;
}

/** Get the binary mtime (ms), or 0 if it doesn't exist. */
function getBinaryMtime(): number {
	try {
		return statSync(BINARY_PATH).mtimeMs;
	} catch {
		return 0;
	}
}

/** Compile the Swift CLI if source files are newer than the binary. */
function ensureCompiled(): void {
	const srcMtime = getSourceMtime();
	const binMtime = getBinaryMtime();

	if (binMtime > 0 && binMtime >= srcMtime) {
		return; // Binary is up-to-date
	}

	const action = binMtime === 0 ? "Compiling" : "Recompiling";
	try {
		execFileSync("swift", ["build", "-c", "release"], {
			cwd: SWIFT_CLI_DIR,
			timeout: 30_000,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (err: any) {
		const stderr = err.stderr?.toString() || "";
		const stdout = err.stdout?.toString() || "";
		throw new Error(
			`Swift compilation failed (${action.toLowerCase()}):\n${stderr || stdout || err.message}`
		);
	}
}

// ---------------------------------------------------------------------------
// CLI invocation
// ---------------------------------------------------------------------------

interface MacAgentResponse {
	success: boolean;
	data?: Record<string, any>;
	error?: string;
}

/**
 * Invoke the mac-agent CLI with a command and optional params.
 * Handles compilation caching, stdin/stdout JSON protocol, and error surfacing.
 */
function execMacAgent(command: string, params?: Record<string, any>): MacAgentResponse {
	ensureCompiled();

	const input = JSON.stringify({ command, params: params ?? {} });
	let stdout: string;
	let stderr: string = "";

	// Interaction commands (click, type) can block while the target app
	// processes the action — e.g. TextEdit's AXPress on "New Document"
	// takes ~12s while it dismisses the Open dialog and creates a window.
	// Screenshots can also be slow for large retina windows.
	const slowCommands = new Set(["clickElement", "typeText", "screenshotWindow"]);
	const timeout = slowCommands.has(command) ? 30_000 : 10_000;

	try {
		const result = execFileSync(BINARY_PATH, [], {
			input,
			timeout,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			maxBuffer: 5 * 1024 * 1024, // 5MB — needed for retina screenshot base64 payloads
		});
		stdout = typeof result === "string" ? result : String(result);
	} catch (err: any) {
		stderr = err.stderr?.toString() || "";
		const isTimeout = err.killed || err.signal === "SIGTERM";
		// If the process exited non-zero but produced stdout, try to parse it
		if (err.stdout) {
			stdout = err.stdout.toString();
		} else if (isTimeout) {
			throw new Error(
				`mac-agent timed out after ${timeout / 1000}s (command: ${command}). ` +
				`The target app may be slow to respond — AXPress can block while the app processes the action.`
			);
		} else {
			throw new Error(
				`mac-agent CLI failed (command: ${command}):\n${stderr || err.message}`
			);
		}
	}

	try {
		return JSON.parse(stdout.trim()) as MacAgentResponse;
	} catch {
		throw new Error(
			`mac-agent returned invalid JSON (command: ${command}):\nstdout: ${stdout}\nstderr: ${stderr}`
		);
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// -----------------------------------------------------------------
	// mac_check_permissions
	// -----------------------------------------------------------------
	pi.registerTool({
		name: "mac_check_permissions",
		label: "Mac Permissions",
		description:
			"Check whether macOS Accessibility and Screen Recording permissions are enabled for the current terminal. " +
			"Returns { accessibilityEnabled, screenRecordingEnabled }. Accessibility is required for UI automation; " +
			"Screen Recording is required for mac_screenshot. Both are granted in System Settings > Privacy & Security.",
		promptGuidelines: [
			"Run this first if any mac tool returns a permission error.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId: any) {
			const result = execMacAgent("checkPermissions");
			if (!result.success) {
				throw new Error("mac_check_permissions: " + result.error);
			}
			const accessibility = result.data?.accessibilityEnabled ?? false;
			const screenRecording = result.data?.screenRecordingEnabled ?? false;

			const lines: string[] = [];
			lines.push(accessibility
				? "✅ Accessibility: enabled"
				: "❌ Accessibility: NOT enabled — grant in System Settings > Privacy & Security > Accessibility");
			lines.push(screenRecording
				? "✅ Screen Recording: enabled"
				: "❌ Screen Recording: NOT enabled — grant in System Settings > Privacy & Security > Screen Recording");

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: result.data,
			};
		},
	});

	// -----------------------------------------------------------------
	// mac_list_apps
	// -----------------------------------------------------------------
	pi.registerTool({
		name: "mac_list_apps",
		label: "List Apps",
		description:
			"List all running macOS applications. Returns an array of { name, bundleId, pid, isActive } " +
			"for user-facing apps (regular activation policy). Set includeBackground to true to also " +
			"include accessory/background apps.",
		promptGuidelines: [
			"Use to discover what apps are running before interacting with them.",
		],
		parameters: Type.Object({
			includeBackground: Type.Optional(Type.Boolean({ description: "Include background/accessory apps (default: false)" })),
		}),

		async execute(_toolCallId: any, { includeBackground }: { includeBackground?: boolean }) {
			const result = execMacAgent("listApps", includeBackground ? { includeBackground: true } : undefined);
			if (!result.success) {
				throw new Error("mac_list_apps: " + result.error);
			}
			const apps = result.data as unknown as Array<{ name: string; bundleId: string; pid: number; isActive: boolean }>;
			const summary = apps.map(a => `${a.name} (${a.bundleId}) pid:${a.pid}${a.isActive ? " [active]" : ""}`).join("\n");
			return {
				content: [{ type: "text" as const, text: `${apps.length} running apps:\n${summary}` }],
				details: { apps },
			};
		},
	});

	// -----------------------------------------------------------------
	// mac_launch_app
	// -----------------------------------------------------------------
	pi.registerTool({
		name: "mac_launch_app",
		label: "Launch App",
		description:
			"Launch a macOS application by name or bundle ID. " +
			"Returns { launched, name, bundleId, pid } on success. " +
			"Provide either 'name' (e.g. 'TextEdit') or 'bundleId' (e.g. 'com.apple.TextEdit').",
		promptGuidelines: [
			"Use app name for well-known apps; use bundleId when the name is ambiguous.",
		],
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Application name (e.g. 'TextEdit', 'Safari')" })),
			bundleId: Type.Optional(Type.String({ description: "Bundle identifier (e.g. 'com.apple.TextEdit')" })),
		}),

		async execute(_toolCallId: any, { name, bundleId }: { name?: string; bundleId?: string }) {
			if (!name && !bundleId) {
				throw new Error("mac_launch_app: provide either 'name' or 'bundleId' parameter");
			}
			const params: Record<string, string> = {};
			if (name) params.name = name;
			if (bundleId) params.bundleId = bundleId;

			const result = execMacAgent("launchApp", params);
			if (!result.success) {
				throw new Error("mac_launch_app: " + result.error);
			}
			const d = result.data!;
			return {
				content: [{ type: "text" as const, text: `Launched ${d.name} (${d.bundleId}) pid:${d.pid}` }],
				details: result.data,
			};
		},
	});

	// -----------------------------------------------------------------
	// mac_activate_app
	// -----------------------------------------------------------------
	pi.registerTool({
		name: "mac_activate_app",
		label: "Activate App",
		description:
			"Bring a running macOS application to the front. " +
			"Returns { activated, name } on success. Errors if the app is not running. " +
			"Provide either 'name' or 'bundleId'.",
		promptGuidelines: [
			"Activate an app before interacting with its UI to ensure it is frontmost.",
		],
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Application name" })),
			bundleId: Type.Optional(Type.String({ description: "Bundle identifier" })),
		}),

		async execute(_toolCallId: any, { name, bundleId }: { name?: string; bundleId?: string }) {
			if (!name && !bundleId) {
				throw new Error("mac_activate_app: provide either 'name' or 'bundleId' parameter");
			}
			const params: Record<string, string> = {};
			if (name) params.name = name;
			if (bundleId) params.bundleId = bundleId;

			const result = execMacAgent("activateApp", params);
			if (!result.success) {
				throw new Error("mac_activate_app: " + result.error);
			}
			return {
				content: [{ type: "text" as const, text: `Activated ${result.data?.name}` }],
				details: result.data,
			};
		},
	});

	// -----------------------------------------------------------------
	// mac_quit_app
	// -----------------------------------------------------------------
	pi.registerTool({
		name: "mac_quit_app",
		label: "Quit App",
		description:
			"Quit a running macOS application. " +
			"Returns { quit, name } on success. Errors if the app is not running. " +
			"Provide either 'name' or 'bundleId'.",
		promptGuidelines: [
			"Use to clean up apps launched during automation — don't leave apps running unnecessarily.",
		],
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Application name" })),
			bundleId: Type.Optional(Type.String({ description: "Bundle identifier" })),
		}),

		async execute(_toolCallId: any, { name, bundleId }: { name?: string; bundleId?: string }) {
			if (!name && !bundleId) {
				throw new Error("mac_quit_app: provide either 'name' or 'bundleId' parameter");
			}
			const params: Record<string, string> = {};
			if (name) params.name = name;
			if (bundleId) params.bundleId = bundleId;

			const result = execMacAgent("quitApp", params);
			if (!result.success) {
				throw new Error("mac_quit_app: " + result.error);
			}
			return {
				content: [{ type: "text" as const, text: `Quit ${result.data?.name}` }],
				details: result.data,
			};
		},
	});

	// -----------------------------------------------------------------
	// mac_list_windows
	// -----------------------------------------------------------------
	pi.registerTool({
		name: "mac_list_windows",
		label: "List Windows",
		description:
			"List all on-screen windows for a macOS application. " +
			"Returns an array of { windowId, title, bounds: {x,y,width,height}, isOnScreen, layer }. " +
			"The windowId can be used with getWindowInfo for detailed inspection or with screenshotWindow for capture. " +
			"Returns an empty array (not error) if the app is running but has no visible windows. " +
			"Errors if the app is not running.",
		promptGuidelines: [
			"Use to get windowId values needed by mac_screenshot.",
		],
		parameters: Type.Object({
			app: Type.String({ description: "Application name (e.g. 'TextEdit') or bundle identifier (e.g. 'com.apple.TextEdit')" }),
		}),

		async execute(_toolCallId: any, { app }: { app: string }) {
			const result = execMacAgent("listWindows", { app });
			if (!result.success) {
				throw new Error("mac_list_windows: " + result.error);
			}
			const data = result.data as { windows: Array<{ windowId: number; title: string; bounds: Record<string, number>; isOnScreen: boolean; layer: number }>; app: string; pid: number };
			const windows = data.windows ?? [];
			if (windows.length === 0) {
				return {
					content: [{ type: "text" as const, text: `${data.app} (pid:${data.pid}) has no visible windows.` }],
					details: data,
				};
			}
			const summary = windows.map(w =>
				`  windowId:${w.windowId} "${w.title}" ${w.bounds.width}x${w.bounds.height} at (${w.bounds.x},${w.bounds.y}) layer:${w.layer}`
			).join("\n");
			return {
				content: [{ type: "text" as const, text: `${data.app} (pid:${data.pid}) — ${windows.length} window(s):\n${summary}` }],
				details: data,
			};
		},
	});

	// -----------------------------------------------------------------
	// mac_find
	// -----------------------------------------------------------------
	pi.registerTool({
		name: "mac_find",
		label: "Find Elements",
		description:
			"Find UI elements in a macOS application's accessibility tree. Three modes:\n" +
			"- 'search' (default): Find elements matching role/title/value/identifier criteria. Returns a numbered list of matches.\n" +
			"- 'tree': Dump the full accessibility subtree as an indented tree. Use maxDepth/maxCount to bound output.\n" +
			"- 'focused': Get the currently focused element in the app. No criteria needed.\n" +
			"The 'app' param accepts an app name (e.g. 'Finder') or bundle ID (e.g. 'com.apple.Finder').",
		promptGuidelines: [
			"Prefer for targeted element search — use role/title/value criteria to narrow results.",
			"Use mode:focused to check the current focus target without search criteria.",
			"Use mac_get_tree instead of mode:tree when you just need to understand app structure.",
		],
		parameters: Type.Object({
			app: Type.String({ description: "Application name or bundle identifier" }),
			mode: Type.Optional(StringEnum(["search", "tree", "focused"] as const, { description: "'search' (default), 'tree', or 'focused'" })),
			role: Type.Optional(Type.String({ description: "AX role to match (e.g. 'AXButton', 'AXTextArea')" })),
			title: Type.Optional(Type.String({ description: "AX title to match" })),
			value: Type.Optional(Type.String({ description: "AX value to match" })),
			identifier: Type.Optional(Type.String({ description: "AX identifier to match" })),
			matchType: Type.Optional(Type.String({ description: "'exact' (default) or 'contains'" })),
			maxDepth: Type.Optional(Type.Number({ description: "Maximum tree depth to traverse (default: 10)" })),
			maxCount: Type.Optional(Type.Number({ description: "Maximum elements to return/visit (default: 100)" })),
		}),

		async execute(_toolCallId: any, args: {
			app: string;
			mode?: string;
			role?: string;
			title?: string;
			value?: string;
			identifier?: string;
			matchType?: string;
			maxDepth?: number;
			maxCount?: number;
		}) {
			const mode = args.mode ?? "search";

			// --- Focused mode ---
			if (mode === "focused") {
				const result = execMacAgent("getFocusedElement", { app: args.app });
				if (!result.success) {
					throw new Error("mac_find (focused): " + result.error);
				}
				const el = result.data as Record<string, any>;
				const parts = [el.role ?? "unknown"];
				if (el.title) parts.push(`"${el.title}"`);
				if (el.value !== undefined) parts.push(`[${el.value}]`);
				return {
					content: [{ type: "text" as const, text: `Focused element: ${parts.join(" ")}` }],
					details: result.data,
				};
			}

			// --- Tree mode ---
			if (mode === "tree") {
				const params: Record<string, any> = { app: args.app };
				if (args.maxDepth !== undefined) params.maxDepth = args.maxDepth;
				if (args.maxCount !== undefined) params.maxCount = args.maxCount;

				const result = execMacAgent("getTree", params);
				if (!result.success) {
					throw new Error("mac_find (tree): " + result.error);
				}

				const data = result.data as { tree: any[]; totalElements: number; truncated: boolean };
				const lines: string[] = [];

				function renderTree(nodes: any[], indent: number) {
					for (const node of nodes) {
						const parts = [node.role ?? "?"];
						if (node.title) parts.push(`"${node.title}"`);
						if (node.value !== undefined && node.value !== "") parts.push(`[${node.value}]`);
						lines.push("  ".repeat(indent) + parts.join(" "));
						if (node.children?.length) {
							renderTree(node.children, indent + 1);
						}
					}
				}

				renderTree(data.tree ?? [], 0);
				const truncNote = data.truncated ? `\n(truncated — ${data.totalElements} elements visited)` : "";
				return {
					content: [{ type: "text" as const, text: `${lines.join("\n")}${truncNote}` }],
					details: result.data,
				};
			}

			// --- Search mode (default) ---
			const params: Record<string, any> = { app: args.app };
			if (args.role) params.role = args.role;
			if (args.title) params.title = args.title;
			if (args.value) params.value = args.value;
			if (args.identifier) params.identifier = args.identifier;
			if (args.matchType) params.matchType = args.matchType;
			if (args.maxDepth !== undefined) params.maxDepth = args.maxDepth;
			if (args.maxCount !== undefined) params.maxCount = args.maxCount;

			const result = execMacAgent("findElements", params);
			if (!result.success) {
				throw new Error("mac_find (search): " + result.error);
			}

			const data = result.data as { elements: any[]; totalVisited: number; truncated: boolean };
			const elements = data.elements ?? [];

			if (elements.length === 0) {
				const criteria = [args.role, args.title, args.value, args.identifier].filter(Boolean).join(", ");
				return {
					content: [{ type: "text" as const, text: `No elements found matching: ${criteria || "(no criteria)"}` }],
					details: result.data,
				};
			}

			const lines = elements.map((el: any, i: number) => {
				const parts = [`${i + 1}. ${el.role ?? "?"}`];
				if (el.title) parts.push(`"${el.title}"`);
				if (el.value !== undefined && el.value !== "") parts.push(`[${el.value}]`);
				return parts.join(" ");
			});
			const truncNote = data.truncated ? `\n(truncated — search stopped at limit)` : "";
			return {
				content: [{ type: "text" as const, text: `${elements.length} element(s) found:\n${lines.join("\n")}${truncNote}` }],
				details: result.data,
			};
		},
	});

	// -----------------------------------------------------------------
	// mac_get_tree
	// -----------------------------------------------------------------
	pi.registerTool({
		name: "mac_get_tree",
		label: "Get UI Tree",
		description:
			"Get a compact accessibility tree of a macOS application's UI structure. " +
			"Returns an indented tree showing role, title, and value of each element. " +
			"Tighter defaults than mac_find's tree mode — designed for quick structure inspection. " +
			"Each line: `role \"title\" [value]` with 2-space indent per depth level. " +
			"Omits title/value when nil or empty.",
		promptGuidelines: [
			"Use for understanding app UI structure — start with low limits and increase if needed.",
			"Prefer mac_find search mode when you know what you're looking for.",
			"Check the truncation note to know if the tree was cut short.",
		],
		parameters: Type.Object({
			app: Type.String({ description: "Application name or bundle identifier" }),
			maxDepth: Type.Optional(Type.Number({ description: "Maximum tree depth to traverse (default: 3)" })),
			maxCount: Type.Optional(Type.Number({ description: "Maximum elements to include (default: 50)" })),
		}),

		async execute(_toolCallId: any, args: { app: string; maxDepth?: number; maxCount?: number }) {
			const params: Record<string, any> = { app: args.app };
			params.maxDepth = args.maxDepth ?? 3;
			params.maxCount = args.maxCount ?? 50;

			const result = execMacAgent("getTree", params);
			if (!result.success) {
				throw new Error("mac_get_tree: " + result.error);
			}

			const data = result.data as { tree: any[]; totalElements: number; truncated: boolean };
			const lines: string[] = [];

			function renderNode(nodes: any[], indent: number) {
				for (const node of nodes) {
					const parts = [node.role ?? "?"];
					if (node.title) parts.push(`"${node.title}"`);
					if (node.value !== undefined && node.value !== null && node.value !== "") parts.push(`[${node.value}]`);
					lines.push("  ".repeat(indent) + parts.join(" "));
					if (node.children?.length) {
						renderNode(node.children, indent + 1);
					}
				}
			}

			renderNode(data.tree ?? [], 0);
			if (data.truncated) {
				lines.push(`\n(truncated — ${data.totalElements} elements visited, increase maxDepth or maxCount for more)`);
			}
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { totalElements: data.totalElements, truncated: data.truncated },
			};
		},
	});

	// -----------------------------------------------------------------
	// mac_click
	// -----------------------------------------------------------------
	pi.registerTool({
		name: "mac_click",
		label: "Click Element",
		description:
			"Click a UI element in a macOS application by performing AXPress. " +
			"Finds the first element matching the given criteria (role, title, value, identifier) and clicks it. " +
			"At least one criterion is required. Returns the clicked element's attributes.",
		promptGuidelines: [
			"Verify the click worked by reading the resulting state with mac_find or mac_read.",
			"Use mac_find first to discover the right role/title/value criteria before clicking.",
		],
		parameters: Type.Object({
			app: Type.String({ description: "Application name or bundle identifier" }),
			role: Type.Optional(Type.String({ description: "AX role (e.g. 'AXButton', 'AXMenuItem')" })),
			title: Type.Optional(Type.String({ description: "AX title to match" })),
			value: Type.Optional(Type.String({ description: "AX value to match" })),
			identifier: Type.Optional(Type.String({ description: "AX identifier to match" })),
			matchType: Type.Optional(Type.String({ description: "'exact' (default) or 'contains'" })),
		}),

		async execute(_toolCallId: any, args: {
			app: string;
			role?: string;
			title?: string;
			value?: string;
			identifier?: string;
			matchType?: string;
		}) {
			if (!args.role && !args.title && !args.value && !args.identifier) {
				throw new Error("mac_click: provide at least one search criterion (role, title, value, or identifier)");
			}
			const params: Record<string, any> = { app: args.app };
			if (args.role) params.role = args.role;
			if (args.title) params.title = args.title;
			if (args.value) params.value = args.value;
			if (args.identifier) params.identifier = args.identifier;
			if (args.matchType) params.matchType = args.matchType;

			const result = execMacAgent("clickElement", params);
			if (!result.success) {
				throw new Error("mac_click: " + result.error);
			}

			const el = result.data?.element as Record<string, any> | undefined;
			const parts = [el?.role ?? "element"];
			if (el?.title) parts.push(`'${el.title}'`);
			return {
				content: [{ type: "text" as const, text: `Clicked ${parts.join(" ")}` }],
				details: result.data,
			};
		},
	});

	// -----------------------------------------------------------------
	// mac_type
	// -----------------------------------------------------------------
	pi.registerTool({
		name: "mac_type",
		label: "Type Text",
		description:
			"Type text into a UI element in a macOS application by setting its AXValue attribute. " +
			"Finds the first element matching the given criteria and sets its value. " +
			"Returns the actual value after setting (read-back verification). " +
			"At least one criterion is required.",
		promptGuidelines: [
			"Read back the value after typing to verify — the return value includes actual content.",
			"Target text fields/areas by role (AXTextArea, AXTextField) for reliability.",
		],
		parameters: Type.Object({
			app: Type.String({ description: "Application name or bundle identifier" }),
			text: Type.String({ description: "Text to type into the element" }),
			role: Type.Optional(Type.String({ description: "AX role (e.g. 'AXTextArea', 'AXTextField')" })),
			title: Type.Optional(Type.String({ description: "AX title to match" })),
			value: Type.Optional(Type.String({ description: "AX value to match" })),
			identifier: Type.Optional(Type.String({ description: "AX identifier to match" })),
			matchType: Type.Optional(Type.String({ description: "'exact' (default) or 'contains'" })),
		}),

		async execute(_toolCallId: any, args: {
			app: string;
			text: string;
			role?: string;
			title?: string;
			value?: string;
			identifier?: string;
			matchType?: string;
		}) {
			if (!args.role && !args.title && !args.value && !args.identifier) {
				throw new Error("mac_type: provide at least one search criterion (role, title, value, or identifier)");
			}
			const params: Record<string, any> = { app: args.app, text: args.text };
			if (args.role) params.role = args.role;
			if (args.title) params.title = args.title;
			if (args.value) params.value = args.value;
			if (args.identifier) params.identifier = args.identifier;
			if (args.matchType) params.matchType = args.matchType;

			const result = execMacAgent("typeText", params);
			if (!result.success) {
				throw new Error("mac_type: " + result.error);
			}

			const el = result.data?.element as Record<string, any> | undefined;
			const actualValue = result.data?.value;
			const parts = [el?.role ?? "element"];
			if (el?.title) parts.push(`'${el.title}'`);
			return {
				content: [{ type: "text" as const, text: `Typed into ${parts.join(" ")} — value is now: ${actualValue}` }],
				details: result.data,
			};
		},
	});

	// -----------------------------------------------------------------
	// mac_screenshot
	// -----------------------------------------------------------------
	pi.registerTool({
		name: "mac_screenshot",
		label: "Screenshot Window",
		description:
			"Take a screenshot of a macOS application window by its window ID (from mac_list_windows). " +
			"Returns the screenshot as an image content block for visual analysis, alongside text metadata " +
			"(dimensions and format). Requires Screen Recording permission — use mac_check_permissions to verify.",
		promptGuidelines: [
			"Use for visual verification when accessibility attributes aren't sufficient.",
			"Prefer nominal resolution unless retina detail is needed — retina doubles payload size.",
			"Requires Screen Recording permission — run mac_check_permissions first if screenshot fails.",
		],
		parameters: Type.Object({
			windowId: Type.Number({ description: "Window ID from mac_list_windows output" }),
			format: Type.Optional(StringEnum(["jpeg", "png"] as const, { description: "'jpeg' (default) or 'png'" })),
			quality: Type.Optional(Type.Number({ description: "JPEG compression quality 0-1 (default: 0.8)" })),
			retina: Type.Optional(Type.Boolean({ description: "Capture at full pixel resolution (default: false)" })),
		}),

		async execute(_toolCallId: any, args: { windowId: number; format?: string; quality?: number; retina?: boolean }) {
			const params: Record<string, any> = { windowId: args.windowId };
			if (args.format) params.format = args.format;
			if (args.quality !== undefined) params.quality = args.quality;
			if (args.retina !== undefined) params.retina = args.retina;

			const result = execMacAgent("screenshotWindow", params);
			if (!result.success) {
				throw new Error("mac_screenshot: " + result.error);
			}

			const data = result.data!;
			const imageData = data.imageData as string;
			const format = data.format as string;
			const width = data.width as number;
			const height = data.height as number;
			const mimeType = format === "png" ? "image/png" : "image/jpeg";

			return {
				content: [
					{ type: "text" as const, text: `Screenshot: ${width}x${height} ${format}` },
					{ type: "image" as const, data: imageData, mimeType },
				],
				details: { width, height, format, mimeType },
			};
		},
	});

	// -----------------------------------------------------------------
	// mac_read
	// -----------------------------------------------------------------
	pi.registerTool({
		name: "mac_read",
		label: "Read Attribute",
		description:
			"Read one or more accessibility attributes from a UI element in a macOS application. " +
			"Finds the first element matching the given criteria and reads the named attribute(s). " +
			"AXValue subtypes (CGPoint, CGSize, CGRect, CFRange) are automatically unpacked to structured dicts. " +
			"Use 'attribute' for a single attribute or 'attributes' for multiple. At least one search criterion is required.",
		promptGuidelines: [
			"Use to verify state after actions — read AXValue to confirm text was typed, AXEnabled to check if a button is active.",
		],
		parameters: Type.Object({
			app: Type.String({ description: "Application name or bundle identifier" }),
			attribute: Type.Optional(Type.String({ description: "Single attribute name to read (e.g. 'AXValue', 'AXPosition', 'AXRole')" })),
			attributes: Type.Optional(Type.Array(Type.String(), { description: "Multiple attribute names to read" })),
			role: Type.Optional(Type.String({ description: "AX role (e.g. 'AXButton', 'AXTextArea')" })),
			title: Type.Optional(Type.String({ description: "AX title to match" })),
			value: Type.Optional(Type.String({ description: "AX value to match" })),
			identifier: Type.Optional(Type.String({ description: "AX identifier to match" })),
			matchType: Type.Optional(Type.String({ description: "'exact' (default) or 'contains'" })),
		}),

		async execute(_toolCallId: any, args: {
			app: string;
			attribute?: string;
			attributes?: string[];
			role?: string;
			title?: string;
			value?: string;
			identifier?: string;
			matchType?: string;
		}) {
			if (!args.attribute && (!args.attributes || args.attributes.length === 0)) {
				throw new Error("mac_read: provide 'attribute' (single) or 'attributes' (array) parameter");
			}
			if (!args.role && !args.title && !args.value && !args.identifier) {
				throw new Error("mac_read: provide at least one search criterion (role, title, value, or identifier)");
			}
			const params: Record<string, any> = { app: args.app };
			if (args.attribute) params.attribute = args.attribute;
			if (args.attributes) params.attributes = args.attributes;
			if (args.role) params.role = args.role;
			if (args.title) params.title = args.title;
			if (args.value) params.value = args.value;
			if (args.identifier) params.identifier = args.identifier;
			if (args.matchType) params.matchType = args.matchType;

			const result = execMacAgent("readAttribute", params);
			if (!result.success) {
				throw new Error("mac_read: " + result.error);
			}

			// Format output based on single vs multi attribute
			if (args.attribute && !args.attributes) {
				const val = result.data?.value;
				const formatted = typeof val === "object" ? JSON.stringify(val) : String(val);
				return {
					content: [{ type: "text" as const, text: `${args.attribute}: ${formatted}` }],
					details: result.data,
				};
			}

			// Multi-attribute: format as key: value lines
			const values = result.data?.values as Record<string, any> | undefined;
			if (values) {
				const lines = Object.entries(values).map(([k, v]) => {
					const formatted = typeof v === "object" ? JSON.stringify(v) : String(v);
					return `${k}: ${formatted}`;
				});
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: result.data,
				};
			}

			// Fallback
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
				details: result.data,
			};
		},
	});

	// -----------------------------------------------------------------
	// System prompt injection — mac-tools usage guidelines
	// -----------------------------------------------------------------
	pi.on("before_agent_start", async (event) => {
		const guidelines = `

[SYSTEM CONTEXT — Mac Tools]

## Native macOS App Interaction

You have mac-tools for controlling native macOS applications (Finder, TextEdit, Safari, Xcode, etc.) via Accessibility APIs.

**Mac-tools vs browser-tools:** Use mac-tools for native macOS apps. Use browser-tools for web pages inside a browser. If you need to interact with a website in Safari or Chrome, use browser-tools — mac-tools controls the browser's native UI chrome (menus, tabs, address bar), not web page content.

**Permissions:** If any mac tool returns a permission error, run \`mac_check_permissions\` to diagnose. Accessibility and Screen Recording permissions are granted in System Settings > Privacy & Security.

**Interaction pattern — discover → act → verify:**
1. **Discover** the UI structure with \`mac_find\` (search for specific elements) or \`mac_get_tree\` (see overall layout)
2. **Act** with \`mac_click\` (press buttons/menus) or \`mac_type\` (enter text into fields)
3. **Verify** the result with \`mac_read\` (check attribute values) or \`mac_screenshot\` (visual confirmation)

**Tree queries:** Start with default limits (mac_get_tree: maxDepth:3, maxCount:50). Increase only if the element you need isn't visible in the output. Large trees waste context.

**Screenshots:** Use \`mac_screenshot\` only when visual verification is genuinely needed — the image payload is large. Prefer \`mac_read\` or \`mac_find\` for checking text values and element state.`;

		return { systemPrompt: event.systemPrompt + guidelines };
	});
}
