// GSD-2 — UnitContextManifest (#4782 phase 1).
//
// Declarative description of what context each auto-mode unit type needs
// in its system prompt. Establishes the contract that later phases will
// use to drive a single composeSystemPromptForUnit() — replacing the
// per-unit-type branching currently spread across `auto-prompts.ts`.
//
// **Phase 1 ships the type + the data + a CI coverage guard.** It adds
// zero wiring — no caller reads a manifest yet. Every unit type gets a
// manifest that describes today's behavior as faithfully as possible, so
// when the composer lands in phase 2 the migration can proceed manifest-
// by-manifest without behavior change.
//
// Phased rollout tracking:
//   - Phase 1 (this PR): schema + manifests + coverage test.
//   - Phase 2: add composeSystemPromptForUnit(); migrate one low-risk
//     unit type (e.g. reassess-roadmap) as the pilot.
//   - Phase 3: migrate remaining unit types, tighten manifests per
//     empirical usage, introduce skipWhen predicates absorbing the
//     reassess opt-in gate from #4778.
//   - Phase 4: introduce pipeline variants as declared sequences,
//     absorbing the scope-classifier gates from #4781.
//
// Naming:
//   - Artifact keys are STABLE strings (not paths). Path resolution is
//     the composer's job; manifests describe intent, not disk layout.
//   - Char budgets are nominal — blown budgets log a telemetry event,
//     they do not truncate or error (the composer decides fallback).

// ─── Artifact registry ────────────────────────────────────────────────────

/**
 * Stable identifiers for every artifact class a unit might inline, excerpt,
 * or reference on-demand. Adding a new artifact class requires (a) a key
 * here, (b) path/body resolution in the composer, and (c) updates to any
 * manifest that should surface it.
 */
export const ARTIFACT_KEYS = [
  // Milestone-scoped
  "roadmap",
  "milestone-context",
  "milestone-summary",
  "milestone-validation",
  "milestone-research",
  "milestone-plan",
  // Slice-scoped
  "slice-research",
  "slice-plan",
  "slice-summary",
  "slice-uat",
  "slice-assessment",
  // Task-scoped
  "task-plan",
  "task-summary",
  "prior-task-summaries",
  "dependency-summaries",
  // Project-scoped
  "requirements",
  "decisions",
  "project",
  "templates",
] as const;

export type ArtifactKey = typeof ARTIFACT_KEYS[number];

// ─── Policy types ─────────────────────────────────────────────────────────

/**
 * Skill catalog policy. `all` preserves today's default: the full catalog
 * is stamped into the prompt. `allowlist` narrows to the named skills.
 * `none` suppresses the catalog entirely.
 *
 * The allowlist mode pairs with `skill-manifest.ts` (#4779) — entries
 * there are the source of truth for "which skills are dispatched for a
 * unit type"; this manifest carries the policy shape so the composer
 * can unify the two surfaces in phase 2.
 */
export type SkillsPolicy =
  | { readonly mode: "none" }
  | { readonly mode: "all" }
  | { readonly mode: "allowlist"; readonly skills: readonly string[] };

/** Knowledge block policy — see `bootstrap/system-context.ts` loadKnowledgeBlock. */
export type KnowledgePolicy = "none" | "critical-only" | "scoped" | "full";

/** Memory store policy — see `bootstrap/system-context.ts` loadMemoryBlock. */
export type MemoryPolicy = "none" | "critical-only" | "prompt-relevant";

/** Preferences block policy. */
export type PreferencesPolicy = "none" | "active-only" | "full";

// ─── Manifest ─────────────────────────────────────────────────────────────

