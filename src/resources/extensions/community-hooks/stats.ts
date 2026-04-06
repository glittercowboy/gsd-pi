// GSD Community Hooks — Runtime Stats
//
// Tracks per-hook activity during the current session. Used by the hooks
// management command to show what each hook has been doing.

export interface HookStats {
  /** Number of times the hook fired. */
  fires: number;
  /** Number of actions taken (blocks, warnings, notifications). */
  actions: number;
  /** Last action timestamp. */
  lastAction?: string;
  /** Last action description. */
  lastDescription?: string;
}

const sessionStats = new Map<string, HookStats>();

export function recordFire(hookKey: string): void {
  const stats = sessionStats.get(hookKey) ?? { fires: 0, actions: 0 };
  stats.fires++;
  sessionStats.set(hookKey, stats);
}

export function recordAction(hookKey: string, description: string): void {
  const stats = sessionStats.get(hookKey) ?? { fires: 0, actions: 0 };
  stats.actions++;
  stats.lastAction = new Date().toISOString();
  stats.lastDescription = description;
  sessionStats.set(hookKey, stats);
}

export function getStats(hookKey: string): HookStats {
  return sessionStats.get(hookKey) ?? { fires: 0, actions: 0 };
}

export function getAllStats(): Map<string, HookStats> {
  return new Map(sessionStats);
}

export function resetStats(): void {
  sessionStats.clear();
}
