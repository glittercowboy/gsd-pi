# Plan: Onboarding, Detection & Init Wizard

> **Status**: Phase 1 (Detection), Phase 3 (Init Wizard), Phase 4 (Integration), Phase 5 (Tests) — IMPLEMENTED
> **Branch**: `feature/onboarding-detection-wizard`
> **Phase 2 (Global Setup refactor)**: Deferred — `/gsd setup` provides routing to existing commands for now

## Problem Statement

GSD currently has two disconnected onboarding paths:

1. **App onboarding** (`onboarding.ts`) — pre-TUI, only handles LLM/tool auth. Runs once ever, no project awareness.
2. **Project bootstrap** (`showSmartEntry()`) — silently creates `.gsd/` and drops you into the discuss prompt with zero explanation.

Neither detects v1 `.planning/` directories, explains what GSD is, offers project-level configuration, or helps returning users entering a new folder.

## Design Decisions

### Q1: Should bare `/gsd` show a menu or auto-start?

**Answer: Contextual behavior based on detection.**

| Detected State | Behavior |
|---|---|
| No `.gsd/`, no `.planning/` | **Init Wizard** (new project onboarding) |
| No `.gsd/`, has `.planning/` | **Migration offer** → `/gsd migrate` or skip |
| Has `.gsd/`, no milestones | Current flow (discuss prompt) |
| Has `.gsd/`, has milestones | Current flow (smart entry / auto resume) |
| First-ever GSD launch (no `~/.gsd/`) | **Global setup** first, then project init |

### Q2: Should there be an onboarding wizard?

**Answer: Yes — two-tier wizard.**

- **Global wizard** (`/gsd setup`) — runs once per machine. Handles: LLM auth (absorb current `onboarding.ts`), global preferences (default model, mode, timeout defaults), tool keys, remote questions.
- **Project wizard** (`/gsd init`) — runs once per project folder. Handles: project-type detection, preferences template, git init, `.gitignore`, optional CONTEXT.md seeding.

Both wizards should be:
- Skippable at every step
- Re-runnable (`/gsd setup` and `/gsd init` work any time)
- Non-blocking (sensible defaults if skipped entirely)

---

## Architecture

### New File: `src/resources/extensions/gsd/init-wizard.ts`

Project-level init wizard. Responsible for the interactive experience when entering a new folder.

### New File: `src/resources/extensions/gsd/detection.ts`

Pure detection functions. No UI, no side effects.

### Modified: `src/resources/extensions/gsd/guided-flow.ts`

`showSmartEntry()` gains a detection preamble before the current logic.

### Modified: `src/resources/extensions/gsd/commands.ts`

New subcommands: `/gsd init`, `/gsd setup`. Existing `/gsd migrate` stays.

### Modified: `src/onboarding.ts`

Refactored to be callable from both pre-TUI boot and `/gsd setup`.

---

## Phase 1: Detection Engine (`detection.ts`)

Pure functions, zero UI dependencies.

### Task 1.1: `detectProjectState(basePath: string): ProjectDetection`

```typescript
interface ProjectDetection {
  /** What kind of GSD state exists */
  state: 'none' | 'v1-planning' | 'v2-gsd' | 'v2-gsd-empty';

  /** Is this the first time GSD has been used on this machine? */
  isFirstEverLaunch: boolean;

  /** Does ~/.gsd/ exist with preferences? */
  hasGlobalSetup: boolean;

  /** v1 details (if state === 'v1-planning') */
  v1?: {
    path: string;
    hasPhasesDir: boolean;
    hasRoadmap: boolean;
    phaseCount: number;
  };

  /** v2 details (if state === 'v2-gsd' or 'v2-gsd-empty') */
  v2?: {
    milestoneCount: number;
    hasPreferences: boolean;
    hasContext: boolean;
  };

  /** Detected project ecosystem signals */
  projectSignals: ProjectSignals;
}

interface ProjectSignals {
  /** Detected package managers / project files */
  detectedFiles: string[];  // e.g. ['package.json', 'Cargo.toml', 'go.mod']
  /** Is this a git repo already? */
  isGitRepo: boolean;
  /** Is this a monorepo? (workspaces, lerna, nx, turborepo) */
  isMonorepo: boolean;
  /** Primary language hint */
  primaryLanguage?: string;
  /** Has existing CI? */
  hasCI: boolean;
  /** Has existing tests? */
  hasTests: boolean;
}
```

