// GSD Extension — Hook Engine (Post-Unit, Pre-Dispatch, State Persistence)
// Manages hook queue, cycle tracking, artifact verification, pre-dispatch
// interception, and durable hook state for user-configured extensibility.

import type {
  PostUnitHookConfig,
  PreDispatchHookConfig,
  HookExecutionState,
  HookDispatchResult,
  PreDispatchResult,
  PersistedHookState,
  HookStatusEntry,
} from "./types.js";
import { resolvePostUnitHooks, resolvePreDispatchHooks } from "./preferences.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ─── Hook Queue State ──────────────────────────────────────────────────────

/** Currently executing hook, or null if in normal dispatch flow. */
let activeHook: HookExecutionState | null = null;

/** Queue of hooks remaining for the current trigger unit. */
let hookQueue: Array<{
  config: PostUnitHookConfig;
  triggerUnitType: string;
  triggerUnitId: string;
}> = [];

/** Cycle counts per hook+trigger, keyed as "hookName/triggerUnitType/triggerUnitId". */
const cycleCounts = new Map<string, number>();

/** Set when a hook completes with retry_on artifact present — signals caller to re-run trigger. */
let retryPending = false;

/** Stores the trigger unit info for pending retries so caller knows what to re-run. */
let retryTrigger: { unitType: string; unitId: string } | null = null;

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Called after a unit completes. Returns the next hook unit to dispatch,
 * or null if no hooks apply (normal dispatch should proceed).
 *
 * Call flow:
 * 1. A core unit (e.g. execute-task) completes → handleAgentEnd calls this
 * 2. If hooks match, returns first hook to dispatch. Caller sends the prompt.
 * 3. Hook unit completes → handleAgentEnd calls this again (activeHook is set)
 * 4. Checks retry_on / next hook / done → returns next action or null
 */
export function checkPostUnitHooks(
  completedUnitType: string,
  completedUnitId: string,
  basePath: string,
): HookDispatchResult | null {
  // If we just completed a hook unit, handle its result
  if (activeHook) {
    return handleHookCompletion(basePath);
  }

  // Don't trigger hooks for other hook units (prevent hook-on-hook chains)
  // Don't trigger hooks for triage units (prevent hook-on-triage chains)
  // Don't trigger hooks for quick-task units (lightweight one-offs from captures)
  if (completedUnitType.startsWith("hook/") || completedUnitType === "triage-captures" || completedUnitType === "quick-task") return null;

  // Check if any hooks are configured for this unit type
  const hooks = resolvePostUnitHooks().filter(h =>
    h.after.includes(completedUnitType),
  );
  if (hooks.length === 0) return null;

  // Build hook queue for this trigger
  hookQueue = hooks.map(config => ({
    config,
    triggerUnitType: completedUnitType,
    triggerUnitId: completedUnitId,
  }));

  return dequeueNextHook(basePath);
}

/**
 * Returns whether a hook is currently active (for progress display).
 */
export function getActiveHook(): HookExecutionState | null {
  return activeHook;
}

/**
 * Returns true if a retry of the trigger unit was requested by a hook.
 * Caller should re-dispatch the original trigger unit, then hooks will
 * fire again on its next completion.
 */
export function isRetryPending(): boolean {
  return retryPending;
}

/**
 * Returns the trigger unit info for a pending retry, or null.
 * Clears the retry state after reading.
 */
export function consumeRetryTrigger(): { unitType: string; unitId: string } | null {
  if (!retryPending || !retryTrigger) return null;
  const trigger = { ...retryTrigger };
  retryPending = false;
  retryTrigger = null;
  return trigger;
}

/**
 * Reset all hook state. Called on auto-mode start/stop.
 */
export function resetHookState(): void {
  activeHook = null;
  hookQueue = [];
  cycleCounts.clear();
  retryPending = false;
  retryTrigger = null;
}

// ─── Internal ──────────────────────────────────────────────────────────────

