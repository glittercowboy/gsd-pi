// GSD — Persistent per-project blocklist of provider/model pairs that the
// provider has rejected at request time for account entitlement reasons.
//
// Lives at `.gsd/runtime/blocked-models.json` so the block survives /gsd auto
// restarts.  Auto-mode model selection skips blocked entries; agent-end
// recovery adds entries when a runtime rejection is classified as
// `unsupported-model`.  See issue #4513.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gsdRoot } from "./paths.js";
import { withFileLockSync } from "./file-lock.js";

export interface BlockedModelEntry {
  provider: string;
  id: string;
  reason: string;
  blockedAt: number;
}

interface BlockedModelsFile {
  version: 1;
  blocked: BlockedModelEntry[];
}

function blockedModelsPath(basePath: string): string {
  return join(gsdRoot(basePath), "runtime", "blocked-models.json");
}

function modelKey(provider: string, id: string): string {
  return `${provider.toLowerCase()}/${id.toLowerCase()}`;
}

function readFileSafe(path: string): BlockedModelsFile {
  if (!existsSync(path)) return { version: 1, blocked: [] };
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BlockedModelsFile>;
    if (!parsed || !Array.isArray(parsed.blocked)) {
      return { version: 1, blocked: [] };
    }
    const blocked = parsed.blocked.filter(
      (e): e is BlockedModelEntry =>
        !!e && typeof e.provider === "string" && typeof e.id === "string",
    );
    return { version: 1, blocked };
  } catch {
    // Corrupted JSON: treat as empty so a bad file never blocks dispatch.
    return { version: 1, blocked: [] };
  }
}

export function loadBlockedModels(basePath: string): BlockedModelEntry[] {
  return readFileSafe(blockedModelsPath(basePath)).blocked;
}

export function isModelBlocked(
  basePath: string,
  provider: string | undefined,
  id: string | undefined,
): boolean {
  if (!provider || !id) return false;
  const target = modelKey(provider, id);
  return loadBlockedModels(basePath).some(
    (e) => modelKey(e.provider, e.id) === target,
  );
}

export function blockModel(
  basePath: string,
  provider: string,
  id: string,
  reason: string,
): void {
  const path = blockedModelsPath(basePath);
  mkdirSync(dirname(path), { recursive: true });
  // Ensure the file exists before we try to lock it — proper-lockfile requires
  // the target path to exist (file-lock.ts falls through to an unlocked call
  // otherwise).
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify({ version: 1, blocked: [] }, null, 2) + "\n", "utf-8");
  }
  withFileLockSync(path, () => {
    const current = readFileSafe(path);
    const target = modelKey(provider, id);
    if (current.blocked.some((e) => modelKey(e.provider, e.id) === target)) {
      return;
    }
    const next: BlockedModelsFile = {
      version: 1,
      blocked: [
        ...current.blocked,
        { provider, id, reason, blockedAt: Date.now() },
      ],
    };
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf-8");
  });
}
