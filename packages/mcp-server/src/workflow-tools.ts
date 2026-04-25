/**
 * Workflow MCP tools — exposes the core GSD mutation/read handlers over MCP.
 */

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

type WorkflowToolExecutors = {
  SUPPORTED_SUMMARY_ARTIFACT_TYPES: readonly string[];
  executeMilestoneStatus: (params: { milestoneId: string }, basePath?: string) => Promise<unknown>;
  executePlanMilestone: (
    params: {
      milestoneId: string;
      title: string;
      vision: string;
      slices: Array<{
        sliceId: string;
        title: string;
        risk: string;
        depends: string[];
        demo: string;
        goal: string;
        successCriteria?: string;
        proofLevel?: string;
        integrationClosure?: string;
        observabilityImpact?: string;
        isSketch?: boolean;
        sketchScope?: string;
      }>;
      status?: string;
      dependsOn?: string[];
      successCriteria?: string[];
      keyRisks?: Array<{ risk: string; whyItMatters: string }>;
      proofStrategy?: Array<{ riskOrUnknown: string; retireIn: string; whatWillBeProven: string }>;
      verificationContract?: string;
      verificationIntegration?: string;
      verificationOperational?: string;
      verificationUat?: string;
      definitionOfDone?: string[];
      requirementCoverage?: string;
      boundaryMapMarkdown?: string;
    },
    basePath?: string,
  ) => Promise<unknown>;
  executePlanSlice: (
    params: {
      milestoneId: string;
      sliceId: string;
      goal: string;
      tasks: Array<{
        taskId: string;
        title: string;
        description: string;
        estimate: string;
        files: string[];
        verify: string;
        inputs: string[];
        expectedOutput: string[];
        observabilityImpact?: string;
      }>;
      successCriteria?: string;
      proofLevel?: string;
      integrationClosure?: string;
      observabilityImpact?: string;
    },
    basePath?: string,
  ) => Promise<unknown>;
  executeReplanSlice: (
    params: {
      milestoneId: string;
      sliceId: string;
      blockerTaskId: string;
      blockerDescription: string;
      whatChanged: string;
      updatedTasks: Array<{
        taskId: string;
        title: string;
        description: string;
        estimate: string;
        files: string[];
        verify: string;
        inputs: string[];
        expectedOutput: string[];
        fullPlanMd?: string;
      }>;
      removedTaskIds: string[];
    },
    basePath?: string,
  ) => Promise<unknown>;
  executeSliceComplete: (
    params: {
      sliceId: string;
      milestoneId: string;
      sliceTitle: string;
      oneLiner: string;
      narrative: string;
      verification: string;
      uatContent: string;
      deviations?: string;
      knownLimitations?: string;
      followUps?: string;
      keyFiles?: string[] | string;
      keyDecisions?: string[] | string;
      patternsEstablished?: string[] | string;
      observabilitySurfaces?: string[] | string;
      provides?: string[] | string;
      requirementsSurfaced?: string[] | string;
      drillDownPaths?: string[] | string;
      affects?: string[] | string;
      requirementsAdvanced?: Array<{ id: string; how: string } | string>;
      requirementsValidated?: Array<{ id: string; proof: string } | string>;
      requirementsInvalidated?: Array<{ id: string; what: string } | string>;
      filesModified?: Array<{ path: string; description: string } | string>;
      requires?: Array<{ slice: string; provides: string } | string>;
    },
    basePath?: string,
  ) => Promise<unknown>;
  executeCompleteMilestone: (
    params: {
      milestoneId: string;
      title: string;
      oneLiner: string;
      narrative: string;
      verificationPassed: boolean;
      successCriteriaResults?: string;
      definitionOfDoneResults?: string;
      requirementOutcomes?: string;
      keyDecisions?: string[];
      keyFiles?: string[];
      lessonsLearned?: string[];
      followUps?: string;
      deviations?: string;
    },
    basePath?: string,
  ) => Promise<unknown>;
  executeValidateMilestone: (
    params: {
      milestoneId: string;
      verdict: "pass" | "needs-attention" | "needs-remediation";
      remediationRound: number;
      successCriteriaChecklist: string;
      sliceDeliveryAudit: string;
      crossSliceIntegration: string;
      requirementCoverage: string;
      verificationClasses?: string;
      verdictRationale: string;
      remediationPlan?: string;
    },
    basePath?: string,
  ) => Promise<unknown>;
  executeReassessRoadmap: (
    params: {
      milestoneId: string;
      completedSliceId: string;
      verdict: string;
      assessment: string;
      sliceChanges: {
        modified: Array<{
          sliceId: string;
          title: string;
          risk?: string;
          depends?: string[];
          demo?: string;
        }>;
        added: Array<{
          sliceId: string;
          title: string;
          risk?: string;
          depends?: string[];
          demo?: string;
        }>;
        removed: string[];
      };
    },
    basePath?: string,
  ) => Promise<unknown>;
  executeSaveGateResult: (
    params: {
      milestoneId: string;
      sliceId: string;
      gateId: string;
      taskId?: string;
      verdict: "pass" | "flag" | "omitted";
      rationale: string;
      findings?: string;
    },
    basePath?: string,
  ) => Promise<unknown>;
  executeSummarySave: (
    params: {
      milestone_id: string;
      slice_id?: string;
      task_id?: string;
      artifact_type: string;
      content: string;
    },
    basePath?: string,
  ) => Promise<unknown>;
  executeTaskComplete: (
    params: {
      taskId: string;
      sliceId: string;
      milestoneId: string;
      oneLiner: string;
      narrative: string;
      verification: string;
      deviations?: string;
      knownIssues?: string;
      keyFiles?: string[];
      keyDecisions?: string[];
      blockerDiscovered?: boolean;
      escalation?: {
        question: string;
        options: Array<{ id: string; label: string; tradeoffs: string }>;
        recommendation: string;
        recommendationRationale: string;
        continueWithDefault: boolean;
      };
      verificationEvidence?: Array<
        { command: string; exitCode: number; verdict: string; durationMs: number } | string
      >;
    },
    basePath?: string,
  ) => Promise<unknown>;
};

type WorkflowWriteGateModule = {
  loadWriteGateSnapshot: (basePath?: string) => {
    verifiedDepthMilestones: string[];
    activeQueuePhase: boolean;
    pendingGateId: string | null;
  };
  shouldBlockPendingGateInSnapshot: (
    snapshot: {
      verifiedDepthMilestones: string[];
      activeQueuePhase: boolean;
      pendingGateId: string | null;
    },
    toolName: string,
    milestoneId: string | null,
    queuePhaseActive?: boolean,
  ) => { block: boolean; reason?: string };
  shouldBlockQueueExecutionInSnapshot: (
    snapshot: {
      verifiedDepthMilestones: string[];
      activeQueuePhase: boolean;
      pendingGateId: string | null;
    },
    toolName: string,
    input: string,
    queuePhaseActive?: boolean,
  ) => { block: boolean; reason?: string };
};

type WorkflowDbBootstrapModule = {
  ensureDbOpen: (basePath?: string) => Promise<boolean>;
};

let workflowToolExecutorsPromise: Promise<WorkflowToolExecutors> | null = null;
let workflowExecutionQueue: Promise<void> = Promise.resolve();
let workflowWriteGatePromise: Promise<WorkflowWriteGateModule> | null = null;

function getAllowedProjectRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const configuredRoot = env.GSD_WORKFLOW_PROJECT_ROOT?.trim();
  return configuredRoot ? resolve(configuredRoot) : null;
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve the symlink target of `<allowedRoot>/.gsd` when it points into the
 * external state layout (`~/.gsd/projects/<hash>/`). Returns the realpath of
 * that target so callers can accept worktree paths that live under
 * `<external-state>/worktrees/<MID>/`. Returns null when `.gsd` is absent or
 * resolution fails — the caller should fall back to the direct containment
 * check in that case.
 */
function resolveExternalStateRoot(allowedRoot: string): string | null {
  try {
    return realpathSync(join(allowedRoot, ".gsd"));
  } catch {
    return null;
  }
}

