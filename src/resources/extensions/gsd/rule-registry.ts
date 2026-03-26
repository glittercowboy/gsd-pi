// GSD Extension — Unified Rule Registry
//
// Holds all dispatch rules and hooks as a flat list of UnifiedRule objects.
// Provides evaluation methods for each phase (dispatch, post-unit, pre-dispatch)
// and encapsulates mutable hook state as instance fields.
//
// A module-level singleton accessor allows existing code to migrate incrementally.

import type { UnifiedRule, RulePhase } from "./rule-types.js";
import type { DispatchAction, DispatchContext, DispatchRule } from "./auto-dispatch.js";
import type {
  PostUnitHookConfig,
  PreDispatchHookConfig,
  HookDispatchResult,
  PreDispatchResult,
  HookExecutionState,
  PersistedHookState,
  HookStatusEntry,
} from "./types.js";
import { resolvePostUnitHooks, resolvePreDispatchHooks } from "./preferences.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseUnitId } from "./unit-id.js";

// ─── Artifact Path Resolution ──────────────────────────────────────────────

export function resolveHookArtifactPath(basePath: string, unitId: string, artifactName: string): string {
  const { milestone, slice, task } = parseUnitId(unitId);
  if (task !== undefined && slice !== undefined) {
    return join(basePath, ".gsd", "milestones", milestone, "slices", slice, "tasks", `${task}-${artifactName}`);
  }
  if (slice !== undefined) {
    return join(basePath, ".gsd", "milestones", milestone, "slices", slice, artifactName);
  }
  return join(basePath, ".gsd", "milestones", milestone, artifactName);
}

// ─── Dispatch Rule Conversion ──────────────────────────────────────────────

/**
 * Convert an array of DispatchRule objects to UnifiedRule[] format.
 * Preserves exact array order — dispatch is order-dependent (first-match-wins).
 */
export function convertDispatchRules(rules: DispatchRule[]): UnifiedRule[] {
  return rules.map((rule) => ({
    name: rule.name,
    when: "dispatch" as const,
    evaluation: "first-match" as const,
    where: rule.match,
    then: (result: any) => result,
    description: `Dispatch rule: ${rule.name}`,
  }));
}

// ─── RuleRegistry ─────────────────────────────────────────────────────────

const HOOK_STATE_FILE = "hook-state.json";

export class RuleRegistry {
  /** Static dispatch rules provided at construction time. */
  private readonly dispatchRules: UnifiedRule[];

  // ── Mutable hook state (encapsulated, not module-level) ──────────────

  activeHook: HookExecutionState | null = null;
  hookQueue: Array<{
    config: PostUnitHookConfig;
    triggerUnitType: string;
    triggerUnitId: string;
  }> = [];
  cycleCounts: Map<string, number> = new Map();
  retryPending: boolean = false;
  retryTrigger: { unitType: string; unitId: string; retryArtifact: string } | null = null;

  constructor(dispatchRules: UnifiedRule[]) {
    this.dispatchRules = dispatchRules;
  }

  // ── Core query ───────────────────────────────────────────────────────

  /**
   * Returns all rules: static dispatch rules + dynamically loaded hook rules.
   * Hook rules are loaded fresh from preferences on each call (not cached).
   */
  listRules(): UnifiedRule[] {
    const rules: UnifiedRule[] = [...this.dispatchRules];

    // Convert post-unit hooks to unified rules
    const postHooks = resolvePostUnitHooks();
    for (const hook of postHooks) {
      rules.push({
        name: hook.name,
        when: "post-unit",
        evaluation: "all-matching",
        where: (unitType: string) => hook.after.includes(unitType),
        then: () => hook,
        description: `Post-unit hook: fires after ${hook.after.join(", ")}`,
        lifecycle: {
          artifact: hook.artifact,
          retry_on: hook.retry_on,
          max_cycles: hook.max_cycles,
        },
      });
    }

    // Convert pre-dispatch hooks to unified rules
    const preHooks = resolvePreDispatchHooks();
    for (const hook of preHooks) {
      rules.push({
        name: hook.name,
        when: "pre-dispatch",
        evaluation: "all-matching",
        where: (unitType: string) => hook.before.includes(unitType),
        then: () => hook,
        description: `Pre-dispatch hook: fires before ${hook.before.join(", ")}`,
      });
    }

    return rules;
  }

