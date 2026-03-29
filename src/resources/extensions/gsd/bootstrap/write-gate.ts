const MILESTONE_CONTEXT_RE = /M\d+(?:-[a-z0-9]{6})?-CONTEXT\.md$/;

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
 */
const BASH_READ_ONLY_RE = /^\s*(cat|head|tail|less|more|wc|file|stat|du|df|which|type|echo|printf|ls|find|grep|rg|awk|sed\b(?!.*-i)|sort|uniq|diff|comm|tr|cut|tee\s+-a\s+\/dev\/null|git\s+(log|show|diff|status|branch|tag|remote|rev-parse|ls-files|blame|shortlog|describe|stash\s+list|config\s+--get|cat-file)|gh\s+(issue|pr|api|repo|release)\s+(view|list|diff|status|checks)|mkdir\s+-p\s+\.gsd|rtk\s)/;

let depthVerificationDone = false;
let activeQueuePhase = false;

export function isDepthVerified(): boolean {
  return depthVerificationDone;
}

export function isQueuePhaseActive(): boolean {
  return activeQueuePhase;
}

export function setQueuePhaseActive(active: boolean): void {
  activeQueuePhase = active;
}

export function resetWriteGateState(): void {
  depthVerificationDone = false;
}

export function clearDiscussionFlowState(): void {
  depthVerificationDone = false;
  activeQueuePhase = false;
}

export function markDepthVerified(): void {
  depthVerificationDone = true;
}

export function shouldBlockContextWrite(
  toolName: string,
  inputPath: string,
  milestoneId: string | null,
  depthVerified: boolean,
  queuePhaseActive?: boolean,
): { block: boolean; reason?: string } {
  if (toolName !== "write") return { block: false };

  const inDiscussion = milestoneId !== null;
  const inQueue = queuePhaseActive ?? false;
  if (!inDiscussion && !inQueue) return { block: false };
  if (!MILESTONE_CONTEXT_RE.test(inputPath)) return { block: false };
  if (depthVerified) return { block: false };

  return {
    block: true,
    reason: `Blocked: Cannot write to milestone CONTEXT.md during discussion phase without depth verification. Call ask_user_questions with question id "depth_verification" first to confirm discussion depth before writing context.`,
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

  // Unknown tools — allow by default (custom extension tools, etc.)
  return { block: false };
}

