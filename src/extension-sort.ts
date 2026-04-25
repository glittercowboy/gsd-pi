// GSD-2 — Extension Sort: Topological dependency ordering
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { readManifestFromEntryPath } from './extension-registry.js'

export interface SortWarning {
  declaringId: string
  missingId: string
  message: string
}

export interface SortResult {
  sortedPaths: string[]
  warnings: SortWarning[]
}

/**
 * Sort extension entry paths in topological dependency-first order using Kahn's BFS algorithm.
 *
 * - Extensions without manifests are prepended in input order.
 * - Missing dependencies produce a structured warning but do not block loading.
 * - Cycles produce warnings; cycle participants are appended alphabetically.
 * - Self-dependencies are silently ignored.
 */
export function sortExtensionPaths(paths: string[]): SortResult {
  const warnings: SortWarning[] = []
  const pathsWithoutId: string[] = []
  const idToPath = new Map<string, string>()

  // Step 1: Build ID map
  for (const path of paths) {
    const manifest = readManifestFromEntryPath(path)
    if (!manifest) {
      pathsWithoutId.push(path)
    } else {
      idToPath.set(manifest.id, path)
    }
  }

  // Step 2: Build graph — inDegree and dependents adjacency
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>() // dep → [ids that depend on dep]

  for (const id of idToPath.keys()) {
    if (!inDegree.has(id)) inDegree.set(id, 0)
    if (!dependents.has(id)) dependents.set(id, [])
  }

  for (const [id, path] of idToPath) {
    const manifest = readManifestFromEntryPath(path)
    const rawDeps = manifest?.dependencies?.extensions ?? []
    const deps = Array.isArray(rawDeps) ? rawDeps : []

    for (const depId of deps) {
      // Silently ignore self-deps
      if (depId === id) continue

      if (!idToPath.has(depId)) {
        // Missing dependency — warn and skip edge
        warnings.push({
          declaringId: id,
          missingId: depId,
          message: `Extension '${id}' declares dependency '${depId}' which is not installed — loading anyway`,
        })
        continue
      }

      // Valid edge: id depends on depId → increment inDegree[id], add id to dependents[depId]
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1)
      const depDependents = dependents.get(depId) ?? []
      depDependents.push(id)
      dependents.set(depId, depDependents)
    }
  }

  // Step 3: Kahn's algorithm — start with nodes that have inDegree 0
  const sorted: string[] = []
  // Ready queue: IDs with inDegree 0, maintained in alphabetical order
  const ready: string[] = [...idToPath.keys()]
    .filter(id => inDegree.get(id) === 0)
    .sort()

  while (ready.length > 0) {
    const id = ready.shift()!
    sorted.push(idToPath.get(id)!)

    const deps = dependents.get(id) ?? []
    for (const depId of deps) {
      const newDegree = (inDegree.get(depId) ?? 0) - 1
      inDegree.set(depId, newDegree)
      if (newDegree === 0) {
        // Insert into ready queue maintaining alphabetical order
        const insertIdx = ready.findIndex(r => r > depId)
        if (insertIdx === -1) {
          ready.push(depId)
        } else {
          ready.splice(insertIdx, 0, depId)
        }
      }
    }
  }

  // Step 4: Cycle handling — any remaining IDs with inDegree > 0
  const cycleIds = [...idToPath.keys()]
    .filter(id => (inDegree.get(id) ?? 0) > 0)
    .sort()

  if (cycleIds.length > 0) {
    const cycleSet = new Set(cycleIds)

    for (const id of cycleIds) {
      const path = idToPath.get(id)!
      const manifest = readManifestFromEntryPath(path)
      const rawDeps = manifest?.dependencies?.extensions ?? []
      const deps = Array.isArray(rawDeps) ? rawDeps : []

      for (const depId of deps) {
        if (depId === id) continue
        if (!cycleSet.has(depId)) continue

        // Both id and depId are in cycle — emit warning
        warnings.push({
          declaringId: id,
          missingId: depId,
          message: `Extension '${id}' and '${depId}' form a dependency cycle — loading both anyway (alphabetical order)`,
        })
      }

      sorted.push(path)
    }
  }

  return {
    sortedPaths: [...pathsWithoutId, ...sorted],
    warnings,
  }
}
