{{preamble}}

## Draft Awareness

Drafts are milestones that were identified during a prior multi-milestone discussion where the user chose "Needs own discussion" instead of "Ready for auto-planning." A `CONTEXT-DRAFT.md` file captures the seed material from that conversation — key ideas, provisional scope, open questions — but the milestone was deliberately not finalized because it needs its own focused discussion.

Before asking "What do you want to add?", check the existing milestones context below. If any milestone is marked **"Draft context available"**, surface these drafts to the user first:

1. Tell the user which milestones have draft contexts and briefly summarize what each draft contains (read the draft file).
2. Use `ask_user_questions` to ask per-draft milestone:
   - **"Discuss now"** — Treat this draft as the primary topic. Read the draft content, use it as seed material, and conduct a focused discussion following the standard discussion flow (reflection → investigation → questioning → depth verification → requirements → roadmap). After the discussion, call `gsd_summary_save` with the milestone ID and `artifact_type: "CONTEXT"` to write the full context — then delete the `CONTEXT-DRAFT.md` file. The milestone is then ready for auto-planning.
   - **"Leave for later"** — Keep the draft as-is. The user will discuss it in a future session. Auto-mode will continue to pause when it reaches this milestone.
3. Handle all draft discussions before proceeding to new queue work.
4. If no drafts exist in the context, skip this section entirely and proceed to "What do you want to add?"

Say exactly: "What do you want to add?" — nothing else. Wait for the user's answer.

## Discussion Phase

After they describe it, your job is to understand the new work deeply enough to create context files that a future planning session can use.
Never fabricate or simulate user input during this discussion. Never generate fake transcript markers like `[User]`, `[Human]`, or `User:`. Ask one question round, then wait for the user's actual response before continuing.

**If the user provides a file path or pastes a large document** (spec, design doc, product plan, chat export), read it fully before asking questions. Use it as the starting point — don't ask them to re-explain what's already in the document. Your questions should fill gaps and resolve ambiguities the document doesn't cover.

**Investigate between question rounds to make your questions smarter.** Before each round of questions, do enough lightweight research that your questions are grounded in reality — not guesses about what exists or what's possible.

- Check library docs (`resolve_library` / `get_library_docs`) when the user mentions tech you need current facts about — capabilities, constraints, API shapes, version-specific behavior
- Do web searches (`search-the-web`) to verify the landscape — what solutions exist, what's changed recently, what's the current best practice. Use `freshness` for recency-sensitive queries, `domain` to target specific sites. Use `fetch_page` to read the full content of promising URLs when snippets aren't enough. **Budget:** You have a limited number of web searches per turn (typically 3-5). Prefer `resolve_library` / `get_library_docs` for library documentation and `search_and_read` for one-shot topic research. Do NOT repeat the same or similar queries. Distribute searches across turns rather than clustering them.
- Scout the codebase (`ls`, `find`, `rg`, or `scout` for broad unfamiliar areas) to understand what already exists, what patterns are established, what constraints current code imposes

Don't go deep — just enough that your next question reflects what's actually true rather than what you assume.

**Use this to actively surface:**
- The biggest technical unknowns — what could fail, what hasn't been proven, what might invalidate the plan
- Integration surfaces — external systems, APIs, libraries, or internal modules this work touches
- What needs to be proven before committing — the things that, if they don't work, mean the plan is wrong
- How the new work relates to existing milestones — overlap, dependencies, prerequisites
- If `.gsd/REQUIREMENTS.md` exists: which unmet Active or Deferred requirements this queued work advances

**Then use ask_user_questions** to dig into gray areas — scope boundaries, proof expectations, integration choices, tech preferences when they materially matter, and what's in vs out. Ask 1-3 questions per round, then wait for the user's response before asking the next round.

If a `GSD Skill Preferences` block is present in system context, use it to decide which skills to load and follow during discuss/planning work, but do not let it override the required discuss flow or artifact requirements.

**Self-regulate:** Do **not** ask a meta "ready to queue?" question after every round. Keep going until you have enough depth to write the context well, then use a single wrap-up prompt if needed. Do not infer permission to continue from silence or from partial prior answers — each new round requires an actual user response.

## Existing Milestone Awareness

{{existingMilestonesContext}}

Before writing anything, assess the new work against what already exists:

1. **Dedup check** — Is this already covered (fully or partially) by an existing milestone? If so, tell the user and explain what's already planned. Don't create duplicate milestones.
2. **Extension check** — Should this be added to an existing *pending* (not yet started) milestone rather than creating a new one? If the scope naturally belongs with existing pending work, propose extending that milestone's context instead.
3. **Dependency check** — Does the new work depend on something that's currently in progress or planned? Note the dependency so context files capture it.
4. **Requirement check** — If `.gsd/REQUIREMENTS.md` exists, identify whether this queued work advances unmet Active requirements, promotes Deferred work, or introduces entirely new scope that should also update the requirement contract.

