/**
 * Task isolation backends for subagent execution.
 *
 * Provides filesystem isolation via git worktrees or FUSE overlays
 * so concurrent subagents don't stomp on each other's files.
 * Changes are captured as patches and merged back to the main repo.
 */

import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// ============================================================================
// Types
// ============================================================================

export type IsolationMode = "none" | "worktree" | "fuse-overlay";

export interface DeltaPatch {
	/** Patch file path (for logging/debugging) */
	path: string;
	/** Unified diff content */
	content: string;
}

export interface MergeResult {
	success: boolean;
	appliedPatches: string[];
	failedPatches: string[];
	error?: string;
}

export interface IsolationEnvironment {
	/** The isolated working directory */
	workDir: string;
	/** Teardown the isolation environment */
	cleanup: () => Promise<void>;
	/** Capture changes made in the isolated environment */
	captureDelta: () => Promise<DeltaPatch[]>;
}

interface Baseline {
	stagedDiff: string;
	unstagedDiff: string;
	untrackedFiles: Array<{ relativePath: string; content: Buffer }>;
}

// ============================================================================
// Directory helpers
// ============================================================================

function encodeCwd(cwd: string): string {
	return cwd.replace(/\//g, "--");
}

function getIsolationBaseDir(cwd: string, taskId: string): string {
	return path.join(os.homedir(), ".gsd", "wt", encodeCwd(cwd), taskId);
}

// Track active isolation dirs for cleanup on exit
const activeIsolations = new Set<string>();
let exitHandlerRegistered = false;

function registerExitHandler(): void {
	if (exitHandlerRegistered) return;
	exitHandlerRegistered = true;

	const cleanup = () => {
		for (const dir of activeIsolations) {
			try {
				// Best-effort sync cleanup: remove git worktree
				const { execFileSync } = require("node:child_process");
				try {
					execFileSync("git", ["worktree", "remove", "--force", dir], {
						stdio: "ignore",
						timeout: 5000,
					});
				} catch {
					// Worktree may not exist (FUSE mode), just rm
				}
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// Best effort
			}
		}
	};

	process.on("exit", cleanup);
}

// ============================================================================
// Git helpers
// ============================================================================

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFile("git", args, {
		cwd,
		maxBuffer: 50 * 1024 * 1024, // 50MB for large diffs
	});
	return stdout;
}

async function gitSilent(args: string[], cwd: string): Promise<string> {
	try {
		return await git(args, cwd);
	} catch {
		return "";
	}
}

// ============================================================================
// Baseline: capture and apply dirty state
// ============================================================================

async function captureBaseline(repoRoot: string): Promise<Baseline> {
	// Staged changes
	const stagedDiff = await gitSilent(["diff", "--cached", "--binary"], repoRoot);

	// Unstaged changes (tracked files only)
	const unstagedDiff = await gitSilent(["diff", "--binary"], repoRoot);

	// Untracked files
	const untrackedOutput = await gitSilent(
		["ls-files", "--others", "--exclude-standard", "-z"],
		repoRoot,
	);
	const untrackedPaths = untrackedOutput
		.split("\0")
		.filter((p) => p.length > 0);

	const untrackedFiles: Array<{ relativePath: string; content: Buffer }> = [];
	for (const relativePath of untrackedPaths) {
		const fullPath = path.join(repoRoot, relativePath);
		try {
			const stat = fs.statSync(fullPath);
			if (stat.isFile() && stat.size < 10 * 1024 * 1024) {
				// Skip files > 10MB
				untrackedFiles.push({
					relativePath,
					content: fs.readFileSync(fullPath),
				});
			}
		} catch {
			// Skip unreadable files
		}
	}

	return { stagedDiff, unstagedDiff, untrackedFiles };
}