  // ── Dispatch evaluation (async, first-match-wins) ───────────────────

  /**
   * Iterate dispatch rules in order. First match wins.
   * Returns stop action if no rule matches (unhandled phase).
   */
  async evaluateDispatch(ctx: DispatchContext): Promise<DispatchAction> {
    for (const rule of this.dispatchRules) {
      const result = await rule.where(ctx);
      if (result) {
        if (result.action !== "skip") result.matchedRule = rule.name;
        return result;
      }
    }
    return {
      action: "stop",
      reason: `Unhandled phase "${ctx.state.phase}" — run /gsd doctor to diagnose.`,
      level: "info",
      matchedRule: "<no-match>",
    };
  }

  // ── Post-unit hook evaluation (sync, all-matching with lifecycle) ────

  /**
   * Replicate exact semantics of checkPostUnitHooks from post-unit-hooks.ts:
   * hook-on-hook prevention, idempotency, cycle limits, retry_on, dequeue.
   */
  evaluatePostUnit(
    completedUnitType: string,
    completedUnitId: string,
    basePath: string,
  ): HookDispatchResult | null {
    // If we just completed a hook unit, handle its result
    if (this.activeHook) {
      return this._handleHookCompletion(basePath);
    }

    // Don't trigger hooks for other hook units (prevent hook-on-hook chains)
    // Don't trigger hooks for triage units or quick-task units
    if (
      completedUnitType.startsWith("hook/") ||
      completedUnitType === "triage-captures" ||
      completedUnitType === "quick-task"
    ) {
      return null;
    }

    // Check if any hooks are configured for this unit type
    const hooks = resolvePostUnitHooks().filter(h =>
      h.after.includes(completedUnitType),
    );
    if (hooks.length === 0) return null;

    // Build hook queue for this trigger
    this.hookQueue = hooks.map(config => ({
      config,
      triggerUnitType: completedUnitType,
      triggerUnitId: completedUnitId,
    }));

    return this._dequeueNextHook(basePath);
  }

  private _dequeueNextHook(basePath: string): HookDispatchResult | null {
    while (this.hookQueue.length > 0) {
      const entry = this.hookQueue.shift()!;
      const { config, triggerUnitType, triggerUnitId } = entry;

      // Check idempotency — if artifact already exists, skip
      if (config.artifact) {
        const artifactPath = resolveHookArtifactPath(basePath, triggerUnitId, config.artifact);
        if (existsSync(artifactPath)) continue;
      }

      // Check cycle limit
      const cycleKey = `${config.name}/${triggerUnitType}/${triggerUnitId}`;
      const currentCycle = (this.cycleCounts.get(cycleKey) ?? 0) + 1;
      const maxCycles = config.max_cycles ?? 1;
      if (currentCycle > maxCycles) continue;

      this.cycleCounts.set(cycleKey, currentCycle);

      this.activeHook = {
        hookName: config.name,
        triggerUnitType,
        triggerUnitId,
        cycle: currentCycle,
        pendingRetry: false,
      };

      // Build prompt with variable substitution
      const { milestone: mid, slice: sid, task: tid } = parseUnitId(triggerUnitId);
      let prompt = config.prompt
        .replace(/\{milestoneId\}/g, mid ?? "")
        .replace(/\{sliceId\}/g, sid ?? "")
        .replace(/\{taskId\}/g, tid ?? "");

      // Inject browser safety instruction
      prompt += "\n\n**Browser tool safety:** Do NOT use `browser_wait_for` with `condition: \"network_idle\"` — it hangs indefinitely when dev servers keep persistent connections (Vite HMR, WebSocket). Use `selector_visible`, `text_visible`, or `delay` instead.";

      return {
        hookName: config.name,
        prompt,
        model: config.model,
        unitType: `hook/${config.name}`,
        unitId: triggerUnitId,
      };
    }

    // No more hooks — clear active state
    this.activeHook = null;
    return null;
  }

