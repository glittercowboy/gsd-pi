import { test, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import {
	startFileWatcher,
	stopFileWatcher,
} from "../resources/extensions/gsd/file-watcher.ts";

function createTempAgentDir(): string {
	const tmp = mkdtempSync(join(tmpdir(), "gsd-fw-test-"));
	mkdirSync(join(tmp, "extensions"), { recursive: true });
	// Seed watched files so chokidar treats writes as "change" not "add"
	writeFileSync(join(tmp, "settings.json"), "{}");
	writeFileSync(join(tmp, "auth.json"), "{}");
	writeFileSync(join(tmp, "models.json"), "{}");
	return tmp;
}

function createMockEventBus() {
	const events: { channel: string; data: unknown }[] = [];
	return {
		events,
		emit(channel: string, data: unknown) {
			events.push({ channel, data });
		},
		on(_channel: string, _handler: (data: unknown) => void) {
			return () => {};
		},
	};
}

afterEach(async () => {
	await stopFileWatcher();
});

test("startFileWatcher and stopFileWatcher run without errors", async () => {
	const dir = createTempAgentDir();
	const bus = createMockEventBus();

	await startFileWatcher(dir, bus);
	await stopFileWatcher();
});

test("stopFileWatcher is safe to call when no watcher is active", async () => {
	await stopFileWatcher();
});

test("settings.json change emits settings-changed event", async () => {
	const dir = createTempAgentDir();
	const bus = createMockEventBus();

	await startFileWatcher(dir, bus);
	await delay(200);

	writeFileSync(join(dir, "settings.json"), JSON.stringify({ updated: true }));
	// Wait for debounce (300ms) + filesystem propagation
	await delay(800);

	const matched = bus.events.filter((e) => e.channel === "settings-changed");
	assert.ok(matched.length > 0, "should emit settings-changed event");
});

test("auth.json change emits auth-changed event", async () => {
	const dir = createTempAgentDir();
	const bus = createMockEventBus();

	await startFileWatcher(dir, bus);
	// Allow watcher to fully initialize before writing
	await delay(200);

	writeFileSync(join(dir, "auth.json"), JSON.stringify({ token: "new" }));
	await delay(800);

	const matched = bus.events.filter((e) => e.channel === "auth-changed");
	assert.ok(matched.length > 0, "should emit auth-changed event");
});

test("models.json change emits models-changed event", async () => {
	const dir = createTempAgentDir();
	const bus = createMockEventBus();

	await startFileWatcher(dir, bus);
	await delay(200);

	writeFileSync(join(dir, "models.json"), JSON.stringify({ model: "new" }));
	await delay(800);

	const matched = bus.events.filter((e) => e.channel === "models-changed");
	assert.ok(matched.length > 0, "should emit models-changed event");
});

test("extensions directory change emits extensions-changed event", { skip: process.platform === "win32" ? "chokidar subdirectory events are unreliable on Windows CI" : undefined }, async () => {
	const dir = createTempAgentDir();
	const bus = createMockEventBus();

	await startFileWatcher(dir, bus);
	await delay(500);

	writeFileSync(
		join(dir, "extensions", "my-ext.json"),
		JSON.stringify({ name: "test" }),
	);
	await delay(2000);

	const matched = bus.events.filter(
		(e) => e.channel === "extensions-changed",
	);
	assert.ok(matched.length > 0, "should emit extensions-changed event");
});

test("unrelated file changes are ignored", async () => {
	const dir = createTempAgentDir();
	const bus = createMockEventBus();

	await startFileWatcher(dir, bus);
	// Wait for watcher to settle, then clear any residual events from setup
	await delay(400);
	bus.events.length = 0;

	writeFileSync(join(dir, "random.txt"), "hello");
	await delay(600);

	assert.strictEqual(bus.events.length, 0, "should not emit any events");
});

test("debouncing coalesces rapid changes into one event", async () => {
	const dir = createTempAgentDir();
	const bus = createMockEventBus();

	await startFileWatcher(dir, bus);

	// Rapid-fire writes
	for (let i = 0; i < 5; i++) {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ i }));
	}
	await delay(800);

	const matched = bus.events.filter((e) => e.channel === "settings-changed");
	assert.strictEqual(
		matched.length,
		1,
		"rapid changes should be debounced into a single event",
	);
});