function dequeueNextHook(basePath: string): HookDispatchResult | null {
  while (hookQueue.length > 0) {
    const entry = hookQueue.shift()!;
    const { config, triggerUnitType, triggerUnitId } = entry;

    // Check idempotency — if artifact already exists, skip this hook
    if (config.artifact) {
      const artifactPath = resolveHookArtifactPath(basePath, triggerUnitId, config.artifact);
      if (existsSync(artifactPath)) continue;
    }

    // Check cycle limit
    const cycleKey = `${config.name}/${triggerUnitType}/${triggerUnitId}`;
    const currentCycle = (cycleCounts.get(cycleKey) ?? 0) + 1;
    const maxCycles = config.max_cycles ?? 1;
    if (currentCycle > maxCycles) continue;

    cycleCounts.set(cycleKey, currentCycle);

    activeHook = {
      hookName: config.name,
      triggerUnitType,
      triggerUnitId,
      cycle: currentCycle,
      pendingRetry: false,
    };

    // Build the prompt with variable substitution
    const [mid, sid, tid] = triggerUnitId.split("/");
    let prompt = config.prompt
      .replace(/\{milestoneId\}/g, mid ?? "")
      .replace(/\{sliceId\}/g, sid ?? "")
      .replace(/\{taskId\}/g, tid ?? "");

    // Inject browser safety instruction for hooks that may use browser tools (#1345).
    // Vite HMR and other persistent connections prevent networkidle from resolving.
    prompt += "\n\n**Browser tool safety:** Do NOT use `browser_wait_for` with `condition: \"network_idle\"` — it hangs indefinitely when dev servers keep persistent connections (Vite HMR, WebSocket). Use `selector_visible`, `text_visible`, or `delay` instead.";

    return {
      hookName: config.name,
      prompt,
      model: config.model,
      unitType: `hook/${config.name}`,
      unitId: triggerUnitId,
    };
  }

  // No more hooks — clear active state and return null for normal dispatch
  activeHook = null;
  return null;
}

function handleHookCompletion(basePath: string): HookDispatchResult | null {
  const hook = activeHook!;
  const hooks = resolvePostUnitHooks();
  const config = hooks.find(h => h.name === hook.hookName);

  // Check if retry was requested via retry_on artifact
  if (config?.retry_on) {
    const retryArtifactPath = resolveHookArtifactPath(basePath, hook.triggerUnitId, config.retry_on);
    if (existsSync(retryArtifactPath)) {
      // Check cycle limit before allowing retry
      const cycleKey = `${config.name}/${hook.triggerUnitType}/${hook.triggerUnitId}`;
      const currentCycle = cycleCounts.get(cycleKey) ?? 1;
      const maxCycles = config.max_cycles ?? 1;

      if (currentCycle < maxCycles) {
        // Signal retry — caller will re-dispatch the trigger unit
        activeHook = null;
        hookQueue = [];
        retryPending = true;
        retryTrigger = { unitType: hook.triggerUnitType, unitId: hook.triggerUnitId };
        return null;
      }
      // Max cycles reached — fall through to normal completion
    }
  }

  // Hook completed normally — try next hook in queue
  activeHook = null;
  return dequeueNextHook(basePath);
}

/**
 * Resolve the path where a hook artifact is expected to be written.
 * Uses the trigger unit's directory context:
 *   - Task-level (M001/S01/T01): .gsd/M001/slices/S01/tasks/T01-{artifact}
 *   - Slice-level (M001/S01):    .gsd/M001/slices/S01/{artifact}
 *   - Milestone-level (M001):    .gsd/M001/{artifact}
 */