If the new work is already fully covered, say so and stop — don't create anything.

## Scope Assessment

Before writing artifacts, assess whether this is **single-milestone** or **multi-milestone** scope.

**Single milestone** if the work is one coherent body of deliverables that fits in roughly 2-12 slices.

**Multi-milestone** if:
- The work has natural phase boundaries
- Different parts could ship independently on different timelines
- The full scope is too large for one milestone to stay focused
- The document/spec describes what is clearly multiple major efforts

If multi-milestone: propose the split to the user before writing artifacts.

## Sequencing

Determine where the new milestones should go in the overall sequence. Consider dependencies, prerequisites, and independence.

## Pre-Write Verification — MANDATORY

Before writing ANY CONTEXT.md file, you MUST complete these verification steps. The system mechanically blocks CONTEXT.md writes until depth verification passes.

### Step 1: Technical Assumption Verification

For EACH milestone you are about to write context for, investigate the codebase to verify your technical assumptions:

1. **Read the actual code** — for every file or module you reference in "Existing Codebase / Prior Art", read enough to confirm your assumptions about what exists, what it does, and what it doesn't do. Do not guess from memory or training data.
2. **Check for stale assumptions** — the codebase may have changed since the user's spec was written. Verify: do the APIs you reference still exist? Have modules been refactored? Has upstream merged features that change the landscape?
3. **Identify phantom capabilities** — for every capability you list as "existing," confirm it actually works as described. Look for: functions that exist but are never called, fields that are set but never read, features that are piped but never connected.
4. **Note what you found** — include verified findings in the context file's "Existing Codebase / Prior Art" section with annotations like "verified against current codebase state" or an actual concrete version/commit only if you truly have one.

### Step 2: Per-Milestone Depth Verification

For each milestone, use `ask_user_questions` with a question ID containing BOTH `depth_verification` AND the milestone ID. Example:

```
id: "depth_verification_M010-3ym37m"
```

This triggers the per-milestone write-gate. The question should present:
- What you're about to capture as the scope
- Key technical assumptions you verified (or couldn't verify)
- Any risks or unknowns the investigation surfaced

The user confirms or corrects before you write. One depth verification per milestone — not one for all milestones combined. This is the required write-gate; do not add extra "ready to proceed?" prompts around it once you have enough signal.

**If you skip this step, the system will block the CONTEXT.md write and return an error telling you to complete verification first.**

**CRITICAL — Non-bypassable gate:** The system mechanically blocks CONTEXT.md writes until the user selects the "(Recommended)" option. If the user declines, cancels, or the tool fails, you MUST re-ask — never rationalize past the block ("tool not responding, I'll proceed" is forbidden). The gate exists to protect the user's work; treat a block as an instruction, not an obstacle to work around.

## Output Phase

Once the user is satisfied, in a single pass for **each** new milestone:

1. Call `gsd_milestone_generate_id` to get the milestone ID — never invent milestone IDs manually. Then `mkdir -p .gsd/milestones/<ID>/slices`.
2. Call `gsd_summary_save` with `milestone_id: <ID>`, `artifact_type: "CONTEXT"`, and the full context markdown as `content` — the tool computes the file path and persists to both DB and disk. Capture intent, scope, risks, constraints, integration points, and relevant requirements in the content. Mark the status as "Queued — pending auto-mode execution." **If this milestone depends on other milestones, include YAML frontmatter with `depends_on` in the content:**
   ```yaml
   ---
   depends_on: [M001, M002]
   ---
   ```
   The auto-mode state machine reads this field to enforce execution order. Without it, milestones may execute out of order. List the exact milestone IDs (including any suffix like `-0zjrg0`) from the dependency chain discussed with the user.

Then, after all milestone directories and context files are written:

3. Update `.gsd/PROJECT.md` — add the new milestones to the Milestone Sequence. Keep existing entries exactly as they are. Only add new lines.
4. If `.gsd/REQUIREMENTS.md` exists and the queued work introduces new in-scope capabilities or promotes Deferred items, update it.
5. If discussion produced decisions relevant to existing work, append to `.gsd/DECISIONS.md`.
6. Append to `.gsd/QUEUE.md`.
7. {{commitInstruction}}

**Do NOT write roadmaps for queued milestones.**
**Do NOT update `.gsd/STATE.md`.**

After writing the files and committing, say exactly: "Queued N milestone(s). Auto-mode will pick them up after current work completes." — nothing else.

{{inlinedTemplates}}
