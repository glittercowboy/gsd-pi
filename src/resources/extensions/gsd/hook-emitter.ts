// GSD Extension — Layer 2 Event Emitter Bridge
//
// Holds a module-scoped reference to the ExtensionAPI so deeply-nested code
// (auto-loop, git-service callers, verification, budget) can emit Layer 2
// events without having to thread `pi` through every function signature.
//
// Set once from `registerGsdExtension`. All emitters are best-effort — a
// missing `pi` (e.g. in standalone unit tests) silently becomes a no-op.

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import type {
  BeforeCommitEventResult,
  BeforePrEventResult,
  BeforePushEventResult,
  BeforeVerifyEventResult,
  BudgetThresholdEventResult,
  VerifyFailure,
} from "@gsd/pi-coding-agent";

let _pi: ExtensionAPI | undefined;

export function setHookEmitter(pi: ExtensionAPI): void {
  _pi = pi;
}

export function clearHookEmitter(): void {
  _pi = undefined;
}

// ─── Notification ──────────────────────────────────────────────────────────

export async function emitNotification(
  kind: "blocked" | "input_needed" | "milestone_ready" | "idle" | "error",
  message: string,
  details?: Record<string, unknown>,
): Promise<void> {
  if (!_pi) return;
  await _pi.emitExtensionEvent({ type: "notification", kind, message, details });
}

// ─── Git Lifecycle ─────────────────────────────────────────────────────────

export async function emitBeforeCommit(args: {
  message: string;
  files: string[];
  cwd: string;
  author?: string;
}): Promise<BeforeCommitEventResult | undefined> {
  if (!_pi) return undefined;
  return (await _pi.emitExtensionEvent({
    type: "before_commit",
    ...args,
  })) as BeforeCommitEventResult | undefined;
}

export async function emitCommit(args: {
  sha: string;
  message: string;
  files: string[];
  cwd: string;
}): Promise<void> {
  if (!_pi) return;
  await _pi.emitExtensionEvent({ type: "commit", ...args });
}

export async function emitBeforePush(args: {
  remote: string;
  branch: string;
  cwd: string;
}): Promise<BeforePushEventResult | undefined> {
  if (!_pi) return undefined;
  return (await _pi.emitExtensionEvent({
    type: "before_push",
    ...args,
  })) as BeforePushEventResult | undefined;
}

export async function emitPush(args: { remote: string; branch: string; cwd: string }): Promise<void> {
  if (!_pi) return;
  await _pi.emitExtensionEvent({ type: "push", ...args });
}

export async function emitBeforePr(args: {
  branch: string;
  targetBranch: string;
  title: string;
  body: string;
  cwd: string;
}): Promise<BeforePrEventResult | undefined> {
  if (!_pi) return undefined;
  return (await _pi.emitExtensionEvent({
    type: "before_pr",
    ...args,
  })) as BeforePrEventResult | undefined;
}

export async function emitPrOpened(args: {
  url: string;
  branch: string;
  targetBranch: string;
  cwd: string;
}): Promise<void> {
  if (!_pi) return;
  await _pi.emitExtensionEvent({ type: "pr_opened", ...args });
}

// ─── Verification ──────────────────────────────────────────────────────────

export async function emitBeforeVerify(args: {
  unitType?: string;
  unitId?: string;
  cwd: string;
}): Promise<BeforeVerifyEventResult | undefined> {
  if (!_pi) return undefined;
  return (await _pi.emitExtensionEvent({
    type: "before_verify",
    ...args,
  })) as BeforeVerifyEventResult | undefined;
}

export async function emitVerifyResult(args: {
  passed: boolean;
  failures: VerifyFailure[];
  unitType?: string;
  unitId?: string;
  cwd: string;
}): Promise<void> {
  if (!_pi) return;
  await _pi.emitExtensionEvent({ type: "verify_result", ...args });
}

// ─── Budget ────────────────────────────────────────────────────────────────

export async function emitBudgetThreshold(args: {
  fraction: number;
  spent: number;
  limit: number;
}): Promise<BudgetThresholdEventResult | undefined> {
  if (!_pi) return undefined;
  return (await _pi.emitExtensionEvent({
    type: "budget_threshold",
    fraction: args.fraction,
    spent: args.spent,
    limit: args.limit,
    currency: "USD",
  })) as BudgetThresholdEventResult | undefined;
}

// ─── Orchestrator Boundaries ───────────────────────────────────────────────

export async function emitMilestoneStart(args: {
  milestoneId: string;
  title?: string;
  cwd: string;
}): Promise<void> {
  if (!_pi) return;
  await _pi.emitExtensionEvent({ type: "milestone_start", ...args });
}

export async function emitMilestoneEnd(args: {
  milestoneId: string;
  status: "completed" | "failed" | "cancelled";
  cwd: string;
}): Promise<void> {
  if (!_pi) return;
  await _pi.emitExtensionEvent({ type: "milestone_end", ...args });
}

export async function emitUnitStart(args: {
  unitType: string;
  unitId: string;
  milestoneId?: string;
  cwd: string;
}): Promise<void> {
  if (!_pi) return;
  await _pi.emitExtensionEvent({ type: "unit_start", ...args });
}

export async function emitUnitEnd(args: {
  unitType: string;
  unitId: string;
  milestoneId?: string;
  status: "completed" | "failed" | "cancelled" | "blocked";
  cwd: string;
}): Promise<void> {
  if (!_pi) return;
  await _pi.emitExtensionEvent({ type: "unit_end", ...args });
}
