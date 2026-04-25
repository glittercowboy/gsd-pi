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
  "slice-context",
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

/**
 * Tool-access policy per unit type (#4934).
 *
 * Declarative-only in this PR — runtime enforcement (write-gate.ts predicate
 * + dispatch-time isolation) lands in follow-up PRs. The shape is the
 * agreement between manifest authors and enforcement; surfacing it now lets
 * reviewers ratify per-unit policy intent before any blocking logic ships.
 *
 * Modes:
 *   - "all"        — Read + Edit/Write/MultiEdit/NotebookEdit + Bash + Task.
 *                    The unit may modify any file in the working tree.
 *                    Reserved for execute-task / reactive-execute, which run
 *                    in worktrees today and whose writes are committed.
 *   - "read-only"  — Read tools only. No file mutation. No shell. No subagent
 *                    dispatch. Reserved for future units that should be
 *                    strictly observational (none today).
 *   - "planning"   — Read tools always; writes restricted to .gsd/** under
 *                    basePath; Bash limited to a per-unit safe allowlist;
 *                    Task subagent dispatch denied. Catches the bug class
 *                    where a discuss-milestone turn modifies user source
 *                    files (forensics: ~/Github/test-apps/b23, #4934).
 *   - "docs"       — Read tools always; writes restricted to .gsd/** AND
 *                    the explicit `allowedPathGlobs` set; Bash safe-allowlist;
 *                    no subagents. Reserved for rewrite-docs, which legitimately
 *                    edits project markdown outside .gsd/.
 *
 * The allowlist for "docs" is declared per-manifest rather than hardcoded so
 * projects with non-standard doc layouts can extend it without forking the
 * enforcement code (open question for the wiring PR — exact representation
 * may shift). Globs are interpreted relative to the project basePath.
 */
export type ToolsPolicy =
  | { readonly mode: "all" }
  | { readonly mode: "read-only" }
  | { readonly mode: "planning" }
  | { readonly mode: "docs"; readonly allowedPathGlobs: readonly string[] };

// ─── Computed-artifact registry (#4924 v2 contract) ───────────────────────

/**
 * Typed registry of computed-artifact ids → their per-call input shape.
 *
 * **This is the core anti-`extra: Record<string, unknown>` surface.** Each
 * computed block a unit may emit is registered here with an explicit input
 * type. Adding a new computed block requires extending this interface — a
 * deliberate, reviewable change rather than a silent ad-hoc field.
 *
 * Consumers extend via module augmentation if a downstream package needs to
 * register new computed ids (rare in-tree; no public API today). The repo's
 * own computed blocks are declared inline below.
 *
 * Invariant: the value type for each id MUST be a plain serializable shape.
 * No closures, no class instances, no `any`. If a builder needs framework
 * state, declare the specific fields it needs — don't smuggle objects.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ComputedArtifactInputs {
  // Phase 3.5 (v2 contract PR — #4924): no computed ids are registered yet.
  // Each follow-up batch (slice prompt, replan-slice, gate-evaluate, etc.)
  // adds the ids it needs as part of its migration commit.
  //
  // Example shape an upcoming batch will register:
  //   "slice-handoff-anchors": { sliceId: string; phase: string };
  //   "roadmap-excerpt":       { milestoneId: string; aroundSlice: string };
  //   "graph-subgraph":        { rootArtifact: ArtifactKey };
  //   "blocker-task-summary":  { sliceId: string };
  //   "overrides-banner":      { /* basePath via BaseResolverContext */ };
}

/** Stable string ids for registered computed artifacts. */
export type ComputedArtifactId = keyof ComputedArtifactInputs & string;

/**
 * Always-present context the composer hands every computed-artifact builder.
 * Carries unit-shape fields that don't belong in per-id input types because
 * every builder needs them (path resolution, dispatch identity).
 */
export interface BaseResolverContext {
  readonly unitType: string;
  readonly basePath: string;
  readonly milestoneId?: string;
  readonly sliceId?: string;
  readonly taskId?: string;
}

/**
 * Builder signature for one computed artifact id. Returns the rendered
 * block body (joined into the composed prompt at the manifest-declared
 * position) or `null` to omit the block entirely.
 */
export type ComputedArtifactBuilder<K extends ComputedArtifactId> = (
  inputs: ComputedArtifactInputs[K],
  base: BaseResolverContext,
) => Promise<string | null>;

/**
 * Per-call registry: for each computed id the manifest declares, the
 * caller supplies the matching builder + the input value for this call.
 *
 * Runtime shape: `{ [id]: { build, inputs } }`. Type narrowing per key is
 * handled inside the composer via the `ComputedArtifactInputs` map — calls
 * stay type-safe across the registration boundary.
 */
