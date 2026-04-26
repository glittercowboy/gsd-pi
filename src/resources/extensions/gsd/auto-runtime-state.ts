// GSD auto-mode runtime state
import { AutoSession } from "./auto/session.js";
import type { CurrentUnit } from "./auto/session.js";
import {
  isDeterministicPolicyError,
  isQueuedUserMessageSkip,
  isToolInvocationError,
  markToolEnd as markTrackedToolEnd,
  markToolStart as markTrackedToolStart,
} from "./auto-tool-tracking.js";

export const autoSession = new AutoSession();

export type AutoRuntimeSnapshot = {
  active: boolean;
  paused: boolean;
  currentUnit: CurrentUnit | null;
  basePath: string;
};

export function getAutoRuntimeSnapshot(): AutoRuntimeSnapshot {
  return {
    active: autoSession.active,
    paused: autoSession.paused,
    currentUnit: autoSession.currentUnit ? { ...autoSession.currentUnit } : null,
    basePath: autoSession.basePath,
  };
}

export function isAutoActive(): boolean {
  return autoSession.active;
}

export function isAutoPaused(): boolean {
  return autoSession.paused;
}

export function markToolStart(toolCallId: string, toolName?: string): void {
  markTrackedToolStart(toolCallId, autoSession.active, toolName);
}

export function markToolEnd(toolCallId: string): void {
  markTrackedToolEnd(toolCallId);
}

export function recordToolInvocationError(toolName: string, errorMsg: string): void {
  if (!autoSession.active) return;
  if (isToolInvocationError(errorMsg) || isQueuedUserMessageSkip(errorMsg) || isDeterministicPolicyError(errorMsg)) {
    autoSession.lastToolInvocationError = `${toolName}: ${errorMsg}`;
  }
}
