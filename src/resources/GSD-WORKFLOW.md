# GSD Workflow — Manual Bootstrap Protocol

> This document teaches you how to operate the GSD planning methodology manually using files on disk.
>
> **When to read this:** At the start of any session working on GSD-managed work, or when loaded by `/gsd`.
>
> **After reading this, always read `.gsd/STATE.md` to find out what's next.**
> If the milestone has a `M###-CONTEXT.md`, read that too. If the active slice has an `S##-CONTEXT.md`, read that as well — these files contain project-specific decisions, reference paths, and implementation guidance that this generic methodology doc does not.

---

## Quick Start: "What's next?"

Read these files in order and act on what they say:

1. **`.gsd/STATE.md`** — Where are we? What's the next action?
2. **`.gsd/milestones/<active>/M###-ROADMAP.md`** — What's the plan? Which slices are done? (`STATE.md` tells you which milestone is active)
3. **`.gsd/milestones/<active>/M###-CONTEXT.md`** — Milestone-level project decisions, reference paths, constraints. Read this before doing implementation work.
4. If a slice is active and has one, read **`S##-CONTEXT.md`** — Slice-specific decisions and constraints.
5. If a slice is active, read its **`S##-PLAN.md`** — Which tasks exist? Which are done?
6. If `.gsd/CODEBASE.md` exists, skim it for fast structural orientation before broad code exploration.
7. If a task was interrupted, check for **`continue.md`** in the active slice directory — Resume from there.

Then do the thing `STATE.md` says to do next.

---

## The Hierarchy

```
Milestone  →  a shippable version (4-10 slices)
  Slice    →  one demoable vertical capability (1-7 tasks)
    Task   →  one context-window-sized unit of work (fits in one session)
```

**The iron rule:** A task MUST fit in one context window. If it can't, it's two tasks.

---

## File Locations

All artifacts live in `.gsd/` at the project root:

```
.gsd/
  STATE.md                                  # Dashboard — always read first (derived cache; runtime, gitignored)
  DECISIONS.md                              # Append-only decisions register
  CODEBASE.md                               # Generated codebase map cache (auto-refreshed by GSD)
  milestones/
    M001/
      M001-ROADMAP.md                       # Milestone plan (checkboxes = state)
      M001-CONTEXT.md                       # Optional: user decisions from discuss phase
      M001-RESEARCH.md                      # Optional: codebase/tech research
      M001-SUMMARY.md                       # Milestone rollup (updated as slices complete)
      slices/
        S01/
          S01-PLAN.md                       # Task decomposition for this slice
          S01-CONTEXT.md                    # Optional: slice-level user decisions
          S01-RESEARCH.md                   # Optional: slice-level research
          S01-SUMMARY.md                    # Slice summary (written on completion)
          S01-UAT.md                        # Non-blocking human test script (written on completion)
          continue.md                       # Ephemeral: resume point if interrupted
          tasks/
            T01-PLAN.md                     # Individual task plan
            T01-SUMMARY.md                  # Task summary with frontmatter
```

---

## File Format Reference

### `M###-ROADMAP.md`

```markdown
# M001: Title of the Milestone

**Vision:** One paragraph describing what this milestone delivers.

**Success Criteria:**
- Observable outcome 1
- Observable outcome 2

---

## Slices

- [ ] **S01: Slice Title** `risk:low` `depends:[]`
  > After this: what the user can demo when this slice is done.

- [ ] **S02: Another Slice** `risk:medium` `depends:[S01]`
  > After this: demo sentence.

- [x] **S03: Completed Slice** `risk:low` `depends:[S01]`
  > After this: demo sentence.
```

**Parsing rules:** `- [x]` = done, `- [ ]` = not done. The `risk:` and `depends:[]` tags are inline metadata parsed from the line. `depends:[]` lists slice IDs this slice requires to be complete first.

