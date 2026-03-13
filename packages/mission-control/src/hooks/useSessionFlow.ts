/**
 * Session flow state machine hook.
 *
 * Routes between initializing -> onboarding | resume | dashboard based on
 * WebSocket connection status, planning state, and continue-here data.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import type { PlanningState } from "../server/types";
import type { ConnectionStatus } from "./useReconnectingWebSocket";

export type SessionMode = "initializing" | "onboarding" | "resume" | "dashboard";

export interface ContinueHereData {
  phase: string;
  task: number;
  totalTasks: number;
  status: string;
  currentState: string;
  nextAction: string;
}

/**
 * Pure derivation of session mode from state inputs.
 * Exported for direct-call testing (no React renderer needed).
 */
export function deriveSessionMode(
  state: PlanningState | null,
  wsStatus: ConnectionStatus,
  continueHere: ContinueHereData | null,
  skipOnboarding: boolean = false
): SessionMode {
  // Not connected yet — show loading
  if (wsStatus !== "connected") {
    return "initializing";
  }

  // User explicitly dismissed onboarding (Start Chat or folder selected) — go to dashboard
  if (skipOnboarding) {
    return continueHere !== null ? "resume" : "dashboard";
  }

  // Connected but no project data — onboarding
  if (
    state === null ||
    (state.slices.length === 0 && (state.roadmap === null || state.roadmap.slices.length === 0))
  ) {
    return "onboarding";
  }

  // Has project data + continue-here — resume
  if (continueHere !== null) {
    return "resume";
  }

  // Has project data, no continue-here — dashboard
  return "dashboard";
}

export interface UseSessionFlowResult {
  mode: SessionMode;
  continueHere: ContinueHereData | null;
  dismiss: () => void;
}

/**
 * Session flow state machine hook.
 *
 * Determines which screen to show based on:
 * 1. WebSocket connection status
 * 2. Whether planning state has project data
 * 3. Whether a continue-here file exists (fetched from /api/session/status)
 *
 * Uses a ref guard to prevent re-fetching session status on every state update.
 */
export function useSessionFlow(
  state: PlanningState | null,
  wsStatus: ConnectionStatus
): UseSessionFlowResult {
  const [continueHere, setContinueHere] = useState<ContinueHereData | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [skipOnboarding, setSkipOnboarding] = useState(false);
  const fetchedRef = useRef(false);

  // Fetch continue-here data once when we have state
  useEffect(() => {
    if (wsStatus !== "connected" || state === null || fetchedRef.current) return;
    if (state.slices.length === 0 && (state.roadmap === null || state.roadmap.slices.length === 0)) return;

    fetchedRef.current = true;

    fetch("/api/session/status")
      .then((res) => res.json())
      .then((data: { continueHere: ContinueHereData | null }) => {
        if (data.continueHere) {
          setContinueHere(data.continueHere);
        }
      })
      .catch(() => {
        // Session status fetch failed — default to dashboard
      });
  }, [state, wsStatus]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    setSkipOnboarding(true);
    setContinueHere(null);
  }, []);

  const effectiveContinueHere = dismissed ? null : continueHere;
  const mode = deriveSessionMode(state, wsStatus, effectiveContinueHere, skipOnboarding);

  return { mode, continueHere: effectiveContinueHere, dismiss };
}
