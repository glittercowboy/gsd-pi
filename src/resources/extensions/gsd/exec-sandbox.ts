// GSD Exec Sandbox — tool-output sandboxing for sub-sessions.
//
// Runs a script in a subprocess and persists stdout/stderr to
// `.gsd/exec/<id>.{stdout,stderr,meta.json}`. Only a short digest is
// returned to the calling agent's context, keeping large outputs
// (e.g. Playwright snapshots, issue dumps) out of the window.
//
// Inspired by mksglu/context-mode (Elastic License 2.0). Independent
// implementation — no upstream code incorporated.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export interface ExecSandboxRequest {
  /** Interpreter to use. */
  runtime: "bash" | "node" | "python";
  /** Script body. Executed via the runtime's -c equivalent. */
  script: string;
  /** Optional purpose/label recorded in meta.json. */
  purpose?: string;
  /** Per-invocation timeout in ms. Clamped to `clamp_timeout_ms`. */
  timeout_ms?: number;
}

export interface ExecSandboxOptions {
  /** Project root. stdout/stderr persist under `<baseDir>/.gsd/exec/`. */
  baseDir: string;
  /** Absolute upper bound for the timeout. */
  clamp_timeout_ms: number;
  /** Default timeout if request omits one. */
  default_timeout_ms: number;
  /** Cap on persisted stdout bytes. Further output is truncated with a marker. */
  stdout_cap_bytes: number;
  /** Cap on persisted stderr bytes. */
  stderr_cap_bytes: number;
  /** Number of trailing stdout chars returned as the digest. */
  digest_chars: number;
  /** Env var allowlist (case-sensitive). PATH/HOME always forwarded. */
  env_allowlist: readonly string[];
  /** Optional override of process.env for tests. */
  env?: NodeJS.ProcessEnv;
  /** Optional override for the current time (tests). */
  now?: () => Date;
  /** Optional override for id generation (tests). */
  generateId?: () => string;
}

export interface ExecSandboxResult {
  id: string;
  runtime: ExecSandboxRequest["runtime"];
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  duration_ms: number;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  stdout_path: string;
  stderr_path: string;
  meta_path: string;
  digest: string;
}

const ALWAYS_FORWARD_ENV = ["PATH", "HOME"] as const;

export const EXEC_DEFAULTS = {
  clampTimeoutMs: 600_000,
  defaultTimeoutMs: 30_000,
  stdoutCapBytes: 1_048_576,
  stderrCapBytes: 262_144,
  digestChars: 300,
  envAllowlist: [
    "LANG",
    "LC_ALL",
    "TERM",
    "TZ",
    "SHELL",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "NODE_OPTIONS",
    "PYTHONPATH",
    "PYTHONIOENCODING",
  ] as const,
} as const;