async function applyBaseline(
	worktreeDir: string,
	baseline: Baseline,
): Promise<void> {
	// Apply staged diff
	if (baseline.stagedDiff.trim()) {
		const patchPath = path.join(worktreeDir, ".gsd-staged.patch");
		fs.writeFileSync(patchPath, baseline.stagedDiff);
		try {
			await git(["apply", "--binary", patchPath], worktreeDir);
			await git(["add", "-A"], worktreeDir);
		} catch {
			// Non-fatal: staged diff may not apply cleanly
		} finally {
			fs.unlinkSync(patchPath);
		}
	}

	// Apply unstaged diff on top
	if (baseline.unstagedDiff.trim()) {
		const patchPath = path.join(worktreeDir, ".gsd-unstaged.patch");
		fs.writeFileSync(patchPath, baseline.unstagedDiff);
		try {
			await git(["apply", "--binary", patchPath], worktreeDir);
		} catch {
			// Non-fatal: unstaged diff may not apply cleanly
		} finally {
			fs.unlinkSync(patchPath);
		}
	}

	// Copy untracked files
	for (const file of baseline.untrackedFiles) {
		const dest = path.join(worktreeDir, file.relativePath);
		const destDir = path.dirname(dest);
		fs.mkdirSync(destDir, { recursive: true });
		fs.writeFileSync(dest, file.content);
	}

	// Commit the baseline state so captureDeltaPatch can diff against it
	// without accidentally including the parent's dirty state in the delta.
	await gitSilent(["add", "-A"], worktreeDir);
	await gitSilent(
		["commit", "--allow-empty", "-m", "gsd: baseline snapshot"],
		worktreeDir,
	);
}

// ============================================================================
// Delta capture
// ============================================================================

async function captureDeltaPatch(
	isolationDir: string,
): Promise<DeltaPatch[]> {
	const patches: DeltaPatch[] = [];

	// Add all changes (tracked + untracked) to index for diffing
	await gitSilent(["add", "-A"], isolationDir);

	// Capture the full diff against HEAD
	const diff = await gitSilent(
		["diff", "--cached", "--binary", "HEAD"],
		isolationDir,
	);

	if (diff.trim()) {
		patches.push({
			path: path.join(isolationDir, "delta.patch"),
			content: diff,
		});
	}

	return patches;
}

// ============================================================================
// Worktree backend
// ============================================================================

export async function createWorktreeIsolation(
	repoRoot: string,
	taskId: string,
): Promise<IsolationEnvironment> {
	const worktreeDir = getIsolationBaseDir(repoRoot, taskId);

	registerExitHandler();
	activeIsolations.add(worktreeDir);

	// Create parent directories
	fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });

	// Remove stale worktree if it exists
	try {
		await git(["worktree", "remove", "--force", worktreeDir], repoRoot);
	} catch {
		// Doesn't exist, that's fine
	}
	// Also clean up any leftover directory
	fs.rmSync(worktreeDir, { recursive: true, force: true });

	// Create the worktree
	await git(
		["worktree", "add", "--detach", worktreeDir, "HEAD"],
		repoRoot,
	);

	// Capture and apply the parent's dirty state
	const baseline = await captureBaseline(repoRoot);
	await applyBaseline(worktreeDir, baseline);

	return {
		workDir: worktreeDir,

		async captureDelta(): Promise<DeltaPatch[]> {
			return captureDeltaPatch(worktreeDir);
		},

		async cleanup(): Promise<void> {
			activeIsolations.delete(worktreeDir);
			try {
				await git(
					["worktree", "remove", "--force", worktreeDir],
					repoRoot,
				);
			} catch {
				// Force remove directory if git worktree remove fails
				fs.rmSync(worktreeDir, { recursive: true, force: true });
			}
		},
	};
}

// ============================================================================
// FUSE overlay backend (Linux only)
// ============================================================================

async function findBinary(name: string): Promise<string | null> {
	try {
		const { stdout } = await execFile("which", [name]);
		const p = stdout.trim();
		return p || null;
	} catch {
		return null;
	}
}