export interface UnitContextManifest {
  /** Skills catalog shape to surface. */
  readonly skills: SkillsPolicy;
  /** Knowledge block policy. */
  readonly knowledge: KnowledgePolicy;
  /** Memory store policy. */
  readonly memory: MemoryPolicy;
  /** Whether CODEBASE.md is inlined. */
  readonly codebaseMap: boolean;
  /** Preferences block policy. */
  readonly preferences: PreferencesPolicy;
  /** Artifact handling: inline (full body), excerpt (compact), or on-demand (path only). */
  readonly artifacts: {
    readonly inline: readonly ArtifactKey[];
    readonly excerpt: readonly ArtifactKey[];
    readonly onDemand: readonly ArtifactKey[];
  };
  /**
   * Nominal upper bound for composer-generated system prompt size, in
   * characters. Phase 2 composer logs telemetry when a unit exceeds its
   * budget; truncation is not enforced. Set conservatively — today's
   * observed maxima come from `complete-milestone` (~1.2M tokens cached;
   * ~4.8M chars) and `validate-milestone` (~300K tokens; ~1.2M chars).
   */
  readonly maxSystemPromptChars: number;
}

// ─── Manifests ────────────────────────────────────────────────────────────

// Phase 1 policy: every manifest encodes today's behavior. Skills = "all"
// unless the unit type was already narrowed via the existing skill-manifest
// resolver (#4779). Memory/knowledge policies reflect the defaults in
// `bootstrap/system-context.ts`. Artifact classifications follow what
// `auto-prompts.ts` inlines today for each unit type.

const COMMON_BUDGET_LARGE = 1_500_000;  // ~400K tokens
const COMMON_BUDGET_MEDIUM = 750_000;   // ~200K tokens
const COMMON_BUDGET_SMALL = 250_000;    // ~65K tokens

/**
 * Canonical unit types handled by auto-mode dispatch. The coverage test
 * enumerates these against `UNIT_MANIFESTS` to catch manifest drift when
 * a new unit type lands.
 */
export const KNOWN_UNIT_TYPES = [
  "research-milestone",
  "plan-milestone",
  "discuss-milestone",
  "validate-milestone",
  "complete-milestone",
  "research-slice",
  "plan-slice",
  "refine-slice",
  "replan-slice",
  "complete-slice",
  "reassess-roadmap",
  "execute-task",
  "reactive-execute",
  "run-uat",
  "gate-evaluate",
  "rewrite-docs",
] as const;

export type UnitType = typeof KNOWN_UNIT_TYPES[number];

