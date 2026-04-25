/**
 * Hashline read tool — reads files with LINE#ID prefix on each line.
 *
 * Produces output like:
 *   1#QQ:function hello() {
 *   2#KX:  return 42;
 *   3#NW:}
 *
 * These tags are used by the hashline_edit tool to address lines precisely.
 */
import type { AgentTool } from "@gsd/pi-agent-core";
import type { ImageContent, TextContent } from "@gsd/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { formatDimensionNote, resizeImage } from "../../utils/image-resize.js";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.js";
import { formatHashLines } from "./hashline.js";
import { resolveReadPath } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type HashlineReadToolInput = Static<typeof readSchema>;

export interface HashlineReadToolDetails {
	truncation?: TruncationResult;
}

/**
 * Pluggable operations for the hashline read tool.
 */
export interface HashlineReadOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	access: (absolutePath: string) => Promise<void>;
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: HashlineReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface HashlineReadToolOptions {
	autoResizeImages?: boolean;
	operations?: HashlineReadOperations;
}

export function createHashlineReadTool(cwd: string, options?: HashlineReadToolOptions): AgentTool<typeof readSchema> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;

	return {
		name: "read",
		label: "read",
		description: `Read a file with LINE#ID hash anchors on each line. These anchors are used by hashline_edit for precise edits. Output format: LINENUM#HASH:CONTENT. Supports text files and images. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Use offset/limit for large files.`,
		parameters: readSchema,
		execute: async (
			_toolCallId: string,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
		) => {
			const absolutePath = resolveReadPath(path, cwd);

			return new Promise<{ content: (TextContent | ImageContent)[]; details: HashlineReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}

					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					if (signal) {
						signal.addEventListener("abort", onAbort, { once: true });
					}

					(async () => {
						try {
							await ops.access(absolutePath);

							if (aborted) return;

							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;

							let content: (TextContent | ImageContent)[];
							let details: HashlineReadToolDetails | undefined;

							if (mimeType) {
								// Image handling (identical to standard read tool)
								const buffer = await ops.readFile(absolutePath);
								const base64 = buffer.toString("base64");

								if (autoResizeImages) {
									const resized = await resizeImage({ type: "image", data: base64, mimeType });
									const dimensionNote = formatDimensionNote(resized);
									let textNote = `Read image file [${resized.mimeType}]`;
									if (dimensionNote) {
										textNote += `\n${dimensionNote}`;
									}
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: resized.data, mimeType: resized.mimeType },
									];
								} else {
									content = [
										{ type: "text", text: `Read image file [${mimeType}]` },
										{ type: "image", data: base64, mimeType },
									];
								}
							} else {
								// Text file — format with hashline prefixes
								const buffer = await ops.readFile(absolutePath);
								const textContent = buffer.toString("utf-8");
								const allLines = textContent.split("\n");
								const totalFileLines = allLines.length;

								let startLine = offset ? Math.max(0, offset - 1) : 0;

								// Clamp offset to file bounds instead of throwing (#3007)
								let offsetClamped = false;
								if (startLine >= allLines.length) {
									startLine = Math.max(0, allLines.length - 1);
									offsetClamped = true;
								}
								const startLineDisplay = startLine + 1;

								let selectedContent: string;
								let userLimitedLines: number | undefined;
								if (limit !== undefined) {
									const endLine = Math.min(startLine + limit, allLines.length);
									selectedContent = allLines.slice(startLine, endLine).join("\n");
									userLimitedLines = endLine - startLine;
								} else {
									selectedContent = allLines.slice(startLine).join("\n");
								}

								// Apply truncation
								const truncation = truncateHead(selectedContent);

								let outputText: string;

								if (truncation.firstLineExceedsLimit) {
									const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
									outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
									details = { truncation };
								} else if (truncation.truncated) {
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;

									// Format with hashline prefixes
									outputText = formatHashLines(truncation.content, startLineDisplay);

									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
									const remaining = allLines.length - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;

									outputText = formatHashLines(truncation.content, startLineDisplay);
									outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
								} else {
									outputText = formatHashLines(truncation.content, startLineDisplay);
								}

								// Prepend clamp notice so the agent knows offset was adjusted
								if (offsetClamped) {
									outputText = `[Offset ${offset} beyond end of file (${totalFileLines} lines). Clamped to line ${startLineDisplay}.]\n\n${outputText}`;
								}

								content = [{ type: "text", text: outputText }];
							}

							if (aborted) return;

							if (signal) signal.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: any) {
							if (signal) signal.removeEventListener("abort", onAbort);
							if (!aborted) {
								reject(error);
							}
						}
					})();
				},
			);
		},
	};
}

/** Default hashline read tool using process.cwd() */
export const hashlineReadTool = createHashlineReadTool(process.cwd());
