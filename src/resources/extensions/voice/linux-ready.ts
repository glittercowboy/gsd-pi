/**
 * linux-ready.ts — Linux voice readiness logic (extracted for testability).
 *
 * Handles:
 *   - Detecting system vs venv python3
 *   - Diagnosing sounddevice import errors (portaudio vs missing module)
 *   - Auto-creating venv on PEP 668 systems
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const VOICE_VENV_DIR = path.join(
	process.env.HOME || process.env.USERPROFILE || os.homedir(),
	".gsd",
	"voice-venv",
);
export const VOICE_VENV_PYTHON = path.join(VOICE_VENV_DIR, "bin", "python3");

/** Return the python3 binary path — prefer venv if it exists, else system. */
export function linuxPython(): string {
	if (fs.existsSync(VOICE_VENV_PYTHON)) return VOICE_VENV_PYTHON;
	return "python3";
}

/**
 * Diagnose a sounddevice import error from its stderr output.
 *
 * Returns:
 *   - "missing-module"  — sounddevice python package not installed
 *   - "missing-portaudio" — libportaudio2 native library not found
 *   - "unknown"         — unrecognized error
 *
 * IMPORTANT: Check "No module" / "ModuleNotFoundError" BEFORE checking for the
 * word "sounddevice", because `ModuleNotFoundError: No module named 'sounddevice'`
 * contains both strings. The more specific check must come first.
 */
export function diagnoseSounddeviceError(stderr: string): "missing-module" | "missing-portaudio" | "unknown" {
	// Check for missing Python module FIRST — the error message
	// "ModuleNotFoundError: No module named 'sounddevice'" contains the word
	// "sounddevice", so the old order (checking "sounddevice" first) was wrong.
	if (stderr.includes("No module") || stderr.includes("ModuleNotFoundError")) {
		return "missing-module";
	}
	// Now check for native portaudio library issues.
	if (stderr.includes("PortAudio") || stderr.includes("portaudio")) {
		return "missing-portaudio";
	}
	return "unknown";
}

export interface ReadinessCallbacks {
	notify: (message: string, level: "info" | "error") => void;
	/** Override for execFileSync — for testing. Uses execFileSync (safe, no shell). */
	execFile?: typeof execFileSync;
	/** Override for fs.existsSync — for testing */
	exists?: typeof fs.existsSync;
}

/**
 * Auto-create the voice venv if it doesn't exist.
 * Uses execFileSync internally (no shell, safe from injection).
 *
 * Returns true on success, false on failure.
 */
export function ensureVoiceVenv(cb: ReadinessCallbacks): boolean {
	const exists = cb.exists ?? fs.existsSync;
	const execFile = cb.execFile ?? execFileSync;

	if (exists(VOICE_VENV_PYTHON)) return true;

	cb.notify("Voice: setting up Python environment — one-time setup", "info");
	try {
		execFile("python3", ["-m", "venv", VOICE_VENV_DIR], { timeout: 30000 });
		execFile(
			path.join(VOICE_VENV_DIR, "bin", "pip"),
			["install", "sounddevice", "requests", "--quiet"],
			{ timeout: 120000 },
		);
		return true;
	} catch {
		cb.notify("Voice: failed to create Python venv — run: python3 -m venv ~/.gsd/voice-venv", "error");
		return false;
	}
}