export function validateProjectDir(projectDir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isAbsolute(projectDir)) {
    throw new Error(`projectDir must be an absolute path. Received: ${projectDir}`);
  }

  const lexicallyResolved = resolve(projectDir);
  // Resolve symlinks on the candidate before the containment check so that a
  // symlink inside the allowed root pointing outside of it cannot bypass the
  // guard. Falls back to the lexical path if the candidate does not exist yet
  // (legitimate for a brand-new worktree dir about to be created).
  const resolvedProjectDir = safeRealpath(lexicallyResolved);

  const allowedRoot = getAllowedProjectRoot(env);
  if (!allowedRoot) return resolvedProjectDir;

  const resolvedAllowedRoot = safeRealpath(allowedRoot);
  if (isWithinRoot(resolvedProjectDir, resolvedAllowedRoot)) return resolvedProjectDir;

  // External state layout: `<allowedRoot>/.gsd` may be a symlink into
  // `~/.gsd/projects/<hash>/`, and auto-worktrees live under
  // `~/.gsd/projects/<hash>/worktrees/<MID>/`. Accept candidates that are
  // under the realpath of `<allowedRoot>/.gsd` — they belong to this project
  // even though their absolute path is outside allowedRoot (#issue-a44).
  const externalRoot = resolveExternalStateRoot(resolvedAllowedRoot);
  if (externalRoot && isWithinRoot(resolvedProjectDir, externalRoot)) {
    return resolvedProjectDir;
  }

  throw new Error(
    `projectDir must stay within the configured workflow project root. Received: ${resolvedProjectDir}; allowed root: ${resolvedAllowedRoot}`,
  );
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch (err) {
    // Only fall back for non-existent paths — a legitimate case when a worktree
    // directory hasn't been created yet. Permission errors (EACCES), not-a-
    // directory (ENOTDIR), etc. must propagate so we do not silently degrade
    // to a lexical-only containment check that a restricted symlink could
    // bypass.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return path;
    throw err;
  }
}

function parseToolArgs<T>(schema: z.ZodType<T>, args: Record<string, unknown>): T {
  return schema.parse(args);
}

/**
 * Extract a milestone ID from parsed tool args, trying common field names.
 * Returns null when no field is present or the value is not a string.
 */
function extractMilestoneId(parsed: Record<string, unknown>): string | null {
  const candidates = [parsed.milestoneId, parsed.milestone_id, parsed.mid];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim();
  }
  return null;
}

/**
 * If an auto-worktree exists for the given milestone under
 * `<projectRoot>/.gsd/worktrees/<milestoneId>/`, return that path as the
 * basePath the tool should write against. Returns null when no worktree
 * exists for this milestone, leaving the caller to use the project root.
 *
 * This unbreaks the external-state layout where the MCP server's process.cwd()
 * is the project root (set at Claude Code launch) but auto-mode is actually
 * working inside a per-milestone worktree. Without this, tool writes go to
 * the shared project `.gsd/` and auto-mode's verifyExpectedArtifact (which
 * uses the worktree `.gsd/`) fails, triggering a guaranteed retry per unit.
 */
function resolveActiveWorktreeBasePath(
  projectRoot: string,
  milestoneId: string | null,
): string | null {
  if (!milestoneId) return null;
  const wtPath = join(projectRoot, ".gsd", "worktrees", milestoneId);
  if (!existsSync(wtPath)) return null;
  // Sanity check: a real git worktree has a `.git` file with a gitdir pointer.
  // Bare directories without it shouldn't hijack the write path.
  if (!existsSync(join(wtPath, ".git"))) return null;
  return wtPath;
}

function parseWorkflowArgs<T extends { projectDir?: string }>(
  schema: z.ZodType<T>,
  args: Record<string, unknown>,
): T & { projectDir: string } {
  const parsed = parseToolArgs(schema, args);
  // Step 1: figure out the project root. The agent shouldn't need to pass
  // projectDir — default to process.cwd() which the MCP server inherited from
  // Claude Code (launched at the project root).
  const projectRootCandidate = parsed.projectDir ?? process.cwd();
  const projectRoot = validateProjectDir(projectRootCandidate);

  // Step 2: if this tool call is scoped to a milestone that has an active
  // auto-worktree, re-route writes to the worktree's .gsd rather than the
  // project's shared .gsd. auto-mode's verifyExpectedArtifact runs against
  // the worktree, and a mismatch here causes every unit to retry once.
  const milestoneId = extractMilestoneId(parsed as Record<string, unknown>);
  const worktreeBasePath = resolveActiveWorktreeBasePath(projectRoot, milestoneId);
  const effectiveBasePath = worktreeBasePath ?? projectRoot;

  return {
    ...parsed,
    projectDir: effectiveBasePath,
  };
}

function isWorkflowToolExecutors(value: unknown): value is WorkflowToolExecutors {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const functionExports = [
    "executeMilestoneStatus",
    "executePlanMilestone",
    "executePlanSlice",
    "executeReplanSlice",
    "executeSliceComplete",
    "executeCompleteMilestone",
    "executeValidateMilestone",
    "executeReassessRoadmap",
    "executeSaveGateResult",
    "executeSummarySave",
    "executeTaskComplete",
  ];

  return Array.isArray(record.SUPPORTED_SUMMARY_ARTIFACT_TYPES) &&
    functionExports.every((key) => typeof record[key] === "function");
}

function getSupportedSummaryArtifactTypes(executors: WorkflowToolExecutors): readonly string[] {
  return executors.SUPPORTED_SUMMARY_ARTIFACT_TYPES;
}

function getWriteGateModuleCandidates(): string[] {
  const candidates: string[] = [];
  const explicitModule = process.env.GSD_WORKFLOW_WRITE_GATE_MODULE?.trim();
  if (explicitModule) {
    if (/^[a-z]{2,}:/i.test(explicitModule) && !explicitModule.startsWith("file:")) {
      throw new Error("GSD_WORKFLOW_WRITE_GATE_MODULE only supports file: URLs or filesystem paths.");
    }
    candidates.push(explicitModule.startsWith("file:") ? explicitModule : toFileUrl(explicitModule));
  }

  candidates.push(
    new URL("../../../src/resources/extensions/gsd/bootstrap/write-gate.js", import.meta.url).href,
    new URL("../../../dist/resources/extensions/gsd/bootstrap/write-gate.js", import.meta.url).href,
    new URL("../../../src/resources/extensions/gsd/bootstrap/write-gate.ts", import.meta.url).href,
  );

  return [...new Set(candidates)];
}

function toFileUrl(modulePath: string): string {
  return pathToFileURL(resolve(modulePath)).href;
}

/** @internal — exported for testing only */
export function _buildImportCandidates(relativePath: string): string[] {
  // Build candidate paths: try the given path first, then swap src/<->dist/
  // and try .ts extension. This handles both dev (tsx from src/) and prod
  // (compiled from dist/) execution contexts.
  const candidates: string[] = [relativePath];
  const swapped = relativePath.includes("/src/")
    ? relativePath.replace("/src/", "/dist/")
    : relativePath.includes("/dist/")
      ? relativePath.replace("/dist/", "/src/")
      : null;
  if (swapped) candidates.push(swapped);
  // Also try .ts variants for dev-mode tsx execution
  if (relativePath.endsWith(".js")) {
    candidates.push(relativePath.replace(/\.js$/, ".ts"));
    if (swapped) candidates.push(swapped.replace(/\.js$/, ".ts"));
  }
  return candidates;
}