export async function createFuseOverlayIsolation(
	repoRoot: string,
	taskId: string,
): Promise<IsolationEnvironment> {
	const baseDir = getIsolationBaseDir(repoRoot, taskId);
	const upperDir = path.join(baseDir, "upper");
	const workDir = path.join(baseDir, "work");
	const mergedDir = path.join(baseDir, "merged");

	// Check for fuse-overlayfs
	const fuseBin = await findBinary("fuse-overlayfs");
	if (!fuseBin) {
		// Fall back to worktree
		return createWorktreeIsolation(repoRoot, taskId);
	}

	registerExitHandler();
	activeIsolations.add(baseDir);

	// Clean up any stale mount/directory
	fs.rmSync(baseDir, { recursive: true, force: true });

	// Create directory structure
	fs.mkdirSync(upperDir, { recursive: true });
	fs.mkdirSync(workDir, { recursive: true });
	fs.mkdirSync(mergedDir, { recursive: true });

	// Mount the overlay
	await execFile(fuseBin, [
		"-o",
		`lowerdir=${repoRoot},upperdir=${upperDir},workdir=${workDir}`,
		mergedDir,
	]);

	// Capture the parent's dirty file set so we can exclude them from the delta.
	// Upper dir will contain both parent-dirty files (visible through overlay) and
	// subagent-written files — we only want the latter.
	const parentDirtyFiles = new Set<string>();
	const parentStatus = await gitSilent(["status", "--porcelain", "-z"], repoRoot);
	for (const entry of parentStatus.split("\0").filter(Boolean)) {
		// Porcelain format: XY filename (skip 3-char prefix)
		const filePath = entry.slice(3);
		if (filePath) parentDirtyFiles.add(filePath);
	}

	return {
		workDir: mergedDir,

		async captureDelta(): Promise<DeltaPatch[]> {
			// Generate patches from upper dir (files actually written by the subagent).
			// Exclude files that were already dirty in the parent repo.
			const patches: DeltaPatch[] = [];
			const diffs: string[] = [];

			const walk = (dir: string, prefix: string) => {
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
					if (entry.isDirectory()) {
						walk(path.join(dir, entry.name), rel);
					} else if (entry.isFile() && !parentDirtyFiles.has(rel)) {
						// This file was written by the subagent, not inherited from parent
						diffs.push(rel);
					}
				}
			};
			walk(upperDir, "");

			if (diffs.length > 0) {
				// Use git diff in the merged dir (which has the .git) for only subagent files
				const diff = await gitSilent(
					["diff", "--binary", "HEAD", "--", ...diffs],
					mergedDir,
				);
				if (diff.trim()) {
					patches.push({
						path: path.join(mergedDir, "delta.patch"),
						content: diff,
					});
				}
			}

			return patches;
		},

		async cleanup(): Promise<void> {
			activeIsolations.delete(baseDir);
			try {
				// Unmount
				const fusermount = (await findBinary("fusermount")) || "fusermount";
				await execFile(fusermount, ["-u", mergedDir]);
			} catch {
				// Try fusermount3 as fallback
				try {
					await execFile("fusermount3", ["-u", mergedDir]);
				} catch {
					// Best effort
				}
			}
			// Remove all dirs
			fs.rmSync(baseDir, { recursive: true, force: true });
		},
	};
}

// ============================================================================
// Unified creation
// ============================================================================

export async function createIsolation(
	repoRoot: string,
	taskId: string,
	mode: IsolationMode,
): Promise<IsolationEnvironment> {
	switch (mode) {
		case "fuse-overlay":
			return createFuseOverlayIsolation(repoRoot, taskId);
		case "worktree":
			return createWorktreeIsolation(repoRoot, taskId);
		default:
			throw new Error(`Isolation mode "${mode}" requires no isolation environment`);
	}
}

// ============================================================================
// Patch merge
// ============================================================================

export async function mergeDeltaPatches(
	repoRoot: string,
	patches: DeltaPatch[],
): Promise<MergeResult> {
	if (patches.length === 0) {
		return { success: true, appliedPatches: [], failedPatches: [] };
	}

	// Combine all patches into one
	const combined = patches.map((p) => p.content).join("\n");
	const patchFile = path.join(
		os.tmpdir(),
		`gsd-merge-${Date.now()}.patch`,
	);

	const appliedPatches: string[] = [];
	const failedPatches: string[] = [];

	try {
		fs.writeFileSync(patchFile, combined);

		// Dry run first
		try {
			await git(
				["apply", "--check", "--binary", patchFile],
				repoRoot,
			);
		} catch (err) {
			// Dry run failed — patches conflict
			for (const p of patches) failedPatches.push(p.path);
			return {
				success: false,
				appliedPatches,
				failedPatches,
				error: `Patch conflict: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		// Apply for real
		await git(["apply", "--binary", patchFile], repoRoot);
		for (const p of patches) appliedPatches.push(p.path);

		return { success: true, appliedPatches, failedPatches };
	} finally {
		try {
			fs.unlinkSync(patchFile);
		} catch {
			// Best effort
		}
	}
}

// ============================================================================
// Settings reader (reads directly from settings file)
// ============================================================================

export function readIsolationMode(): IsolationMode {
	try {
		const { getAgentDir } = require("@gsd/pi-coding-agent");
		const settingsPath = path.join(getAgentDir(), "settings.json");
		if (!fs.existsSync(settingsPath)) return "none";
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		const mode = settings?.taskIsolation?.mode;
		if (mode === "worktree" || mode === "fuse-overlay") return mode;
		return "none";
	} catch {
		return "none";
	}
}

