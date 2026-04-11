/**
 * Workflow MCP tools — exposes the core GSD mutation/read handlers over MCP.
 */

import { isAbsolute, relative, resolve } from "node:path";
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
        successCriteria: string;
        proofLevel: string;
        integrationClosure: string;
        observabilityImpact: string;
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

function validateProjectDir(projectDir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isAbsolute(projectDir)) {
    throw new Error(`projectDir must be an absolute path. Received: ${projectDir}`);
  }

  const resolvedProjectDir = resolve(projectDir);
  const allowedRoot = getAllowedProjectRoot(env);
  if (allowedRoot && !isWithinRoot(resolvedProjectDir, allowedRoot)) {
    throw new Error(
      `projectDir must stay within the configured workflow project root. Received: ${resolvedProjectDir}; allowed root: ${allowedRoot}`,
    );
  }

  return resolvedProjectDir;
}

function parseToolArgs<T>(schema: z.ZodType<T>, args: Record<string, unknown>): T {
  return schema.parse(args);
}

function parseWorkflowArgs<T extends { projectDir: string }>(
  schema: z.ZodType<T>,
  args: Record<string, unknown>,
): T {
  const parsed = parseToolArgs(schema, args);
  return {
    ...parsed,
    projectDir: validateProjectDir(parsed.projectDir),
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
] as const;

async function runSerializedWorkflowOperation<T>(fn: () => Promise<T>): Promise<T> {
  // The shared DB adapter and workflow log base path are process-global, so
  // workflow MCP mutations must not overlap within a single server process.
  const prior = workflowExecutionQueue;
  let release!: () => void;
  workflowExecutionQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await prior;
  try {
    return await fn();
  } finally {
    release();
  }
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
  const {
    taskId,
    sliceId,
    milestoneId,
    oneLiner,
    narrative,
    verification,
    deviations,
    knownIssues,
    keyFiles,
    keyDecisions,
    blockerDiscovered,
    verificationEvidence,
  } = args;
  const { executeTaskComplete } = await getWorkflowToolExecutors();
  return runSerializedWorkflowOperation(() =>
    executeTaskComplete(
      {
        taskId,
        sliceId,
        milestoneId,
        oneLiner,
        narrative,
        verification,
        deviations,
        knownIssues,
        keyFiles,
        keyDecisions,
        blockerDiscovered,
        verificationEvidence,
      },
      projectDir,
    ),
  );
}

async function handleSliceComplete(
  projectDir: string,
  args: z.infer<typeof sliceCompleteSchema>,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_slice_complete", projectDir, args.milestoneId);
  const { executeSliceComplete } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return runSerializedWorkflowOperation(() => executeSliceComplete(params, projectDir));
}

async function handleReplanSlice(
  projectDir: string,
  args: z.infer<typeof replanSliceSchema>,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_replan_slice", projectDir, args.milestoneId);
  const { executeReplanSlice } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return runSerializedWorkflowOperation(() => executeReplanSlice(params, projectDir));
}

async function handleCompleteMilestone(
  projectDir: string,
  args: z.infer<typeof completeMilestoneSchema>,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_complete_milestone", projectDir, args.milestoneId);
  const { executeCompleteMilestone } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return runSerializedWorkflowOperation(() => executeCompleteMilestone(params, projectDir));
}

async function handleValidateMilestone(
  projectDir: string,
  args: z.infer<typeof validateMilestoneSchema>,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_validate_milestone", projectDir, args.milestoneId);
  const { executeValidateMilestone } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return runSerializedWorkflowOperation(() => executeValidateMilestone(params, projectDir));
}

async function handleReassessRoadmap(
  projectDir: string,
  args: z.infer<typeof reassessRoadmapSchema>,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_reassess_roadmap", projectDir, args.milestoneId);
  const { executeReassessRoadmap } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return runSerializedWorkflowOperation(() => executeReassessRoadmap(params, projectDir));
}

async function handleSaveGateResult(
  projectDir: string,
  args: z.infer<typeof saveGateResultSchema>,
): Promise<unknown> {
  await enforceWorkflowWriteGate("gsd_save_gate_result", projectDir, args.milestoneId);
  const { executeSaveGateResult } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return runSerializedWorkflowOperation(() => executeSaveGateResult(params, projectDir));
}

async function ensureMilestoneDbRow(milestoneId: string): Promise<void> {
  try {
    const { insertMilestone } = await importLocalModule<any>("../../../src/resources/extensions/gsd/gsd-db.js");
    insertMilestone({ id: milestoneId, status: "queued" });
  } catch {
    // Ignore pre-existing rows or transient DB availability issues.
  }
}

const projectDirParam = z.string().describe("Absolute path to the project directory within the configured workflow root");

const planMilestoneParams = {
  projectDir: projectDirParam,
  milestoneId: z.string().describe("Milestone ID (e.g. M001)"),
  title: z.string().describe("Milestone title"),
  vision: z.string().describe("Milestone vision"),
  slices: z.array(z.object({
    sliceId: z.string(),
    title: z.string(),
    risk: z.string(),
    depends: z.array(z.string()),
    demo: z.string(),
    goal: z.string(),
    successCriteria: z.string(),
    proofLevel: z.string(),
    integrationClosure: z.string(),
    observabilityImpact: z.string(),
  })).describe("Planned slices for the milestone"),
  status: z.string().optional().describe("Milestone status"),
  dependsOn: z.array(z.string()).optional().describe("Milestone dependencies"),
  successCriteria: z.array(z.string()).optional().describe("Top-level success criteria bullets"),
  keyRisks: z.array(z.object({
    risk: z.string(),
    whyItMatters: z.string(),
  })).optional().describe("Structured risk entries"),
  proofStrategy: z.array(z.object({
    riskOrUnknown: z.string(),
    retireIn: z.string(),
    whatWillBeProven: z.string(),
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
  milestoneId: z.string().describe("Milestone ID (e.g. M001)"),
  sliceId: z.string().describe("Slice ID (e.g. S01)"),
  goal: z.string().describe("Slice goal"),
  tasks: z.array(z.object({
    taskId: z.string(),
    title: z.string(),
    description: z.string(),
    estimate: z.string(),
    files: z.array(z.string()),
    verify: z.string(),
    inputs: z.array(z.string()),
    expectedOutput: z.array(z.string()),
    observabilityImpact: z.string().optional(),
  })).describe("Planned tasks for the slice"),
  successCriteria: z.string().optional(),
  proofLevel: z.string().optional(),
  integrationClosure: z.string().optional(),
  observabilityImpact: z.string().optional(),
};
const planSliceSchema = z.object(planSliceParams);

const completeMilestoneParams = {
  projectDir: projectDirParam,
  milestoneId: z.string().describe("Milestone ID (e.g. M001)"),
  title: z.string().describe("Milestone title"),
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
  milestoneId: z.string().describe("Milestone ID (e.g. M001)"),
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
  sliceId: z.string(),
  title: z.string(),
  risk: z.string().optional(),
  depends: z.array(z.string()).optional(),
  demo: z.string().optional(),
});

const reassessRoadmapParams = {
  projectDir: projectDirParam,
  milestoneId: z.string().describe("Milestone ID (e.g. M001)"),
  completedSliceId: z.string().describe("Slice ID that just completed"),
  verdict: z.string().describe("Assessment verdict such as roadmap-confirmed or roadmap-adjusted"),
  assessment: z.string().describe("Assessment text explaining the roadmap decision"),
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
  gateId: z.enum(["Q3", "Q4", "Q5", "Q6", "Q7", "Q8"]).describe("Gate ID"),
  taskId: z.string().optional().describe("Task ID for task-scoped gates"),
  verdict: z.enum(["pass", "flag", "omitted"]).describe("Gate verdict"),
  rationale: z.string().describe("One-sentence justification"),
  findings: z.string().optional().describe("Detailed markdown findings"),
};
const saveGateResultSchema = z.object(saveGateResultParams);

const replanSliceParams = {
  projectDir: projectDirParam,
  milestoneId: z.string().describe("Milestone ID (e.g. M001)"),
  sliceId: z.string().describe("Slice ID (e.g. S01)"),
  blockerTaskId: z.string().describe("Task ID that discovered the blocker"),
  blockerDescription: z.string().describe("Description of the blocker"),
  whatChanged: z.string().describe("Summary of what changed in the plan"),
  updatedTasks: z.array(z.object({
    taskId: z.string(),
    title: z.string(),
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
  sliceId: z.string().describe("Slice ID (e.g. S01)"),
  milestoneId: z.string().describe("Milestone ID (e.g. M001)"),
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
  milestoneId: z.string().describe("Milestone ID (e.g. M001)"),
  sliceId: z.string().describe("Slice ID (e.g. S01)"),
  taskId: z.string().describe("Task ID (e.g. T01)"),
  title: z.string().describe("Task title"),
  description: z.string().describe("Task description / steps block"),
  estimate: z.string().describe("Task estimate"),
  files: z.array(z.string()).describe("Files likely touched"),
  verify: z.string().describe("Verification command or block"),
  inputs: z.array(z.string()).describe("Input files or references"),
  expectedOutput: z.array(z.string()).describe("Expected output files or artifacts"),
  observabilityImpact: z.string().optional().describe("Task observability impact"),
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
  taskId: z.string().describe("Task ID (e.g. T01)"),
  sliceId: z.string().describe("Slice ID (e.g. S01)"),
  milestoneId: z.string().describe("Milestone ID (e.g. M001)"),
  oneLiner: z.string().describe("One-line summary of what was accomplished"),
  narrative: z.string().describe("Detailed narrative of what happened during the task"),
  verification: z.string().describe("What was verified and how"),
  deviations: z.string().optional().describe("Deviations from the task plan"),
  knownIssues: z.string().optional().describe("Known issues discovered but not fixed"),
  keyFiles: z.array(z.string()).optional().describe("List of key files created or modified"),
  keyDecisions: z.array(z.string()).optional().describe("List of key decisions made during this task"),
  blockerDiscovered: z.boolean().optional().describe("Whether a plan-invalidating blocker was discovered"),
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
      const result = await runSerializedWorkflowOperation(async () => {
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
      const result = await runSerializedWorkflowOperation(async () => {
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
      await runSerializedWorkflowOperation(async () => {
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
      await runSerializedWorkflowOperation(async () => {
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
      const result = await runSerializedWorkflowOperation(async () => {
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
      const result = await runSerializedWorkflowOperation(async () => {
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
      const id = await runSerializedWorkflowOperation(async () => {
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
        const nextId = nextMilestoneId(allIds);
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
      const id = await runSerializedWorkflowOperation(async () => {
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
        const nextId = nextMilestoneId(allIds);
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
      return runSerializedWorkflowOperation(() => executePlanMilestone(params, projectDir));
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
      return runSerializedWorkflowOperation(() => executePlanSlice(params, projectDir));
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
      const result = await runSerializedWorkflowOperation(async () => {
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
      const result = await runSerializedWorkflowOperation(async () => {
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
      await runSerializedWorkflowOperation(async () => {
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
      return runSerializedWorkflowOperation(() =>
        executors.executeSummarySave({ milestone_id, slice_id, task_id, artifact_type, content }, projectDir),
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
      const { projectDir, milestoneId } = parseWorkflowArgs(milestoneStatusSchema, args);
      await enforceWorkflowWriteGate("gsd_milestone_status", projectDir, milestoneId);
      const { executeMilestoneStatus } = await getWorkflowToolExecutors();
      return runSerializedWorkflowOperation(() => executeMilestoneStatus({ milestoneId }, projectDir));
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
}
