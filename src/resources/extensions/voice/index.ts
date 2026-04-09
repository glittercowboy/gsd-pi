import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import { shortcutDesc } from "../shared/mod.js";
import type { AssistantMessage } from "@gsd/pi-ai";
import { isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { linuxPython, diagnoseSounddeviceError, ensureVoiceVenv, VOICE_VENV_PYTHON } from "./linux-ready.js";

const __extensionDir = import.meta.dirname!;
const SWIFT_SRC = path.join(__extensionDir, "speech-recognizer.swift");
const RECOGNIZER_BIN = path.join(__extensionDir, "speech-recognizer");
const PYTHON_SCRIPT = path.join(__extensionDir, "speech-recognizer.py");

const IS_DARWIN = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";

function ensureBinary(): boolean {
	if (fs.existsSync(RECOGNIZER_BIN)) return true;
	try {
		execFileSync("swiftc", [SWIFT_SRC, "-o", RECOGNIZER_BIN, "-framework", "Speech", "-framework", "AVFoundation"], {
			timeout: 60000,
		});
		return true;
	} catch {
		return false;
	}
}

let linuxReady = false;

function ensureLinuxReady(ctx: ExtensionContext): boolean {
	if (linuxReady) return true;

	// Check GROQ_API_KEY is available
	if (!process.env.GROQ_API_KEY) {
		ctx.ui.notify("Voice: GROQ_API_KEY not set — run 'gsd config' to configure", "error");
		return false;
	}

	// Check python3 exists
	try {
		execFileSync("which", ["python3"], { stdio: "pipe" });
	} catch {
		ctx.ui.notify("Voice: python3 not found — install with: sudo apt install python3", "error");
		return false;
	}

	// Check that sounddevice is importable
	const py = linuxPython();
	try {
		execFileSync(py, ["-c", "import sounddevice"], {
			stdio: "pipe",
			timeout: 10000,
		});
	} catch (err: unknown) {
		const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? "";
		const diagnosis = diagnoseSounddeviceError(stderr);

		if (diagnosis === "missing-module") {
			// Module not installed — auto-create venv (handles PEP 668 systems
			// where system pip is blocked). See #2403.
			if (!ensureVoiceVenv({ notify: (msg, level) => ctx.ui.notify(msg, level) })) {
				return false;
			}
			linuxReady = true;
			return true;
		} else if (diagnosis === "missing-portaudio") {
			ctx.ui.notify("Voice: install libportaudio2 with: sudo apt install libportaudio2", "error");
		} else {
			ctx.ui.notify(`Voice: dependency check failed — ${stderr.split("\n")[0] || "unknown error"}`, "error");
		}
		return false;
	}

	linuxReady = true;
	return true;
}

export default function (pi: ExtensionAPI) {
	if (!IS_DARWIN && !IS_LINUX) return;

	let active = false;
	let recognizerProcess: ChildProcess | null = null;
	let flashOn = true;
	let flashTimer: ReturnType<typeof setInterval> | null = null;
	let footerTui: { requestRender: () => void } | null = null;

	function setVoiceFooter(ctx: ExtensionContext, on: boolean) {
		if (!on) {
			stopFlash();
			ctx.ui.setFooter(undefined);
			return;
		}

		flashOn = true;
		flashTimer = setInterval(() => {
			flashOn = !flashOn;
			footerTui?.requestRender();
		}, 500);

		ctx.ui.setFooter((tui, theme, footerData) => {
			footerTui = tui;
			const branchUnsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: branchUnsub,
				invalidate() {},
				render(width: number): string[] {
					// Row 1: pwd (branch) ... ● transcribing
					let pwd = process.cwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;

					const dot = flashOn ? theme.fg("error", "●") : theme.fg("dim", "●");
					const voiceTag = `${dot} ${theme.fg("error", "transcribing")}`;
					const voiceTagWidth = visibleWidth(voiceTag);

					const maxPwdWidth = width - voiceTagWidth - 2;
					const pwdStr = truncateToWidth(theme.fg("dim", pwd), maxPwdWidth, theme.fg("dim", "..."));
					const pad1 = " ".repeat(Math.max(1, width - visibleWidth(pwdStr) - voiceTagWidth));
					const row1 = truncateToWidth(pwdStr + pad1 + voiceTag, width);

					// Row 2: stats ... model
					let totalInput = 0, totalOutput = 0, totalCost = 0;
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const m = entry.message as AssistantMessage;
							totalInput += m.usage.input;
							totalOutput += m.usage.output;
							totalCost += m.usage.cost.total;
						}
					}

					const fmt = (n: number) => n < 1000 ? `${n}` : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
					const parts: string[] = [];
					if (totalInput) parts.push(`↑${fmt(totalInput)}`);
					if (totalOutput) parts.push(`↓${fmt(totalOutput)}`);
					if (totalCost) parts.push(`$${totalCost.toFixed(3)}`);

					const usage = ctx.getContextUsage();
					const ctxPct = usage?.percent !== null && usage?.percent !== undefined ? `${usage.percent.toFixed(1)}%` : "?";
					const ctxWin = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					parts.push(`${ctxPct}/${fmt(ctxWin)}`);

					const statsLeft = theme.fg("dim", parts.join(" "));
					const modelRight = theme.fg("dim", ctx.model?.id || "no-model");
					const statsLeftW = visibleWidth(statsLeft);
					const modelRightW = visibleWidth(modelRight);
					const pad2 = " ".repeat(Math.max(2, width - statsLeftW - modelRightW));
					const row2 = truncateToWidth(statsLeft + pad2 + modelRight, width);

					return [row1, row2];
				},
			};
		});
	}

	function stopFlash() {
		if (flashTimer) { clearInterval(flashTimer); flashTimer = null; }
		footerTui = null;
	}

	async function toggleVoice(ctx: ExtensionContext) {
		if (active) {
			killRecognizer();
			active = false;
			setVoiceFooter(ctx, false);
			return;
		}

		if (IS_DARWIN) {
			if (!ensureBinary()) {
				ctx.ui.notify("Voice: failed to compile speech recognizer (need Xcode CLI tools)", "error");
				return;
			}
		} else if (IS_LINUX) {
			if (!ensureLinuxReady(ctx)) {
				return;
			}
		}

		active = true;
		setVoiceFooter(ctx, true);
		await runVoiceSession(ctx);
	}

	pi.registerCommand("voice", {
		description: "Toggle voice mode",
		handler: async (_args, ctx) => toggleVoice(ctx),
	});

	pi.registerShortcut("ctrl+alt+v", {
		description: shortcutDesc("Toggle voice mode", "/voice"),
		handler: async (ctx) => toggleVoice(ctx),
	});

	function killRecognizer() {
		if (recognizerProcess) { recognizerProcess.kill("SIGTERM"); recognizerProcess = null; }
	}

	function startRecognizer(
		onPartial: (text: string) => void,
		onFinal: (text: string) => void,
		onError: (msg: string) => void,
		onReady: () => void,
	) {
		if (IS_LINUX) {
			recognizerProcess = spawn(linuxPython(), [PYTHON_SCRIPT], {
				stdio: ["pipe", "pipe", "pipe"],
			});
		} else {
			recognizerProcess = spawn(RECOGNIZER_BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
		}
		const rl = readline.createInterface({ input: recognizerProcess.stdout! });
		rl.on("line", (line: string) => {
			if (line === "READY") { onReady(); return; }
			if (line.startsWith("PARTIAL:")) onPartial(line.slice(8));
			else if (line.startsWith("FINAL:")) onFinal(line.slice(6));
			else if (line.startsWith("ERROR:")) onError(line.slice(6));
		});
		recognizerProcess.on("error", (err) => onError(err.message));
		recognizerProcess.on("exit", () => { recognizerProcess = null; });
	}

	async function runVoiceSession(ctx: ExtensionContext): Promise<void> {
		return new Promise<void>((resolve) => {
			// The Swift recognizer handles accumulation across pause-induced
			// transcription resets. Both PARTIAL and FINAL messages contain
			// the full accumulated text, so we just pass them through.
			startRecognizer(
				(text) => {
					ctx.ui.setEditorText(text);
				},
				(text) => {
					ctx.ui.setEditorText(text);
				},
				(msg) => ctx.ui.notify(`Voice: ${msg}`, "error"),
				() => {},
			);

			ctx.ui.custom<void>(
				(_tui, _theme, _kb, done) => ({
					render(): string[] { return []; },
					handleInput(data: string) {
						if (isKeyRelease(data)) return;
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
							killRecognizer();
							active = false;
							setVoiceFooter(ctx, false);
							done();
						}
					},
					invalidate() {},
				}),
				{ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%" } },
			).then(() => resolve());
		});
	}
}