  private _handleHookCompletion(basePath: string): HookDispatchResult | null {
    const hook = this.activeHook!;
    const hooks = resolvePostUnitHooks();
    const config = hooks.find(h => h.name === hook.hookName);

    // Check if retry was requested via retry_on artifact
    if (config?.retry_on) {
      const retryArtifactPath = resolveHookArtifactPath(basePath, hook.triggerUnitId, config.retry_on);
      if (existsSync(retryArtifactPath)) {
        const cycleKey = `${config.name}/${hook.triggerUnitType}/${hook.triggerUnitId}`;
        const currentCycle = this.cycleCounts.get(cycleKey) ?? 1;
        const maxCycles = config.max_cycles ?? 1;

        if (currentCycle < maxCycles) {
          this.activeHook = null;
          this.hookQueue = [];
          this.retryPending = true;
          this.retryTrigger = {
            unitType: hook.triggerUnitType,
            unitId: hook.triggerUnitId,
            retryArtifact: config.retry_on,
          };
          return null;
        }
      }
    }

    // Hook completed normally — try next hook in queue
    this.activeHook = null;
    return this._dequeueNextHook(basePath);
  }

  // ── Pre-dispatch hook evaluation (sync, all-matching with compose) ──

  /**
   * Replicate exact semantics of runPreDispatchHooks from post-unit-hooks.ts:
   * modify/skip/replace compose semantics.
   */
  evaluatePreDispatch(
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

    const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
    const substitute = (text: string): string =>
      text
        .replace(/\{milestoneId\}/g, mid ?? "")
        .replace(/\{sliceId\}/g, sid ?? "")
        .replace(/\{taskId\}/g, tid ?? "");

    const firedHooks: string[] = [];
    let currentPrompt = prompt;

    for (const hook of hooks) {
      if (hook.action === "skip") {
        if (hook.skip_if) {
          const conditionPath = resolveHookArtifactPath(basePath, unitId, hook.skip_if);
          if (!existsSync(conditionPath)) continue;
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

  // ── State accessors ─────────────────────────────────────────────────

  getActiveHook(): HookExecutionState | null {
    return this.activeHook;
  }

  isRetryPending(): boolean {
    return this.retryPending;
  }

  /**
   * Returns the trigger unit info for a pending retry, or null.
   * Clears the retry state after reading.
   */
  consumeRetryTrigger(): { unitType: string; unitId: string; retryArtifact: string } | null {
    if (!this.retryPending || !this.retryTrigger) return null;
    const trigger = { ...this.retryTrigger };
    this.retryPending = false;
    this.retryTrigger = null;
    return trigger;
  }

  /** Clear all mutable state (activeHook, hookQueue, cycleCounts, retryPending, retryTrigger). */
  resetState(): void {
    this.activeHook = null;
    this.hookQueue = [];
    this.cycleCounts.clear();
    this.retryPending = false;
    this.retryTrigger = null;
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private _hookStatePath(basePath: string): string {
    return join(basePath, ".gsd", HOOK_STATE_FILE);
  }

  /** Persist current hook cycle counts to disk. */
  persistState(basePath: string): void {
    const state: PersistedHookState = {
      cycleCounts: Object.fromEntries(this.cycleCounts),
      savedAt: new Date().toISOString(),
    };
    try {
      const dir = join(basePath, ".gsd");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this._hookStatePath(basePath), JSON.stringify(state, null, 2), "utf-8");
    } catch {
      // Non-fatal — state is recreatable from artifacts
    }
  }

  /** Restore hook cycle counts from disk after a crash/restart. */
  restoreState(basePath: string): void {
    try {
      const filePath = this._hookStatePath(basePath);
      if (!existsSync(filePath)) return;
      const raw = readFileSync(filePath, "utf-8");
      const state: PersistedHookState = JSON.parse(raw);
      if (state.cycleCounts && typeof state.cycleCounts === "object") {
        this.cycleCounts.clear();
        for (const [key, value] of Object.entries(state.cycleCounts)) {
          if (typeof value === "number") {
            this.cycleCounts.set(key, value);
          }
        }
      }
    } catch {
      // Non-fatal — fresh state is fine
    }
  }

  /** Clear persisted hook state file from disk. */
  clearPersistedState(basePath: string): void {
    try {
      const filePath = this._hookStatePath(basePath);
      if (existsSync(filePath)) {
        writeFileSync(
          filePath,
          JSON.stringify({ cycleCounts: {}, savedAt: new Date().toISOString() }, null, 2),
          "utf-8",
        );
      }
    } catch {
      // Non-fatal
    }
  }

  // ── Hook status reporting ───────────────────────────────────────────

  /** Get status of all configured hooks for display. */
  getHookStatus(): HookStatusEntry[] {
    const entries: HookStatusEntry[] = [];

    const postHooks = resolvePostUnitHooks();
    for (const hook of postHooks) {
      const activeCycles: Record<string, number> = {};
      for (const [key, count] of this.cycleCounts) {
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
   * Bypasses normal flow — forces hook to run even if artifact exists.
   */
  triggerHookManually(
    hookName: string,
    unitType: string,
    unitId: string,
    basePath: string,
  ): HookDispatchResult | null {
    const hook = resolvePostUnitHooks().find(h => h.name === hookName);
    if (!hook) {
      console.error(`[triggerHookManually] Hook "${hookName}" not found in post_unit_hooks`);
      return null;
    }

    if (!hook.prompt || typeof hook.prompt !== "string" || hook.prompt.trim().length === 0) {
      console.error(`[triggerHookManually] Hook "${hookName}" has empty prompt`);
      return null;
    }

    this.activeHook = {
      hookName: hook.name,
      triggerUnitType: unitType,
      triggerUnitId: unitId,
      cycle: 1,
      pendingRetry: false,
    };

    this.hookQueue = [{
      config: hook,
      triggerUnitType: unitType,
      triggerUnitId: unitId,
    }];

    const cycleKey = `${hook.name}/${unitType}/${unitId}`;
    const currentCycle = (this.cycleCounts.get(cycleKey) ?? 0) + 1;
    this.cycleCounts.set(cycleKey, currentCycle);
    this.activeHook.cycle = currentCycle;

    const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
    const prompt = hook.prompt
      .replace(/\{milestoneId\}/g, mid ?? "")
      .replace(/\{sliceId\}/g, sid ?? "")
      .replace(/\{taskId\}/g, tid ?? "");

    return {
      hookName: hook.name,
      prompt,
      model: hook.model,
      unitType: `hook/${hook.name}`,
      unitId,
    };
  }

  /** Format hook status for terminal display. */
  formatHookStatus(): string {
    const entries = this.getHookStatus();
    if (entries.length === 0) {
      return "No hooks configured. Add post_unit_hooks or pre_dispatch_hooks to .gsd/PREFERENCES.md";
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
}

// ─── Module-level Singleton ─────────────────────────────────────────────────

let _registry: RuleRegistry | null = null;

/** Get the singleton registry. Throws if not initialized. */
export function getRegistry(): RuleRegistry {
  if (!_registry) {
    throw new Error("RuleRegistry not initialized — call initRegistry() or setRegistry() first.");
  }
  return _registry;
}

/** Set the singleton registry instance. */
export function setRegistry(r: RuleRegistry): void {
  _registry = r;
}

/** Create and set the singleton registry with the given dispatch rules. */
export function initRegistry(dispatchRules: UnifiedRule[]): RuleRegistry {
  const registry = new RuleRegistry(dispatchRules);
  setRegistry(registry);
  return registry;
}

/**
 * Get the singleton registry, lazily creating one with empty dispatch rules
 * if not yet initialized. This ensures facade functions work even when
 * the full registry hasn't been set up (e.g. during testing).
 */
export function getOrCreateRegistry(): RuleRegistry {
  if (!_registry) {
    _registry = new RuleRegistry([]);
  }
  return _registry;
}

/** Reset the singleton (for testing). */
export function resetRegistry(): void {
  _registry = null;
}
