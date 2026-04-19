import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface WorkflowMcpLaunchConfig {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface WorkflowCapabilityOptions {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  surface?: string;
  unitType?: string;
  authMode?: "apiKey" | "oauth" | "externalCli" | "none";
  baseUrl?: string;
}

const MCP_WORKFLOW_TOOL_SURFACE = new Set([
  "ask_user_questions",
  "gsd_decision_save",
  "gsd_complete_milestone",
  "gsd_complete_task",
  "gsd_complete_slice",
  "gsd_generate_milestone_id",
  "gsd_journal_query",
  "gsd_milestone_complete",
  "gsd_milestone_generate_id",
  "gsd_checkpoint_db",
  "gsd_milestone_status",
  "gsd_milestone_validate",
  "gsd_plan_task",
  "gsd_plan_milestone",
  "gsd_plan_slice",
  "gsd_replan_slice",
  "gsd_reassess_roadmap",
  "gsd_requirement_save",
  "gsd_requirement_update",
  "gsd_roadmap_reassess",
  "gsd_save_decision",
  "gsd_save_gate_result",
  "gsd_save_requirement",
  "gsd_skip_slice",
  "gsd_slice_replan",
  "gsd_slice_complete",
  "gsd_summary_save",
  "gsd_task_plan",
  "gsd_task_complete",
  "gsd_update_requirement",
  "gsd_validate_milestone",
]);

function parseLookupOutput(output: Buffer | string): string {
  return output
    .toString()
    .trim()
    .split(/\r?\n/)[0] ?? "";
}

function parseJsonEnv<T>(env: NodeJS.ProcessEnv, name: string): T | undefined {
  const raw = env[name];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Invalid JSON in ${name}`);
  }
}

function lookupCommand(command: string, platform: NodeJS.Platform = process.platform): string | null {
  const lookup = platform === "win32" ? `where ${command}` : `which ${command}`;
  try {
    const resolved = parseLookupOutput(execSync(lookup, { timeout: 5_000, stdio: "pipe" }));
    return resolved || null;
  } catch {
    return null;
  }
}

function findWorkflowCliFromAncestorPath(startPath: string): string | null {
  let current = resolve(startPath);

  while (true) {
    const candidate = resolve(current, "packages", "mcp-server", "dist", "cli.js");
    if (existsSync(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function getBundledWorkflowMcpCliPath(env: NodeJS.ProcessEnv): string | null {
  const envAnchors = [
    env.GSD_BIN_PATH?.trim(),
    env.GSD_CLI_PATH?.trim(),
    env.GSD_WORKFLOW_PATH?.trim(),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const anchor of envAnchors) {
    const candidate = findWorkflowCliFromAncestorPath(anchor);
    if (candidate) return candidate;
  }

  const candidates = [
    resolve(fileURLToPath(new URL("../../../../packages/mcp-server/src/cli.ts", import.meta.url))),
    resolve(fileURLToPath(new URL("../../../../../packages/mcp-server/src/cli.ts", import.meta.url))),
    resolve(fileURLToPath(new URL("../../../../packages/mcp-server/dist/cli.js", import.meta.url))),
    resolve(fileURLToPath(new URL("../../../../../packages/mcp-server/dist/cli.js", import.meta.url))),
  ];

  for (const bundledCli of candidates) {
    if (existsSync(bundledCli)) return bundledCli;
  }

  return null;
}

function getBundledWorkflowExecutorModulePath(): string | null {
  const candidates = [
    resolve(fileURLToPath(new URL("./tools/workflow-tool-executors.js", import.meta.url))),
    resolve(fileURLToPath(new URL("./tools/workflow-tool-executors.ts", import.meta.url))),
    resolve(fileURLToPath(new URL("../../../../dist/resources/extensions/gsd/tools/workflow-tool-executors.js", import.meta.url))),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function getBundledWorkflowWriteGateModulePath(): string | null {
  const candidates = [
    resolve(fileURLToPath(new URL("./bootstrap/write-gate.js", import.meta.url))),
    resolve(fileURLToPath(new URL("./bootstrap/write-gate.ts", import.meta.url))),
    resolve(fileURLToPath(new URL("../../../../dist/resources/extensions/gsd/bootstrap/write-gate.js", import.meta.url))),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function getResolveTsHookPath(): string | null {
  const candidates = [
    resolve(fileURLToPath(new URL("./tests/resolve-ts.mjs", import.meta.url))),
    resolve(fileURLToPath(new URL("../../../../src/resources/extensions/gsd/tests/resolve-ts.mjs", import.meta.url))),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function mergeNodeOptions(existing: string | undefined, additions: string[]): string | undefined {
  const tokens = (existing ?? "").split(/\s+/).map((value) => value.trim()).filter(Boolean);
  for (const addition of additions) {
    if (!tokens.includes(addition)) {
      tokens.push(addition);
    }
  }
  return tokens.length > 0 ? tokens.join(" ") : undefined;
}

function buildWorkflowLaunchEnv(
  projectRoot: string,
  gsdCliPath: string | undefined,
  explicitEnv?: Record<string, string>,
  workflowCliPath?: string,
): Record<string, string> {
  const executorModulePath = getBundledWorkflowExecutorModulePath();
  const writeGateModulePath = getBundledWorkflowWriteGateModulePath();
  const resolveTsHookPath = getResolveTsHookPath();
  const wantsSourceTs =
    Boolean(resolveTsHookPath) &&
    (
      (workflowCliPath?.endsWith(".ts") ?? false) ||
      (executorModulePath?.endsWith(".ts") ?? false) ||
      (writeGateModulePath?.endsWith(".ts") ?? false)
    );
  const nodeOptions = wantsSourceTs
    ? mergeNodeOptions(explicitEnv?.NODE_OPTIONS, [
        "--experimental-strip-types",
        `--import=${pathToFileURL(resolveTsHookPath!).href}`,
      ])
    : explicitEnv?.NODE_OPTIONS;

  return {
    ...(explicitEnv ?? {}),
    ...(gsdCliPath ? { GSD_CLI_PATH: gsdCliPath } : {}),
    ...(executorModulePath ? { GSD_WORKFLOW_EXECUTORS_MODULE: executorModulePath } : {}),
    ...(writeGateModulePath ? { GSD_WORKFLOW_WRITE_GATE_MODULE: writeGateModulePath } : {}),
    ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
    GSD_PERSIST_WRITE_GATE_STATE: "1",
    GSD_WORKFLOW_PROJECT_ROOT: projectRoot,
  };
}

export function detectWorkflowMcpLaunchConfig(
  projectRoot = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): WorkflowMcpLaunchConfig | null {
  const name = env.GSD_WORKFLOW_MCP_NAME?.trim() || "gsd-workflow";
  const explicitCommand = env.GSD_WORKFLOW_MCP_COMMAND?.trim();
  const explicitArgs = parseJsonEnv<unknown>(env, "GSD_WORKFLOW_MCP_ARGS");
  const explicitEnv = parseJsonEnv<Record<string, string>>(env, "GSD_WORKFLOW_MCP_ENV");
  const explicitCwd = env.GSD_WORKFLOW_MCP_CWD?.trim();
  const gsdCliPath = env.GSD_CLI_PATH?.trim() || env.GSD_BIN_PATH?.trim();
  const workflowProjectRoot =
    explicitEnv?.GSD_WORKFLOW_PROJECT_ROOT?.trim() ||
    env.GSD_WORKFLOW_PROJECT_ROOT?.trim() ||
    env.GSD_PROJECT_ROOT?.trim() ||
    explicitCwd ||
    projectRoot;
  const resolvedWorkflowProjectRoot = resolve(workflowProjectRoot);

  if (explicitCommand) {
    const launchEnv = buildWorkflowLaunchEnv(resolve(workflowProjectRoot), gsdCliPath, explicitEnv);
    return {
      name,
      command: explicitCommand,
      args: Array.isArray(explicitArgs) && explicitArgs.length > 0 ? explicitArgs.map(String) : undefined,
      cwd: explicitCwd || undefined,
      env: Object.keys(launchEnv).length > 0 ? launchEnv : undefined,
    };
  }

  const distCli = resolve(resolvedWorkflowProjectRoot, "packages", "mcp-server", "dist", "cli.js");
  if (existsSync(distCli)) {
    return {
      name,
      command: process.execPath,
      args: [distCli],
      cwd: resolvedWorkflowProjectRoot,
      env: buildWorkflowLaunchEnv(resolvedWorkflowProjectRoot, gsdCliPath, undefined, distCli),
    };
  }

  const bundledCli = getBundledWorkflowMcpCliPath(env);
  if (bundledCli) {
    return {
      name,
      command: process.execPath,
      args: [bundledCli],
      cwd: resolvedWorkflowProjectRoot,
      env: buildWorkflowLaunchEnv(resolvedWorkflowProjectRoot, gsdCliPath, undefined, bundledCli),
    };
  }

  const binPath = lookupCommand("gsd-mcp-server");
  if (binPath) {
    return {
      name,
      command: binPath,
      env: buildWorkflowLaunchEnv(resolvedWorkflowProjectRoot, gsdCliPath),
    };
  }

  return null;
}

export function buildWorkflowMcpServers(
  projectRoot = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Record<string, Record<string, unknown>> | undefined {
  const launch = detectWorkflowMcpLaunchConfig(projectRoot, env);
  if (!launch) return undefined;

  return {
    [launch.name]: {
      command: launch.command,
      ...(launch.args && launch.args.length > 0 ? { args: launch.args } : {}),
      ...(launch.env ? { env: launch.env } : {}),
      ...(launch.cwd ? { cwd: launch.cwd } : {}),
    },
  };
}

export function getRequiredWorkflowToolsForGuidedUnit(unitType: string): string[] {
  switch (unitType) {
    case "discuss-milestone":
      return ["gsd_summary_save", "gsd_plan_milestone"];
    case "discuss-slice":
      return ["gsd_summary_save"];
    case "research-milestone":
    case "research-slice":
      return ["gsd_summary_save"];
    case "plan-milestone":
      return ["gsd_plan_milestone"];
    case "plan-slice":
      return ["gsd_plan_slice"];
    case "execute-task":
      return ["gsd_task_complete"];
    case "complete-slice":
      return ["gsd_slice_complete"];
    default:
      return [];
  }
}

export function getRequiredWorkflowToolsForAutoUnit(unitType: string): string[] {
  switch (unitType) {
    case "discuss-milestone":
      return ["gsd_summary_save", "gsd_plan_milestone"];
    case "research-milestone":
    case "research-slice":
    case "run-uat":
      return ["gsd_summary_save"];
    case "plan-milestone":
      return ["gsd_plan_milestone"];
    case "plan-slice":
      return ["gsd_plan_slice"];
    case "execute-task":
    case "execute-task-simple":
    case "reactive-execute":
      return ["gsd_complete_task"];
    case "complete-slice":
      return ["gsd_complete_slice"];
    case "replan-slice":
      return ["gsd_replan_slice"];
    case "reassess-roadmap":
      return ["gsd_milestone_status", "gsd_reassess_roadmap"];
    case "gate-evaluate":
      return ["gsd_save_gate_result"];
    case "validate-milestone":
      return ["gsd_milestone_status", "gsd_validate_milestone"];
    case "complete-milestone":
      return ["gsd_milestone_status", "gsd_complete_milestone"];
    default:
      return [];
  }
}

export function usesWorkflowMcpTransport(
  authMode: WorkflowCapabilityOptions["authMode"],
  baseUrl: string | undefined,
): boolean {
  return authMode === "externalCli" && typeof baseUrl === "string" && baseUrl.startsWith("local://");
}

export function supportsStructuredQuestions(
  activeTools: string[],
  options: Pick<WorkflowCapabilityOptions, "authMode" | "baseUrl"> = {},
): boolean {
  if (!activeTools.includes("ask_user_questions")) return false;

  return true;
}

export function getWorkflowTransportSupportError(
  provider: string | undefined,
  requiredTools: string[],
  options: WorkflowCapabilityOptions = {},
): string | null {
  if (!provider || requiredTools.length === 0) return null;
  if (!usesWorkflowMcpTransport(options.authMode, options.baseUrl)) return null;

  const projectRoot = options.projectRoot ?? process.cwd();
  const env = options.env ?? process.env;
  const launch = detectWorkflowMcpLaunchConfig(projectRoot, env);
  const surface = options.surface ?? "workflow dispatch";
  const unitLabel = options.unitType ? ` for ${options.unitType}` : "";
  const providerLabel = `"${provider}"`;

  if (!launch) {
    return `Provider ${providerLabel} cannot run ${surface}${unitLabel}: the GSD workflow MCP server is not configured or discoverable. Detected Claude Code model but no workflow MCP. Please run /gsd mcp init . from your project root. You can also configure GSD_WORKFLOW_MCP_COMMAND, build packages/mcp-server/dist/cli.js, or install gsd-mcp-server on PATH.`;
  }

  const missing = [...new Set(requiredTools)].filter((tool) => !MCP_WORKFLOW_TOOL_SURFACE.has(tool));
  if (missing.length === 0) return null;

  return `Provider ${providerLabel} cannot run ${surface}${unitLabel}: this unit requires ${missing.join(", ")}, but the workflow MCP transport currently exposes only ${Array.from(MCP_WORKFLOW_TOOL_SURFACE).sort().join(", ")}.`;
}
