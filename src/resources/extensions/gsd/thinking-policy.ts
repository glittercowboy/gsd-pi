/**
 * Thinking-policy resolver.
 *
 * Computes the thinking level to use for a single auto-mode unit dispatch
 * based on the user's `thinking_policy` block in PREFERENCES.md and a
 * fallback supplied by the caller (typically the live `pi.getThinkingLevel()`
 * value captured at auto-mode start).
 *
 * Resolution order (first match wins):
 *   1. `unitTypes[unitType]` — exact match.
 *   2. `prefixes[<longest matching prefix>]` — e.g. `research-slice` matches `research-`.
 *   3. `default`.
 *   4. `fallback` argument (caller's existing/default level).
 *
 * NOTE: A user-driven `/thinking` override is captured separately at
 * auto-mode start and must beat the policy. That precedence is enforced at
 * the call site in `auto-model-selection.ts`, not here — this resolver only
 * computes the policy's recommended level.
 */

import type { ThinkingLevel, ThinkingPolicyConfig } from "./preferences-types.js";

export type { ThinkingLevel, ThinkingPolicyConfig };

export function resolveThinkingLevel(
  unitType: string,
  policy: ThinkingPolicyConfig | undefined,
  fallback: ThinkingLevel,
): ThinkingLevel {
  if (!policy) return fallback;

  const exact = policy.unitTypes?.[unitType];
  if (exact) return exact;

  if (policy.prefixes) {
    let bestKey: string | undefined;
    let bestLen = -1;
    for (const key of Object.keys(policy.prefixes)) {
      if (unitType.startsWith(key) && key.length > bestLen) {
        bestKey = key;
        bestLen = key.length;
      }
    }
    if (bestKey !== undefined) return policy.prefixes[bestKey];
  }

  return policy.default ?? fallback;
}

/**
 * Compute the thinking level for a dispatch, given the snapshot captured at
 * auto-mode start. Returns the snapshot unchanged when no policy is configured
 * (so callers don't need to special-case the no-policy path).
 *
 * Pass `null`/`undefined` for `startLevel` if no snapshot exists; the caller
 * decides what to do with a missing level (typically: skip `setThinkingLevel`).
 */
export function getEffectiveThinkingLevel(
  unitType: string,
  policy: ThinkingPolicyConfig | undefined,
  startLevel: ThinkingLevel | null | undefined,
): ThinkingLevel | null | undefined {
  if (!policy) return startLevel;
  const fallback = (startLevel ?? "medium") as ThinkingLevel;
  return resolveThinkingLevel(unitType, policy, fallback);
}
