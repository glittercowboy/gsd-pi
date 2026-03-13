import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
	formatTimelineEntries,
	buildFailureHypothesis,
	summarizeBrowserSession,
} from "../core.js";
import type { ToolDeps } from "../state.js";
import {
	ARTIFACT_ROOT,
	HAR_FILENAME,
	getPageRegistry,
	getActiveFrame,
	getConsoleLogs,
	getNetworkLogs,
	getDialogLogs,
	getActionTimeline,
	getActiveTraceSession,
	setActiveTraceSession,
	getHarState,
	setHarState,
	getSessionStartedAt,
	getSessionArtifactDir,
} from "../state.js";
import {
	getActiveFrameMetadata,
	ensureDir,
} from "../utils.js";

export function registerSessionTools(pi: ExtensionAPI, deps: ToolDeps): void {
	// -------------------------------------------------------------------------
	// browser_close
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_close",
		label: "Browser Close",
		description: "Close the browser and clean up all resources.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				await deps.closeBrowser();
				return {
					content: [{ type: "text", text: "Browser closed." }],
					details: {},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Close failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_trace_start
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_trace_start",
		label: "Browser Trace Start",
		description: "Start a Playwright trace for the current browser session and persist trace metadata under the session artifact directory.",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Optional short trace session name for artifact filenames." })),
			title: Type.Optional(Type.String({ description: "Optional trace title recorded in metadata." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { context: browserContext } = await deps.ensureBrowser();
				const activeTrace = getActiveTraceSession();
				if (activeTrace) {
					return {
						content: [{ type: "text", text: `Trace already active: ${activeTrace.name}` }],
						details: { error: "trace_already_active", activeTraceSession: activeTrace, ...deps.getSessionArtifactMetadata() },
						isError: true,
					};
				}
				const startedAt = Date.now();
				const name = (params.name?.trim() || `trace-${deps.formatArtifactTimestamp(startedAt)}`).replace(/[^a-zA-Z0-9._-]+/g, "-");
				await browserContext.tracing.start({ screenshots: true, snapshots: true, sources: true, title: params.title ?? name });
				setActiveTraceSession({ startedAt, name, title: params.title ?? name });
				return {
					content: [{ type: "text", text: `Trace started: ${name}\nSession dir: ${getSessionArtifactDir()}` }],
					details: { activeTraceSession: getActiveTraceSession(), ...deps.getSessionArtifactMetadata() },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Trace start failed: ${err.message}` }],
					details: { error: err.message, ...deps.getSessionArtifactMetadata() },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_trace_stop
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_trace_stop",
		label: "Browser Trace Stop",
		description: "Stop the active Playwright trace and write the trace zip to disk under the session artifact directory.",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Optional artifact basename override for the trace zip." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { context: browserContext } = await deps.ensureBrowser();
				const activeTrace = getActiveTraceSession();
				if (!activeTrace) {
					return {
						content: [{ type: "text", text: "No active trace session to stop." }],
						details: { error: "trace_not_active", ...deps.getSessionArtifactMetadata() },
						isError: true,
					};
				}
				const traceSession = activeTrace;
				const traceName = (params.name?.trim() || traceSession.name).replace(/[^a-zA-Z0-9._-]+/g, "-");
				const tracePath = deps.buildSessionArtifactPath(`${traceName}.trace.zip`);
				await browserContext.tracing.stop({ path: tracePath });
				const fileStat = await stat(tracePath);
				setActiveTraceSession(null);
				return {
					content: [{ type: "text", text: `Trace stopped: ${tracePath}` }],
					details: {
						path: tracePath,
						bytes: fileStat.size,
						elapsedMs: Date.now() - traceSession.startedAt,
						traceName,
						...deps.getSessionArtifactMetadata(),
					},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Trace stop failed: ${err.message}` }],
					details: { error: err.message, ...deps.getSessionArtifactMetadata() },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_export_har
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_export_har",
		label: "Browser Export HAR",
		description: "Export the truthfully recorded session HAR from disk to a stable artifact path and return compact metadata.",
		parameters: Type.Object({
			filename: Type.Optional(Type.String({ description: "Optional destination filename within the session artifact directory." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				await deps.ensureBrowser();
				const harState = getHarState();
				if (!harState.enabled || !harState.configuredAtContextCreation || !harState.path) {
					return {
						content: [{ type: "text", text: "HAR export unavailable: HAR recording was not enabled at browser context creation." }],
						details: { error: "har_not_enabled", ...deps.getSessionArtifactMetadata() },
						isError: true,
					};
				}
				const sourcePath = harState.path;
				const destinationName = (params.filename?.trim() || `export-${HAR_FILENAME}`).replace(/[^a-zA-Z0-9._-]+/g, "-");
				const destinationPath = deps.buildSessionArtifactPath(destinationName);
				const exportResult = sourcePath === destinationPath
					? { path: sourcePath, bytes: (await stat(sourcePath)).size }
					: await deps.copyArtifactFile(sourcePath, destinationPath);
				setHarState({
					...harState,
					exportCount: harState.exportCount + 1,
					lastExportedPath: exportResult.path,
					lastExportedAt: Date.now(),
				});
				return {
					content: [{ type: "text", text: `HAR exported: ${exportResult.path}` }],
					details: { path: exportResult.path, bytes: exportResult.bytes, ...deps.getSessionArtifactMetadata() },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `HAR export failed: ${err.message}` }],
					details: { error: err.message, ...deps.getSessionArtifactMetadata() },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_timeline
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_timeline",
		label: "Browser Timeline",
		description: "Return a compact structured summary of the tracked browser action timeline and optional on-disk export path.",
		parameters: Type.Object({
			writeToDisk: Type.Optional(Type.Boolean({ description: "Write the timeline JSON to disk under the session artifact directory." })),
			filename: Type.Optional(Type.String({ description: "Optional JSON filename when writeToDisk is true." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				await deps.ensureBrowser();
				const actionTimeline = getActionTimeline();
				const timeline = formatTimelineEntries(actionTimeline.entries, {
					limit: actionTimeline.limit,
					totalActions: actionTimeline.nextId - 1,
				});
				let artifact: { path: string; bytes: number } | null = null;
				if (params.writeToDisk) {
					const filename = (params.filename?.trim() || "timeline.json").replace(/[^a-zA-Z0-9._-]+/g, "-");
					artifact = await deps.writeArtifactFile(deps.buildSessionArtifactPath(filename), JSON.stringify(timeline, null, 2));
				}
				return {
					content: [{ type: "text", text: artifact ? `${timeline.summary}\nArtifact: ${artifact.path}` : timeline.summary }],
					details: { ...timeline, artifact, ...deps.getSessionArtifactMetadata() },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Timeline failed: ${err.message}` }],
					details: { error: err.message, ...deps.getSessionArtifactMetadata() },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_session_summary
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_session_summary",
		label: "Browser Session Summary",
		description: "Return a compact structured summary of the current browser session, including pages, actions, waits/assertions, bounded-history caveats, and trace/HAR state.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				await deps.ensureBrowser();
				const pages = await deps.getLivePagesSnapshot();
				const actionTimeline = getActionTimeline();
				const pageRegistry = getPageRegistry();
				const consoleLogs = getConsoleLogs();
				const networkLogs = getNetworkLogs();
				const dialogLogs = getDialogLogs();
				const baseSummary = summarizeBrowserSession({
					timeline: actionTimeline,
					totalActions: actionTimeline.nextId - 1,
					pages,
					activePageId: pageRegistry.activePageId,
					activeFrame: getActiveFrameMetadata(),
					consoleEntries: consoleLogs,
					networkEntries: networkLogs,
					dialogEntries: dialogLogs,
					consoleLimit: 1000,
					networkLimit: 1000,
					dialogLimit: 1000,
					sessionStartedAt: getSessionStartedAt(),
					now: Date.now(),
				});
				const failureHypothesis = buildFailureHypothesis({
					timeline: actionTimeline,
					consoleEntries: consoleLogs,
					networkEntries: networkLogs,
					dialogEntries: dialogLogs,
				});
				const activeTrace = getActiveTraceSession();
				const traceState = activeTrace
					? { status: "active", ...activeTrace }
					: { status: "inactive", lastTracePath: getSessionArtifactDir() ? deps.buildSessionArtifactPath("*.trace.zip") : null };
				const harState = getHarState();
				const harSummary = {
					enabled: harState.enabled,
					configuredAtContextCreation: harState.configuredAtContextCreation,
					path: harState.path,
					exportCount: harState.exportCount,
					lastExportedPath: harState.lastExportedPath,
					lastExportedAt: harState.lastExportedAt,
				};
				return {
					content: [{ type: "text", text: `${baseSummary.summary}\nFailure hypothesis: ${failureHypothesis}` }],
					details: {
						...baseSummary,
						failureHypothesis,
						trace: traceState,
						har: harSummary,
						...deps.getSessionArtifactMetadata(),
					},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Session summary failed: ${err.message}` }],
					details: { error: err.message, ...deps.getSessionArtifactMetadata() },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------------
	// browser_debug_bundle
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_debug_bundle",
		label: "Browser Debug Bundle",
		description: "Write a timestamped debug bundle to disk with screenshot, logs, timeline, pages, session summary, and accessibility output, then return compact paths and counts.",
		parameters: Type.Object({
			selector: Type.Optional(Type.String({ description: "Optional CSS selector to scope the accessibility snapshot before fallback behavior applies." })),
			name: Type.Optional(Type.String({ description: "Optional short bundle name suffix for the output directory." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await deps.ensureBrowser();
				const startedAt = Date.now();
				const sessionDir = await deps.ensureSessionArtifactDir();
				const bundleDir = path.join(ARTIFACT_ROOT, `${deps.formatArtifactTimestamp(startedAt)}-${deps.sanitizeArtifactName(params.name ?? "debug-bundle", "debug-bundle")}`);
				await ensureDir(bundleDir);
				const pages = await deps.getLivePagesSnapshot();
				const actionTimeline = getActionTimeline();
				const pageRegistry = getPageRegistry();
				const consoleLogs = getConsoleLogs();
				const networkLogs = getNetworkLogs();
				const dialogLogs = getDialogLogs();
				const timeline = formatTimelineEntries(actionTimeline.entries, {
					limit: actionTimeline.limit,
					totalActions: actionTimeline.nextId - 1,
				});
				const sessionSummary = summarizeBrowserSession({
					timeline: actionTimeline,
					totalActions: actionTimeline.nextId - 1,
					pages,
					activePageId: pageRegistry.activePageId,
					activeFrame: getActiveFrameMetadata(),
					consoleEntries: consoleLogs,
					networkEntries: networkLogs,
					dialogEntries: dialogLogs,
					consoleLimit: 1000,
					networkLimit: 1000,
					dialogLimit: 1000,
					sessionStartedAt: getSessionStartedAt(),
					now: Date.now(),
				});
				const failureHypothesis = buildFailureHypothesis({
					timeline: actionTimeline,
					consoleEntries: consoleLogs,
					networkEntries: networkLogs,
					dialogEntries: dialogLogs,
				});
				const accessibility = await deps.captureAccessibilityMarkdown(params.selector);
				const screenshotPath = path.join(bundleDir, "screenshot.jpg");
				await p.screenshot({ path: screenshotPath, type: "jpeg", quality: 80, fullPage: false });
				const screenshotStat = await stat(screenshotPath);
				const artifacts = {
					screenshot: { path: screenshotPath, bytes: screenshotStat.size },
					console: await deps.writeArtifactFile(path.join(bundleDir, "console.json"), JSON.stringify(consoleLogs, null, 2)),
					network: await deps.writeArtifactFile(path.join(bundleDir, "network.json"), JSON.stringify(networkLogs, null, 2)),
					dialog: await deps.writeArtifactFile(path.join(bundleDir, "dialog.json"), JSON.stringify(dialogLogs, null, 2)),
					timeline: await deps.writeArtifactFile(path.join(bundleDir, "timeline.json"), JSON.stringify(timeline, null, 2)),
					summary: await deps.writeArtifactFile(path.join(bundleDir, "summary.json"), JSON.stringify({
						...sessionSummary,
						failureHypothesis,
						trace: getActiveTraceSession(),
						har: getHarState(),
						sessionArtifactDir: sessionDir,
					}, null, 2)),
					pages: await deps.writeArtifactFile(path.join(bundleDir, "pages.json"), JSON.stringify(pages, null, 2)),
					accessibility: await deps.writeArtifactFile(path.join(bundleDir, "accessibility.md"), accessibility.snapshot),
				};
				return {
					content: [{ type: "text", text: `Debug bundle written: ${bundleDir}\n${sessionSummary.summary}\nFailure hypothesis: ${failureHypothesis}` }],
					details: {
						bundleDir,
						artifacts,
						accessibilityScope: accessibility.scope,
						accessibilitySource: accessibility.source,
						counts: {
							console: consoleLogs.length,
							network: networkLogs.length,
							dialog: dialogLogs.length,
							actions: timeline.count,
							pages: pages.length,
						},
						elapsedMs: Date.now() - startedAt,
						summary: sessionSummary,
						failureHypothesis,
						...deps.getSessionArtifactMetadata(),
					},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Debug bundle failed: ${err.message}` }],
					details: { error: err.message, ...deps.getSessionArtifactMetadata() },
					isError: true,
				};
			}
		},
	});
}
