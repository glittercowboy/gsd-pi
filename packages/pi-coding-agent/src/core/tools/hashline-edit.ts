/**
 * Hashline edit tool — applies file edits using line-hash anchors.
 *
 * The model references lines by `LINE#ID` tags from read output.
 * Each tag uniquely identifies a line, so edits remain stable even when lines shift.
 */
import type { AgentTool } from "@gsd/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, unlink as fsUnlink, writeFile as fsWriteFile } from "fs/promises";
import {
	detectLineEnding,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.js";
import {
	type Anchor,
	applyHashlineEdits,
	computeLineHash,
	type HashlineEdit,
	parseHashlineText,
	parseTag,
} from "./hashline.js";
import { resolveToCwd } from "./path-utils.js";

// ═══════════════════════════════════════════════════════════════════════════
// Schema
// ═══════════════════════════════════════════════════════════════════════════

const hashlineEditItemSchema = Type.Object(
	{
		op: Type.Union([Type.Literal("replace"), Type.Literal("append"), Type.Literal("prepend")]),
		pos: Type.Optional(Type.String({ description: "Anchor tag (e.g. \"5#QQ\")" })),
		end: Type.Optional(Type.String({ description: "End anchor for range replace" })),
		lines: Type.Union([
			Type.Array(Type.String(), { description: "Replacement content lines" }),
			Type.String(),
			Type.Null(),
		]),
	},
	{ additionalProperties: false },
);

const hashlineEditSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit" }),
		edits: Type.Array(hashlineEditItemSchema, { description: "Edits to apply (referenced by LINE#ID tags from read output)" }),
		delete: Type.Optional(Type.Boolean({ description: "If true, delete the file" })),
		move: Type.Optional(Type.String({ description: "If set, move/rename the file to this path" })),
	},
	{ additionalProperties: false },
);

export type HashlineEditInput = Static<typeof hashlineEditSchema>;
export type HashlineEditItem = Static<typeof hashlineEditItemSchema>;

export interface HashlineEditToolDetails {
	/** Unified diff of the changes made */
	diff: string;
	/** Line number of the first change in the new file */
	firstChangedLine?: number;
}

/**
 * Pluggable operations for the hashline edit tool.
 */
export interface HashlineEditOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	access: (absolutePath: string) => Promise<void>;
	unlink: (absolutePath: string) => Promise<void>;
}

const defaultHashlineEditOperations: HashlineEditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
	unlink: (path) => fsUnlink(path),
};

export interface HashlineEditToolOptions {
	operations?: HashlineEditOperations;
}

/** Parse a tag, returning undefined instead of throwing on garbage. */
function tryParseTag(raw: string): Anchor | undefined {
	try {
		return parseTag(raw);
	} catch {
		return undefined;
	}
}

/**
 * Map flat tool-schema edits into typed HashlineEdit objects.
 */
function resolveEditAnchors(edits: HashlineEditItem[]): HashlineEdit[] {
	const result: HashlineEdit[] = [];
	for (const edit of edits) {
		const lines = parseHashlineText(edit.lines);
		const tag = edit.pos ? tryParseTag(edit.pos) : undefined;
		const end = edit.end ? tryParseTag(edit.end) : undefined;

		const op = edit.op === "append" || edit.op === "prepend" ? edit.op : "replace";
		switch (op) {
			case "replace": {
				if (tag && end) {
					result.push({ op: "replace", pos: tag, end, lines });
				} else if (tag || end) {
					result.push({ op: "replace", pos: tag || end!, lines });
				} else {
					throw new Error("Replace requires at least one anchor (pos or end).");
				}
				break;
			}
			case "append": {
				result.push({ op: "append", pos: tag ?? end, lines });
				break;
			}
			case "prepend": {
				result.push({ op: "prepend", pos: end ?? tag, lines });
				break;
			}
		}
	}
	return result;
}

const HASHLINE_EDIT_DESCRIPTION = `Edit a file by referencing LINE#ID tags from read output. Each tag uniquely identifies a line via content hash, so edits remain stable even when lines shift.

Read the file first to get fresh tags. Submit one edit call per file with all operations batched.

Operations:
- replace: Replace line(s) at pos (and optionally through end) with lines content
- append: Insert lines after pos (omit pos for end of file)
- prepend: Insert lines before pos (omit pos for beginning of file)

Set lines to null or [] to delete lines. Set delete:true to delete the file.`;

