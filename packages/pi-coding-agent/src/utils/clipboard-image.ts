import { spawnSync } from "child_process";

import { readImageFromClipboard as nativeReadImage } from "@gsd/native/clipboard";
import { ImageFormat, parseImage } from "@gsd/native/image";

export type ClipboardImage = {
	bytes: Uint8Array;
	mimeType: string;
};

const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const DEFAULT_LIST_TIMEOUT_MS = 1000;
const DEFAULT_READ_TIMEOUT_MS = 3000;
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

export function extensionForImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return null;
	}
}

function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => ({ raw: t, base: baseMimeType(t) }));

	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		const match = normalized.find((t) => t.base === preferred);
		if (match) {
			return match.raw;
		}
	}

	const anyImage = normalized.find((t) => t.base.startsWith("image/"));
	return anyImage?.raw ?? null;
}

function isSupportedImageMimeType(mimeType: string): boolean {
	const base = baseMimeType(mimeType);
	return SUPPORTED_IMAGE_MIME_TYPES.some((t) => t === base);
}

/**
 * Convert unsupported image formats to PNG using the native Rust image module.
 * Returns null if conversion fails.
 */
async function convertToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	try {
		const image = await parseImage(bytes);
		const pngBytes = await image.encode(ImageFormat.PNG, 100);
		return new Uint8Array(pngBytes);
	} catch {
		return null;
	}
}

function runCommand(
	command: string,
	args: string[],
	options?: { timeoutMs?: number; maxBufferBytes?: number },
): { stdout: Buffer; ok: boolean } {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
	const maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

	const result = spawnSync(command, args, {
		timeout: timeoutMs,
		maxBuffer: maxBufferBytes,
	});

	if (result.error) {
		return { ok: false, stdout: Buffer.alloc(0) };
	}

	if (result.status !== 0) {
		return { ok: false, stdout: Buffer.alloc(0) };
	}

	const stdout = Buffer.isBuffer(result.stdout)
		? result.stdout
		: Buffer.from(result.stdout ?? "", typeof result.stdout === "string" ? "utf-8" : undefined);

	return { ok: true, stdout };
}

function readClipboardImageViaWlPaste(): ClipboardImage | null {
	const list = runCommand("wl-paste", ["--list-types"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
	if (!list.ok) {
		return null;
	}

	const types = list.stdout
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);

	const selectedType = selectPreferredImageMimeType(types);
	if (selectedType) {
		const data = runCommand("wl-paste", ["--type", selectedType, "--no-newline"]);
		if (data.ok && data.stdout.length > 0) {
			return { bytes: data.stdout, mimeType: baseMimeType(selectedType) };
		}
	}

	// Fallback for WSLg/BMP: when only image/bmp is available, ask wl-paste
	// to convert to PNG on the fly. wl-paste supports format conversion for
	// some compositor types. If that fails, try reading BMP and converting
	// via ImageMagick (#813).
	const hasBmp = types.some((t) => baseMimeType(t) === "image/bmp");
	if (!selectedType && hasBmp) {
		// Try requesting PNG directly — wl-paste may convert
		const pngData = runCommand("wl-paste", ["--type", "image/png", "--no-newline"]);
		if (pngData.ok && pngData.stdout.length > 0) {
			return { bytes: pngData.stdout, mimeType: "image/png" };
		}

		// Try reading BMP and converting via ImageMagick convert
		const bmpData = runCommand("wl-paste", ["--type", "image/bmp", "--no-newline"]);
		if (bmpData.ok && bmpData.stdout.length > 0) {
			const converted = spawnSync("convert", ["bmp:-", "png:-"], {
				input: bmpData.stdout,
				timeout: 5000,
				maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
			});
			if (!converted.error && converted.status === 0 && converted.stdout.length > 0) {
				const stdout = Buffer.isBuffer(converted.stdout)
					? converted.stdout
					: Buffer.from(converted.stdout);
				return { bytes: stdout, mimeType: "image/png" };
			}
		}
	}

	return null;
}

function readClipboardImageViaXclip(): ClipboardImage | null {
	const targets = runCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
	});

	let candidateTypes: string[] = [];
	if (targets.ok) {
		candidateTypes = targets.stdout
			.toString("utf-8")
			.split(/\r?\n/)
			.map((t) => t.trim())
			.filter(Boolean);
	}

	const preferred = candidateTypes.length > 0 ? selectPreferredImageMimeType(candidateTypes) : null;
	const tryTypes = preferred ? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES] : [...SUPPORTED_IMAGE_MIME_TYPES];

	for (const mimeType of tryTypes) {
		const data = runCommand("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"]);
		if (data.ok && data.stdout.length > 0) {
			return { bytes: data.stdout, mimeType: baseMimeType(mimeType) };
		}
	}

	return null;
}

export async function readClipboardImage(options?: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}): Promise<ClipboardImage | null> {
	const env = options?.env ?? process.env;
	const platform = options?.platform ?? process.platform;

	if (env.TERMUX_VERSION) {
		return null;
	}

	let image: ClipboardImage | null = null;

	if (platform === "linux" && isWaylandSession(env)) {
		// Wayland: use CLI tools (wl-paste/xclip) since native arboard
		// may not have access to the Wayland compositor from a terminal.
		image = readClipboardImageViaWlPaste() ?? readClipboardImageViaXclip();
	} else {
		// macOS, Windows, Linux X11: use native Rust clipboard (arboard)
		try {
			const nativeImage = await nativeReadImage();
			if (!nativeImage || nativeImage.data.length === 0) {
				return null;
			}
			image = { bytes: nativeImage.data, mimeType: nativeImage.mimeType };
		} catch {
			return null;
		}
	}

	if (!image) {
		return null;
	}

	// Convert unsupported formats (e.g., BMP from WSLg) to PNG
	if (!isSupportedImageMimeType(image.mimeType)) {
		const pngBytes = await convertToPng(image.bytes);
		if (!pngBytes) {
			return null;
		}
		return { bytes: pngBytes, mimeType: "image/png" };
	}

	return image;
}
