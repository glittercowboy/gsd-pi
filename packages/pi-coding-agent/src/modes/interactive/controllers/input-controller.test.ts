import assert from "node:assert/strict";
import test from "node:test";

import { setupEditorSubmitHandler } from "./input-controller.js";

type HostOptions = {
	knownSlashCommands?: string[];
};

function getSlashCommandName(text: string): string {
	const trimmed = text.trim();
	const spaceIndex = trimmed.indexOf(" ");
	return spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
}

function createHost(options: HostOptions = {}) {
	const prompted: string[] = [];
	const errors: string[] = [];
	const warnings: string[] = [];
	const tips: string[] = [];
	const history: string[] = [];
	const knownSlashCommands = new Set(options.knownSlashCommands ?? []);
	let editorText = "";
	let settingsOpened = 0;

	const editor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory(text: string) {
			history.push(text);
		},
	};

	const host = {
		defaultEditor: editor as typeof editor & { onSubmit?: (text: string) => Promise<void> },
		editor,
		session: {
			isBashRunning: false,
			isCompacting: false,
			isStreaming: false,
			prompt: async (text: string) => {
				prompted.push(text);
			},
		},
		ui: {
			requestRender() {},
		},
		getSlashCommandContext: () => ({
			showSettingsSelector: () => {
				settingsOpened += 1;
			},
		}),
		handleBashCommand: async () => {},
		showWarning(message: string) {
			warnings.push(message);
		},
		showError(message: string) {
			errors.push(message);
		},
		showTip(message: string) {
			tips.push(message);
		},
		updateEditorBorderColor() {},
		isExtensionCommand() {
			return false;
		},
		isKnownSlashCommand(text: string) {
			return knownSlashCommands.has(getSlashCommandName(text));
		},
		queueCompactionMessage() {},
		updatePendingMessagesDisplay() {},
		flushPendingBashComponents() {},
		contextualTips: {
			recordBashIncluded() {},
			evaluate() {
				return undefined;
			},
		},
		getContextPercent() {
			return undefined;
		},
	};

	setupEditorSubmitHandler(host as any);

	return {
		host: host as typeof host & { defaultEditor: typeof editor & { onSubmit: (text: string) => Promise<void> } },
		prompted,
		errors,
		warnings,
		tips,
		history,
		getEditorText: () => editorText,
		getSettingsOpened: () => settingsOpened,
	};
}

test("input-controller: built-in slash commands stay in TUI dispatch", async () => {
	const { host, prompted, errors, getSettingsOpened, getEditorText } = createHost();

	await host.defaultEditor.onSubmit("/settings");

	assert.equal(getSettingsOpened(), 1, "built-in /settings should open the settings selector");
	assert.deepEqual(prompted, [], "built-in slash commands should not reach session.prompt");
	assert.deepEqual(errors, [], "built-in slash commands should not show errors");
	assert.equal(getEditorText(), "", "built-in slash commands should clear the editor after handling");
});

test("input-controller: extension slash commands fall through to session.prompt", async () => {
	const { host, prompted, errors, history } = createHost({ knownSlashCommands: ["gsd"] });

	await host.defaultEditor.onSubmit("/gsd help");

	assert.deepEqual(prompted, ["/gsd help"], "known extension slash commands should reach session.prompt");
	assert.deepEqual(errors, [], "known extension slash commands should not show unknown-command errors");
	assert.deepEqual(history, ["/gsd help"], "known extension slash commands should still be added to history");
});

test("input-controller: prompt template slash commands fall through to session.prompt", async () => {
	const { host, prompted, errors } = createHost({ knownSlashCommands: ["daily"] });

	await host.defaultEditor.onSubmit("/daily focus area");

	assert.deepEqual(prompted, ["/daily focus area"]);
	assert.deepEqual(errors, []);
});

test("input-controller: skill slash commands fall through to session.prompt", async () => {
	const { host, prompted, errors } = createHost({ knownSlashCommands: ["skill:create-skill"] });

	await host.defaultEditor.onSubmit("/skill:create-skill routing bug");

	assert.deepEqual(prompted, ["/skill:create-skill routing bug"]);
	assert.deepEqual(errors, []);
});

test("input-controller: disabled skill slash commands stay unknown", async () => {
	const { host, prompted, errors } = createHost();

	await host.defaultEditor.onSubmit("/skill:create-skill routing bug");

	assert.deepEqual(prompted, []);
	assert.deepEqual(errors, ["Unknown command: /skill:create-skill. Use slash autocomplete to see available commands."]);
});

test("input-controller: /export prefix does not swallow unrelated slash commands", async () => {
	const { host, prompted, errors } = createHost();

	await host.defaultEditor.onSubmit("/exportfoo");

	assert.deepEqual(prompted, []);
	assert.deepEqual(errors, ["Unknown command: /exportfoo. Use slash autocomplete to see available commands."]);
});

test("input-controller: truly unknown slash commands stop before session.prompt", async () => {
	const { host, prompted, errors, getEditorText } = createHost();

	await host.defaultEditor.onSubmit("/definitely-not-a-command");

	assert.deepEqual(prompted, [], "unknown slash commands should not reach session.prompt");
	assert.deepEqual(
		errors,
		["Unknown command: /definitely-not-a-command. Use slash autocomplete to see available commands."],
	);
	assert.equal(getEditorText(), "", "unknown slash commands should clear the editor after showing the error");
});

test("input-controller: absolute file paths are not treated as slash commands (#3478)", async () => {
	const { host, prompted, errors } = createHost();

	await host.defaultEditor.onSubmit("/Users/name/Desktop/screenshot.png");

	assert.deepEqual(errors, [], "file paths should not trigger unknown command error");
	assert.deepEqual(prompted, ["/Users/name/Desktop/screenshot.png"], "file paths should be sent as plain input");
});

test("input-controller: Linux absolute paths are not treated as slash commands (#3478)", async () => {
	const { host, prompted, errors } = createHost();

	await host.defaultEditor.onSubmit("/home/user/documents/file.txt");

	assert.deepEqual(errors, [], "Linux paths should not trigger unknown command error");
	assert.deepEqual(prompted, ["/home/user/documents/file.txt"], "Linux paths should be sent as plain input");
});

test("input-controller: /tmp paths are not treated as slash commands (#3478)", async () => {
	const { host, prompted, errors } = createHost();

	await host.defaultEditor.onSubmit("/tmp/some-file.log");

	assert.deepEqual(errors, []);
	assert.deepEqual(prompted, ["/tmp/some-file.log"]);
});
