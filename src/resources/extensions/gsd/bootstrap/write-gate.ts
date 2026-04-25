import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regex matching milestone CONTEXT.md file names in both legacy M001
 * and unique M001-abc123 formats. Exported so regex-hardening tests
 * can exercise the real pattern rather than a drift-prone inline
 * re-implementation (see #4835).
 */
export const MILESTONE_CONTEXT_RE = /M\d+(?:-[a-z0-9]{6})?-CONTEXT\.md$/;
const CONTEXT_MILESTONE_RE = /(?:^|[/\\])(M\d+(?:-[a-z0-9]{6})?)-CONTEXT\.md$/i;
const DEPTH_VERIFICATION_MILESTONE_RE = /depth_verification[_-](M\d+(?:-[a-z0-9]{6})?)/i;

/**
 * Path segment that identifies .gsd/ planning artifacts.
 * Writes to these paths are allowed during queue mode.
 */
const GSD_DIR_RE = /(^|[/\\])\.gsd([/\\]|$)/;

/**
 * Read-only tool names that are always safe during queue mode.
 */
const QUEUE_SAFE_TOOLS = new Set([
  "read", "grep", "find", "ls", "glob",
  // Discussion & planning tools
  "ask_user_questions",
  "gsd_milestone_generate_id",
  "gsd_summary_save",
  // Web research tools used during queue discussion
  "search-the-web", "resolve_library", "get_library_docs", "fetch_page",
  "search_and_read",
]);

/**
 * Bash commands that are read-only / investigative — safe during queue mode.
 * Matches the leading command in a bash invocation.
 *
 * Extension policy: add commands here when they are read-only / diagnostic.
 * Never add commands that mutate project state (write files, run builds that
 * emit artifacts, install packages, etc.).
 *
 * Current read-only additions (Bug #4385):
 *   npm run <diagnostic> — read-only diagnostic scripts: test, lint, typecheck, etc.
 *                         NOT: build, install, compile, generate, deploy (artifact-producing)
 *   npm ls/list/info    — inspect installed packages (read-only)
 *   npm outdated/audit  — security/update checks (read-only)
 *   npx <pkg>           — run a package binary without installing globally
 *   tsx                 — TypeScript runner used for dry-run / inspection scripts
 *   node --print        — evaluate and print an expression, no side effects
 *   python / python3    — script inspection, version checks
 *   pip / pip3 show     — show installed package info (read-only)
 *   jq                  — read-only JSON query
 *   yq                  — read-only YAML query
 *   curl -s / curl --silent — fetch for inspection (no -o / no output redirect)
 *   openssl version     — version / certificate inspection
 *   env / printenv      — print environment variables
 *   true / false        — shell no-ops / test exit codes
 */
const BASH_READ_ONLY_RE = /^\s*(cat|head|tail|less|more|wc|file|stat|du|df|which|type|echo|printf|ls|find|grep|rg|awk|sed\b(?!.*-i)|sort|uniq|diff|comm|tr|cut|tee\s+-a\s+\/dev\/null|git\s+(log|show|diff|status|branch|tag|remote|rev-parse|ls-files|blame|shortlog|describe|stash\s+list|config\s+--get|cat-file)|gh\s+(issue|pr|api|repo|release)\s+(view|list|diff|status|checks)|mkdir\s+-p\s+\.gsd|rtk\s|npm\s+run\s+(test|test:\w+|lint|lint:\w+|typecheck|type-check|type-check:\w+|check|verify|audit|outdated|format:check|ci|validate)\b|npm\s+(ls|list|info|view|show|outdated|audit|explain|doctor|ping|--version|-v)\b|npx\s|tsx\s|node\s+(--print|--version|-v\b)|python[23]?\s+(-c\s+'[^']*'|--version|-V\b|-m\s+(pip\s+show|pip\s+list|site))|pip[23]?\s+(show|list|freeze|check|index\s+versions)\b|jq\s|yq\s|curl\s+(-s\b|--silent\b)(?!\s+[^|>]*\s-[oO]\b)(?!\s+[^|>]*\s--output\b)[^|>]*$|openssl\s+(version|x509|s_client)|env\b|printenv\b|true\b|false\b)/;

const verifiedDepthMilestones = new Set<string>();
let activeQueuePhase = false;

/**
 * Discussion gate enforcement state.
 *
 * When ask_user_questions is called with a recognized gate question ID,
 * we track the pending gate. Until the gate is confirmed (user selects the
 * first/recommended option), all non-read-only tool calls are blocked.
 * This mechanically prevents the model from rationalizing past failed or
 * cancelled gate questions.
 */
let pendingGateId: string | null = null;

/**
 * Recognized gate question ID patterns.
 * These appear in discuss.md (depth/requirements/roadmap).
 */
const GATE_QUESTION_PATTERNS = [
  "depth_verification",
] as const;

/**
 * Tools that are safe to call while a gate is pending.
 * Includes read-only tools and ask_user_questions itself (so the model can re-ask).
 */
const GATE_SAFE_TOOLS = new Set([
  "ask_user_questions",
  "read", "grep", "find", "ls", "glob",
  "search-the-web", "resolve_library", "get_library_docs", "fetch_page",
  "search_and_read",
]);

export interface WriteGateSnapshot {
  verifiedDepthMilestones: string[];
  activeQueuePhase: boolean;
  pendingGateId: string | null;
}

function shouldPersistWriteGateSnapshot(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GSD_PERSIST_WRITE_GATE_STATE === "1";
}

function writeGateSnapshotPath(basePath: string = process.cwd()): string {
  return join(basePath, ".gsd", "runtime", "write-gate-state.json");
}

function currentWriteGateSnapshot(): WriteGateSnapshot {
  return {
    verifiedDepthMilestones: [...verifiedDepthMilestones].sort(),
    activeQueuePhase,
    pendingGateId,
  };
}

function persistWriteGateSnapshot(basePath: string = process.cwd()): void {
  if (!shouldPersistWriteGateSnapshot()) return;
  const path = writeGateSnapshotPath(basePath);
  mkdirSync(join(basePath, ".gsd", "runtime"), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, JSON.stringify(currentWriteGateSnapshot(), null, 2), "utf-8");
  renameSync(tempPath, path);
}

function clearPersistedWriteGateSnapshot(basePath: string = process.cwd()): void {
  if (!shouldPersistWriteGateSnapshot()) return;
  const path = writeGateSnapshotPath(basePath);
  try {
    unlinkSync(path);
  } catch {
    // swallow
  }
}

function normalizeWriteGateSnapshot(value: unknown): WriteGateSnapshot {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const verified = Array.isArray(record.verifiedDepthMilestones)
    ? record.verifiedDepthMilestones.filter((item): item is string => typeof item === "string")
    : [];
  return {
    verifiedDepthMilestones: [...new Set(verified)].sort(),
    activeQueuePhase: record.activeQueuePhase === true,
    pendingGateId: typeof record.pendingGateId === "string" ? record.pendingGateId : null,
  };
}

const EMPTY_SNAPSHOT: WriteGateSnapshot = {
  verifiedDepthMilestones: [],
  activeQueuePhase: false,
  pendingGateId: null,
};

export function loadWriteGateSnapshot(basePath: string = process.cwd()): WriteGateSnapshot {
  const path = writeGateSnapshotPath(basePath);
  if (!existsSync(path)) {
    // When persist mode is active and the file has been deleted, treat it as a
    // full state reset so deleting the file clears the HARD BLOCK gate.
    // In non-persist mode the file is never written, so fall back to in-memory.
    if (shouldPersistWriteGateSnapshot()) return EMPTY_SNAPSHOT;
    return currentWriteGateSnapshot();
  }
  try {
    return normalizeWriteGateSnapshot(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return currentWriteGateSnapshot();
  }
}

export function isDepthVerified(): boolean {
  return verifiedDepthMilestones.size > 0;
}

/**
 * Check whether a specific milestone has passed depth verification.
 */
export function isMilestoneDepthVerified(milestoneId: string | null | undefined): boolean {
  if (!milestoneId) return false;
  return verifiedDepthMilestones.has(milestoneId);
}

export function isMilestoneDepthVerifiedInSnapshot(
  snapshot: WriteGateSnapshot,
  milestoneId: string | null | undefined,
): boolean {
  if (!milestoneId) return false;
  return snapshot.verifiedDepthMilestones.includes(milestoneId);
}

export function isQueuePhaseActive(): boolean {
  return activeQueuePhase;
}

export function setQueuePhaseActive(active: boolean): void {
  activeQueuePhase = active;
  persistWriteGateSnapshot();
}

export function resetWriteGateState(): void {
  verifiedDepthMilestones.clear();
  pendingGateId = null;
  persistWriteGateSnapshot();
}

export function clearDiscussionFlowState(): void {
  verifiedDepthMilestones.clear();
  activeQueuePhase = false;
  pendingGateId = null;
  clearPersistedWriteGateSnapshot();
}

export function markDepthVerified(milestoneId?: string | null, basePath: string = process.cwd()): void {
  if (!milestoneId) return;
  verifiedDepthMilestones.add(milestoneId);
  persistWriteGateSnapshot(basePath);
}

/**
 * Check whether a question ID matches a recognized gate pattern.
 */
export function isGateQuestionId(questionId: string): boolean {
  return GATE_QUESTION_PATTERNS.some(pattern => questionId.includes(pattern));
}

/**
 * Extract the milestone ID embedded in a depth-verification question id.
 * Prompts are expected to use ids like `depth_verification_M001_confirm`.
 */
export function extractDepthVerificationMilestoneId(questionId: string): string | null {
  const match = questionId.match(DEPTH_VERIFICATION_MILESTONE_RE);
  return match?.[1] ?? null;
}

/**
 * Extract the milestone ID from a milestone CONTEXT file path.
 */
function extractContextMilestoneId(inputPath: string): string | null {
  const match = inputPath.match(CONTEXT_MILESTONE_RE);
  return match?.[1] ?? null;
}

/**
 * Mark a gate as pending (called when ask_user_questions is invoked with a gate ID).
 */
export function setPendingGate(gateId: string): void {
  pendingGateId = gateId;
  persistWriteGateSnapshot();
}

/**
 * Clear the pending gate (called when the user confirms).
 */
export function clearPendingGate(): void {
  pendingGateId = null;
  persistWriteGateSnapshot();
}

/**
 * Get the currently pending gate, if any.
 */
export function getPendingGate(): string | null {
  return pendingGateId;
}

/**
 * Check whether a tool call should be blocked because a discussion gate
 * is pending (ask_user_questions was called but not confirmed).
 *
 * Returns { block: true, reason } if the tool should be blocked.
 * Read-only tools and ask_user_questions itself are always allowed.
 */
export function shouldBlockPendingGate(
  toolName: string,
  milestoneId: string | null,
  queuePhaseActive?: boolean,
): { block: boolean; reason?: string } {
  return shouldBlockPendingGateInSnapshot(currentWriteGateSnapshot(), toolName, milestoneId, queuePhaseActive);
}

export function shouldBlockPendingGateInSnapshot(
  snapshot: WriteGateSnapshot,
  toolName: string,
  _milestoneId: string | null,
  _queuePhaseActive?: boolean,
): { block: boolean; reason?: string } {
  if (!snapshot.pendingGateId) return { block: false };

  if (GATE_SAFE_TOOLS.has(toolName)) return { block: false };

  // Bash read-only commands are also safe
  if (toolName === "bash") return { block: false }; // bash is checked separately below

  return {
    block: true,
    reason: [
      `HARD BLOCK: Discussion gate "${snapshot.pendingGateId}" has not been confirmed by the user.`,
      `You MUST re-call ask_user_questions with the gate question before making any other tool calls.`,
      `If the previous ask_user_questions call failed, errored, was cancelled, or the user's response`,
      `did not match a provided option, you MUST re-ask — never rationalize past the block.`,
      `Do NOT proceed, do NOT use alternative approaches, do NOT skip the gate.`,
    ].join(" "),
  };
}

/**
 * Check whether a bash command should be blocked because a discussion gate is pending.
 * Read-only bash commands are allowed; mutating commands are blocked.
 */
export function shouldBlockPendingGateBash(
  command: string,
  milestoneId: string | null,
  queuePhaseActive?: boolean,
): { block: boolean; reason?: string } {
  return shouldBlockPendingGateBashInSnapshot(currentWriteGateSnapshot(), command, milestoneId, queuePhaseActive);
}

export function shouldBlockPendingGateBashInSnapshot(
  snapshot: WriteGateSnapshot,
  command: string,
  _milestoneId: string | null,
  _queuePhaseActive?: boolean,
): { block: boolean; reason?: string } {
  if (!snapshot.pendingGateId) return { block: false };

  // Allow read-only bash commands
  if (BASH_READ_ONLY_RE.test(command)) return { block: false };

  return {
    block: true,
    reason: [
      `HARD BLOCK: Discussion gate "${snapshot.pendingGateId}" has not been confirmed by the user.`,
      `You MUST re-call ask_user_questions with the gate question before running mutating commands.`,
      `If the previous ask_user_questions call failed, errored, was cancelled, or the user's response`,
      `did not match a provided option, you MUST re-ask — never rationalize past the block.`,
    ].join(" "),
  };
}

/**
 * Check whether a depth_verification answer confirms the discussion is complete.
 * Uses structural validation: the selected answer must exactly match the first
 * option label from the question definition (the confirmation option by convention).
 * This rejects free-form "Other" text, decline options, and garbage input without
 * coupling to any specific label substring.
 *
 * @param selected  The answer's selected value from details.response.answers[id].selected
 * @param options   The question's options array from event.input.questions[n].options
 */
export function isDepthConfirmationAnswer(
  selected: unknown,
  options?: Array<{ label?: string }>,
): boolean {
  const value = Array.isArray(selected) ? selected[0] : selected;
  if (typeof value !== "string" || !value) return false;

  // If options are available, structurally validate: selected must exactly match
  // the first option (confirmation) label. Rejects free-form "Other" and decline options.
  if (Array.isArray(options) && options.length > 0) {
    const confirmLabel = options[0]?.label;
    return typeof confirmLabel === "string" && value === confirmLabel;
  }

  // Fallback when options aren't available (e.g., older call sites):
  // accept only if it contains "(Recommended)" — the prompt convention suffix.
  return value.includes("(Recommended)");
}

export function shouldBlockContextWrite(
  toolName: string,
  inputPath: string,
  milestoneId: string | null,
  _queuePhaseActive?: boolean,
): { block: boolean; reason?: string } {
  if (toolName !== "write") return { block: false };
  if (!MILESTONE_CONTEXT_RE.test(inputPath)) return { block: false };

  const targetMilestoneId = extractContextMilestoneId(inputPath) ?? milestoneId;
  if (!targetMilestoneId) {
    return {
      block: true,
      reason: [
        `HARD BLOCK: Cannot write milestone CONTEXT.md without knowing which milestone it belongs to.`,
        `This is a mechanical gate — you MUST NOT proceed, retry, or rationalize past this block.`,
        `Required action: call ask_user_questions with question id containing "depth_verification" and the milestone id.`,
      ].join(" "),
    };
  }

  if (isMilestoneDepthVerified(targetMilestoneId)) return { block: false };

  return {
    block: true,
    reason: [
      `HARD BLOCK: Cannot write to milestone CONTEXT.md without depth verification.`,
      `This is a mechanical gate — you MUST NOT proceed, retry, or rationalize past this block.`,
      `Required action: call ask_user_questions with question id containing "depth_verification".`,
      `The user MUST select the "(Recommended)" confirmation option to unlock this gate.`,
      `If the user declines, cancels, or the tool fails, you must re-ask — not bypass.`,
    ].join(" "),
  };
}

/**
 * Check whether a gsd_summary_save CONTEXT artifact should be blocked.
 * Slice-level CONTEXT artifacts are allowed; milestone-level CONTEXT writes
 * require the milestone to be depth-verified first.
 */
export function shouldBlockContextArtifactSave(
  artifactType: string,
  milestoneId: string | null,
  sliceId?: string | null,
): { block: boolean; reason?: string } {
  return shouldBlockContextArtifactSaveInSnapshot(currentWriteGateSnapshot(), artifactType, milestoneId, sliceId);
}

export function shouldBlockContextArtifactSaveInSnapshot(
  snapshot: WriteGateSnapshot,
  artifactType: string,
  milestoneId: string | null,
  sliceId?: string | null,
): { block: boolean; reason?: string } {
  if (artifactType !== "CONTEXT") return { block: false };
  if (sliceId) return { block: false };
  if (!milestoneId) {
    return {
      block: true,
      reason: [
        `HARD BLOCK: Cannot save milestone CONTEXT without a milestone_id.`,
        `This is a mechanical gate — you MUST NOT proceed, retry, or rationalize past this block.`,
      ].join(" "),
    };
  }
  if (isMilestoneDepthVerifiedInSnapshot(snapshot, milestoneId)) return { block: false };

  return {
    block: true,
    reason: [
      `HARD BLOCK: Cannot save milestone CONTEXT without depth verification for ${milestoneId}.`,
      `This is a mechanical gate — you MUST NOT proceed, retry, or rationalize past this block.`,
      `Required action: call ask_user_questions with question id containing "depth_verification_${milestoneId}".`,
      `The user MUST select the "(Recommended)" confirmation option to unlock this gate.`,
    ].join(" "),
  };
}

/**
 * Queue-mode execution guard (#2545).
 *
 * When the queue phase is active, the agent should only create planning
 * artifacts (milestones, CONTEXT.md, QUEUE.md, etc.) — never execute work.
 * This function blocks write/edit/bash tool calls that would modify source
 * code outside of .gsd/.
 *
 * @param toolName  The tool being called (write, edit, bash, etc.)
 * @param input     For write/edit: the file path. For bash: the command string.
 * @param queuePhaseActive  Whether the queue phase is currently active.
 * @returns { block, reason } — block=true if the call should be rejected.
 */
export function shouldBlockQueueExecution(
  toolName: string,
  input: string,
  queuePhaseActive: boolean,
): { block: boolean; reason?: string } {
  return shouldBlockQueueExecutionInSnapshot(currentWriteGateSnapshot(), toolName, input, queuePhaseActive);
}

export function shouldBlockQueueExecutionInSnapshot(
  snapshot: WriteGateSnapshot,
  toolName: string,
  input: string,
  queuePhaseActive: boolean = snapshot.activeQueuePhase,
): { block: boolean; reason?: string } {
  if (!queuePhaseActive) return { block: false };

  // Always-safe tools (read-only, discussion, planning)
  if (QUEUE_SAFE_TOOLS.has(toolName)) return { block: false };

  // write/edit — allow if targeting .gsd/ planning artifacts
  if (toolName === "write" || toolName === "edit") {
    if (GSD_DIR_RE.test(input)) return { block: false };
    return {
      block: true,
      reason: `Blocked: /gsd queue is a planning tool — it creates milestones, not executes work. ` +
        `Cannot ${toolName} to "${input}" during queue mode. ` +
        `Write CONTEXT.md files and update PROJECT.md/QUEUE.md instead.`,
    };
  }

  // bash — allow read-only/investigative commands, block everything else
  if (toolName === "bash") {
    if (BASH_READ_ONLY_RE.test(input)) return { block: false };
    return {
      block: true,
      reason: `Blocked: /gsd queue is a planning tool — it creates milestones, not executes work. ` +
        `Cannot run "${input.slice(0, 80)}${input.length > 80 ? "…" : ""}" during queue mode. ` +
        `Use read-only commands (cat, grep, git log, etc.) to investigate, then write planning artifacts.`,
    };
  }

  // Unknown tools — block by default in queue mode so custom tools cannot
  // bypass execution restrictions.
  return {
    block: true,
    reason: `Blocked: /gsd queue is a planning tool — it creates milestones, not executes work. Unknown tools are not permitted during queue mode.`,
  };
}
