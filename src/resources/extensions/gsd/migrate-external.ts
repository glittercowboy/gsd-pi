/**
 * GSD External State Migration
 *
 * Migrates legacy in-project `.gsd/` directories to the external
 * `~/.gsd/projects/<hash>/` state directory. After migration, a
 * symlink replaces the original directory so all paths remain valid.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, cpSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { externalGsdRoot } from "./repo-identity.js";

export interface MigrationResult {
  migrated: boolean;
  error?: string;
}

/**
 * Migrate a legacy in-project `.gsd/` directory to external storage.
 *
 * Algorithm:
 * 1. If `<project>/.gsd` is a symlink or doesn't exist -> skip
 * 2. If `<project>/.gsd` is a real directory:
 *    a. Compute external path from repoIdentity
 *    b. mkdir -p external dir
 *    c. Rename `.gsd` -> `.gsd.migrating` (atomic on same FS, acts as lock)
 *    d. Copy contents to external dir (skip `worktrees/` subdirectory)
 *    e. Create symlink `.gsd -> external path`
 *    f. Remove `.gsd.migrating`
 * 3. On failure: rename `.gsd.migrating` back to `.gsd` (rollback)
 */
export function migrateToExternalState(basePath: string): MigrationResult {
  const localGsd = join(basePath, ".gsd");

  // Skip if doesn't exist
  if (!existsSync(localGsd)) {
    return { migrated: false };
  }

  // Skip if already a symlink
  try {
    const stat = lstatSync(localGsd);
    if (stat.isSymbolicLink()) {
      return { migrated: false };
    }
    if (!stat.isDirectory()) {
      return { migrated: false, error: ".gsd exists but is not a directory or symlink" };
    }
  } catch (err) {
    return { migrated: false, error: `Cannot stat .gsd: ${err instanceof Error ? err.message : String(err)}` };
  }

  const externalPath = externalGsdRoot(basePath);
  const migratingPath = join(basePath, ".gsd.migrating");

  try {
    // mkdir -p the external dir
    mkdirSync(externalPath, { recursive: true });

    // Rename .gsd -> .gsd.migrating (atomic lock)
    renameSync(localGsd, migratingPath);

    // Copy contents to external dir, skipping worktrees/
    const entries = readdirSync(migratingPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "worktrees") continue; // worktrees stay local

      const src = join(migratingPath, entry.name);
      const dst = join(externalPath, entry.name);

      try {
        if (entry.isDirectory()) {
          cpSync(src, dst, { recursive: true, force: true });
        } else {
          cpSync(src, dst, { force: true });
        }
      } catch {
        // Non-fatal: continue with other files
      }
    }

    // Create symlink .gsd -> external path
    symlinkSync(externalPath, localGsd, "junction");

    // Remove .gsd.migrating
    rmSync(migratingPath, { recursive: true, force: true });

    return { migrated: true };
  } catch (err) {
    // Rollback: rename .gsd.migrating back to .gsd
    try {
      if (existsSync(migratingPath) && !existsSync(localGsd)) {
        renameSync(migratingPath, localGsd);
      }
    } catch {
      // Rollback failed -- leave .gsd.migrating for doctor to detect
    }

    return {
      migrated: false,
      error: `Migration failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Recover from a failed migration (`.gsd.migrating` exists).
 * Moves `.gsd.migrating` back to `.gsd` if `.gsd` doesn't exist.
 */
export function recoverFailedMigration(basePath: string): boolean {
  const localGsd = join(basePath, ".gsd");
  const migratingPath = join(basePath, ".gsd.migrating");

  if (!existsSync(migratingPath)) return false;
  if (existsSync(localGsd)) return false; // both exist -- ambiguous, don't touch

  try {
    renameSync(migratingPath, localGsd);
    return true;
  } catch {
    return false;
  }
}
