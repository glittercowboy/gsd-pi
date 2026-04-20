---
name: write-docs
description: >-
  Collaborative document authoring workflow for proposals, technical specs, decision docs, README sections, ADRs, and long-form prose that must work for fresh readers. Use when asked to "write the docs", "draft a proposal", "write a spec", "write an RFC", "write the README", or when a document needs to be understandable by someone without this session's context. Three stages: gather context, iterate on structure, reader-test for a stranger.
---

<objective>
Produce documentation that works for a reader landing cold. Not a summary of what was built, not a dump of the conversation, but a document that transfers intent to someone who wasn't here. Run it through three stages — Context → Refine → Reader-Test — and don't ship until a hypothetical reader could act on it.
</objective>

<context>
GSD already produces durable artifacts (`M###-CONTEXT.md`, `S##-SUMMARY.md`, `DECISIONS.md`, `KNOWLEDGE.md`), but those are scaffolded by templates. This skill is for free-form documentation: README changes, public docs, architectural proposals, RFCs, PR descriptions, runbooks, and anything that lives under `docs/`, `mintlify-docs/`, or `gitbook/` in this repo.

Invocation points:
- User asks to write or rewrite a piece of documentation
- Before shipping a feature that adds user-facing behavior — docs need updates
- After `write-milestone-brief` when the brief needs a public-facing summary for non-GSD consumers
- PR description for a meaningful change
</context>

<core_principle>
**WRITE FOR THE FRESH READER.** The test is not "does the maintainer understand it" — you are the maintainer. The test is "can someone who has never seen this code act correctly after reading this?"

**ITERATE STRUCTURE BEFORE PROSE.** An outline that's wrong will not be saved by good sentences. Agree on the sections, what each is for, and in what order before drafting the body.

**NO FILE PATHS IN TRUNK DOCS.** Paths rot. Describe modules, behaviors, and invariants. A README that cites `src/foo.ts:42` is a future broken link.
</core_principle>

<process>

## Stage 1: Context gathering

1. **Who is the reader?** Internal engineer, open-source contributor, end user, future you at 3am. The answer changes everything.
2. **What should they be able to do after reading?** Name the single post-read action. "Understand the auth flow" is not an action — "implement a new auth provider using the documented extension points" is.
3. **What do they already know?** Assume they have docs for the language and framework, not for your codebase. Don't re-explain React; do explain your project's conventions.
4. **What context from this conversation/codebase belongs in the doc?** Ask the user to dump any missing material. Do not invent examples.

One round of clarifying questions. Then proceed.

## Stage 2: Refine structure

1. **Draft an outline, not prose.** Numbered sections, one-line purpose for each. Show it to the user.
2. **Iterate the outline.** Remove sections the reader doesn't need. Reorder so the must-knows come first. Flag sections that can't be written without more input.
3. **Only then, fill sections.** Write the body of each section in order. Keep sentences short. Prefer concrete examples over abstractions. Show small diffs or code snippets where they clarify; skip them where they'd rot.
4. **Draft in place.** Write directly to the target file — `docs/<name>.md`, `README.md`, `mintlify-docs/…`. Do not keep a scratch draft in the conversation.

## Stage 3: Reader-test

1. **Cold-read it.** Read the doc top to bottom as if you hadn't written it. Stop at every moment you thought "they already know X" — that's a gap.
2. **Can the named post-read action be taken?** Walk through it. If yes, the doc works. If no, identify the missing piece and add it.
3. **Cut aggressively.** Anything that isn't serving the post-read action comes out. Documentation bloat kills docs.
4. **Offer to the user:** "Here's the draft. Want me to run a fresh sub-agent (`Agent(subagent_type=Explore)`) as a cold reader to stress-test it?"

## Stage 4: Wire it in

1. Link to the new doc from relevant entry points (README.md index, docs/ sidebar, mintlify-docs config, etc.).
2. If it documents a decision, also append a one-line entry to `.gsd/DECISIONS.md` pointing at the doc.
3. If it's a public-facing change, flag for the next release notes / CHANGELOG update.

</process>

<anti_patterns>

- **"Writing a summary of what we did"** — the reader doesn't care about the journey. Document the destination.
- **Paths and line numbers in long-lived docs.** They rot. Use module names.
- **Re-explaining general concepts.** If the reader needs to know what HTTP is, the doc is aimed at the wrong audience.
- **Starting with prose.** Outline first, always.
- **Not cold-reading.** Every doc gets one pass as if you've never seen it.
- **Claiming "done" without the reader-test.** Docs that haven't been cold-read are notes, not docs.

</anti_patterns>

<success_criteria>

- [ ] The reader and their post-read action are named explicitly.
- [ ] The outline was agreed before prose was written.
- [ ] A cold-read pass happened; gaps were closed.
- [ ] No file paths or line numbers in the trunk doc (decision-scoped ADRs may include them).
- [ ] Doc is linked from a relevant entry point — it is discoverable, not orphaned.
- [ ] The named action is actually executable after reading.

</success_criteria>
