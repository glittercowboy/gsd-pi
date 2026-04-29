import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { readClipboardImage } from "../utils/clipboard-image.js";

test(
	"Wayland BMP clipboard requests PNG transcode via wl-paste first (WSLg regression)",
	{ skip: process.platform !== "linux" },
	async (t) => {
		const tempDir = mkdtempSync(join(tmpdir(), "clipboard-image-test-"));
		const wlPastePath = join(tempDir, "wl-paste");
		const logPath = join(tempDir, "wl-paste.log");

		const oldPath = process.env.PATH;
		const oldLog = process.env.FAKE_WL_LOG_PATH;

		t.after(() => {
			if (oldPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = oldPath;
			}

			if (oldLog === undefined) {
				delete process.env.FAKE_WL_LOG_PATH;
			} else {
				process.env.FAKE_WL_LOG_PATH = oldLog;
			}

			rmSync(tempDir, { recursive: true, force: true });
		});

		const fakeWlPaste = [
			"#!/usr/bin/env bash",
			"set -euo pipefail",
			"printf '%s\\n' \"$*\" >> \"${FAKE_WL_LOG_PATH}\"",
			"if [ \"${1:-}\" = \"--list-types\" ]; then",
			"  printf 'image/bmp\\n'",
			"  exit 0",
			"fi",
			"if [ \"${1:-}\" = \"--type\" ] && [ \"${2:-}\" = \"image/png\" ]; then",
			"  printf 'PNGDATA'",
			"  exit 0",
			"fi",
			"if [ \"${1:-}\" = \"--type\" ] && [ \"${2:-}\" = \"image/bmp\" ]; then",
			"  printf 'BM'",
			"  exit 0",
			"fi",
			"exit 1",
		].join("\n");

		writeFileSync(wlPastePath, fakeWlPaste, { encoding: "utf-8" });
		chmodSync(wlPastePath, 0o755);

		process.env.FAKE_WL_LOG_PATH = logPath;
		process.env.PATH = [tempDir, oldPath].filter(Boolean).join(delimiter);

		const image = await readClipboardImage({
			platform: "linux",
			env: {
				...process.env,
				WAYLAND_DISPLAY: "wayland-0",
				XDG_SESSION_TYPE: "wayland",
			},
		});

		const callLog = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "<missing wl-paste log>";

		assert.ok(image, `Expected an image from clipboard. wl-paste log:\n${callLog}`);
		assert.equal(image.mimeType, "image/png");
		assert.equal(Buffer.from(image.bytes).toString("utf-8"), "PNGDATA");

		assert.match(callLog, /--list-types/);
		assert.match(callLog, /--type image\/bmp --no-newline/);
		assert.match(callLog, /--type image\/png --no-newline/);
	},
);
