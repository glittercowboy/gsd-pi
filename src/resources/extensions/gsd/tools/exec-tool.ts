// GSD Exec Tool — executor for the gsd_exec MCP tool.
//
// Thin wrapper around exec-sandbox.ts that reads effective options from
// the project preferences (context_mode block) and formats the result
// for MCP return.

import {
  EXEC_DEFAULTS,
  runExecSandbox,
  type ExecSandboxOptions,
  type ExecSandboxRequest,
  type ExecSandboxResult,
} from "../exec-sandbox.js";
import { isContextModeEnabled, type ContextModeConfig } from "../preferences-types.js";

export interface ExecToolParams {
  runtime: ExecSandboxRequest["runtime"];
  script: string;
  purpose?: string;
  timeout_ms?: number;
}

export interface ToolExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

export interface ExecToolDeps {
  baseDir: string;
  preferences: { context_mode?: ContextModeConfig } | null;
  /** Optional override for testing. */
  run?: (req: ExecSandboxRequest, opts: ExecSandboxOptions) => Promise<ExecSandboxResult>;
  now?: () => Date;
  generateId?: () => string;
}

export function buildExecOptions(
  baseDir: string,
  cfg: ContextModeConfig | undefined,
  extras?: Pick<ExecSandboxOptions, "env" | "now" | "generateId">,
): ExecSandboxOptions {
  const allowlist = Array.isArray(cfg?.exec_env_allowlist) ? cfg!.exec_env_allowlist! : EXEC_DEFAULTS.envAllowlist;
  const stdoutCap = clampNumber(
    cfg?.exec_stdout_cap_bytes,
    EXEC_DEFAULTS.stdoutCapBytes,
    4_096,
    16_777_216,
  );
  const defaultTimeout = clampNumber(
    cfg?.exec_timeout_ms,
    EXEC_DEFAULTS.defaultTimeoutMs,
    1_000,
    EXEC_DEFAULTS.clampTimeoutMs,
  );
  const digestChars = clampNumber(cfg?.exec_digest_chars, EXEC_DEFAULTS.digestChars, 0, 4_000);
  return {
    baseDir,
    clamp_timeout_ms: EXEC_DEFAULTS.clampTimeoutMs,
    default_timeout_ms: defaultTimeout,
    stdout_cap_bytes: stdoutCap,
    stderr_cap_bytes: EXEC_DEFAULTS.stderrCapBytes,
    digest_chars: digestChars,
    env_allowlist: allowlist,
    ...extras,
  };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return Math.floor(value);
}

function isEnabled(prefs: ExecToolDeps["preferences"]): boolean {
  return isContextModeEnabled(prefs);
}

function disabledResult(): ToolExecutionResult {
  return {
    content: [
      {
        type: "text",
        text:
          "gsd_exec is disabled by `context_mode.enabled: false` in preferences. Remove that " +
          "override (or set it to true) to re-enable sandboxed tool-output execution.",
      },
    ],
    details: { operation: "gsd_exec", error: "context_mode_disabled" },
    isError: true,
  };
}

function paramError(message: string): ToolExecutionResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    details: { operation: "gsd_exec", error: "invalid_params", detail: message },
    isError: true,
  };
}

export async function executeGsdExec(
  params: ExecToolParams,
  deps: ExecToolDeps,
): Promise<ToolExecutionResult> {
  if (!isEnabled(deps.preferences)) return disabledResult();

  const runtime = params.runtime;
  if (runtime !== "bash" && runtime !== "node" && runtime !== "python") {
    return paramError(`invalid runtime "${String(runtime)}" — must be bash | node | python`);
  }
  const script = typeof params.script === "string" ? params.script : "";
  if (script.trim().length === 0) {
    return paramError("script is required and must be a non-empty string");
  }
  if (Buffer.byteLength(script, "utf8") > 200_000) {
    return paramError("script exceeds the 200 KB length limit");
  }

  const opts = buildExecOptions(
    deps.baseDir,
    deps.preferences?.context_mode,
    { now: deps.now, generateId: deps.generateId },
  );
  const run = deps.run ?? runExecSandbox;

  try {
    const result = await run(
      {
        runtime,
        script,
        ...(typeof params.purpose === "string" ? { purpose: params.purpose } : {}),
        ...(typeof params.timeout_ms === "number" ? { timeout_ms: params.timeout_ms } : {}),
      },
      opts,
    );
    return formatResult(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: gsd_exec failed — ${message}` }],
      details: { operation: "gsd_exec", error: message },
      isError: true,
    };
  }
}

function formatResult(result: ExecSandboxResult): ToolExecutionResult {
  const headerLines = [
    `gsd_exec[${result.id}] runtime=${result.runtime} exit=${formatExit(result)} duration=${result.duration_ms}ms`,
    `  stdout: ${result.stdout_bytes}B${result.stdout_truncated ? " (truncated)" : ""} → ${result.stdout_path}`,
    `  stderr: ${result.stderr_bytes}B${result.stderr_truncated ? " (truncated)" : ""} → ${result.stderr_path}`,
  ];
  const summary = `${headerLines.join("\n")}\n--- digest ---\n${result.digest}`.trimEnd();
  return {
    content: [{ type: "text", text: summary }],
    details: {
      operation: "gsd_exec",
      id: result.id,
      runtime: result.runtime,
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
      meta_path: result.meta_path,
    },
    isError: result.timed_out || result.signal !== null || result.exit_code !== 0,
  };
}

function formatExit(result: ExecSandboxResult): string {
  if (result.timed_out) return "timeout";
  if (result.signal) return `signal:${result.signal}`;
  if (result.exit_code === null) return "null";
  return String(result.exit_code);
}