**Boundary Map** (required section in M###-ROADMAP.md):

After the slices section, include a `## Boundary Map` that shows what each slice produces and consumes:

```markdown
## Boundary Map

### S01 → S02
Produces:
  types.ts → User, Session, AuthToken (interfaces)
  auth.ts  → generateToken(), verifyToken(), refreshToken()

Consumes: nothing (leaf node)

### S02 → S03
Produces:
  api/auth/login.ts  → POST handler
  api/auth/signup.ts → POST handler
  middleware.ts       → authMiddleware()

Consumes from S01:
  auth.ts → generateToken(), verifyToken()
```

The boundary map is a **planning artifact** — not runnable code. It:
- Forces upfront thinking about slice boundaries before implementation
- Gives downstream slices a concrete target to code against
- Enables deterministic verification that slices actually connect
- Gets updated during slice planning if new interfaces emerge

### `S##-PLAN.md` (slice-level)

```markdown
# S01: Slice Title

**Goal:** What this slice achieves.
**Demo:** What the user can see/do when this is done.

## Must-Haves
- Observable outcome 1 (used for verification)
- Observable outcome 2

## Tasks

- [ ] **T01: Task Title**
  Description of what this task does.
  
- [ ] **T02: Another Task**
  Description.

## Files Likely Touched
- path/to/file.ts
- path/to/another.ts
```

### `T##-PLAN.md` (task-level)

```markdown
# T01: Task Title

**Slice:** S01
**Milestone:** M001

## Goal
What this task accomplishes in one sentence.

## Must-Haves

### Truths
Observable behaviors that must be true when this task is done:
- "User can sign up with email and password"
- "Login returns a JWT token"

### Artifacts
Files that must exist with real implementation (not stubs):
- `src/lib/auth.ts` — JWT helpers (min 30 lines, exports: generateToken, verifyToken)
- `src/app/api/auth/login/route.ts` — Login endpoint (exports: POST)

### Key Links
Critical wiring between artifacts:
- `login/route.ts` → `auth.ts` via import of `generateToken`
- `middleware.ts` → `auth.ts` via import of `verifyToken`

## Steps
1. First thing to do
2. Second thing to do
3. Third thing to do

## Context
- Relevant prior decisions or patterns to follow
- Key files to read before starting
```

**Must-haves are what make verification mechanically checkable.** Truths are checked by running commands or reading output. Artifacts are checked by confirming files exist with real content. Key links are checked by confirming imports/references actually connect the pieces.

### `STATE.md`

```markdown
# GSD State

**Active Milestone:** M001 — Title
**Active Slice:** S02 — Slice Title
**Active Task:** T01 — Task Title
**Phase:** Executing

## Recent Decisions
- Decision 1
- Decision 2

## Blockers
- None (or list blockers)

## Next Action
Exact next thing to do.
```

### `M###-CONTEXT.md` / `S##-CONTEXT.md` (from discuss phase)

```markdown
# M001: Milestone or Slice Title — Context

**Gathered:** 2026-03-07
**Status:** Ready for planning

## Implementation Decisions
- Decision on gray area 1
- Decision on gray area 2

## Agent's Discretion
- Areas where the user said "you decide"

## Deferred Ideas
- Ideas that came up but belong in other slices
```

### `DECISIONS.md` (append-only register)

```markdown
# Decisions Register

<!-- Append-only. Never edit or remove existing rows.
     To reverse a decision, add a new row that supersedes it.
     Read this file at the start of any planning or research phase. -->

| # | When | Scope | Decision | Choice | Rationale | Revisable? |
|---|------|-------|----------|--------|-----------|------------|
| D001 | M001/S01 | library | Validation library | Zod | Type inference, already in deps | No |
| D002 | M001/S01 | arch | Session storage | HTTP-only cookies | Security, SSR compat | Yes — if mobile added |
| D003 | M001/S02 | api | API versioning | URL prefix /v1 | Simple, fits scale | Yes |
| D004 | M001/S03 | convention | Error format | RFC 7807 | Standard, client-friendly | No |
| D005 | M002/S01 | arch | Session storage | JWT in Authorization header | Mobile client needs it (supersedes D002) | No |
```

**Rules:**
- **Append-only** — rows are never edited or removed. To reverse a decision, add a new row that supersedes it (reference the old ID).
- **#** — Sequential ID (`D001`, `D002`, ...), never reused.
- **When** — Where the decision was made: `M001`, `M001/S01`, or `M001/S01/T02`.
- **Scope** — Category tag: `arch`, `pattern`, `library`, `data`, `api`, `scope`, `convention`.
- **Revisable?** — `No`, or `Yes — trigger condition`.

**When to read:** At the start of any planning or research phase.
**When to write:** During discussion (seed from context), during planning (structural choices), during task execution (if an architectural choice was made), and during slice completion (catch-all for missed decisions).

---

## The Phases

Work flows through these phases. Each phase produces a file.

### Phase 1: Discuss (Optional)

**Purpose:** Capture user decisions on gray areas before planning.
**Produces:** `M###-CONTEXT.md` for milestone-level discussion or `S##-CONTEXT.md` for slice-level discussion.
**When to use:** When the scope has ambiguities the user should weigh in on.
**When to skip:** When the user already knows exactly what they want, or told you to just go.

**How to do it manually:**
1. Read the roadmap to understand the scope.
2. Identify 3-5 gray areas — implementation decisions the user cares about.
3. Use `ask_user_questions` to discuss each area, one round at a time. Never fabricate user input; wait for the user's actual response before the next round.
4. Write decisions to the appropriate context file (`M###-CONTEXT.md` or `S##-CONTEXT.md`).
5. Do NOT discuss how to implement — only what the user wants.

### Phase 2: Research (Optional)

**Purpose:** Scout the codebase and relevant docs before planning.
**Produces:** `M###-RESEARCH.md` at milestone level or `S##-RESEARCH.md` at slice level.
**When to use:** When working in unfamiliar code, with unfamiliar libraries, or on complex integrations.
**When to skip:** When the codebase is familiar and the work is straightforward.

**How to do it manually:**
1. Read `M###-CONTEXT.md` and/or `S##-CONTEXT.md` if they exist — know what decisions are locked.
2. Scout relevant code: `rg`, `find`, read key files.
3. Use `resolve_library` / `get_library_docs` if needed.
4. Write findings to `research.md` with these sections:

```markdown
# S01: Slice Title — Research

**Researched:** 2026-03-07
**Domain:** Primary technology/problem domain
**Confidence:** HIGH/MEDIUM/LOW

## Summary
2-3 paragraph executive summary. Primary recommendation.

## Don't Hand-Roll
| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
Problems that look simple but have existing solutions.

## Common Pitfalls
### Pitfall 1: Name
**What goes wrong:** ...
**Why it happens:** ...
**How to avoid:** ...
**Warning signs:** ...

## Relevant Code
Existing files, patterns, reusable assets, integration points.

## Sources
- Context7: /library/id — topics fetched (HIGH confidence)
- WebSearch: finding — verified against docs (MEDIUM confidence)
```

The **Don't Hand-Roll** and **Common Pitfalls** sections prevent the most expensive mistakes.

### Phase 3: Plan

**Purpose:** Decompose work into context-window-sized tasks with must-haves.
**Produces:** `S##-PLAN.md` + individual `T01-PLAN.md` files.

**For a milestone (roadmap):**
1. Read `M###-CONTEXT.md`, `M###-RESEARCH.md`, and `.gsd/DECISIONS.md` if they exist.
2. Decompose the vision into 4-10 demoable vertical slices.
3. Order by risk (high-risk first to validate feasibility early).
4. Write `M###-ROADMAP.md` with checkboxes, risk levels, dependencies, demo sentences.
5. **Write the boundary map** — for each slice, specify what it produces (functions, types, interfaces, endpoints) and what it consumes from upstream slices. This forces interface thinking before implementation and enables deterministic verification that slices actually connect.

**For a slice (task decomposition):**
1. Read the slice's entry in `M###-ROADMAP.md` **and its boundary map section** — know what interfaces this slice must produce and consume.
2. Read `M###-CONTEXT.md`, `S##-CONTEXT.md`, `M###-RESEARCH.md`, `S##-RESEARCH.md`, and `.gsd/DECISIONS.md` if they exist for this slice.
3. Read summaries from dependency slices (check `depends:[]` in roadmap).
4. Verify that upstream slices' actual outputs match what the boundary map says this slice consumes. If they diverge, update the boundary map.
5. Decompose into 1-7 tasks, each fitting one context window.
6. Each task needs: title, description, steps (3-10), must-haves (observable verification criteria).
7. Must-haves should reference boundary map contracts — e.g. "exports `generateToken()` as specified in boundary map S01→S02".
8. Write `S##-PLAN.md` and individual `T##-PLAN.md` files.

### Phase 4: Execute

**Purpose:** Do the work for one task.
**Produces:** Code changes + `[DONE:n]` markers.

**How to do it manually:**
1. Read the task's `T##-PLAN.md`.
2. Read relevant summaries from prior tasks (for context on what's already built).
3. Execute each step. Mark progress with `[DONE:n]` in responses.
4. If you made an architectural, pattern, or library decision, append it to `.gsd/DECISIONS.md`.
5. If interrupted or context is getting full, write `continue.md` (see below).

### Phase 5: Verify

**Purpose:** Check that the task's must-haves are actually met.
**Produces:** Pass/fail determination.

**Verification ladder — use the strongest tier you can reach:**
1. **Static:** Files exist, exports present, wiring connected, not stubs.
2. **Command:** Tests pass, build succeeds, lint clean, blocked command works.
3. **Behavioral:** Browser flows work, API responses correct.
4. **Human:** Ask the user only when you genuinely can't verify yourself.

**The rule:** "All steps done" is NOT verification. Check the actual outcomes.

**Verification report format** (written into the summary or surfaced on failure):

```
### Observable Truths
| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User can sign up | ✓ PASS | POST /api/auth/signup returns 201 |
| 2 | Login returns JWT | ✗ FAIL | Returns 500 — missing env var |

### Artifacts
| File | Expected | Status | Evidence |
|------|----------|--------|---------|
| src/lib/auth.ts | JWT helpers, min 30 lines | ✓ SUBSTANTIVE | 87 lines, exports generateTokens |
| src/lib/email.ts | Email sending | ✗ STUB | 8 lines, console.log instead of sending |

### Key Links
| From | To | Via | Status |
|------|----|----|--------|
| login/route.ts | auth.ts | import generateTokens | ✓ WIRED |
| email.ts | Resend API | resend.emails.send() | ✗ NOT WIRED |

### Anti-Patterns Found
| File | Line | Pattern | Severity |
|------|------|---------|----------|
| src/lib/email.ts | 5 | console.log stub | 🛑 Blocker |
```

When verification finds gaps, include a **Gaps** section with what's missing, impact, and suggested fix.

### Phase 6: Summarize

**Purpose:** Record what happened for downstream tasks.
**Produces:** `T##-SUMMARY.md`, and when slice completes, `S##-SUMMARY.md`.

**Task summary format:**
```markdown
---
id: T01
parent: S01
milestone: M001
provides:
  - What this task built (~5 items)
requires:
  - slice: S00
    provides: What that prior slice built that this task used
affects: [S02, S03]
key_files:
  - path/to/important/file.ts
key_decisions:
  - "Decision made: reasoning"
patterns_established:
  - "Pattern name and where it lives"
drill_down_paths:
  - .gsd/milestones/M001/slices/S01/tasks/T01-PLAN.md
duration: 15min
verification_result: pass
completed_at: 2026-03-07T16:00:00Z
---

# T01: Task Title

**Substantive one-liner — NOT "task complete" but what actually shipped**

## What Happened

Concise prose narrative of what was built, why key decisions were made,
and what matters for future work.

## Deviations
What differed from the plan and why (or "None").

## Files Created/Modified
- `path/to/file.ts` — What it does
```

The one-liner must be substantive: "JWT auth with refresh rotation using jose" not "Authentication implemented."

**Slice summary:** Written when all tasks in a slice complete. Compresses all task summaries. Includes `drill_down_paths` to each task summary. During slice completion, review task summaries for `key_decisions` and ensure any significant ones are captured in `.gsd/DECISIONS.md`.

**Milestone summary:** Updated each time a slice completes. Compresses all slice summaries. This is what gets injected into later slice planning instead of loading many individual summaries.

### Phase 7: Advance

**Purpose:** Mark work done and move to the next thing.

**After a task completes:**
1. Mark the task done in `S##-PLAN.md` (checkbox).
2. Check if there's a next task in the slice → execute it.
3. If slice is complete → write slice summary, mark slice done in `M###-ROADMAP.md`.

**After a slice completes:**
1. Write slice `S##-SUMMARY.md` (compresses all task summaries).
2. Write slice `S##-UAT.md` — a non-blocking human test script derived from the slice's must-haves and demo sentence. The agent does NOT wait for UAT results.
3. Mark the slice checkbox in `M###-ROADMAP.md` as `[x]`.
4. Update `STATE.md` with new position.
5. Update milestone `M###-SUMMARY.md` with the completed slice's contributions.
6. Continue to next slice immediately. The user tests the UAT whenever convenient.
7. If the user reports UAT failures later, create fix tasks in the current or a new slice.
8. If all slices done → milestone complete.

---

## Continue-Here Protocol

**When to write `continue.md`:**
- You're about to lose context (compaction, session end, Ctrl+C).
- The current task isn't done yet.
- You want to pause and come back later.

**What to capture:**
```markdown
---
milestone: M001
slice: S01
task: T02
step: 3
total_steps: 7
saved_at: 2026-03-07T15:30:00Z
---

## Completed Work
- What's already done in this task and prior tasks in the slice.

## Remaining Work
- What steps remain, with enough detail to resume.

## Decisions Made
- Key decisions and WHY (so next session doesn't re-debate).

## Context
The "vibe" — what you were thinking, what's tricky, what to watch out for.

## Next Action
The EXACT first thing to do when resuming. Not vague. Specific.
```

**How to resume:**
1. Read `continue.md`.
2. Delete `continue.md` (it's consumed, not permanent).
3. Pick up from "Next Action".

---

## State Management

### `STATE.md` is a derived cache

It is NOT the source of truth. It's a convenience dashboard.

**Sources of truth:**
- `M###-ROADMAP.md` → which slices exist and which are done
- `S##-PLAN.md` → which tasks exist within a slice
- `T##-SUMMARY.md` → what happened during a task
- `S##-SUMMARY.md` and `M###-SUMMARY.md` → compressed slice and milestone outcomes

**Update `STATE.md`** after every significant action:
- Active milestone/slice/task
- Recent decisions (last 3-5)
- Blockers
- Next action (most important — this is what a fresh session reads first)

### Reconciliation

If files disagree, **pause and surface to the user**:
- Roadmap says slice done but task summaries missing → inconsistency
- Task marked done but no summary → treat as incomplete
- Continue file exists for completed task → delete continue file
- State points to nonexistent slice/task → rebuild state from files

---

## Git Strategy: Branch-Per-Slice with Squash Merge

**Principle:** Main is always clean and working. Each slice gets an isolated branch. The user never runs a git command — the agent handles everything.

### Branch Lifecycle

1. **Slice starts** → create branch `gsd/M001/S01` from main
2. **Per-task commits** on the branch — atomic, descriptive, bisectable
3. **Slice completes** → squash merge to main as one clean commit
4. **Branch deleted** — squash commit on main is the permanent record

### What Main Looks Like

```
feat(M001/S03): milestone and slice discuss commands
feat(M001/S02): extension scaffold and command routing
feat(M001/S01): file I/O foundation
```

One commit per slice. Individually revertable. Reads like a changelog.

### What the Branch Looks Like

```
gsd/M001/S01:
  test(S01/T03): round-trip tests passing
  feat(S01/T03): file writer with round-trip fidelity
  feat(S01/T02): markdown parser for plan files
  feat(S01/T01): core types and interfaces
  docs(S01): add slice plan
```

### Commit Conventions

| When | Format | Example |
|------|--------|---------|
| Task completed | `{type}(S01/T02): <one-liner from summary>` | Type inferred from title (`feat`, `fix`, `test`, etc.) |
| Plan/docs committed | `docs(S01): add slice plan` | Planning artifacts |
| Slice squash to main | `type(M001/S01): <slice title>` | Type inferred from title |
| State rebuild | `chore(S01/T02): auto-commit after state-rebuild` | Bookkeeping only |

The system reads the task summary after execution and builds a meaningful commit message:
- **Subject**: `{type}({sliceId}/{taskId}): {one-liner}` — the one-liner from the summary frontmatter
- **Type**: Inferred from the task title and one-liner (`feat`, `fix`, `test`, `refactor`, `docs`, `perf`, `chore`)
- **Body**: Key files from the summary frontmatter (up to 8 files listed)

Commit types: `feat`, `fix`, `test`, `refactor`, `docs`, `perf`, `chore`

### Squash Merge Message

```
feat(M001/S01): file I/O foundation

Agent can parse, format, load, and save all GSD file types with round-trip fidelity.

Tasks completed:
- T01: core types and interfaces
- T02: markdown parser for plan files
- T03: file writer with round-trip fidelity
```

### Rollback

| Problem | Fix |
|---------|-----|
| Bad task | `git reset --hard HEAD~1` to previous commit on the branch |
| Bad slice | `git revert <squash commit>` on main |
| UAT failure after merge | Fix tasks on `gsd/M001/S01-fix` branch, squash as `fix(M001/S01): <fix>` |

---

## Summary Injection for Downstream Tasks

When planning or executing a task, load relevant prior context:

1. Check the current slice's `depends:[]` in `M###-ROADMAP.md`.
2. Load summaries from those dependency slices.
3. Start with the **highest available level** — milestone `M###-SUMMARY.md` first.
4. Only drill down to slice/task summaries if you need specific detail.
5. Stay within **~2500 tokens** of total injected summary context.
6. If the dependency chain is too large, drop the oldest/least-relevant summaries first.

**Aim for:**
- ~5 provides per summary
- ~10 key_files per summary
- ~5 key_decisions per summary
- ~3 patterns_established per summary

These are soft caps — exceed them when genuinely needed, but don't let summaries become essays.

---

## Project-Specific Context

This methodology doc is generic. Project-specific guidance belongs in the milestone and slice context files:

- **`.gsd/milestones/<active>/M###-CONTEXT.md`** — milestone-level architecture decisions, reference file paths, and implementation constraints
- **`.gsd/milestones/<active>/slices/S##/S##-CONTEXT.md`** — slice-level decisions, edge cases, and narrow implementation guidance when present

**Always read the active milestone's `M###-CONTEXT.md` before starting implementation work.** If the active slice also has `S##-CONTEXT.md`, read that too. These files tell you what decisions are locked, what files to reference, and how to verify your work in this specific project.

---

## Checklist for a Fresh Session

1. Read `.gsd/STATE.md` — what's the next action?
2. Check for `continue.md` in the active slice — is there interrupted work?
3. If resuming: read `continue.md`, delete it, pick up from "Next Action".
4. If starting fresh: read the active slice's `S##-PLAN.md`, find the next incomplete task.
5. If in a planning or research phase, read `.gsd/DECISIONS.md` — respect existing decisions.
6. Read relevant summaries from prior tasks/slices for context.
7. Do the work.
8. Verify the must-haves.
9. Write the summary.
10. Mark done, update `STATE.md`, advance.
11. If context is getting full or you're done for now: write `continue.md` if mid-task, or update `STATE.md` with next action if between tasks.

## When Context Gets Large

If you sense context pressure (many files read, long execution, lots of tool output):

1. **If mid-task:** Write `continue.md` with exact resume state. Tell the user: "Context is getting full. I've saved progress to continue.md. Start a new session and run `/gsd` to pick up where you left off, or `/gsd auto` to resume in auto-execution mode."
2. **If between tasks:** Just update `STATE.md` with the next action. No continue file needed — the next session will read STATE.md and pick up the next task cleanly.
3. **Don't fight it.** The whole system is designed for this. A fresh session with the right files loaded is better than a stale session with degraded reasoning.
