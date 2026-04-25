import type { GSDPreferences } from "../preferences.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";

export interface UokFlags {
  enabled: boolean;
  legacyFallback: boolean;
  gates: boolean;
  modelPolicy: boolean;
  executionGraph: boolean;
  gitops: boolean;
  gitopsTurnAction: "commit" | "snapshot" | "status-only";
  gitopsTurnPush: boolean;
  auditUnified: boolean;
  planV2: boolean;
}

function envForcesLegacyFallback(): boolean {
  const raw = process.env.GSD_UOK_FORCE_LEGACY ?? process.env.GSD_UOK_LEGACY_FALLBACK;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function resolveUokFlags(prefs: GSDPreferences | undefined): UokFlags {
  const uok = prefs?.uok;
  const legacyFallback = uok?.legacy_fallback?.enabled === true || envForcesLegacyFallback();
  const enabledByPreference = uok?.enabled ?? true;
  return {
    enabled: enabledByPreference && !legacyFallback,
    legacyFallback,
    gates: uok?.gates?.enabled ?? true,
    modelPolicy: uok?.model_policy?.enabled ?? true,
    executionGraph: uok?.execution_graph?.enabled ?? true,
    gitops: uok?.gitops?.enabled ?? true,
    gitopsTurnAction: uok?.gitops?.turn_action ?? "commit",
    gitopsTurnPush: uok?.gitops?.turn_push === true,
    auditUnified: uok?.audit_unified?.enabled ?? true,
    planV2: uok?.plan_v2?.enabled ?? true,
  };
}

export function loadUokFlags(): UokFlags {
  const prefs = loadEffectiveGSDPreferences()?.preferences;
  return resolveUokFlags(prefs);
}