export const UNIT_MANIFESTS: Record<UnitType, UnitContextManifest> = {
  // ─── Milestone-scoped ────────────────────────────────────────────────
  "research-milestone": {
    skills: { mode: "all" },
    knowledge: "full",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    artifacts: {
      inline: ["project", "requirements", "decisions", "templates"],
      excerpt: [],
      onDemand: [],
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM,
  },
  "plan-milestone": {
    skills: { mode: "all" },
    knowledge: "full",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    artifacts: {
      inline: ["project", "requirements", "decisions", "milestone-research", "templates"],
      excerpt: [],
      onDemand: [],
    },
    maxSystemPromptChars: COMMON_BUDGET_LARGE,
  },
  "discuss-milestone": {
    skills: { mode: "all" },
    knowledge: "full",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    artifacts: {
      inline: ["project", "requirements", "decisions", "milestone-context", "templates"],
      excerpt: [],
      onDemand: [],
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM,
  },
  "validate-milestone": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: false,
    preferences: "active-only",
    artifacts: {
      inline: ["roadmap", "slice-summary", "slice-uat", "requirements", "decisions", "templates"],
      excerpt: [],
      onDemand: [],
    },
    maxSystemPromptChars: COMMON_BUDGET_LARGE,
  },
  "complete-milestone": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: false,
    preferences: "active-only",
    artifacts: {
      // #4780 landed slice-summary as excerpt for this unit; phase 2 of
      // the architecture will read this manifest as the source of truth
      // and retire the special-case wiring in auto-prompts.ts.
      inline: ["roadmap", "milestone-context", "requirements", "decisions", "project", "templates"],
      excerpt: ["slice-summary"],
      onDemand: ["slice-summary"],
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM,
  },

  // ─── Slice-scoped ────────────────────────────────────────────────────
  "research-slice": {
    skills: { mode: "all" },
    knowledge: "full",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    artifacts: {
      inline: ["roadmap", "milestone-research", "dependency-summaries", "templates"],
      excerpt: [],
      onDemand: [],
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM,
  },
  "plan-slice": {
    skills: { mode: "all" },
    knowledge: "full",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    artifacts: {
      inline: ["roadmap", "slice-research", "dependency-summaries", "requirements", "decisions", "templates"],
      excerpt: [],
      onDemand: [],
    },
    maxSystemPromptChars: COMMON_BUDGET_LARGE,
  },
  "refine-slice": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    artifacts: {
      inline: ["slice-plan", "slice-research", "dependency-summaries", "templates"],
      excerpt: [],
      onDemand: [],
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM,
  },
  "replan-slice": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    artifacts: {
      inline: ["slice-plan", "slice-research", "dependency-summaries", "prior-task-summaries", "templates"],
      excerpt: [],
      onDemand: [],
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM,
  },
  "complete-slice": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: false,
    preferences: "active-only",
    artifacts: {
      inline: ["slice-plan", "slice-research", "prior-task-summaries", "requirements", "templates"],
      excerpt: [],
      onDemand: [],
    },
    maxSystemPromptChars: COMMON_BUDGET_LARGE,
  },
  "reassess-roadmap": {
    skills: { mode: "all" },
    knowledge: "critical-only",
    memory: "critical-only",
    codebaseMap: false,
    preferences: "none",
    artifacts: {
      inline: ["roadmap", "slice-summary"],
      excerpt: [],
      onDemand: [],
    },
    maxSystemPromptChars: COMMON_BUDGET_SMALL,
  },

  // ─── Task-scoped ─────────────────────────────────────────────────────
  "execute-task": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    artifacts: {
      inline: ["task-plan", "slice-plan", "prior-task-summaries", "templates"],
      excerpt: [],
      onDemand: ["slice-research"],
    },
    maxSystemPromptChars: COMMON_BUDGET_LARGE,
  },
  "reactive-execute": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    artifacts: {
      inline: ["slice-plan", "prior-task-summaries", "templates"],
      excerpt: [],
      onDemand: ["slice-research"],
    },
    maxSystemPromptChars: COMMON_BUDGET_LARGE,
  },

  // ─── Ancillary units ─────────────────────────────────────────────────
  "run-uat": {
    skills: { mode: "all" },
    knowledge: "critical-only",
    memory: "critical-only",
    codebaseMap: false,
    preferences: "active-only",
    artifacts: {
      inline: ["slice-uat", "slice-plan"],
      excerpt: [],
      onDemand: [],
    },
    maxSystemPromptChars: COMMON_BUDGET_SMALL,
  },
  "gate-evaluate": {
    skills: { mode: "all" },
    knowledge: "critical-only",
    memory: "critical-only",
    codebaseMap: false,
    preferences: "active-only",
    artifacts: {
      inline: ["slice-plan", "prior-task-summaries"],
      excerpt: [],
      onDemand: [],
    },
    maxSystemPromptChars: COMMON_BUDGET_SMALL,
  },
  "rewrite-docs": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    artifacts: {
      inline: ["project", "requirements", "decisions", "templates"],
      excerpt: [],
      onDemand: [],
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM,
  },
};

// ─── Lookup helper ────────────────────────────────────────────────────────

/**
 * Return the manifest for a unit type, or null when the type is unknown.
 *
 * Callers MUST treat null as "fall through to today's default behavior"
 * rather than erroring — unknown unit types may be experimental and
 * should not crash the composer.
 */
export function resolveManifest(unitType: string): UnitContextManifest | null {
  return (UNIT_MANIFESTS as Record<string, UnitContextManifest>)[unitType] ?? null;
}