export function resolveHookArtifactPath(basePath: string, unitId: string, artifactName: string): string {
  const parts = unitId.split("/");
  if (parts.length === 3) {
    const [mid, sid, tid] = parts;
    return join(basePath, ".gsd", mid, "slices", sid, "tasks", `${tid}-${artifactName}`);
  }
  if (parts.length === 2) {
    const [mid, sid] = parts;
    return join(basePath, ".gsd", mid, "slices", sid, artifactName);
  }
  return join(basePath, ".gsd", parts[0], artifactName);
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: Pre-Dispatch Hooks
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run pre-dispatch hooks for a unit about to be dispatched.
 * Returns a result indicating whether the unit should proceed (with optional
 * prompt modifications), be skipped, or be replaced entirely.
 *
 * Multiple hooks can fire for the same unit type. They compose:
 * - "modify" hooks stack (all prepend/append applied in order)
 * - "skip" short-circuits (first matching skip wins)
 * - "replace" short-circuits (first matching replace wins)
 * - Skip/replace hooks take precedence over modify hooks
 */
export function runPreDispatchHooks(
  unitType: string,
  unitId: string,
  prompt: string,
  basePath: string,
): PreDispatchResult {
  // Don't intercept hook units
  if (unitType.startsWith("hook/")) {
    return { action: "proceed", prompt, firedHooks: [] };
  }

  const hooks = resolvePreDispatchHooks().filter(h =>
    h.before.includes(unitType),
  );
  if (hooks.length === 0) {
    return { action: "proceed", prompt, firedHooks: [] };
  }

  const [mid, sid, tid] = unitId.split("/");
  const substitute = (text: string): string =>
    text
      .replace(/\{milestoneId\}/g, mid ?? "")
      .replace(/\{sliceId\}/g, sid ?? "")
      .replace(/\{taskId\}/g, tid ?? "");

  const firedHooks: string[] = [];
  let currentPrompt = prompt;

  for (const hook of hooks) {
    if (hook.action === "skip") {
      // Check optional skip condition
      if (hook.skip_if) {
        const conditionPath = resolveHookArtifactPath(basePath, unitId, hook.skip_if);
        if (!existsSync(conditionPath)) continue; // Condition not met, don't skip
      }
      firedHooks.push(hook.name);
      return { action: "skip", firedHooks };
    }

    if (hook.action === "replace") {
      firedHooks.push(hook.name);
      return {
        action: "replace",
        prompt: substitute(hook.prompt ?? ""),
        unitType: hook.unit_type,
        model: hook.model,
        firedHooks,
      };
    }

    if (hook.action === "modify") {
      firedHooks.push(hook.name);
      if (hook.prepend) {
        currentPrompt = `${substitute(hook.prepend)}\n\n${currentPrompt}`;
      }
      if (hook.append) {
        currentPrompt = `${currentPrompt}\n\n${substitute(hook.append)}`;
      }
    }
  }

  return {
    action: "proceed",
    prompt: currentPrompt,
    model: hooks.find(h => h.action === "modify" && h.model)?.model,
    firedHooks,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: Hook State Persistence
// ═══════════════════════════════════════════════════════════════════════════

const HOOK_STATE_FILE = "hook-state.json";

function hookStatePath(basePath: string): string {
  return join(basePath, ".gsd", HOOK_STATE_FILE);
}

/**
 * Persist current hook cycle counts to disk so they survive crashes/restarts.
 * Called after each hook dispatch and on auto-mode pause.
 */
export function persistHookState(basePath: string): void {
  const state: PersistedHookState = {
    cycleCounts: Object.fromEntries(cycleCounts),
    savedAt: new Date().toISOString(),
  };
  try {
    const dir = join(basePath, ".gsd");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(hookStatePath(basePath), JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // Non-fatal — state is recreatable from artifacts
  }
}

/**
 * Restore hook cycle counts from disk after a crash/restart.
 * Called during auto-mode resume.
 */
export function restoreHookState(basePath: string): void {
  try {
    const filePath = hookStatePath(basePath);
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, "utf-8");
    const state: PersistedHookState = JSON.parse(raw);
    if (state.cycleCounts && typeof state.cycleCounts === "object") {
      cycleCounts.clear();
      for (const [key, value] of Object.entries(state.cycleCounts)) {
        if (typeof value === "number") {
          cycleCounts.set(key, value);
        }
      }
    }
  } catch {
    // Non-fatal — fresh state is fine
  }
}

/**
 * Clear persisted hook state file from disk.
 * Called on clean auto-mode stop.
 */
export function clearPersistedHookState(basePath: string): void {
  try {
    const filePath = hookStatePath(basePath);
    if (existsSync(filePath)) {
      writeFileSync(filePath, JSON.stringify({ cycleCounts: {}, savedAt: new Date().toISOString() }, null, 2), "utf-8");
    }
  } catch {
    // Non-fatal
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: Hook Status Reporting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get status of all configured hooks for display by /gsd hooks.
 */
export function getHookStatus(): HookStatusEntry[] {
  const entries: HookStatusEntry[] = [];

  // Post-unit hooks
  const postHooks = resolvePostUnitHooks();
  for (const hook of postHooks) {
    const activeCycles: Record<string, number> = {};
    for (const [key, count] of cycleCounts) {
      if (key.startsWith(`${hook.name}/`)) {
        activeCycles[key] = count;
      }
    }
    entries.push({
      name: hook.name,
      type: "post",
      enabled: hook.enabled !== false,
      targets: hook.after,
      activeCycles,
    });
  }

  // Pre-dispatch hooks
  const preHooks = resolvePreDispatchHooks();
  for (const hook of preHooks) {
    entries.push({
      name: hook.name,
      type: "pre",
      enabled: hook.enabled !== false,
      targets: hook.before,
      activeCycles: {},
    });
  }

  return entries;
}

/**
 * Manually trigger a specific hook for a unit.
 * This bypasses the normal flow and forces the hook to run even if its artifact exists.
 * 
 * @param hookName - The name of the hook to trigger (e.g., "code-review")
 * @param unitType - The type of unit that triggered the hook (e.g., "execute-task")
 * @param unitId - The unit ID (e.g., "M001/S01/T01")
 * @param basePath - The project base path
 * @returns The hook dispatch result or null if hook not found
 */
export function triggerHookManually(
  hookName: string,
  unitType: string,
  unitId: string,
  basePath: string,
): HookDispatchResult | null {
  // Find the hook configuration
  const hook = resolvePostUnitHooks().find(h => h.name === hookName);
  if (!hook) {
    console.error(`[triggerHookManually] Hook "${hookName}" not found in post_unit_hooks`);
    return null;
  }

  if (!hook.prompt || typeof hook.prompt !== 'string' || hook.prompt.trim().length === 0) {
    console.error(`[triggerHookManually] Hook "${hookName}" has empty prompt`);
    return null;
  }

  // Reset any active hook state to allow manual triggering
  activeHook = {
    hookName: hook.name,
    triggerUnitType: unitType,
    triggerUnitId: unitId,
    cycle: 1,
    pendingRetry: false,
  };

  // Build the hook queue with just this hook
  hookQueue = [{
    config: hook,
    triggerUnitType: unitType,
    triggerUnitId: unitId,
  }];

  // Set the cycle count for this specific hook+trigger
  const cycleKey = `${hook.name}/${unitType}/${unitId}`;
  const currentCycle = (cycleCounts.get(cycleKey) ?? 0) + 1;
  cycleCounts.set(cycleKey, currentCycle);

  // Update active hook with the cycle count
  activeHook.cycle = currentCycle;

  // Build the prompt with variable substitution
  const [mid, sid, tid] = unitId.split("/");
  const prompt = hook.prompt
    .replace(/\{milestoneId\}/g, mid ?? "")
    .replace(/\{sliceId\}/g, sid ?? "")
    .replace(/\{taskId\}/g, tid ?? "");

  console.log(`[triggerHookManually] Built prompt for ${hookName}, length: ${prompt.length}`);

  return {
    hookName: hook.name,
    prompt,
    model: hook.model,
    unitType: `hook/${hook.name}`,
    unitId,
  };
}

/**
 * Format hook status for terminal display.
 */
export function formatHookStatus(): string {
  const entries = getHookStatus();
  if (entries.length === 0) {
    return "No hooks configured. Add post_unit_hooks or pre_dispatch_hooks to .gsd/preferences.md";
  }

  const lines: string[] = ["Configured Hooks:", ""];

  const postHooks = entries.filter(e => e.type === "post");
  const preHooks = entries.filter(e => e.type === "pre");

  if (postHooks.length > 0) {
    lines.push("Post-Unit Hooks (run after unit completes):");
    for (const hook of postHooks) {
      const status = hook.enabled ? "enabled" : "disabled";
      const cycles = Object.keys(hook.activeCycles).length;
      const cycleInfo = cycles > 0 ? ` (${cycles} active cycle${cycles === 1 ? "" : "s"})` : "";
      lines.push(`  ${hook.name} [${status}] → after: ${hook.targets.join(", ")}${cycleInfo}`);
    }
    lines.push("");
  }

  if (preHooks.length > 0) {
    lines.push("Pre-Dispatch Hooks (run before unit dispatches):");
    for (const hook of preHooks) {
      const status = hook.enabled ? "enabled" : "disabled";
      lines.push(`  ${hook.name} [${status}] → before: ${hook.targets.join(", ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
