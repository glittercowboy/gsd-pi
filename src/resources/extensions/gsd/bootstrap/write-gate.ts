const MILESTONE_CONTEXT_RE = /M\d+(?:-[a-z0-9]{6})?-CONTEXT\.md$/;

/**
 * Required depth-verification dimensions. All three must be confirmed
 * before CONTEXT.md writes are unblocked (unless the legacy boolean
 * fast-path is used via `markDepthVerified()`).
 */
export const REQUIRED_DIMENSIONS = ['what', 'risks', 'dependencies'] as const;

let depthVerificationDone = false;
let activeQueuePhase = false;
const dimensionMap = new Map<string, boolean>();

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
  dimensionMap.clear();
}

export function clearDiscussionFlowState(): void {
  depthVerificationDone = false;
  activeQueuePhase = false;
  dimensionMap.clear();
}

/**
 * Legacy fast-path: marks the boolean AND all dimensions as verified.
 * Called when a bare `depth_verification` question ID is detected (no
 * dimension suffix). Keeps both state representations consistent.
 */
export function markDepthVerified(): void {
  depthVerificationDone = true;
  for (const dim of REQUIRED_DIMENSIONS) {
    dimensionMap.set(dim, true);
  }
}

/**
 * Mark a single dimension as verified. When all required dimensions
 * are verified, the boolean fast-path is also set for backward compat.
 */
export function markDimensionVerified(dimension: string): void {
  dimensionMap.set(dimension, true);
  if (areAllDimensionsVerified()) {
    depthVerificationDone = true;
  }
}

/**
 * Check whether a specific dimension has been verified.
 */
export function isDimensionVerified(dimension: string): boolean {
  return dimensionMap.get(dimension) === true;
}

/**
 * Check whether all required dimensions are verified.
 */
export function areAllDimensionsVerified(): boolean {
  return REQUIRED_DIMENSIONS.every(dim => dimensionMap.get(dim) === true);
}

/**
 * Returns the list of dimensions that have NOT yet been verified.
 */
function getUnverifiedDimensions(): string[] {
  return REQUIRED_DIMENSIONS.filter(dim => dimensionMap.get(dim) !== true);
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

  const unverified = getUnverifiedDimensions();
  const dimensionDetail = unverified.length > 0 && unverified.length < REQUIRED_DIMENSIONS.length
    ? ` Unverified dimensions: ${unverified.join(', ')}.`
    : '';

  return {
    block: true,
    reason: `Blocked: Cannot write to milestone CONTEXT.md during discussion phase without depth verification. Call ask_user_questions with question id "depth_verification" first to confirm discussion depth before writing context.${dimensionDetail}`,
  };
}
