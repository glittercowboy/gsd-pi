import {
  appendFileSync,
  createReadStream,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rename, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { appRoot } from "../app-paths.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogEntry {
  seq: number;
  event: unknown;
  ts: string;
}

// ---------------------------------------------------------------------------
// Directory helper
// ---------------------------------------------------------------------------

/**
 * Returns the event log directory for a given project working directory.
 * Uses a SHA-256 hash of the path to avoid filesystem-unsafe characters.
 */
export function getEventLogDir(projectCwd: string): string {
  const hash = createHash("sha256").update(projectCwd).digest("hex").slice(0, 16);
  return join(appRoot, "web-events", hash);
}

// ---------------------------------------------------------------------------
// EventLog class
// ---------------------------------------------------------------------------

export class EventLog {
  private seq: number = 0;
  private readonly logPath: string;
  private appendCount: number = 0;

  constructor(private readonly logDir: string) {
    this.logPath = join(logDir, "events.jsonl");
  }

  /** Path to the events.jsonl file — used by the SSE route for replay reads. */
  get filePath(): string {
    return this.logPath;
  }

  /** Current sequence number (last assigned seq). */
  get currentSeq(): number {
    return this.seq;
  }

  /**
   * Initialize the event log. Creates the log directory if needed and restores
   * the sequence counter from the last valid JSON line in the existing log file.
   *
   * Resilient to truncated/malformed last lines — scans all lines and keeps
   * the last valid seq found. Safe to call on a fresh (non-existent) log.
   */
  async init(): Promise<void> {
    mkdirSync(this.logDir, { recursive: true });

    let lastValidSeq = 0;
    try {
      const rl = createInterface({
        input: createReadStream(this.logPath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as LogEntry;
          if (typeof entry.seq === "number") {
            lastValidSeq = entry.seq;
          }
        } catch {
          // Malformed line — keep the last valid seq found so far.
        }
      }
    } catch (err: unknown) {
      // ENOENT = fresh log, seq stays 0. Other errors are surfaced.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        process.stderr.write(`[EventLog] init error reading log: ${String(err)}\n`);
      }
    }

    this.seq = lastValidSeq;
  }

  /**
   * Append a new event to the log with the next sequence number.
   *
   * Sync write intentional: guarantees seq ordering under concurrent emits. ~0.1ms on SSD.
   *
   * Write errors (ENOSPC, permission denied, etc.) are logged to stderr and
   * swallowed — logging failures must not interrupt event delivery.
   *
   * Every 100 appends, triggers an inline rotation check as burst protection
   * beyond the hourly fallback timer.
   */
  append(event: unknown): void {
    this.seq++;
    const entry: LogEntry = {
      seq: this.seq,
      event,
      ts: new Date().toISOString(),
    };

    try {
      // Sync write intentional: guarantees seq ordering under concurrent emits. ~0.1ms on SSD.
      appendFileSync(this.logPath, JSON.stringify(entry) + "\n");
    } catch (err: unknown) {
      process.stderr.write(`[EventLog] append error (seq=${this.seq}): ${String(err)}\n`);
      return;
    }

    this.appendCount++;
    if (this.appendCount >= 100) {
      this.appendCount = 0;
      // Fire-and-forget: provides burst protection beyond the hourly timer.
      void this.rotateIfNeeded();
    }
  }

  /**
   * Async iterator that yields log entries with seq > sinceSeq.
   *
   * Pass sinceSeq = -1 to skip replay entirely (returns immediately).
   * Handles missing log file gracefully (empty iterator).
   * Malformed/non-JSON lines are skipped silently.
   */
  async *readSince(sinceSeq: number): AsyncGenerator<LogEntry> {
    if (sinceSeq < 0) return;

    try {
      const rl = createInterface({
        input: createReadStream(this.logPath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as LogEntry;
          if (typeof entry.seq === "number" && entry.seq > sinceSeq) {
            yield entry;
          }
        } catch {
          // Skip malformed lines silently.
        }
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        process.stderr.write(`[EventLog] readSince error: ${String(err)}\n`);
      }
      // ENOENT = no log yet = no entries to replay.
    }
  }

  /**
   * Returns the seq of the first valid JSON line in the log file, or null if
   * the file is missing or empty.
   */
  async oldestSeq(): Promise<number | null> {
    try {
      const rl = createInterface({
        input: createReadStream(this.logPath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as LogEntry;
          if (typeof entry.seq === "number") {
            rl.close();
            return entry.seq;
          }
        } catch {
          // Malformed line — skip and try next.
        }
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        process.stderr.write(`[EventLog] oldestSeq error: ${String(err)}\n`);
      }
    }
    return null;
  }

  /**
   * Rotates the log file if it exceeds 50MB.
   *
   * Keeps the newest ~10MB of data (whole-line boundaries preserved — no line
   * is ever split). Uses atomic POSIX rename so active readline streams on the
   * old inode continue reading safely.
   */
  async rotateIfNeeded(): Promise<void> {
    let fileSize: number;
    try {
      const info = await stat(this.logPath);
      fileSize = info.size;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        process.stderr.write(`[EventLog] rotateIfNeeded stat error: ${String(err)}\n`);
      }
      return; // Nothing to rotate.
    }

    if (fileSize <= 50 * 1024 * 1024) return;

    try {
      // Read entire file content synchronously.
      const content = readFileSync(this.logPath, "utf-8");

      // Split into lines, filter empty.
      const allLines = content.split("\n").filter(l => l.length > 0);

      // Accumulate lines from the END until total byte length reaches ~10MB.
      const keepTarget = 10 * 1024 * 1024;
      const kept: string[] = [];
      let keptBytes = 0;
      for (let i = allLines.length - 1; i >= 0; i--) {
        const lineBytes = Buffer.byteLength(allLines[i] + "\n");
        if (keptBytes + lineBytes > keepTarget && kept.length > 0) break;
        kept.unshift(allLines[i]);
        keptBytes += lineBytes;
      }

      const rotatedContent = kept.join("\n") + "\n";
      const tmpPath = this.logPath + ".tmp";

      // Write to .tmp then atomically rename over the original.
      writeFileSync(tmpPath, rotatedContent, "utf-8");
      // Atomic rename: active readline streams on old inode continue safely (POSIX)
      await rename(tmpPath, this.logPath);
    } catch (err: unknown) {
      process.stderr.write(`[EventLog] rotation error: ${String(err)}\n`);
    }
  }

  /**
   * Placeholder for future cleanup. Currently a no-op.
   */
  dispose(): void {
    // No-op placeholder for future cleanup.
  }
}
