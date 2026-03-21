import { writeFileSync, renameSync, unlinkSync, mkdirSync, promises as fs } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

const TRANSIENT_LOCK_ERROR_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
const MAX_RENAME_ATTEMPTS = 5;
const SYNC_SLEEP_BUFFER = new SharedArrayBuffer(4);
const SYNC_SLEEP_VIEW = new Int32Array(SYNC_SLEEP_BUFFER);

type RetryableEncoding = BufferEncoding;
type MkdirOptions = { recursive: true };

export interface AtomicWriteAsyncOps {
  mkdir(path: string, options: MkdirOptions): Promise<void>;
  writeFile(path: string, content: string, encoding: RetryableEncoding): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  createTempPath?(filePath: string): string;
}

export interface AtomicWriteSyncOps {
  mkdir(path: string, options: MkdirOptions): void;
  writeFile(path: string, content: string, encoding: RetryableEncoding): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  sleep(ms: number): void;
  createTempPath?(filePath: string): string;
}

function defaultTempPath(filePath: string): string {
  return filePath + `.tmp.${randomBytes(4).toString("hex")}`;
}

function computeRetryDelayMs(attempt: number): number {
  const base = 8 * attempt;
  const jitter = randomBytes(1)[0] % 5;
  return base + jitter;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  Atomics.wait(SYNC_SLEEP_VIEW, 0, 0, ms);
}

function normalizeErrnoCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function isTransientLockError(error: unknown): boolean {
  const code = normalizeErrnoCode(error);
  return typeof code === "string" && TRANSIENT_LOCK_ERROR_CODES.has(code);
}

function buildAtomicWriteError(filePath: string, attempts: number, error: unknown): Error {
  const code = normalizeErrnoCode(error) ?? "UNKNOWN";
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(
    `Atomic write to ${filePath} failed after ${attempts} attempts (last error code: ${code}): ${message}`,
  ) as NodeJS.ErrnoException;
  wrapped.code = code;
  if (error instanceof Error && "stack" in error && error.stack) {
    wrapped.stack = error.stack;
  }
  return wrapped;
}

async function cleanupTempFileAsync(tmpPath: string, ops: AtomicWriteAsyncOps): Promise<void> {
  try {
    await ops.unlink(tmpPath);
  } catch {
    // Best-effort cleanup only.
  }
}

function cleanupTempFileSync(tmpPath: string, ops: AtomicWriteSyncOps): void {
  try {
    ops.unlink(tmpPath);
  } catch {
    // Best-effort cleanup only.
  }
}

/** @internal Exported for retry/cleanup tests. */
export async function atomicWriteAsyncWithOps(
  filePath: string,
  content: string,
  encoding: RetryableEncoding = "utf-8",
  ops: AtomicWriteAsyncOps,
): Promise<void> {
  await ops.mkdir(dirname(filePath), { recursive: true });
  const tmpPath = ops.createTempPath?.(filePath) ?? defaultTempPath(filePath);
  await ops.writeFile(tmpPath, content, encoding);

  let lastError: unknown = null;
  let attempts = 0;

  for (attempts = 1; attempts <= MAX_RENAME_ATTEMPTS; attempts++) {
    try {
      await ops.rename(tmpPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientLockError(error) || attempts === MAX_RENAME_ATTEMPTS) {
        break;
      }
      await ops.sleep(computeRetryDelayMs(attempts));
    }
  }

  await cleanupTempFileAsync(tmpPath, ops);
  throw buildAtomicWriteError(filePath, attempts, lastError);
}

/** @internal Exported for retry/cleanup tests. */
export function atomicWriteSyncWithOps(
  filePath: string,
  content: string,
  encoding: RetryableEncoding = "utf-8",
  ops: AtomicWriteSyncOps,
): void {
  ops.mkdir(dirname(filePath), { recursive: true });
  const tmpPath = ops.createTempPath?.(filePath) ?? defaultTempPath(filePath);
  ops.writeFile(tmpPath, content, encoding);

  let lastError: unknown = null;
  let attempts = 0;

  for (attempts = 1; attempts <= MAX_RENAME_ATTEMPTS; attempts++) {
    try {
      ops.rename(tmpPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientLockError(error) || attempts === MAX_RENAME_ATTEMPTS) {
        break;
      }
      ops.sleep(computeRetryDelayMs(attempts));
    }
  }

  cleanupTempFileSync(tmpPath, ops);
  throw buildAtomicWriteError(filePath, attempts, lastError);
}

const DEFAULT_ASYNC_OPS: AtomicWriteAsyncOps = {
  mkdir: async (path, options) => {
    await fs.mkdir(path, options);
  },
  writeFile: (path, content, encoding) => fs.writeFile(path, content, encoding),
  rename: (from, to) => fs.rename(from, to),
  unlink: (path) => fs.unlink(path),
  sleep: delay,
};

const DEFAULT_SYNC_OPS: AtomicWriteSyncOps = {
  mkdir: (path, options) => mkdirSync(path, options),
  writeFile: (path, content, encoding) => writeFileSync(path, content, encoding),
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path),
  sleep: sleepSync,
};

/**
 * Atomically writes content to a file by writing to a temp file first,
 * then renaming. Prevents partial/corrupt files on crash.
 */
export function atomicWriteSync(filePath: string, content: string, encoding: BufferEncoding = "utf-8"): void {
  return atomicWriteSyncWithOps(filePath, content, encoding, DEFAULT_SYNC_OPS);
}

/**
 * Async variant of atomicWriteSync. Atomically writes content to a file
 * by writing to a temp file first, then renaming.
 */
export async function atomicWriteAsync(filePath: string, content: string, encoding: BufferEncoding = "utf-8"): Promise<void> {
  return atomicWriteAsyncWithOps(filePath, content, encoding, DEFAULT_ASYNC_OPS);
}
