import type { FSWatcher } from "chokidar";
import type { EventBus } from "@gsd/pi-coding-agent";
import { relative } from "node:path";

let watcher: FSWatcher | null = null;
let pending = new Map<string, ReturnType<typeof setTimeout>>();

const EVENT_MAP: Record<string, string> = {
	"settings.json": "settings-changed",
	"auth.json": "auth-changed",
	"models.json": "models-changed",
};

const EXTENSIONS_DIR = "extensions";

const IGNORED_PATTERNS = [
	"**/sessions/**",
	"**/*.tmp",
	"**/*.swp",
	"**/*~",
	"**/.DS_Store",
];

const DEBOUNCE_MS = 300;

/**
 * Start watching `agentDir` (e.g. `~/.gsd/agent/`) for config changes.
 * Emits events on the supplied EventBus when watched files are modified.
 */
export async function startFileWatcher(
	agentDir: string,
	eventBus: EventBus,
): Promise<void> {
	if (watcher) {
		await watcher.close();
	}

	const { watch } = await import("chokidar");

	pending = new Map<string, ReturnType<typeof setTimeout>>();

	function debounceEmit(event: string): void {
		const existing = pending.get(event);
		if (existing) clearTimeout(existing);
		pending.set(
			event,
			setTimeout(() => {
				pending.delete(event);
				eventBus.emit(event, { timestamp: Date.now() });
			}, DEBOUNCE_MS),
		);
	}

	function resolveEvent(filePath: string): string | null {
		const rel = relative(agentDir, filePath);
		if (rel.startsWith("..")) return null;

		// Check direct file matches
		for (const [file, event] of Object.entries(EVENT_MAP)) {
			if (rel === file) return event;
		}

		// Check extensions directory
		if (rel.startsWith(EXTENSIONS_DIR + "/") || rel === EXTENSIONS_DIR) {
			return "extensions-changed";
		}

		return null;
	}

	watcher = watch(agentDir, {
		ignoreInitial: true,
		depth: 2,
		ignored: IGNORED_PATTERNS,
	});

	for (const eventType of ["add", "change", "unlink"] as const) {
		watcher.on(eventType, (filePath: string) => {
			const event = resolveEvent(filePath);
			if (event) debounceEmit(event);
		});
	}

	// Wait for watcher to be ready
	await new Promise<void>((resolve) => {
		watcher!.on("ready", resolve);
	});
}

/**
 * Stop the file watcher and clean up resources.
 */
export async function stopFileWatcher(): Promise<void> {
	for (const timer of pending.values()) clearTimeout(timer);
	pending.clear();
	if (watcher) {
		await watcher.close();
		watcher = null;
	}
}