function buildChildEnv(opts: ExecSandboxOptions): NodeJS.ProcessEnv {
  const source = opts.env ?? process.env;
  const out: NodeJS.ProcessEnv = {};
  const allowed = new Set<string>([...ALWAYS_FORWARD_ENV, ...opts.env_allowlist]);
  for (const key of allowed) {
    const value = source[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function clampTimeout(request: ExecSandboxRequest, opts: ExecSandboxOptions): number {
  const requested = typeof request.timeout_ms === "number" && Number.isFinite(request.timeout_ms)
    ? Math.floor(request.timeout_ms)
    : opts.default_timeout_ms;
  if (requested < 1) return 1;
  if (requested > opts.clamp_timeout_ms) return opts.clamp_timeout_ms;
  return requested;
}

function resolveCommand(runtime: ExecSandboxRequest["runtime"]): { cmd: string; args: string[] } {
  switch (runtime) {
    case "bash":
      return { cmd: "bash", args: ["-c"] };
    case "node":
      return { cmd: process.execPath, args: ["-e"] };
    case "python":
      return { cmd: "python3", args: ["-c"] };
  }
}

function tail(buf: Buffer, chars: number): string {
  if (chars <= 0) return "";
  const text = buf.toString("utf-8");
  return text.length <= chars ? text : text.slice(text.length - chars);
}

/**
 * Run a script in a subprocess, capture stdout/stderr to files under
 * `.gsd/exec/<id>.{stdout,stderr,meta.json}`, and return an `ExecSandboxResult`
 * containing the digest plus metadata.
 *
 * Errors from spawn failures resolve (not reject) with `exit_code=null`.
 * The function is pure with respect to its inputs — no global state beyond
 * filesystem writes under `baseDir`.
 */
export function runExecSandbox(
  request: ExecSandboxRequest,
  opts: ExecSandboxOptions,
): Promise<ExecSandboxResult> {
  return new Promise((resolveP) => {
    const id = (opts.generateId ?? defaultGenerateId)();
    const now = (opts.now ?? (() => new Date()))();
    const execDir = resolve(opts.baseDir, ".gsd", "exec");
    if (!existsSync(execDir)) mkdirSync(execDir, { recursive: true });
    const stdoutPath = resolve(execDir, `${id}.stdout`);
    const stderrPath = resolve(execDir, `${id}.stderr`);
    const metaPath = resolve(execDir, `${id}.meta.json`);

    const timeoutMs = clampTimeout(request, opts);
    const { cmd, args } = resolveCommand(request.runtime);
    const env = buildChildEnv(opts);
    const useProcessGroup = process.platform !== "win32";

    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, [...args, request.script], {
        cwd: opts.baseDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        ...(useProcessGroup ? { detached: true } : {}),
      });
    } catch (err) {
      const duration = Date.now() - started;
      const message = err instanceof Error ? err.message : String(err);
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, `spawn error: ${message}\n`);
      const result: ExecSandboxResult = {
        id,
        runtime: request.runtime,
        exit_code: null,
        signal: null,
        timed_out: false,
        duration_ms: duration,
        stdout_bytes: 0,
        stderr_bytes: Buffer.byteLength(`spawn error: ${message}\n`),
        stdout_truncated: false,
        stderr_truncated: false,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        meta_path: metaPath,
        digest: `[spawn error: ${message}]`,
      };
      writeMeta(metaPath, result, request, now);
      resolveP(result);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = opts.stdout_cap_bytes - stdoutBytes;
      if (remaining <= 0) {
        stdoutTruncated = true;
        return;
      }
      if (chunk.length <= remaining) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      } else {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        stdoutTruncated = true;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const remaining = opts.stderr_cap_bytes - stderrBytes;
      if (remaining <= 0) {
        stderrTruncated = true;
        return;
      }
      if (chunk.length <= remaining) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      } else {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += remaining;
        stderrTruncated = true;
      }
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (useProcessGroup && child.pid != null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    timer.unref?.();

    const finalize = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      const duration = Date.now() - started;
      const stdoutBuf = Buffer.concat(stdoutChunks);
      const stderrBuf = Buffer.concat(stderrChunks);
      const stdoutSuffix = stdoutTruncated ? "\n[truncated: stdout cap reached]\n" : "";
      const stderrSuffix = stderrTruncated ? "\n[truncated: stderr cap reached]\n" : "";
      writeFileSync(stdoutPath, Buffer.concat([stdoutBuf, Buffer.from(stdoutSuffix, "utf-8")]));
      writeFileSync(stderrPath, Buffer.concat([stderrBuf, Buffer.from(stderrSuffix, "utf-8")]));

      const digestBody = tail(stdoutBuf, opts.digest_chars);
      const digest =
        digestBody.length > 0
          ? digestBody
          : timedOut
            ? "[no stdout — timed out]"
            : stderrBuf.length > 0
              ? `[no stdout — tail of stderr]\n${tail(stderrBuf, opts.digest_chars)}`
              : "[no output]";

      const result: ExecSandboxResult = {
        id,
        runtime: request.runtime,
        exit_code: exitCode,
        signal,
        timed_out: timedOut,
        duration_ms: duration,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        meta_path: metaPath,
        digest,
      };
      writeMeta(metaPath, result, request, now);
      resolveP(result);
    };

    child.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      const line = `child error: ${message}\n`;
      const remaining = opts.stderr_cap_bytes - stderrBytes;
      if (remaining > 0) {
        const chunk = Buffer.from(line, "utf-8").subarray(0, remaining);
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
        if (chunk.length < Buffer.byteLength(line, "utf-8")) stderrTruncated = true;
      }
    });
    child.on("close", (code, signal) => finalize(code, signal));
  });
}

function defaultGenerateId(): string {
  return randomUUID();
}

function writeMeta(
  path: string,
  result: ExecSandboxResult,
  request: ExecSandboxRequest,
  now: Date,
): void {
  const meta = {
    id: result.id,
    runtime: result.runtime,
    purpose: request.purpose ?? null,
    script_chars: request.script.length,
    started_at: now.toISOString(),
    finished_at: new Date(now.getTime() + result.duration_ms).toISOString(),
    exit_code: result.exit_code,
    signal: result.signal,
    timed_out: result.timed_out,
    duration_ms: result.duration_ms,
    stdout_bytes: result.stdout_bytes,
    stderr_bytes: result.stderr_bytes,
    stdout_truncated: result.stdout_truncated,
    stderr_truncated: result.stderr_truncated,
    stdout_path: result.stdout_path,
    stderr_path: result.stderr_path,
  };
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
}
