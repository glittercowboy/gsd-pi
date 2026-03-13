/**
 * Session-scoped artifact storage for truncated tool outputs.
 *
 * Artifacts are stored in a directory alongside the session file,
 * accessible via artifact:// URLs.
 */
import { mkdirSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Manages artifact storage for a session.
 *
 * Artifacts are stored with sequential IDs in the session's artifact directory.
 * The directory is created lazily on first write.
 */
export class ArtifactManager {
	#nextId = 0;
	readonly #dir: string;
	#dirCreated = false;
	#initialized = false;

	/**
	 * @param sessionFile Path to the session .jsonl file
	 */
	constructor(sessionFile: string) {
		// Artifact directory is session file path without .jsonl extension
		this.#dir = sessionFile.slice(0, -6);
	}

	/**
	 * Artifact directory path.
	 * Directory may not exist until first artifact is saved.
	 */
	get dir(): string {
		return this.#dir;
	}

	#ensureDir(): void {
		if (!this.#dirCreated) {
			mkdirSync(this.#dir, { recursive: true });
			this.#dirCreated = true;
		}
		if (!this.#initialized) {
			this.#scanExistingIds();
			this.#initialized = true;
		}
	}

	/**
	 * Scan existing artifact files to find the next available ID.
	 * Ensures we don't overwrite artifacts when resuming a session.
	 */
	#scanExistingIds(): void {
		const files = this.listFiles();
		let maxId = -1;
		for (const file of files) {
			const match = file.match(/^(\d+)\..*\.log$/);
			if (match) {
				const id = parseInt(match[1], 10);
				if (id > maxId) maxId = id;
			}
		}
		this.#nextId = maxId + 1;
	}

	/** Atomically allocate next artifact ID. */
	allocateId(): number {
		return this.#nextId++;
	}

	/**
	 * Allocate a new artifact path and ID without writing content.
	 * @param toolType Tool name for file extension (e.g., "bash", "fetch")
	 */
	allocatePath(toolType: string): { id: string; path: string } {
		this.#ensureDir();
		const id = String(this.allocateId());
		const filename = `${id}.${toolType}.log`;
		return { id, path: join(this.#dir, filename) };
	}

	/**
	 * Save content as an artifact and return the artifact ID.
	 * @param content Full content to save
	 * @param toolType Tool name for file extension (e.g., "bash", "fetch")
	 * @returns Artifact ID (numeric string)
	 */
	save(content: string, toolType: string): string {
		const { id, path } = this.allocatePath(toolType);
		writeFileSync(path, content);
		return id;
	}

	/**
	 * Check if an artifact exists.
	 * @param id Artifact ID (numeric string)
	 */
	exists(id: string): boolean {
		const files = this.listFiles();
		return files.some((f) => f.startsWith(`${id}.`));
	}

	/**
	 * List all artifact files in the directory.
	 * Returns empty array if directory doesn't exist.
	 */
	listFiles(): string[] {
		try {
			return readdirSync(this.#dir);
		} catch {
			return [];
		}
	}

	/**
	 * Get the full path to an artifact file.
	 * Returns null if artifact doesn't exist.
	 * @param id Artifact ID (numeric string)
	 */
	getPath(id: string): string | null {
		const files = this.listFiles();
		const match = files.find((f) => f.startsWith(`${id}.`));
		return match ? join(this.#dir, match) : null;
	}
}
