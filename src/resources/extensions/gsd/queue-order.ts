/**
 * GSD Queue Order — Custom milestone execution ordering.
 *
 * Stores an explicit execution order in `.gsd/QUEUE-ORDER.json`.
 * When present, `findMilestoneIds()` uses this order instead of
 * the default numeric sort (milestoneIdSort).
 *
 * The file is committed to git (not gitignored) so ordering
 * survives branch switches and is shared across sessions.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gsdRoot } from "./paths.js";
import { milestoneIdSort } from "./guided-flow.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface QueueOrderFile {
  order: string[];
  updatedAt: string;
}

export interface DependencyViolation {
  milestone: string;
  dependsOn: string;
  type: 'would_block' | 'circular' | 'missing_dep';
  message: string;
}

export interface DependencyRedundancy {
  milestone: string;
  dependsOn: string;
}

export interface DependencyValidation {
  valid: boolean;
  violations: DependencyViolation[];
  redundant: DependencyRedundancy[];
}

// ─── Path ────────────────────────────────────────────────────────────────────

function queueOrderPath(basePath: string): string {
  return join(gsdRoot(basePath), "QUEUE-ORDER.json");
}

// ─── Read / Write ────────────────────────────────────────────────────────────

/**
 * Load the custom queue order. Returns null if no file exists or if
 * the file is corrupt/unreadable.
 */
export function loadQueueOrder(basePath: string): string[] | null {
  const p = queueOrderPath(basePath);
  if (!existsSync(p)) return null;
  try {
    const data: QueueOrderFile = JSON.parse(readFileSync(p, "utf-8"));
    if (!Array.isArray(data.order)) return null;
    return data.order;
  } catch {
    return null;
  }
}

/**
 * Save a custom queue order to disk.
 */
export function saveQueueOrder(basePath: string, order: string[]): void {
  const data: QueueOrderFile = {
    order,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(queueOrderPath(basePath), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ─── Sorting ─────────────────────────────────────────────────────────────────

/**
 * Sort milestone IDs respecting a custom order.
 *
 * - IDs present in `customOrder` appear in that exact sequence.
 * - IDs on disk but NOT in `customOrder` are appended at the end,
 *   sorted by the default `milestoneIdSort` (numeric).
 * - IDs in `customOrder` but NOT on disk are silently skipped.
 * - When `customOrder` is null, falls back to `milestoneIdSort`.
 */
export function sortByQueueOrder(ids: string[], customOrder: string[] | null): string[] {
  if (!customOrder) return [...ids].sort(milestoneIdSort);

  const idSet = new Set(ids);
  const ordered: string[] = [];

  // First: IDs from customOrder that exist on disk
  for (const id of customOrder) {
    if (idSet.has(id)) {
      ordered.push(id);
      idSet.delete(id);
    }
  }

  // Then: remaining IDs not in customOrder, in default sort order
  const remaining = [...idSet].sort(milestoneIdSort);
  return [...ordered, ...remaining];
}

// ─── Pruning ─────────────────────────────────────────────────────────────────

/**
 * Remove IDs from the queue order file that are no longer valid
 * (completed or deleted milestones). No-op if file doesn't exist.
 */
export function pruneQueueOrder(basePath: string, validIds: string[]): void {
  const order = loadQueueOrder(basePath);
  if (!order) return;

  const validSet = new Set(validIds);
  const pruned = order.filter(id => validSet.has(id));

  if (pruned.length !== order.length) {
    saveQueueOrder(basePath, pruned);
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a proposed queue order against dependency constraints.
 *
 * Checks:
 * - would_block: A milestone is placed before one of its dependencies
 * - circular: Two or more milestones form a dependency cycle
 * - missing_dep: A milestone depends on an ID that doesn't exist
 * - redundant: A dependency is satisfied by queue position (dep comes earlier)
 */
export function validateQueueOrder(
  order: string[],
  depsMap: Map<string, string[]>,
  completedIds: Set<string>,
): DependencyValidation {
  const violations: DependencyViolation[] = [];
  const redundant: DependencyRedundancy[] = [];

  const positionMap = new Map<string, number>();
  for (let i = 0; i < order.length; i++) {
    positionMap.set(order[i], i);
  }

  const allKnownIds = new Set([...order, ...completedIds]);

  for (const [mid, deps] of depsMap) {
    const midPos = positionMap.get(mid);
    if (midPos === undefined) continue; // not in pending order

    for (const dep of deps) {
      // Dep already completed — always satisfied
      if (completedIds.has(dep)) continue;

      // Dep doesn't exist anywhere
      if (!allKnownIds.has(dep)) {
        violations.push({
          milestone: mid,
          dependsOn: dep,
          type: 'missing_dep',
          message: `${mid} depends on ${dep}, but ${dep} does not exist.`,
        });
        continue;
      }

      const depPos = positionMap.get(dep);
      if (depPos === undefined) continue; // dep not in pending order (edge case)

      if (depPos > midPos) {
        // Dep comes AFTER this milestone in the order — violation
        violations.push({
          milestone: mid,
          dependsOn: dep,
          type: 'would_block',
          message: `${mid} cannot run before ${dep} — ${mid} depends_on: [${dep}].`,
        });
      } else {
        // Dep comes before — satisfied by position, redundant
        redundant.push({ milestone: mid, dependsOn: dep });
      }
    }
  }

  // Check for circular dependencies
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(node: string, path: string[]): string[] | null {
    if (inStack.has(node)) return [...path, node];
    if (visited.has(node)) return null;

    visited.add(node);
    inStack.add(node);

    const deps = depsMap.get(node) ?? [];
    for (const dep of deps) {
      if (completedIds.has(dep)) continue;
      const cycle = hasCycle(dep, [...path, node]);
      if (cycle) return cycle;
    }

    inStack.delete(node);
    return null;
  }

  for (const mid of order) {
    if (!visited.has(mid)) {
      const cycle = hasCycle(mid, []);
      if (cycle) {
        const cycleStr = cycle.join(' → ');
        violations.push({
          milestone: cycle[0],
          dependsOn: cycle[cycle.length - 2],
          type: 'circular',
          message: `Circular dependency: ${cycleStr}`,
        });
        break; // one cycle report is enough
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    redundant,
  };
}
