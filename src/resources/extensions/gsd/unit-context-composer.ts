// GSD-2 — UnitContextComposer (#4782 phase 2).
//
// Reads a unit type's manifest and orchestrates artifact inlining through
// a caller-provided resolver. Returns a joined context block suitable for
// substitution into the unit's prompt template.
//
// Design rationale:
//   - Pure dependency on the manifest module — no circular import with
//     `auto-prompts.ts` where the per-artifact-key resolver lives.
//   - Caller-supplied resolver means the composer can be unit-tested with
//     trivial mocks; production wiring in `auto-prompts.ts` dispatches to
//     the existing `inlineFile` / `inline*FromDb` helpers.
//   - Null-returning resolvers are skipped silently: they model the
//     "artifact is optional / missing / not applicable to this milestone"
//     case. The composer never errors on a missing artifact.
//
// Scope: phase 2 pilot shipped `composeInlinedContext` for static-key
// inlining. Phase 3.5 (#4924) adds the v2 surface — `composeUnitContext`
// — which also handles excerpts, computed artifacts, and prepended blocks.
// `composeInlinedContext` stays for backward compatibility with the
// already-migrated simple builders.
//
// ─── Composer boundary invariant (#4924) ─────────────────────────────────
//
// The composer is allowed to:
//   - order named sections per the manifest's declared sequence
//   - resolve registered artifacts (static / computed / excerpt / on-demand)
//   - apply typed policies (knowledge / memory / codebase-map / preferences)
//
// The composer must NOT grow:
//   - arbitrary conditionals on unit state
//   - loops over caller-supplied data
//   - string templating beyond section composition (join + separator)
//
// Logic that needs those belongs in a typed computed-artifact builder
// owned by the unit, not in the composer. Reviews must enforce this — it
// is the difference between an orchestrator and a runaway DSL.

import {
  resolveManifest,
  type ArtifactKey,
  type BaseResolverContext,
  type ComputedArtifactId,
  type ComputedArtifactRegistry,
  type UnitContextManifest,
} from "./unit-context-manifest.js";

/**
 * Async function mapping an artifact key to its inlined-content string,
 * or `null` when the artifact does not apply to the current milestone
 * (missing file, empty table, etc).
 */
export type ArtifactResolver = (key: ArtifactKey) => Promise<string | null>;

/**
 * Produce the inlined-context portion of a unit's system prompt by
 * walking the manifest's `artifacts.inline` list in order and calling
 * the provided resolver for each key.
 *
 * Returns an empty string when the unit type has no manifest registered,
 * so callers can guard their wiring with a simple truthy check. Unknown
 * unit types do not error — this mirrors `resolveManifest`'s contract.
 *
 * The separator between inlined blocks matches the in-tree convention
 * (`\n\n---\n\n`) so composer output slots into existing prompt templates
 * without visible diff.
 */
export async function composeInlinedContext(
  unitType: string,
  resolveArtifact: ArtifactResolver,
): Promise<string> {
  const manifest: UnitContextManifest | null = resolveManifest(unitType);
  if (!manifest) return "";

  const blocks: string[] = [];
  for (const key of manifest.artifacts.inline) {
    const body = await resolveArtifact(key);
    if (body !== null && body.length > 0) {
      blocks.push(body);
    }
  }
  return blocks.join("\n\n---\n\n");
}

/**
 * Convenience helper returning the manifest's declared budget so callers
 * can telemetry a mismatch between actual prompt size and declared budget.
 * Returns null for unknown unit types.
 */
export function manifestBudgetChars(unitType: string): number | null {
  const manifest = resolveManifest(unitType);
  return manifest ? manifest.maxSystemPromptChars : null;
}

// ─── v2 surface (#4924) ───────────────────────────────────────────────────

/**
 * Resolver for excerpt-class artifacts. Returns the compact block body
 * (per-unit excerpt rendering — e.g. `buildSliceSummaryExcerpt` for the
 * complete-milestone closer) or `null` to omit. Mirrors `ArtifactResolver`
 * shape so consumers can reuse the same registry pattern.
 */
export type ExcerptResolver = (key: ArtifactKey) => Promise<string | null>;

/**
 * Inputs to the v2 composer entrypoint. The base context is required;
 * each resolver/registry is optional and absent ones are treated as
 * "manifest declares no entries of that class for this unit."
 */
