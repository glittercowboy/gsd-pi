// GSD Extension — Unified Cache Invalidation
//
// Three module-scoped read caches exist across the GSD extension:
//   1. State cache (state.ts)  — memoized deriveState() result
//   2. Path cache  (paths.ts)  — directory listing results (readdirSync)
//   3. Parse cache (files.ts)  — parsed markdown file results
//
// After any file write that changes .gsd/ contents, all three must be
// invalidated together to prevent stale reads. This module provides a
// single function that clears all three atomically.
//
// NOTE: The DB `artifacts` table is NOT included here. Earlier versions
// called clearArtifacts() as part of this bundle (#793), intending to
// force deriveState() to re-parse from disk when files were edited
// out-of-band. But invalidateAllCaches() fires on every post-unit pass,
// so bundling a DESTRUCTIVE `DELETE FROM artifacts` with routine cache
// invalidation meant every row written by saveArtifactToDb / writeAndStore
// was wiped within seconds — leaving the milestone completed on disk but
// the `artifacts` table empty and the agent looping on "file exists but
// DB record missing" recovery calls. If a call site genuinely needs the
// artifact table cleared after an out-of-band file mutation, it should
// invoke clearArtifacts() from gsd-db.js explicitly — do not add it back
// here.

import { invalidateStateCache } from './state.js';
import { clearPathCache } from './paths.js';
import { clearParseCache } from './files.js';

/**
 * Invalidate all GSD runtime read caches in one call.
 *
 * Call this after file writes, milestone transitions, merge reconciliation,
 * or any operation that changes .gsd/ contents on disk. Forgetting to clear
 * any single cache causes stale reads (see #431).
 */
export function invalidateAllCaches(): void {
  invalidateStateCache();
  clearPathCache();
  clearParseCache();
}
