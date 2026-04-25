import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import type { LogLevel, LogEntry } from './types.js';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LoggerOptions {
  filePath: string;
  level: LogLevel;
  verbose?: boolean;
}

/**
 * Structured JSON-lines file logger.
 * Writes LogEntry objects one per line in append mode.
 * The open write stream keeps the Node event loop alive (daemon keepalive).
 */
export class Logger {
  private readonly stream: WriteStream;
  private readonly level: number;
  private readonly verbose: boolean;

  constructor(opts: LoggerOptions) {
    // Ensure parent directory exists
    const dir = dirname(opts.filePath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot create log directory ${dir}: ${msg}`);
    }

    this.stream = createWriteStream(opts.filePath, { flags: 'a' });
    this.level = LEVEL_ORDER[opts.level] ?? LEVEL_ORDER.info;
    this.verbose = opts.verbose ?? false;
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.write('debug', msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.write('info', msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.write('warn', msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.write('error', msg, data);
  }

  /** End the write stream. Resolves when the stream is fully flushed. */
  close(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Attach listeners BEFORE triggering end() so a synchronous error
      // from end() or an immediate 'close' cannot slip past the listener.
      this.stream.once('close', () => resolve());
      this.stream.once('error', reject);
      this.stream.end();
    });
  }

  private write(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.level) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(data !== undefined ? { data } : {}),
    };

    const line = JSON.stringify(entry) + '\n';
    this.stream.write(line);

    if (this.verbose) {
      const prefix = `[${entry.ts}] ${level.toUpperCase()}`;
      const suffix = data ? ` ${JSON.stringify(data)}` : '';
      process.stderr.write(`${prefix}: ${msg}${suffix}\n`);
    }
  }
}
