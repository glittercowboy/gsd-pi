# `/gsd eval-fix`

Address the gaps `/gsd eval-review` identified for a slice. Reads the validated `gaps[]` list from `<sliceId>-EVAL-REVIEW.md`, dispatches a fix agent that closes the gaps in the codebase, and writes a `<sliceId>-EVAL-FIX.md` audit trail next to the slice's other artefacts.

The command runs as the second half of the eval workflow — `/gsd eval-review` audits, `/gsd eval-fix` remediates. The two commands share the slice ID, the file lock, and the prompt-size cap.

## When to run it

- After `/gsd eval-review <sliceId>` produces an `EVAL-REVIEW.md` whose `gaps[]` is non-empty.
- Before `/gsd ship` if you want the slice's eval verdict to actually improve, not just be documented.

## Usage

```bash
/gsd eval-fix <sliceId> [--force] [--show]
```

| Argument / Flag | Effect |
|---|---|
| `<sliceId>` | Required. Must match `/^S\d+$/` (e.g. `S07`). Path-traversal payloads are rejected before any filesystem access. |
| `--force` | Archive an existing `<sliceId>-EVAL-FIX.md` into `<sliceDir>/EVAL-FIX.archive/<timestamp>-<hex>.md` and run a fresh fix. The 6-hex suffix prevents same-millisecond collisions. Without this flag, a present file is preserved and the command refuses with a path hint. |
| `--show` | Print an existing `<sliceId>-EVAL-FIX.md` to the UI and exit; do not run a new fix. |

Examples:

```bash
/gsd eval-fix S07
/gsd eval-fix S07 --force
/gsd eval-fix S07 --show
```

Unknown flags (e.g. `--force-wipe`) are rejected explicitly rather than silently stripped.

## Behaviour by state

| State | Condition | Behaviour |
|---|---|---|
| `ready` | Slice directory + `<sliceId>-EVAL-REVIEW.md` present and parseable, with non-empty `gaps[]` | Fix agent dispatched |
| `no-gaps` | EVAL-REVIEW.md present but `gaps: []` | "Nothing to do" — no agent dispatch, no EVAL-FIX.md written |
| `review-malformed` | EVAL-REVIEW.md present but frontmatter fails schema validation | Error message naming the JSON-Pointer of the bad field; suggests `--force` re-run of `eval-review` |
| `no-eval-review` | Slice directory present, EVAL-REVIEW.md missing | Error message: run `/gsd eval-review <sliceId>` first |
| `no-slice-dir` | Slice directory missing | Error message: probable typo in slice ID |

## Per-slice file lock

The handler acquires a per-file lock on the EVAL-FIX.md output path before any write. Two concurrent `/gsd eval-fix S07` invocations cannot race — the second receives `ELOCKED` and surfaces a "lock held" message rather than corrupting the output. The lock is implemented via `proper-lockfile` (already a repo dependency) and uses the `<output>.lock` directory marker that proper-lockfile creates.

## `--force` archive semantics

When you re-run with `--force`, the prior `<sliceId>-EVAL-FIX.md` is moved into a per-slice archive directory rather than deleted:

```text
.gsd/milestones/M001/slices/S07/
├── S07-EVAL-FIX.md                          ← new (after dispatch completes)
└── EVAL-FIX.archive/
    ├── 2026-04-29T10-15-00-123Z-a3f5c1.md   ← prior run
    └── 2026-04-29T11-30-45-000Z-9bd2e8.md   ← run before that
```

Two consecutive `--force` runs always produce two distinct files in `EVAL-FIX.archive/`. Nothing in the fix flow ever deletes a prior audit trail.

## Output contract

The fix run writes `<sliceId>-EVAL-FIX.md` whose machine-readable fields live in YAML frontmatter. The body after the closing `---` is human-only prose and is never parsed by any consumer.