async function importLocalModule<T>(relativePath: string): Promise<T> {
  const candidates = _buildImportCandidates(relativePath)
    .map((p) => new URL(p, import.meta.url).href);

  let lastErr: unknown;
  for (const candidate of candidates) {
    try {
      return await import(candidate) as T;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function getWorkflowExecutorModuleCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  const explicitModule = env.GSD_WORKFLOW_EXECUTORS_MODULE?.trim();
  if (explicitModule) {
    if (/^[a-z]{2,}:/i.test(explicitModule) && !explicitModule.startsWith("file:")) {
      throw new Error("GSD_WORKFLOW_EXECUTORS_MODULE only supports file: URLs or filesystem paths.");
    }
    candidates.push(explicitModule.startsWith("file:") ? explicitModule : toFileUrl(explicitModule));
  }

  candidates.push(
    new URL("../../../src/resources/extensions/gsd/tools/workflow-tool-executors.js", import.meta.url).href,
    new URL("../../../dist/resources/extensions/gsd/tools/workflow-tool-executors.js", import.meta.url).href,
    new URL("../../../src/resources/extensions/gsd/tools/workflow-tool-executors.ts", import.meta.url).href,
  );

  return [...new Set(candidates)];
}

async function getWorkflowToolExecutors(): Promise<WorkflowToolExecutors> {
  if (!workflowToolExecutorsPromise) {
    workflowToolExecutorsPromise = (async () => {
      const attempts: string[] = [];
      for (const candidate of getWorkflowExecutorModuleCandidates()) {
        try {
          const loaded = await import(candidate);
          if (isWorkflowToolExecutors(loaded)) {
            return loaded;
          }
          attempts.push(`${candidate} (module shape mismatch)`);
        } catch (err) {
          attempts.push(`${candidate} (${err instanceof Error ? err.message : String(err)})`);
        }
      }

      throw new Error(
        "Unable to load GSD workflow executor bridge for MCP mutation tools. " +
        "Set GSD_WORKFLOW_EXECUTORS_MODULE to an importable workflow-tool-executors module, " +
        "or run the MCP server from a GSD checkout that includes src/resources/extensions/gsd/tools/workflow-tool-executors.(js|ts). " +
        `Attempts: ${attempts.join("; ")}`,
      );
    })();
  }
  return workflowToolExecutorsPromise;
}

async function getWorkflowWriteGateModule(): Promise<WorkflowWriteGateModule> {
  if (!workflowWriteGatePromise) {
    workflowWriteGatePromise = (async () => {
      const attempts: string[] = [];
      for (const candidate of getWriteGateModuleCandidates()) {
        try {
          const loaded = await import(candidate);
          if (
            loaded &&
            typeof loaded.loadWriteGateSnapshot === "function" &&
            typeof loaded.shouldBlockPendingGateInSnapshot === "function" &&
            typeof loaded.shouldBlockQueueExecutionInSnapshot === "function"
          ) {
            return loaded as WorkflowWriteGateModule;
          }
          attempts.push(`${candidate} (module shape mismatch)`);
        } catch (err) {
          attempts.push(`${candidate} (${err instanceof Error ? err.message : String(err)})`);
        }
      }

      throw new Error(
        "Unable to load GSD write-gate bridge for workflow MCP tools. " +
        `Attempts: ${attempts.join("; ")}`,
      );
    })();
  }
  return workflowWriteGatePromise;
}

interface McpToolServer {
  tool(
    name: string,
    description: string,
    params: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): unknown;
}

export const WORKFLOW_TOOL_NAMES = [
  "gsd_decision_save",
  "gsd_save_decision",
  "gsd_requirement_update",
  "gsd_update_requirement",
  "gsd_requirement_save",
  "gsd_save_requirement",
  "gsd_milestone_generate_id",
  "gsd_generate_milestone_id",
  "gsd_plan_milestone",
  "gsd_plan_slice",
  "gsd_plan_task",
  "gsd_task_plan",
  "gsd_replan_slice",
  "gsd_slice_replan",
  "gsd_slice_complete",
  "gsd_complete_slice",
  "gsd_skip_slice",
  "gsd_complete_milestone",
  "gsd_milestone_complete",
  "gsd_validate_milestone",
  "gsd_milestone_validate",
  "gsd_reassess_roadmap",
  "gsd_roadmap_reassess",
  "gsd_save_gate_result",
  "gsd_summary_save",
  "gsd_task_complete",
  "gsd_complete_task",
  "gsd_milestone_status",
  "gsd_journal_query",
  // ADR-013 step 3: memory-store tools exposed to external MCP clients.
  // gsd_memory_graph is namespaced to avoid collision with the existing
  // gsd_graph tool (project knowledge graph from .gsd/ artifacts).
  "gsd_capture_thought",
  "gsd_memory_query",
  "gsd_memory_graph",
] as const;

const DEFAULT_WORKFLOW_OP_TIMEOUT_MS = 5 * 60 * 1000;

function getWorkflowOpTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GSD_MCP_WORKFLOW_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_WORKFLOW_OP_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_WORKFLOW_OP_TIMEOUT_MS;
  return parsed; // 0 disables the timeout
}

/**
 * Adapt an executor `ToolExecutionResult` ({ content, details?, isError? }) to
 * the MCP `CallToolResult` shape ({ content, structuredContent?, isError? }).
 *
 * MCP transports (including stdio) only serialize fields declared in the
 * protocol, so a non-standard `details` field is silently dropped over the
 * wire. Mirroring it into `structuredContent` — the protocol's supported
 * channel for structured tool payloads — preserves the data for clients that
 * render from it (e.g. the save_gate_result renderer that reads gateId /
 * verdict). See #4472.
 *
 * Discard policy for non-plain-object `details`: the `isPlainObject` guard
 * accepts the canonical case (a record literal) and intentionally drops bare
 * primitives (string, number, boolean), bare arrays, and class instances /
 * Date objects. This is deliberate — MCP `structuredContent` is specified as
 * a JSON object; non-object payloads can't round-trip cleanly. No current
 * executor returns a non-object `details`, so this never fires in practice.
 * Future executors needing to return a primitive should wrap it
 * (`details: { value: 42 }`) rather than relying on the discard.
 */
function adaptExecutorResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as Record<string, unknown>;
  if (!("details" in r)) return result;
  const { details, ...rest } = r;
  return isPlainObject(details) ? { ...rest, structuredContent: details } : rest;
}