### Task 1.2: `detectV1Planning(basePath: string): V1Detection | null`

Checks for `.planning/` directory with v1 markers:
- `ROADMAP.md`, `PROJECT.md`, `REQUIREMENTS.md`, `STATE.md`
- `phases/` directory with numbered phases
- Returns null if no `.planning/` found

### Task 1.3: `detectProjectSignals(basePath: string): ProjectSignals`

Quick filesystem scan (no heavy reads):
- Check for `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `Gemfile`, etc.
- Check for monorepo markers (`workspaces` in package.json, `lerna.json`, `nx.json`, `turbo.json`, `pnpm-workspace.yaml`)
- Check for `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`
- Check for test directories (`__tests__`, `tests/`, `test/`, `spec/`)

### Task 1.4: `isFirstEverLaunch(): boolean`

Returns `true` if `~/.gsd/` doesn't exist or has no `PREFERENCES.md`.

---

## Phase 2: Global Setup Wizard (`/gsd setup`)

Absorbs and extends current `onboarding.ts` functionality.

### Task 2.1: Refactor `onboarding.ts` into composable steps

Extract each step into a standalone async function that can be called from:
- Pre-TUI boot (current behavior)
- `/gsd setup` command (new)

Steps become:
- `runLlmSetupStep()` — already exists, just needs export
- `runWebSearchStep()` — already exists
- `runRemoteQuestionsStep()` — already exists
- `runToolKeysStep()` — already exists
- **NEW** `runGlobalPreferencesStep()` — default mode (solo/team), default model routing, timeout defaults

### Task 2.2: `/gsd setup` command handler

```
/gsd setup          → full wizard (all steps)
/gsd setup llm      → just LLM auth
/gsd setup search   → just web search
/gsd setup remote   → just remote questions
/gsd setup keys     → just tool keys
/gsd setup prefs    → just global preferences
```

Shows a summary dashboard at the end:
```
┌ Global Setup ─────────────────────────────────┐
│                                               │
│  ✓ LLM: Anthropic (Claude)                   │
│  ✓ Web search: Brave Search                  │
│  ✓ Remote questions: Discord #gsd-bot        │
│  ✓ Tool keys: 2/3 configured                 │
│  ✓ Preferences: solo mode, Sonnet default    │
│                                               │
└───────────────────────────────────────────────┘
```

### Task 2.3: Pre-TUI boot integration

Modify `shouldRunOnboarding()` to also check `isFirstEverLaunch()`.
When it runs, use the refactored steps so the experience is identical.

---

## Phase 3: Project Init Wizard (`/gsd init`)

### Per-Project Preferences Strategy

Not all preferences belong in the init wizard. The filter: **"What would you regret not setting before your first milestone?"**

#### Tier 1: Ask in init wizard (high impact, easy to answer)

| Pref | Why at init time | Default |
|------|-----------------|---------|
| **`mode`** (solo / team) | Changes git strategy, merge behavior, everything downstream. Wrong default = friction on every milestone. | `solo` |
| **`git.commit_docs`** | Whether `.gsd/` plans get committed to git. Team projects usually want `true`, throwaway prototypes want `false`. Affects the very first commit. | `true` |
| **`git.isolation`** (worktree / branch / none) | Worktree isolation fails in some setups (submodules, shallow clones). Better to detect + ask upfront than crash during first auto run. | `worktree` |
| **`verification_commands`** | "How do we verify code works?" — e.g. `npm test`, `cargo test`, `make check`. Auto-detected from project signals (package.json scripts, Makefile, etc.) and confirmed. Critical for auto-mode to actually validate work. | `[]` (auto-detect) |
| **`custom_instructions`** | Project-specific rules the LLM should follow. E.g. "use Tailwind, not CSS modules", "always write tests", "this is a monorepo, only touch packages/api". First milestone benefits hugely from these. | `[]` |

#### Tier 2: Show but default-skip (power users, "Advanced" expandable section)

| Pref | Why offer but not push | Default |
|------|----------------------|---------|
| **`token_profile`** (budget / balanced / quality) | Cost-conscious users want to set this early, but `balanced` works fine for most. | `balanced` |
| **`phases.skip_research`** | Small projects don't need a research phase. Detectable from project signals (tiny repo = suggest skipping). | `false` |
| **`git.main_branch`** | Usually `main` or `master` — auto-detected from git, confirm only if ambiguous. | auto-detect |
| **`git.auto_push`** | Whether auto-mode pushes after merging. Solo users usually want this; team users may want PR review first. | `true` (solo) / `false` (team) |

#### Tier 3: Don't ask at init (defer to `/gsd prefs project`)

| Pref | Why defer |
|------|----------|
| `models` (per-phase model config) | Complex, per-phase config. Global default is fine to start. |
| `auto_supervisor` (timeouts) | Needs experience with the tool to calibrate. |
| `budget_ceiling` / `budget_enforcement` | Users don't know their budget on a new project. |
| `notifications` | Defaults work fine. |
| `skill_rules` / `always_use_skills` / `avoid_skills` | Too advanced for init — needs milestone experience first. |
| `post_unit_hooks` / `pre_dispatch_hooks` | Power-user territory. |
| `dynamic_routing` | Requires understanding model routing. |
| `parallel` (workers, merge strategy) | Needs milestones defined first. |
| `unique_milestone_ids` | Niche preference. |
| `uat_dispatch` | Niche. |
| `remote_questions` | Already handled in global setup. |
| `context_pause_threshold` | Internal tuning, not user-facing at init. |
| `skill_discovery` / `skill_staleness_days` | Defaults are sensible. |
| `auto_visualize` / `auto_report` | Nice-to-have, defaults fine. |

### Verification Command Auto-Detection

The wizard auto-populates `verification_commands` from project signals:

| Signal | Suggested command |
|--------|------------------|
| `package.json` with `scripts.test` | `npm test` (or `pnpm test` / `yarn test` if lockfile detected) |
| `package.json` with `scripts.build` | `npm run build` |
| `package.json` with `scripts.lint` | `npm run lint` |
| `package.json` with `scripts.typecheck` or `scripts.tsc` | `npm run typecheck` |
| `Cargo.toml` | `cargo test`, `cargo clippy` |
| `go.mod` | `go test ./...`, `go vet ./...` |
| `pyproject.toml` or `setup.py` | `pytest` or `python -m pytest` |
| `Makefile` with `test` target | `make test` |
| `Gemfile` | `bundle exec rspec` or `bundle exec rake test` |
| `.github/workflows/*.yml` | Parse for test commands (informational, not auto-added) |

User sees: "I detected these verification commands — confirm, edit, or add more."

### Task 3.1: `showProjectInit()` — the main wizard

Flow:
```
Step 1: Detection scan (automatic, instant, no prompt)
   ├─ v1 .planning/ found? → Offer migration (Task 3.2)
   ├─ .gsd/ already exists? → Re-init safety (Task 3.3)
   └─ Clean folder → Continue to step 2

Step 2: Project Recognition (informational, no prompt needed)
   "Detected: Node.js monorepo, 3 packages, Jest tests, GitHub Actions CI"
   → Displayed as context, saved to CONTEXT.md seed

Step 3: Git Setup
   ├─ Already a git repo? → Auto-detect main branch, skip init
   └─ Not a git repo → "Initialize git?" (default: yes)

Step 4: Mode Selection
   "How are you working on this project?"
   > Solo (just me)              ← default
     Team (multiple contributors)

Step 5: Verification Commands (auto-populated from detection)
   "How should GSD verify code changes?"
   > npm test                    ← auto-detected from package.json
     npm run build               ← auto-detected
     Add more commands...
     Skip verification

Step 6: Git Preferences
   "Git settings for this project:"
     Commit .gsd/ plans to git?  [Y/n]         ← default yes
     Isolation strategy:         [worktree]     ← default, warn if submodules
     Main branch:                [main]         ← auto-detected, confirm if ambiguous

Step 7: Project Instructions (optional, skippable)
   "Any rules GSD should follow for this project?"
   > (text input, multi-line or one-liner)
   e.g. "Use TypeScript strict mode", "Follow existing patterns in src/"
   Hint: "These become custom_instructions in your project preferences"

Step 8: Advanced (collapsed by default, expandable)
   "Advanced settings (press Enter to skip):"
     Token profile:     [balanced] / budget / quality
     Skip research?     [no] / yes
     Auto-push on merge? [yes] / no

Step 9: Bootstrap .gsd/ structure
   - Creates .gsd/milestones/
   - Creates .gsd/PREFERENCES.md (from wizard answers)
   - Creates .gitignore entries
   - Seeds CONTEXT.md with detected project signals
   - Commits "chore: init gsd" (if commit_docs enabled)

Step 10: Transition
   → Auto-transition to discuss prompt for first milestone
   (Fluid experience — wizard flows directly into "tell me about your project")
```

### Task 3.2: v1 migration detection + offer

When `.planning/` is detected in `showSmartEntry()`:

```
┌ GSD — Legacy Project Detected ────────────────┐
│                                               │
│  Found .planning/ directory (GSD v1 format)   │
│  3 phases, 12 tasks detected                  │
│                                               │
│  > Migrate to GSD v2    (recommended)         │
│    Start fresh                                │
│    Cancel                                     │
│                                               │
└───────────────────────────────────────────────┘
```

"Migrate" → delegates to existing `handleMigrate()` pipeline.
"Start fresh" → runs the normal init wizard, ignoring `.planning/`.

### Task 3.3: Re-init safety

If `.gsd/` already exists when `/gsd init` is run:
- Show current state (X milestones, Y slices)
- Offer: "Reset preferences" / "Re-run project detection" / "Cancel"
- Never destructively delete milestones via init

---

## Phase 4: Smart Entry Integration

### Task 4.1: Update `showSmartEntry()` detection preamble

Before the current logic, add:

```typescript
const detection = detectProjectState(basePath);

// First-ever launch — run global setup first
if (detection.isFirstEverLaunch) {
  await showGlobalSetupWizard(ctx);
}

// v1 detected, no v2 — offer migration
if (detection.state === 'v1-planning') {
  const choice = await offerMigration(ctx, detection.v1!);
  if (choice === 'migrate') {
    await handleMigrate('', ctx, pi);
    return;
  }
  // 'fresh' falls through to normal init
}

// No .gsd/ — run project init wizard
if (detection.state === 'none') {
  await showProjectInit(ctx, pi, basePath, detection);
  return;
}

// Existing .gsd/ — current logic continues unchanged
```

### Task 4.2: Preserve zero-friction for returning users

The detection + init wizard only triggers when `.gsd/` doesn't exist.
Once `.gsd/` exists, the flow is identical to today — no regressions.

---

## Phase 5: Tests

### Task 5.1: Detection engine tests

- `detectProjectState()` with various folder layouts
- `detectV1Planning()` with real and fake `.planning/` dirs
- `detectProjectSignals()` with different project types
- `isFirstEverLaunch()` with/without `~/.gsd/`

### Task 5.2: Init wizard integration tests

- New folder → wizard triggers → `.gsd/` created correctly
- v1 folder → migration offer shown
- Existing `.gsd/` → wizard skipped, normal flow
- Re-run `/gsd init` on existing project → safe behavior

### Task 5.3: Global setup tests

- `/gsd setup` from command handler
- Individual sub-steps (`/gsd setup llm`, etc.)
- Pre-TUI boot still works with refactored steps

---

## File Inventory

| File | Action | Purpose |
|------|--------|---------|
| `src/resources/extensions/gsd/detection.ts` | **NEW** | Pure detection functions |
| `src/resources/extensions/gsd/init-wizard.ts` | **NEW** | Project init wizard UI |
| `src/resources/extensions/gsd/global-setup.ts` | **NEW** | Global setup wizard (refactored from onboarding.ts) |
| `src/onboarding.ts` | **MODIFY** | Delegate to global-setup.ts, keep boot integration |
| `src/resources/extensions/gsd/guided-flow.ts` | **MODIFY** | Add detection preamble to showSmartEntry() |
| `src/resources/extensions/gsd/commands.ts` | **MODIFY** | Add `/gsd init` and `/gsd setup` subcommands |
| Tests (TBD paths) | **NEW** | Detection, init, setup tests |

## Open Questions for Discussion

1. **Should `/gsd init` auto-transition to the discuss prompt?** Or end with "Run /gsd to start"? Auto-transition is more fluid but might feel jarring after a wizard.

2. **Should project signals (detected language, CI, etc.) be persisted?** They're useful context for the discuss prompt but could go stale. Option: seed into CONTEXT.md as a starting point the user can edit.

3. **Should `/gsd setup` be accessible outside the TUI?** e.g. `gsd setup` from the shell before launching. Currently `onboarding.ts` handles this but it's limited.

4. **Migration: should we auto-detect `.planning/` in parent directories?** Some users might run GSD from a subdirectory while `.planning/` is at the repo root.

## Estimated Scope

- **3 new files**, ~400-600 lines total
- **3 modified files**, ~50-80 lines of changes
- **Test files**, ~200-300 lines
- No breaking changes to existing behavior