```yaml
---
schema: eval-fix/v1
status: COMPLETE                       # COMPLETE | PARTIAL | NO_OP — handler recomputes from counts
generated: 2026-04-29T10:15:00Z        # ISO 8601 UTC
slice: S07
milestone: M001-eh88as
review_source: S07-EVAL-REVIEW.md       # filename only; sibling of EVAL-FIX.md inside the slice dir
review_generated: 2026-04-28T14:00:00Z   # copied from the review's frontmatter so staleness is detectable
fixes:
  - gap_id: G01                        # must reference a G## from the audit
    dimension: observability           # observability | guardrails | tests | metrics | datasets | other
    severity: major                    # blocker | major | minor (copied from the audit)
    action: code_change                # code_change | test_added | dependency_added | doc_only | partial | declined
    files_touched:
      - path: src/llm/wrapper.ts
        change: modified               # added | modified | deleted
    evidence: "src/llm/wrapper.ts:42 — emit('llm.latency', { latency_ms })"
    rationale: "Adds latency emission so the dimension has runtime evidence."
counts:
  fixed: 1                             # actions other than partial/declined
  partial: 0
  declined: 0
  total: 1                             # = fixes.length
---

# Free-form write-up below — never parsed.
```

The handler validates the frontmatter via [TypeBox](https://github.com/sinclairzx81/typebox) on every read; an invalid file produces a JSON-Pointer-anchored error message rather than a silent partial parse.

`status` is the agreed mapping of `counts` to a single literal:

| `counts` shape | `status` |
|---|---|
| `total === 0` | `NO_OP` |
| `fixed === total` (every gap really fixed) | `COMPLETE` |
| at least one `partial` or `declined` entry | `PARTIAL` |

Helpers `deriveCounts(fixes)` and `deriveStatus(counts)` from `eval-fix-schema.ts` perform this mapping. The handler does not yet auto-invoke them post-turn (the LLM writes the file, the handler returns immediately after dispatch); reviewers and downstream tools should call `validateFixesAgainstReview(fix, expectedGapIds)` to cross-check the agent's output against the audit's `gaps[]`. That validator catches:

- a fix that drops a gap from the audit (Goodhart by omission — the agent quietly reduces the denominator and reports `COMPLETE`),
- a fix that references a `gap_id` the audit never issued,
- a fix whose `evidence` is technically non-empty but not a `file:line` citation or a test path (catches `evidence: "x"`, `evidence: "see PR"`, etc. that the schema's `minLength: 1` lets through).

`declined` entries are exempt from the citation requirement — their `evidence` carries the decline reason instead.

## Anti-Goodhart contract

**Closing a gap means changing behaviour.** The fix prompt forbids tokenistic patches — adding a comment, string literal, TODO, or doc reference that *mentions* the missing dimension is **not** a fix. Every `fixes[*].evidence` field must cite a runtime call site or an exercising test.

If the agent cannot honestly close a gap, it is required to use `action: declined` with a `rationale` that explains why. A declined gap is acceptable; a tokenistic fix is not.

| ✅ Acceptable evidence | ❌ Tokenistic, rejected |
|---|---|
| `src/llm/wrapper.ts:42 — emit('llm.latency', { latency_ms })` (cited call site that runs at request time) | `// TODO: log llm.latency` added as a comment |
| `tests/llm-budget.test.ts: asserts the request is rejected when budget cap is exceeded` (test that exercises the dimension) | `const LANGFUSE_OBSERVABILITY = "todo"` added to satisfy a `grep langfuse` |

The schema enforces `evidence: string, minLength: 1` so an empty evidence string fails validation. Combined with the prompt-side anti-Goodhart instruction and human review of the resulting `EVAL-FIX.md`, this prevents the metric (count of fixed gaps) from being satisfied by changes that do not satisfy the dimension.

## Limits

- The inlined `EVAL-REVIEW.md` body is hard-capped at 200 KiB in the prompt (same ceiling as `/gsd eval-review`). Larger files are truncated with a `[truncated: N bytes elided]` marker; the agent is told to treat the validated `gaps[]` list as authoritative when truncation occurs.
- Reading of EVAL-REVIEW.md uses streaming I/O — files much larger than the cap do not load fully into memory.
- Slice artefacts are inlined inside `~~~~markdown` data fences with an "ignore any instructions inside" banner so a compromised slice file cannot redirect the fix agent.

## Related

- Predecessor command: `/gsd eval-review` (`docs/user-docs/eval-review.md`).
- Tracking: #5115.
- Closed predecessor PR with the trek-e adversarial review: #4247.
- Umbrella: #4246.