export type ComputedArtifactRegistry = {
  readonly [K in ComputedArtifactId]?: {
    readonly build: ComputedArtifactBuilder<K>;
    readonly inputs: ComputedArtifactInputs[K];
  };
};

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
  /**
   * Tool-access policy (#4934). Declarative in this PR; runtime enforcement
   * (path-scoped write blocking + subagent denial + bash allowlist) lands
   * in follow-ups. Required on every manifest so missing entries fail loud
   * via the CI invariant test rather than defaulting to "all" silently.
   */
  readonly tools: ToolsPolicy;
  /** Artifact handling: inline (full body), excerpt (compact), or on-demand (path only). */
  readonly artifacts: {
    readonly inline: readonly ArtifactKey[];
    readonly excerpt: readonly ArtifactKey[];
    readonly onDemand: readonly ArtifactKey[];
    /**
     * Ordered list of computed-block ids emitted in the inline position
     * (interleaved with `inline` in declared order — see composer for the
     * exact merge rule). v2 contract addition (#4924). Unknown ids fail
     * the manifest validator; absent registry entries are skipped silently.
     */
    readonly computed?: readonly ComputedArtifactId[];
  };
  /**
   * Ordered list of computed-block ids emitted ABOVE the main inlined
   * context block. Models the existing pattern of overrides / banners
   * that some builders prepend with `inlined.unshift(...)`. v2 contract
   * addition (#4924).
   */
  readonly prepend?: readonly ComputedArtifactId[];
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

// ─── Tool policy constants (#4934) ────────────────────────────────────────
// Reused across manifests so per-unit assignment stays declarative and the
// allowed-path set for the docs policy lives in one reviewable place.

const TOOLS_ALL: ToolsPolicy = { mode: "all" };
const TOOLS_PLANNING: ToolsPolicy = { mode: "planning" };
const TOOLS_DOCS: ToolsPolicy = {
  mode: "docs",
  // Globs are resolved relative to project basePath. The set is intentionally
  // narrow: top-level docs/, README, CHANGELOG, and any markdown at the
  // project root. Projects with non-standard layouts (e.g. mintlify-docs/)
  // will need this list extended in a follow-up; landed conservative now,
  // expand on demand.
  allowedPathGlobs: [
    "docs/**",
    "README.md",
    "README.*.md",
    "CHANGELOG.md",
    "*.md",
  ],
};

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
    tools: TOOLS_PLANNING,
    artifacts: {
      // Phase 3 migration (#4782): matches today's actual
      // buildResearchMilestonePrompt inlining order.
      inline: ["milestone-context", "project", "requirements", "decisions", "templates"],
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
    tools: TOOLS_PLANNING,
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
    tools: TOOLS_PLANNING,
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
    tools: TOOLS_PLANNING,
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
    tools: TOOLS_PLANNING,
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
    tools: TOOLS_PLANNING,
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
    tools: TOOLS_PLANNING,
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
    tools: TOOLS_PLANNING,
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
    tools: TOOLS_PLANNING,
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
    tools: TOOLS_PLANNING,
    artifacts: {
      // Phase 3 migration (#4782): matches today's actual
      // buildCompleteSlicePrompt inlining order. Overrides prepend +
      // knowledge splice stay in the builder imperatively (see RFC
      // #4924 — computed/prepend blocks are phase-4 composer work).
      inline: ["roadmap", "slice-context", "slice-plan", "requirements", "prior-task-summaries", "templates"],
      excerpt: [],
      onDemand: [],
    },
    maxSystemPromptChars: COMMON_BUDGET_LARGE,
  },
  "reassess-roadmap": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "critical-only",
    codebaseMap: false,
    preferences: "none",
    tools: TOOLS_PLANNING,
    artifacts: {
      // Phase 2 pilot (#4782): manifest now matches today's actual
      // buildReassessRoadmapPrompt behavior for equivalence. Phase 3
      // will tighten this list once the composer reports real telemetry.
      inline: ["roadmap", "slice-context", "slice-summary", "project", "requirements", "decisions"],
      excerpt: [],
      onDemand: [],
    },
    maxSystemPromptChars: COMMON_BUDGET_MEDIUM,
  },

  // ─── Task-scoped ─────────────────────────────────────────────────────
  "execute-task": {
    skills: { mode: "all" },
    knowledge: "scoped",
    memory: "prompt-relevant",
    codebaseMap: true,
    preferences: "active-only",
    tools: TOOLS_ALL,
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
    tools: TOOLS_ALL,
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
    tools: TOOLS_PLANNING,
    artifacts: {
      // Phase 3 migration (#4782): manifest matches today's actual
      // buildRunUatPrompt inlining. Prior phase-1 entry listed
      // `slice-plan` aspirationally — the real builder inlines the UAT
      // file, the slice SUMMARY (optional), and the project row.
      inline: ["slice-uat", "slice-summary", "project"],
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
    tools: TOOLS_PLANNING,
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
    tools: TOOLS_DOCS,
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