export function createHashlineEditTool(cwd: string, options?: HashlineEditToolOptions): AgentTool<typeof hashlineEditSchema> {
	const ops = options?.operations ?? defaultHashlineEditOperations;

	return {
		name: "hashline_edit",
		label: "hashline_edit",
		description: HASHLINE_EDIT_DESCRIPTION,
		parameters: hashlineEditSchema,
		execute: async (
			_toolCallId: string,
			params: HashlineEditInput,
			signal?: AbortSignal,
		) => {
			const { path, edits, delete: deleteFile, move } = params;
			const absolutePath = resolveToCwd(path, cwd);

			return new Promise<{
				content: Array<{ type: "text"; text: string }>;
				details: HashlineEditToolDetails | undefined;
			}>((resolve, reject) => {
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
						// Handle delete
						if (deleteFile) {
							let fileExists = true;
							try {
								await ops.access(absolutePath);
							} catch {
								fileExists = false;
							}
							if (fileExists) {
								await ops.unlink(absolutePath);
							}
							if (signal) signal.removeEventListener("abort", onAbort);
							resolve({
								content: [{ type: "text", text: fileExists ? `Deleted ${path}` : `File not found, nothing to delete: ${path}` }],
								details: { diff: "" },
							});
							return;
						}

						// Handle file creation (no existing file, anchorless appends/prepends)
						let fileExists = true;
						try {
							await ops.access(absolutePath);
						} catch {
							fileExists = false;
						}

						if (!fileExists) {
							const lines: string[] = [];
							for (const edit of edits) {
								if ((edit.op === "append" || edit.op === "prepend") && !edit.pos && !edit.end) {
									if (edit.op === "prepend") {
										lines.unshift(...parseHashlineText(edit.lines));
									} else {
										lines.push(...parseHashlineText(edit.lines));
									}
								} else {
									throw new Error(`File not found: ${path}`);
								}
							}
							await ops.writeFile(absolutePath, lines.join("\n"));
							if (signal) signal.removeEventListener("abort", onAbort);
							resolve({
								content: [{ type: "text", text: `Created ${path}` }],
								details: { diff: "" },
							});
							return;
						}

						if (aborted) return;

						// Read file
						const rawContent = (await ops.readFile(absolutePath)).toString("utf-8");
						const { bom, text } = stripBom(rawContent);
						const originalEnding = detectLineEnding(text);
						const originalNormalized = normalizeToLF(text);

						if (aborted) return;

						// Resolve and apply edits
						const anchorEdits = resolveEditAnchors(edits);
						const result = applyHashlineEdits(originalNormalized, anchorEdits);

						if (originalNormalized === result.lines && !move) {
							let diagnostic = `No changes made to ${path}. The edits produced identical content.`;
							if (result.noopEdits && result.noopEdits.length > 0) {
								const details = result.noopEdits
									.map(
										e =>
											`Edit ${e.editIndex}: replacement for ${e.loc} is identical to current content:\n  ${e.loc}| ${e.current}`,
									)
									.join("\n");
								diagnostic += `\n${details}`;
								diagnostic +=
									"\nYour content must differ from what the file already contains. Re-read the file to see the current state.";
							}
							throw new Error(diagnostic);
						}

						if (aborted) return;

						// Write result
						const finalContent = bom + restoreLineEndings(result.lines, originalEnding);
						const writePath = move ? resolveToCwd(move, cwd) : absolutePath;

						// Prevent silent overwrite when moving to an existing file
						if (move && writePath !== absolutePath) {
							try {
								await ops.access(writePath);
								// If access succeeds, the file exists — refuse the move
								throw new Error(`Destination file already exists: ${writePath}. Use a different path or delete the existing file first.`);
							} catch (err: any) {
								// Re-throw our own error; swallow only "file not found"
								if (err.message?.startsWith("Destination file already exists:")) throw err;
								// File doesn't exist — safe to proceed
							}
						}

						await ops.writeFile(writePath, finalContent);

						// If moved, delete original
						if (move && writePath !== absolutePath) {
							await ops.unlink(absolutePath);
						}

						if (aborted) return;

						if (signal) signal.removeEventListener("abort", onAbort);

						const diffResult = generateDiffString(originalNormalized, result.lines);
						const resultText = move ? `Moved ${path} to ${move}` : `Updated ${path}`;
						const warningsBlock = result.warnings?.length
							? `\nWarnings:\n${result.warnings.join("\n")}`
							: "";

						resolve({
							content: [
								{
									type: "text",
									text: `${resultText}${warningsBlock}`,
								},
							],
							details: {
								diff: diffResult.diff,
								firstChangedLine: result.firstChangedLine ?? diffResult.firstChangedLine,
							},
						});
					} catch (error: any) {
						if (signal) signal.removeEventListener("abort", onAbort);
						if (!aborted) {
							reject(error);
						}
					}
				})();
			});
		},
	};
}

/** Default hashline edit tool using process.cwd() */
export const hashlineEditTool = createHashlineEditTool(process.cwd());