/**
 * Strict plain-object guard. True only for object literals and
 * `Object.create(null)` — not for `Date`, `URL`, `Map`, `Set`, class instances,
 * or arrays. Used to gate `structuredContent` forwarding so the MCP transport
 * receives only true JSON objects (the protocol contract).
 *
 * Mirrored in `src/mcp-server.ts` for the agent-tool registry path's
 * structured-content gate. Keep both copies in sync if the contract definition
 * needs to evolve. See #4477 review.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

async function runSerializedWorkflowOperation<T>(fn: () => Promise<T>): Promise<T> {
  // The shared DB adapter and workflow log base path are process-global, so
  // workflow MCP mutations must not overlap within a single server process.
  // A per-operation deadline prevents a single stuck call from wedging every
  // subsequent write for the lifetime of the process.
  //
  // Known limitation: on timeout we surface an error and release the queue,
  // but Promise.race cannot cancel the underlying `fn()` — it may continue
  // running in the background and overlap with the next admitted operation.
  // Proper cancellation requires threading an AbortSignal through every
  // workflow executor (`workflow-tool-executors.ts` and friends), which is
  // a larger change. The current trade-off: risk a theoretical overlap after
  // a 5-minute wall-clock timeout vs permanently wedging the server. The
  // overlap window is bounded by how long the zombie `fn()` keeps running;
  // in practice DB writes complete quickly even when the caller gave up.
  const prior = workflowExecutionQueue;
  let release!: () => void;
  workflowExecutionQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await prior;
  const timeoutMs = getWorkflowOpTimeoutMs();
  try {
    if (timeoutMs === 0) {
      return await fn();
    }
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Workflow operation exceeded ${timeoutMs}ms deadline (GSD_MCP_WORKFLOW_TIMEOUT_MS)`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([fn(), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    release();
  }
}

async function runSerializedWorkflowDbOperation<T>(
  projectDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runSerializedWorkflowOperation(async () => {
    const { ensureDbOpen } = await importLocalModule<WorkflowDbBootstrapModule>(
      "../../../src/resources/extensions/gsd/bootstrap/dynamic-tools.js",
    );
    const dbAvailable = await ensureDbOpen(projectDir);
    if (!dbAvailable) {
      throw new Error("GSD database is not available");
    }
    return fn();
  });
}

async function enforceWorkflowWriteGate(
  toolName: string,
  projectDir: string,
  milestoneId: string | null = null,
): Promise<void> {
  const writeGate = await getWorkflowWriteGateModule();
  const snapshot = writeGate.loadWriteGateSnapshot(projectDir);
  const pendingGate = writeGate.shouldBlockPendingGateInSnapshot(
    snapshot,
    toolName,
    milestoneId,
    snapshot.activeQueuePhase,
  );
  if (pendingGate.block) {
    throw new Error(pendingGate.reason ?? "workflow tool blocked by pending discussion gate");
  }

  const queueGuard = writeGate.shouldBlockQueueExecutionInSnapshot(
    snapshot,
    toolName,
    "",
    snapshot.activeQueuePhase,
  );
  if (queueGuard.block) {
    throw new Error(queueGuard.reason ?? "workflow tool blocked during queue mode");
  }
}

async function handleTaskComplete(
  projectDir: string,
  args: Omit<z.infer<typeof taskCompleteSchema>, "projectDir">,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_task_complete", projectDir, args.milestoneId);
  const { executeTaskComplete } = await getWorkflowToolExecutors();
  // Pass `args` through directly rather than destructure-then-rebuild. The
  // previous implementation re-listed each field, which silently dropped
  // schema fields that weren't in the rebuild list (e.g., ADR-011's
  // `escalation` payload). The destructure-then-rebuild pattern is the bug
  // class; matching the spread shape used by sibling handlers (handleSliceComplete,
  // handleReplanSlice) eliminates the recurrence risk by construction.
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeTaskComplete(args, projectDir)),
  );
}

async function handleSliceComplete(
  projectDir: string,
  args: z.infer<typeof sliceCompleteSchema>,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_slice_complete", projectDir, args.milestoneId);
  const { executeSliceComplete } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeSliceComplete(params, projectDir)),
  );
}

async function handleReplanSlice(
  projectDir: string,
  args: z.infer<typeof replanSliceSchema>,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_replan_slice", projectDir, args.milestoneId);
  const { executeReplanSlice } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeReplanSlice(params, projectDir)),
  );
}

async function handleCompleteMilestone(
  projectDir: string,
  args: z.infer<typeof completeMilestoneSchema>,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_complete_milestone", projectDir, args.milestoneId);
  const { executeCompleteMilestone } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeCompleteMilestone(params, projectDir)),
  );
}

async function handleValidateMilestone(
  projectDir: string,
  args: z.infer<typeof validateMilestoneSchema>,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_validate_milestone", projectDir, args.milestoneId);
  const { executeValidateMilestone } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeValidateMilestone(params, projectDir)),
  );
}

async function handleReassessRoadmap(
  projectDir: string,
  args: z.infer<typeof reassessRoadmapSchema>,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_reassess_roadmap", projectDir, args.milestoneId);
  const { executeReassessRoadmap } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeReassessRoadmap(params, projectDir)),
  );
}

async function handleSaveGateResult(
  projectDir: string,
  args: z.infer<typeof saveGateResultSchema>,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_save_gate_result", projectDir, args.milestoneId);
  const { executeSaveGateResult } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeSaveGateResult(params, projectDir)),
  );
}

async function ensureMilestoneDbRow(milestoneId: string): Promise<void> {
  try {
    const { insertMilestone } = await importLocalModule<any>("../../../src/resources/extensions/gsd/gsd-db.js");
    insertMilestone({ id: milestoneId, status: "queued" });
  } catch {
    // Ignore pre-existing rows or transient DB availability issues.
  }
}

// projectDir is optional. When omitted, the server uses process.cwd(). This
// prevents the agent from burning tokens reasoning about which absolute path
// to pass (git root vs worktree vs symlink-resolved external state layout) —
// the server already knows where it is running.
const projectDirParam = z
  .string()
  .optional()
  .describe("Optional. Omit this field — the server defaults to its current working directory, which is already the correct project or worktree root.");

const nonEmptyString = (field: string) =>
  z.string().trim().min(1, `${field} must be a non-empty string`);

// Optional non-empty string: accepts omitted/undefined but rejects "" or
// whitespace. Mirrors executor guards of the form
// `value !== undefined && !isNonEmptyString(value)` — e.g. plan-task's
// observabilityImpact. Do not preprocess "" to undefined; the executor
// treats them differently.
const optionalNonEmptyString = (field: string) => nonEmptyString(field).optional();

// Array of non-empty strings. Mirrors executor guards that call
// `validateStringArray` or `arr.some((item) => !isNonEmptyString(item))`.
const nonEmptyStringArray = (field: string) =>
  z.array(nonEmptyString(`${field}[]`));

// Matches the executor's `isNonEmptyString` (trim + length>0) so Zod rejects
// empty/whitespace fields at parse time. Without this, MCP callers pass "" for
// the heavy planning fields, Zod accepts it, and the executor rejects one
// field per call — forcing the agent into a retry loop to discover every gap.
//
// #4759 follow-up: the four heavy fields are Zod-optional because sketch
// slices (isSketch=true) legitimately omit them, but they are REQUIRED for
// every other slice. The conditional requirement is invisible in the JSON
// Schema `required` array, so callers can only discover it from the
// descriptions or by hitting the runtime superRefine below. The `.describe()`
// calls below make that contract unmistakable in the tool schema sent to
// agents; the superRefine enforces it at parse time.
const HEAVY_FIELD_DESCRIBE = (field: string) =>
  `${field} for this slice. REQUIRED unless isSketch=true (sketch slices defer this to refine-slice).`;

const planMilestoneSliceSchema = z.object({
  sliceId: nonEmptyString("sliceId"),
  title: nonEmptyString("title"),
  risk: nonEmptyString("risk"),
  depends: z.array(z.string()),
  demo: nonEmptyString("demo"),
  goal: nonEmptyString("goal"),
  // ADR-011: heavy planning fields are optional for sketch slices; required for full slices.
  successCriteria: z.string().optional().describe(HEAVY_FIELD_DESCRIBE("successCriteria")),
  proofLevel: z.string().optional().describe(HEAVY_FIELD_DESCRIBE("proofLevel")),
  integrationClosure: z.string().optional().describe(HEAVY_FIELD_DESCRIBE("integrationClosure")),
  observabilityImpact: z.string().optional().describe(HEAVY_FIELD_DESCRIBE("observabilityImpact")),
  // ADR-011 sketch-then-refine fields.
  isSketch: z.boolean().optional().describe("ADR-011: true marks this slice as a sketch awaiting refine-slice expansion. When true, successCriteria/proofLevel/integrationClosure/observabilityImpact may be omitted and sketchScope becomes required."),
  sketchScope: z.string().optional().describe("ADR-011: 2-3 sentence scope boundary, required when isSketch=true"),
}).describe(
  "Planned slice. For full slices (isSketch omitted or false): successCriteria, proofLevel, integrationClosure, and observabilityImpact are all required. For sketch slices (isSketch=true): those four fields may be omitted, but sketchScope is required.",
).superRefine((slice, ctx) => {
  if (slice.isSketch === true) {
    if (typeof slice.sketchScope !== "string" || slice.sketchScope.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sketchScope"],
        message: "sketchScope must be a non-empty string when isSketch is true",
      });
    }
    return;
  }
  const required = ["successCriteria", "proofLevel", "integrationClosure", "observabilityImpact"] as const;
  for (const field of required) {
    const value = slice[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must be a non-empty string`,
      });
    }
  }
});

const planMilestoneParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  title: nonEmptyString("title").describe("Milestone title"),
  vision: nonEmptyString("vision").describe("Milestone vision"),
  slices: z.array(planMilestoneSliceSchema).describe("Planned slices for the milestone"),
  status: z.string().optional().describe("Milestone status"),
  dependsOn: z.array(z.string()).optional().describe("Milestone dependencies"),
  successCriteria: z.array(z.string()).optional().describe("Top-level success criteria bullets"),
  keyRisks: z.array(z.object({
    risk: nonEmptyString("risk"),
    whyItMatters: nonEmptyString("whyItMatters"),
  })).optional().describe("Structured risk entries"),
  proofStrategy: z.array(z.object({
    riskOrUnknown: nonEmptyString("riskOrUnknown"),
    retireIn: nonEmptyString("retireIn"),
    whatWillBeProven: nonEmptyString("whatWillBeProven"),
  })).optional().describe("Structured proof strategy entries"),
  verificationContract: z.string().optional(),
  verificationIntegration: z.string().optional(),
  verificationOperational: z.string().optional(),
  verificationUat: z.string().optional(),
  definitionOfDone: z.array(z.string()).optional(),
  requirementCoverage: z.string().optional(),
  boundaryMapMarkdown: z.string().optional(),
};
const planMilestoneSchema = z.object(planMilestoneParams);

const planSliceParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  goal: nonEmptyString("goal").describe("Slice goal"),
  tasks: z.array(z.object({
    taskId: nonEmptyString("taskId"),
    title: nonEmptyString("title"),
    description: nonEmptyString("description"),
    estimate: nonEmptyString("estimate"),
    files: nonEmptyStringArray("files"),
    verify: nonEmptyString("verify"),
    inputs: nonEmptyStringArray("inputs"),
    expectedOutput: nonEmptyStringArray("expectedOutput"),
    observabilityImpact: optionalNonEmptyString("observabilityImpact"),
  })).describe("Planned tasks for the slice"),
  successCriteria: z.string().optional(),
  proofLevel: z.string().optional(),
  integrationClosure: z.string().optional(),
  observabilityImpact: z.string().optional(),
};
const planSliceSchema = z.object(planSliceParams);

const completeMilestoneParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  title: nonEmptyString("title").describe("Milestone title"),
  oneLiner: z.string().describe("One-sentence summary of what the milestone achieved"),
  narrative: z.string().describe("Detailed narrative of what happened during the milestone"),
  verificationPassed: z.boolean().describe("Must be true after milestone verification succeeds"),
  successCriteriaResults: z.string().optional(),
  definitionOfDoneResults: z.string().optional(),
  requirementOutcomes: z.string().optional(),
  keyDecisions: z.array(z.string()).optional(),
  keyFiles: z.array(z.string()).optional(),
  lessonsLearned: z.array(z.string()).optional(),
  followUps: z.string().optional(),
  deviations: z.string().optional(),
};
const completeMilestoneSchema = z.object(completeMilestoneParams);

const validateMilestoneParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  verdict: z.enum(["pass", "needs-attention", "needs-remediation"]).describe("Validation verdict"),
  remediationRound: z.number().describe("Remediation round (0 for first validation)"),
  successCriteriaChecklist: z.string().describe("Markdown checklist of success criteria with evidence"),
  sliceDeliveryAudit: z.string().describe("Markdown auditing each slice's claimed vs delivered output"),
  crossSliceIntegration: z.string().describe("Markdown describing cross-slice issues or closure"),
  requirementCoverage: z.string().describe("Markdown describing requirement coverage and gaps"),
  verificationClasses: z.string().optional(),
  verdictRationale: z.string().describe("Why this verdict was chosen"),
  remediationPlan: z.string().optional(),
};
const validateMilestoneSchema = z.object(validateMilestoneParams);

const roadmapSliceChangeSchema = z.object({
  sliceId: nonEmptyString("sliceId"),
  title: nonEmptyString("title"),
  risk: z.string().optional(),
  depends: z.array(z.string()).optional(),
  demo: z.string().optional(),
});

const reassessRoadmapParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  completedSliceId: nonEmptyString("completedSliceId").describe("Slice ID that just completed"),
  verdict: nonEmptyString("verdict").describe("Assessment verdict such as roadmap-confirmed or roadmap-adjusted"),
  assessment: nonEmptyString("assessment").describe("Assessment text explaining the roadmap decision"),
  sliceChanges: z.object({
    modified: z.array(roadmapSliceChangeSchema),
    added: z.array(roadmapSliceChangeSchema),
    removed: z.array(z.string()),
  }).describe("Slice changes to apply"),
};
const reassessRoadmapSchema = z.object(reassessRoadmapParams);

const saveGateResultParams = {
  projectDir: projectDirParam,
  milestoneId: z.string().describe("Milestone ID (e.g. M001)"),
  sliceId: z.string().describe("Slice ID (e.g. S01)"),
  gateId: z.string().describe("Gate ID (e.g. Q3, Q4, Q5, Q6, Q7, Q8, MV01, MV02, MV03, MV04). Accepts any string for forward-compatibility with new gates."),
  taskId: z.string().optional().describe("Task ID for task-scoped gates"),
  verdict: z.enum(["pass", "flag", "omitted"]).describe("Gate verdict"),
  rationale: z.string().describe("One-sentence justification"),
  findings: z.string().optional().describe("Detailed markdown findings"),
};
const saveGateResultSchema = z.object(saveGateResultParams);

const replanSliceParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  blockerTaskId: nonEmptyString("blockerTaskId").describe("Task ID that discovered the blocker"),
  blockerDescription: nonEmptyString("blockerDescription").describe("Description of the blocker"),
  whatChanged: nonEmptyString("whatChanged").describe("Summary of what changed in the plan"),
  updatedTasks: z.array(z.object({
    taskId: nonEmptyString("taskId"),
    title: nonEmptyString("title"),
    description: z.string(),
    estimate: z.string(),
    files: z.array(z.string()),
    verify: z.string(),
    inputs: z.array(z.string()),
    expectedOutput: z.array(z.string()),
    fullPlanMd: z.string().optional(),
  })).describe("Tasks to upsert into the replanned slice"),
  removedTaskIds: z.array(z.string()).describe("Task IDs to remove from the slice"),
};
const replanSliceSchema = z.object(replanSliceParams);

const sliceCompleteParams = {
  projectDir: projectDirParam,
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  sliceTitle: z.string().describe("Title of the slice"),
  oneLiner: z.string().describe("One-line summary of what the slice accomplished"),
  narrative: z.string().describe("Detailed narrative of what happened across all tasks"),
  verification: z.string().describe("What was verified across all tasks"),
  uatContent: z.string().describe("UAT test content (markdown body)"),
  deviations: z.string().optional(),
  knownLimitations: z.string().optional(),
  followUps: z.string().optional(),
  keyFiles: z.union([z.array(z.string()), z.string()]).optional(),
  keyDecisions: z.union([z.array(z.string()), z.string()]).optional(),
  patternsEstablished: z.union([z.array(z.string()), z.string()]).optional(),
  observabilitySurfaces: z.union([z.array(z.string()), z.string()]).optional(),
  provides: z.union([z.array(z.string()), z.string()]).optional(),
  requirementsSurfaced: z.union([z.array(z.string()), z.string()]).optional(),
  drillDownPaths: z.union([z.array(z.string()), z.string()]).optional(),
  affects: z.union([z.array(z.string()), z.string()]).optional(),
  requirementsAdvanced: z.array(z.union([
    z.object({ id: z.string(), how: z.string() }),
    z.string(),
  ])).optional(),
  requirementsValidated: z.array(z.union([
    z.object({ id: z.string(), proof: z.string() }),
    z.string(),
  ])).optional(),
  requirementsInvalidated: z.array(z.union([
    z.object({ id: z.string(), what: z.string() }),
    z.string(),
  ])).optional(),
  filesModified: z.array(z.union([
    z.object({ path: z.string(), description: z.string() }),
    z.string(),
  ])).optional(),
  requires: z.array(z.union([
    z.object({ slice: z.string(), provides: z.string() }),
    z.string(),
  ])).optional(),
};
const sliceCompleteSchema = z.object(sliceCompleteParams);

const summarySaveParams = {
  projectDir: projectDirParam,
  milestone_id: z.string().describe("Milestone ID (e.g. M001)"),
  slice_id: z.string().optional().describe("Slice ID (e.g. S01)"),
  task_id: z.string().optional().describe("Task ID (e.g. T01)"),
  artifact_type: z.string().describe("Artifact type to save (SUMMARY, RESEARCH, CONTEXT, ASSESSMENT, CONTEXT-DRAFT)"),
  content: z.string().describe("The full markdown content of the artifact"),
};
const summarySaveSchema = z.object(summarySaveParams);

const decisionSaveParams = {
  projectDir: projectDirParam,
  scope: z.string().describe("Scope of the decision (e.g. architecture, library, observability)"),
  decision: z.string().describe("What is being decided"),
  choice: z.string().describe("The choice made"),
  rationale: z.string().describe("Why this choice was made"),
  revisable: z.string().optional().describe("Whether this can be revisited"),
  when_context: z.string().optional().describe("When/context for the decision"),
  made_by: z.enum(["human", "agent", "collaborative"]).optional().describe("Who made the decision"),
};
const decisionSaveSchema = z.object(decisionSaveParams);

const requirementUpdateParams = {
  projectDir: projectDirParam,
  id: z.string().describe("Requirement ID (e.g. R001)"),
  status: z.string().optional().describe("New status"),
  validation: z.string().optional().describe("Validation criteria or proof"),
  notes: z.string().optional().describe("Additional notes"),
  description: z.string().optional().describe("Updated description"),
  primary_owner: z.string().optional().describe("Primary owning slice"),
  supporting_slices: z.string().optional().describe("Supporting slices"),
};
const requirementUpdateSchema = z.object(requirementUpdateParams);

const requirementSaveParams = {
  projectDir: projectDirParam,
  class: z.string().describe("Requirement class"),
  description: z.string().describe("Short description of the requirement"),
  why: z.string().describe("Why this requirement matters"),
  source: z.string().describe("Origin of the requirement"),
  status: z.string().optional().describe("Requirement status"),
  primary_owner: z.string().optional().describe("Primary owning slice"),
  supporting_slices: z.string().optional().describe("Supporting slices"),
  validation: z.string().optional().describe("Validation criteria"),
  notes: z.string().optional().describe("Additional notes"),
};
const requirementSaveSchema = z.object(requirementSaveParams);

const milestoneGenerateIdParams = {
  projectDir: projectDirParam,
};
const milestoneGenerateIdSchema = z.object(milestoneGenerateIdParams);

const planTaskParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  taskId: nonEmptyString("taskId").describe("Task ID (e.g. T01)"),
  title: nonEmptyString("title").describe("Task title"),
  description: nonEmptyString("description").describe("Task description / steps block"),
  estimate: nonEmptyString("estimate").describe("Task estimate"),
  files: z.array(z.string()).describe("Files likely touched"),
  verify: nonEmptyString("verify").describe("Verification command or block"),
  inputs: z.array(z.string()).describe("Input files or references"),
  expectedOutput: z.array(z.string()).describe("Expected output files or artifacts"),
  observabilityImpact: optionalNonEmptyString("observabilityImpact").describe("Task observability impact"),
};
const planTaskSchema = z.object(planTaskParams);

const skipSliceParams = {
  projectDir: projectDirParam,
  sliceId: z.string().describe("Slice ID (e.g. S02)"),
  milestoneId: z.string().describe("Milestone ID (e.g. M003)"),
  reason: z.string().optional().describe("Reason for skipping this slice"),
};
const skipSliceSchema = z.object(skipSliceParams);

const taskCompleteParams = {
  projectDir: projectDirParam,
  taskId: nonEmptyString("taskId").describe("Task ID (e.g. T01)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  oneLiner: z.string().describe("One-line summary of what was accomplished"),
  narrative: z.string().describe("Detailed narrative of what happened during the task"),
  verification: z.string().describe("What was verified and how"),
  deviations: z.string().optional().describe("Deviations from the task plan"),
  knownIssues: z.string().optional().describe("Known issues discovered but not fixed"),
  keyFiles: z.array(z.string()).optional().describe("List of key files created or modified"),
  keyDecisions: z.array(z.string()).optional().describe("List of key decisions made during this task"),
  blockerDiscovered: z.boolean().optional().describe("Whether a plan-invalidating blocker was discovered"),
  // ADR-011 Phase 2: mid-execution escalation — agent asks the user to resolve an ambiguity.
  escalation: z.object({
    question: z.string().describe("The question the user needs to answer — one clear sentence."),
    options: z.array(z.object({
      id: z.string().describe("Short id (e.g. 'A', 'B') used by /gsd escalate resolve."),
      label: z.string().describe("One-line label."),
      tradeoffs: z.string().describe("1-2 sentences on the tradeoffs of this option."),
    })).min(2).max(4).describe("2-4 options the user can choose between."),
    recommendation: z.string().describe("Option id the executor recommends."),
    recommendationRationale: z.string().describe("Why the recommendation — 1-2 sentences."),
    continueWithDefault: z.boolean().describe(
      "When true, loop continues (artifact logged for later review). When false, auto-mode pauses until the user resolves via /gsd escalate resolve.",
    ),
  }).optional().describe("ADR-011 Phase 2: optional escalation payload. Only honored when phases.mid_execution_escalation is true."),
  verificationEvidence: z.array(z.union([
    z.object({
      command: z.string(),
      exitCode: z.number(),
      verdict: z.string(),
      durationMs: z.number(),
    }),
    z.string(),
  ])).optional().describe("Verification evidence entries"),
};
const taskCompleteSchema = z.object(taskCompleteParams);

const milestoneStatusParams = {
  projectDir: projectDirParam,
  milestoneId: z.string().describe("Milestone ID to query (e.g. M001)"),
};
const milestoneStatusSchema = z.object(milestoneStatusParams);

const journalQueryParams = {
  projectDir: projectDirParam,
  flowId: z.string().optional().describe("Filter by flow ID"),
  unitId: z.string().optional().describe("Filter by unit ID"),
  rule: z.string().optional().describe("Filter by rule name"),
  eventType: z.string().optional().describe("Filter by event type"),
  after: z.string().optional().describe("ISO-8601 lower bound (inclusive)"),
  before: z.string().optional().describe("ISO-8601 upper bound (inclusive)"),
  limit: z.number().optional().describe("Maximum entries to return"),
};
const journalQuerySchema = z.object(journalQueryParams);

export function registerWorkflowTools(server: McpToolServer): void {
  server.tool(
    "gsd_decision_save",
    "Record a project decision to the GSD database and regenerate DECISIONS.md.",
    decisionSaveParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(decisionSaveSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_decision_save", projectDir);
      const result = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { saveDecisionToDb } = await importLocalModule<any>("../../../src/resources/extensions/gsd/db-writer.js");
        return saveDecisionToDb(params, projectDir);
      });
      return { content: [{ type: "text" as const, text: `Saved decision ${result.id}` }] };
    },
  );

  server.tool(
    "gsd_save_decision",
    "Alias for gsd_decision_save. Record a project decision to the GSD database and regenerate DECISIONS.md.",
    decisionSaveParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(decisionSaveSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_decision_save", projectDir);
      const result = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { saveDecisionToDb } = await importLocalModule<any>("../../../src/resources/extensions/gsd/db-writer.js");
        return saveDecisionToDb(params, projectDir);
      });
      return { content: [{ type: "text" as const, text: `Saved decision ${result.id}` }] };
    },
  );

  server.tool(
    "gsd_requirement_update",
    "Update an existing requirement in the GSD database and regenerate REQUIREMENTS.md.",
    requirementUpdateParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(requirementUpdateSchema, args);
      const { projectDir, id, ...updates } = parsed;
      await enforceWorkflowWriteGate("gsd_requirement_update", projectDir);
      await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { updateRequirementInDb } = await importLocalModule<any>("../../../src/resources/extensions/gsd/db-writer.js");
        return updateRequirementInDb(id, updates, projectDir);
      });
      return { content: [{ type: "text" as const, text: `Updated requirement ${id}` }] };
    },
  );

  server.tool(
    "gsd_update_requirement",
    "Alias for gsd_requirement_update. Update an existing requirement in the GSD database and regenerate REQUIREMENTS.md.",
    requirementUpdateParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(requirementUpdateSchema, args);
      const { projectDir, id, ...updates } = parsed;
      await enforceWorkflowWriteGate("gsd_requirement_update", projectDir);
      await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { updateRequirementInDb } = await importLocalModule<any>("../../../src/resources/extensions/gsd/db-writer.js");
        return updateRequirementInDb(id, updates, projectDir);
      });
      return { content: [{ type: "text" as const, text: `Updated requirement ${id}` }] };
    },
  );

  server.tool(
    "gsd_requirement_save",
    "Record a new requirement to the GSD database and regenerate REQUIREMENTS.md.",
    requirementSaveParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(requirementSaveSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_requirement_save", projectDir);
      const result = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { saveRequirementToDb } = await importLocalModule<any>("../../../src/resources/extensions/gsd/db-writer.js");
        return saveRequirementToDb(params, projectDir);
      });
      return { content: [{ type: "text" as const, text: `Saved requirement ${result.id}` }] };
    },
  );

  server.tool(
    "gsd_save_requirement",
    "Alias for gsd_requirement_save. Record a new requirement to the GSD database and regenerate REQUIREMENTS.md.",
    requirementSaveParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(requirementSaveSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_requirement_save", projectDir);
      const result = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { saveRequirementToDb } = await importLocalModule<any>("../../../src/resources/extensions/gsd/db-writer.js");
        return saveRequirementToDb(params, projectDir);
      });
      return { content: [{ type: "text" as const, text: `Saved requirement ${result.id}` }] };
    },
  );

  server.tool(
    "gsd_milestone_generate_id",
    "Generate the next milestone ID for a new GSD milestone.",
    milestoneGenerateIdParams,
    async (args: Record<string, unknown>) => {
      const { projectDir } = parseWorkflowArgs(milestoneGenerateIdSchema, args);
      await enforceWorkflowWriteGate("gsd_milestone_generate_id", projectDir);
      const id = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const {
          claimReservedId,
          findMilestoneIds,
          getReservedMilestoneIds,
          nextMilestoneId,
        } = await importLocalModule<any>("../../../src/resources/extensions/gsd/milestone-ids.js");
        const reserved = claimReservedId();
        if (reserved) {
          await ensureMilestoneDbRow(reserved);
          return reserved;
        }
        const allIds = [...new Set([...findMilestoneIds(projectDir), ...getReservedMilestoneIds()])];
        const prefsMod = await importLocalModule<any>(
          "../../../src/resources/extensions/gsd/preferences.js",
        ).catch(() => null);
        // Graceful degradation: a corrupt preferences file should not crash
        // milestone-id generation. Fall back to non-unique IDs if anything
        // throws here — matches the pre-fix behavior for missing prefs.
        let uniqueEnabled = false;
        try {
          uniqueEnabled = !!prefsMod?.loadEffectiveGSDPreferences?.()?.preferences?.unique_milestone_ids;
        } catch {
          uniqueEnabled = false;
        }
        const nextId = nextMilestoneId(allIds, uniqueEnabled);
        await ensureMilestoneDbRow(nextId);
        return nextId;
      });
      return { content: [{ type: "text" as const, text: id }] };
    },
  );

  server.tool(
    "gsd_generate_milestone_id",
    "Alias for gsd_milestone_generate_id. Generate the next milestone ID for a new GSD milestone.",
    milestoneGenerateIdParams,
    async (args: Record<string, unknown>) => {
      const { projectDir } = parseWorkflowArgs(milestoneGenerateIdSchema, args);
      await enforceWorkflowWriteGate("gsd_milestone_generate_id", projectDir);
      const id = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const {
          claimReservedId,
          findMilestoneIds,
          getReservedMilestoneIds,
          nextMilestoneId,
        } = await importLocalModule<any>("../../../src/resources/extensions/gsd/milestone-ids.js");
        const reserved = claimReservedId();
        if (reserved) {
          await ensureMilestoneDbRow(reserved);
          return reserved;
        }
        const allIds = [...new Set([...findMilestoneIds(projectDir), ...getReservedMilestoneIds()])];
        const prefsMod = await importLocalModule<any>(
          "../../../src/resources/extensions/gsd/preferences.js",
        ).catch(() => null);
        // Graceful degradation: a corrupt preferences file should not crash
        // milestone-id generation. Fall back to non-unique IDs if anything
        // throws here — matches the pre-fix behavior for missing prefs.
        let uniqueEnabled = false;
        try {
          uniqueEnabled = !!prefsMod?.loadEffectiveGSDPreferences?.()?.preferences?.unique_milestone_ids;
        } catch {
          uniqueEnabled = false;
        }
        const nextId = nextMilestoneId(allIds, uniqueEnabled);
        await ensureMilestoneDbRow(nextId);
        return nextId;
      });
      return { content: [{ type: "text" as const, text: id }] };
    },
  );

  server.tool(
    "gsd_plan_milestone",
    "Write milestone planning state to the GSD database and render ROADMAP.md from DB.",
    planMilestoneParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(planMilestoneSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_plan_milestone", projectDir, params.milestoneId);
      const { executePlanMilestone } = await getWorkflowToolExecutors();
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(() => executePlanMilestone(params, projectDir)),
      );
    },
  );

  server.tool(
    "gsd_plan_slice",
    "Write slice/task planning state to the GSD database and render plan artifacts from DB.",
    planSliceParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(planSliceSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_plan_slice", projectDir, params.milestoneId);
      const { executePlanSlice } = await getWorkflowToolExecutors();
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(() => executePlanSlice(params, projectDir)),
      );
    },
  );

  server.tool(
    "gsd_plan_task",
    "Write task planning state to the GSD database and render tasks/T##-PLAN.md from DB.",
    planTaskParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(planTaskSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_plan_task", projectDir, params.milestoneId);
      const result = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { handlePlanTask } = await importLocalModule<any>("../../../src/resources/extensions/gsd/tools/plan-task.js");
        return handlePlanTask(params, projectDir);
      });
      if ("error" in result) {
        throw new Error(result.error);
      }
      return {
        content: [{ type: "text" as const, text: `Planned task ${result.taskId} (${result.sliceId}/${result.milestoneId})` }],
      };
    },
  );

  server.tool(
    "gsd_task_plan",
    "Alias for gsd_plan_task. Write task planning state to the GSD database and render tasks/T##-PLAN.md from DB.",
    planTaskParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(planTaskSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_plan_task", projectDir, params.milestoneId);
      const result = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { handlePlanTask } = await importLocalModule<any>("../../../src/resources/extensions/gsd/tools/plan-task.js");
        return handlePlanTask(params, projectDir);
      });
      if ("error" in result) {
        throw new Error(result.error);
      }
      return {
        content: [{ type: "text" as const, text: `Planned task ${result.taskId} (${result.sliceId}/${result.milestoneId})` }],
      };
    },
  );

  server.tool(
    "gsd_replan_slice",
    "Replan a slice after a blocker is discovered, preserving completed tasks and re-rendering PLAN.md + REPLAN.md.",
    replanSliceParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(replanSliceSchema, args);
      return handleReplanSlice(parsed.projectDir, parsed);
    },
  );

  server.tool(
    "gsd_slice_replan",
    "Alias for gsd_replan_slice. Replan a slice after a blocker is discovered.",
    replanSliceParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(replanSliceSchema, args);
      return handleReplanSlice(parsed.projectDir, parsed);
    },
  );

  server.tool(
    "gsd_slice_complete",
    "Record a completed slice to the GSD database, render SUMMARY.md + UAT.md, and update roadmap projection.",
    sliceCompleteParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(sliceCompleteSchema, args);
      return handleSliceComplete(parsed.projectDir, parsed);
    },
  );

  server.tool(
    "gsd_complete_slice",
    "Alias for gsd_slice_complete. Record a completed slice to the GSD database and render summary/UAT artifacts.",
    sliceCompleteParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(sliceCompleteSchema, args);
      return handleSliceComplete(parsed.projectDir, parsed);
    },
  );

  server.tool(
    "gsd_skip_slice",
    "Mark a slice as skipped so auto-mode advances past it without executing.",
    skipSliceParams,
    async (args: Record<string, unknown>) => {
      const { projectDir, milestoneId, sliceId, reason } = parseWorkflowArgs(skipSliceSchema, args);
      await enforceWorkflowWriteGate("gsd_skip_slice", projectDir, milestoneId);
      await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { getSlice, updateSliceStatus } = await importLocalModule<any>("../../../src/resources/extensions/gsd/gsd-db.js");
        const { invalidateStateCache } = await importLocalModule<any>("../../../src/resources/extensions/gsd/state.js");
        const { rebuildState } = await importLocalModule<any>("../../../src/resources/extensions/gsd/doctor.js");
        const slice = getSlice(milestoneId, sliceId);
        if (!slice) {
          throw new Error(`Slice ${sliceId} not found in milestone ${milestoneId}`);
        }
        if (slice.status === "complete" || slice.status === "done") {
          throw new Error(`Slice ${sliceId} is already complete and cannot be skipped`);
        }
        if (slice.status !== "skipped") {
          updateSliceStatus(milestoneId, sliceId, "skipped");
          invalidateStateCache();
          await rebuildState(projectDir);
        }
      });
      return {
        content: [{ type: "text" as const, text: `Skipped slice ${sliceId} (${milestoneId}). Reason: ${reason ?? "User-directed skip"}.` }],
      };
    },
  );

  server.tool(
    "gsd_complete_milestone",
    "Record a completed milestone to the GSD database and render its SUMMARY.md.",
    completeMilestoneParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(completeMilestoneSchema, args);
      return handleCompleteMilestone(parsed.projectDir, parsed);
    },
  );

  server.tool(
    "gsd_milestone_complete",
    "Alias for gsd_complete_milestone. Record a completed milestone to the GSD database and render its SUMMARY.md.",
    completeMilestoneParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(completeMilestoneSchema, args);
      return handleCompleteMilestone(parsed.projectDir, parsed);
    },
  );

  server.tool(
    "gsd_validate_milestone",
    "Validate a milestone, persist validation results to the GSD database, and render VALIDATION.md.",
    validateMilestoneParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(validateMilestoneSchema, args);
      return handleValidateMilestone(parsed.projectDir, parsed);
    },
  );

  server.tool(
    "gsd_milestone_validate",
    "Alias for gsd_validate_milestone. Validate a milestone and render VALIDATION.md.",
    validateMilestoneParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(validateMilestoneSchema, args);
      return handleValidateMilestone(parsed.projectDir, parsed);
    },
  );

  server.tool(
    "gsd_reassess_roadmap",
    "Reassess a milestone roadmap after a slice completes, writing ASSESSMENT.md and re-rendering ROADMAP.md.",
    reassessRoadmapParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(reassessRoadmapSchema, args);
      return handleReassessRoadmap(parsed.projectDir, parsed);
    },
  );

  server.tool(
    "gsd_roadmap_reassess",
    "Alias for gsd_reassess_roadmap. Reassess a roadmap after slice completion.",
    reassessRoadmapParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(reassessRoadmapSchema, args);
      return handleReassessRoadmap(parsed.projectDir, parsed);
    },
  );

  server.tool(
    "gsd_save_gate_result",
    "Save a quality gate result to the GSD database.",
    saveGateResultParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(saveGateResultSchema, args);
      return handleSaveGateResult(parsed.projectDir, parsed);
    },
  );

  server.tool(
    "gsd_summary_save",
    "Save a GSD summary/research/context/assessment artifact to the database and disk.",
    summarySaveParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(summarySaveSchema, args);
      const { projectDir, milestone_id, slice_id, task_id, artifact_type, content } = parsed;
      await enforceWorkflowWriteGate("gsd_summary_save", projectDir, milestone_id);
      const executors = await getWorkflowToolExecutors();
      const supportedArtifactTypes = getSupportedSummaryArtifactTypes(executors);
      if (!supportedArtifactTypes.includes(artifact_type)) {
        throw new Error(
          `artifact_type must be one of: ${supportedArtifactTypes.join(", ")}`,
        );
      }
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(() =>
          executors.executeSummarySave({ milestone_id, slice_id, task_id, artifact_type, content }, projectDir),
        ),
      );
    },
  );

  server.tool(
    "gsd_task_complete",
    "Record a completed task to the GSD database and render its SUMMARY.md.",
    taskCompleteParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(taskCompleteSchema, args);
      const { projectDir, ...taskArgs } = parsed;
      return handleTaskComplete(projectDir, taskArgs);
    },
  );

  server.tool(
    "gsd_complete_task",
    "Alias for gsd_task_complete. Record a completed task to the GSD database and render its SUMMARY.md.",
    taskCompleteParams,
    async (args: Record<string, unknown>) => {
      const parsed = parseWorkflowArgs(taskCompleteSchema, args);
      const { projectDir, ...taskArgs } = parsed;
      return handleTaskComplete(projectDir, taskArgs);
    },
  );

  server.tool(
    "gsd_milestone_status",
    "Read the current status of a milestone and all its slices from the GSD database.",
    milestoneStatusParams,
    async (args: Record<string, unknown>) => {
      // gsd_milestone_status is a read-only query. In-process (query-tools.ts)
      // does not apply the write-gate; MCP must match to avoid blocking reads
      // during pending-gate or queue-mode states.
      const { projectDir, milestoneId } = parseWorkflowArgs(milestoneStatusSchema, args);
      const { executeMilestoneStatus } = await getWorkflowToolExecutors();
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(() => executeMilestoneStatus({ milestoneId }, projectDir)),
      );
    },
  );

  server.tool(
    "gsd_journal_query",
    "Query the structured event journal for auto-mode iterations.",
    journalQueryParams,
    async (args: Record<string, unknown>) => {
      const { projectDir, limit, ...filters } = parseWorkflowArgs(journalQuerySchema, args);
      const { queryJournal } = await importLocalModule<any>("../../../src/resources/extensions/gsd/journal.js");
      const entries = queryJournal(projectDir, filters).slice(0, limit ?? 100);
      if (entries.length === 0) {
        return { content: [{ type: "text" as const, text: "No matching journal entries found." }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }] };
    },
  );

  // ─── ADR-013 step 3 — memory-store tools for external MCP clients ────────
  //
  // The same three tools the LLM sees in-process as `capture_thought`,
  // `memory_query`, and `gsd_graph` (the memory variant). MCP exposes them
  // under the gsd_* prefix and renames the memory graph to gsd_memory_graph
  // to avoid collision with the project knowledge graph tool registered as
  // `gsd_graph` in server.ts.

  const MEMORY_CATEGORY = z.enum([
    "architecture",
    "convention",
    "gotcha",
    "preference",
    "environment",
    "pattern",
  ]);

  const captureThoughtSchema = z.object({
    projectDir: z.string().optional(),
    category: MEMORY_CATEGORY,
    // Reject empty / whitespace-only content at the schema layer so the LLM
    // never produces a memory row with no searchable text.
    content: z.string().trim().min(1, "content must be a non-empty trimmed string"),
    confidence: z.number().min(0.1).max(0.99).optional(),
    tags: z.array(z.string()).optional(),
    scope: z.string().optional(),
    structuredFields: z.record(z.string(), z.unknown()).optional(),
  });
  const captureThoughtParams = {
    projectDir: z.string().optional().describe("Absolute path to the project directory (defaults to MCP server cwd)"),
    category: MEMORY_CATEGORY.describe("Memory category"),
    content: z.string().describe("Memory text (1-3 sentences, no secrets)"),
    confidence: z.number().min(0.1).max(0.99).optional().describe("0.1-0.99, default 0.8"),
    tags: z.array(z.string()).optional().describe("Free-form tags"),
    scope: z.string().optional().describe("Scope name; defaults to 'project'"),
    structuredFields: z.record(z.string(), z.unknown()).optional().describe("ADR-013 structured payload (e.g. decision fields)"),
  };

  server.tool(
    "gsd_capture_thought",
    "Record a durable project insight into the GSD memory store. Categories: architecture, convention, gotcha, preference, environment, pattern. Mirrors the in-process capture_thought tool for external MCP clients.",
    captureThoughtParams,
    async (args: Record<string, unknown>) => {
      const { projectDir, ...params } = parseWorkflowArgs(captureThoughtSchema, args);
      await enforceWorkflowWriteGate("gsd_capture_thought", projectDir);
      return runSerializedWorkflowDbOperation(projectDir, async () => {
        const { executeMemoryCapture } = await importLocalModule<any>(
          "../../../src/resources/extensions/gsd/tools/memory-tools.js",
        );
        return executeMemoryCapture(params);
      });
    },
  );

  const memoryQuerySchema = z.object({
    projectDir: z.string().optional(),
    // Match the documented "2+ char terms" contract in the in-process
    // memory_query tool — reject sub-2-char queries at the schema layer.
    query: z.string().trim().min(2, "query must be at least 2 characters"),
    k: z.number().int().min(1).max(50).optional(),
    category: MEMORY_CATEGORY.optional(),
    scope: z.string().optional(),
    tag: z.string().optional(),
    include_superseded: z.boolean().optional(),
    reinforce_hits: z.boolean().optional(),
  });
  const memoryQueryParams = {
    projectDir: z.string().optional().describe("Absolute path to the project directory (defaults to MCP server cwd)"),
    query: z.string().describe("Keyword query (2+ char terms)"),
    k: z.number().int().min(1).max(50).optional().describe("Max results (default 10, max 50)"),
    category: MEMORY_CATEGORY.optional().describe("Restrict to a single category"),
    scope: z.string().optional().describe("Only include memories with this scope"),
    tag: z.string().optional().describe("Only include memories tagged with this value"),
    include_superseded: z.boolean().optional().describe("Include superseded memories (default false)"),
    reinforce_hits: z.boolean().optional().describe("Increment hit_count on returned memories (default false)"),
  };

  server.tool(
    "gsd_memory_query",
    "Search the GSD memory store by keyword. Returns ranked memories with id, category, content, confidence, scope, and tags. Mirrors the in-process memory_query tool for external MCP clients.",
    memoryQueryParams,
    async (args: Record<string, unknown>) => {
      const { projectDir, ...params } = parseWorkflowArgs(memoryQuerySchema, args);
      return runSerializedWorkflowDbOperation(projectDir, async () => {
        const { executeMemoryQuery } = await importLocalModule<any>(
          "../../../src/resources/extensions/gsd/tools/memory-tools.js",
        );
        return executeMemoryQuery(params);
      });
    },
  );

  const memoryGraphSchema = z.object({
    projectDir: z.string().optional(),
    mode: z.enum(["build", "query"]),
    memoryId: z.string().optional(),
    depth: z.number().int().min(0).max(5).optional(),
    rel: z.enum(["related_to", "depends_on", "contradicts", "elaborates", "supersedes"]).optional(),
  }).refine(
    (val) => val.mode !== "query" || (typeof val.memoryId === "string" && val.memoryId.trim().length > 0),
    { message: "memoryId is required and must be non-empty when mode=query", path: ["memoryId"] },
  );
  const memoryGraphParams = {
    projectDir: z.string().optional().describe("Absolute path to the project directory (defaults to MCP server cwd)"),
    mode: z.enum(["build", "query"]).describe("build = recompute graph (placeholder), query = inspect edges"),
    memoryId: z.string().optional().describe("Memory ID (required when mode=query)"),
    depth: z.number().int().min(0).max(5).optional().describe("Hops to traverse (0-5, default 1)"),
    rel: z.enum(["related_to", "depends_on", "contradicts", "elaborates", "supersedes"]).optional().describe("Only include edges with this relation type"),
  };

  server.tool(
    "gsd_memory_graph",
    "Inspect the relationship graph between memories. mode=query walks edges from a given memoryId. mode=build is a placeholder reserved for future graph rebuilds. Distinct from gsd_graph (project knowledge graph) — see ADR-013.",
    memoryGraphParams,
    async (args: Record<string, unknown>) => {
      const { projectDir, ...params } = parseWorkflowArgs(memoryGraphSchema, args);
      return runSerializedWorkflowDbOperation(projectDir, async () => {
        const { executeGsdGraph } = await importLocalModule<any>(
          "../../../src/resources/extensions/gsd/tools/memory-tools.js",
        );
        return executeGsdGraph(params);
      });
    },
  );
}