export interface ComposeUnitContextOptions {
  readonly base: BaseResolverContext;
  readonly resolveArtifact?: ArtifactResolver;
  readonly resolveExcerpt?: ExcerptResolver;
  readonly computed?: ComputedArtifactRegistry;
}

/**
 * Composer output. Kept structured (rather than a single joined string)
 * because some builders need to splice the prepend block above their own
 * preamble while keeping the main context block in its existing position.
 *
 * Both fields are joined with the in-tree `\n\n---\n\n` separator. Empty
 * string means "no content for this section" — callers branch on truthy
 * to decide whether to render any wrapper headers.
 */
export interface ComposedUnitContext {
  readonly prepend: string;
  readonly inline: string;
}

const SECTION_SEPARATOR = "\n\n---\n\n";

/**
 * Compose all manifest-declared context for a unit type using the v2
 * surface. Walks `prepend` first (computed-only), then the `inline` list
 * (static keys via `resolveArtifact`), then `excerpt` (via `resolveExcerpt`),
 * then `artifacts.computed` (via the typed registry). Order within each
 * section follows the manifest's declared sequence.
 *
 * Unknown unit types return empty strings for both sections — callers can
 * fall back to existing imperative wiring without a special case.
 *
 * Resolver / registry omissions: if the manifest declares an entry but no
 * resolver / registry entry is provided, the composer skips it silently.
 * This matches the v1 contract where a null body is a no-op, and lets
 * partial migrations land without forcing every consumer to register
 * every artifact class up-front.
 */
export async function composeUnitContext(
  unitType: string,
  opts: ComposeUnitContextOptions,
): Promise<ComposedUnitContext> {
  const manifest: UnitContextManifest | null = resolveManifest(unitType);
  if (!manifest) return { prepend: "", inline: "" };

  // Single-source `unitType`: the manifest is resolved against the
  // function arg, but computed builders read it from `base.unitType`.
  // If those ever diverge (caller passes one type to composeUnitContext
  // but a different one in opts.base), the composer would silently
  // mix one unit's manifest with another unit's computed context.
  // Normalize here so the composer dispatches a consistent identity
  // through to every builder.
  const normalizedOpts: ComposeUnitContextOptions = {
    ...opts,
    base: { ...opts.base, unitType },
  };

  const prependBlocks = await runComputed(manifest.prepend ?? [], normalizedOpts);
  const inlineBlocks: string[] = [];

  for (const key of manifest.artifacts.inline) {
    if (!normalizedOpts.resolveArtifact) break;
    const body = await normalizedOpts.resolveArtifact(key);
    if (body && body.length > 0) inlineBlocks.push(body);
  }
  for (const key of manifest.artifacts.excerpt) {
    if (!normalizedOpts.resolveExcerpt) break;
    const body = await normalizedOpts.resolveExcerpt(key);
    if (body && body.length > 0) inlineBlocks.push(body);
  }
  inlineBlocks.push(...await runComputed(manifest.artifacts.computed ?? [], normalizedOpts));

  return {
    prepend: prependBlocks.join(SECTION_SEPARATOR),
    inline: inlineBlocks.join(SECTION_SEPARATOR),
  };
}

/**
 * Invoke the registered builder for each declared computed id, in order.
 * Missing registry entries (manifest declares the id but caller didn't
 * register it) are skipped silently — see composeUnitContext rationale.
 */
async function runComputed(
  ids: readonly ComputedArtifactId[],
  opts: ComposeUnitContextOptions,
): Promise<string[]> {
  if (ids.length === 0 || !opts.computed) return [];
  // Type safety lives at the registration boundary (caller-supplied
  // `computed` is typed against ComputedArtifactInputs[K] per id). Inside
  // the composer we only dispatch — view the registry through a widened
  // local shape so the loop compiles when the registry is empty (which
  // it is in the v2-contract foundation PR before any computed ids are
  // registered, making `keyof ComputedArtifactInputs` resolve to `never`).
  type AnyEntry = {
    build: (inputs: unknown, base: BaseResolverContext) => Promise<string | null>;
    inputs: unknown;
  };
  const registry = opts.computed as Record<string, AnyEntry | undefined>;
  const out: string[] = [];
  for (const id of ids) {
    const entry = registry[id];
    if (!entry) continue;
    const body = await entry.build(entry.inputs, opts.base);
    if (body && body.length > 0) out.push(body);
  }
  return out;
}
