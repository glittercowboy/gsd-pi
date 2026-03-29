# Evidence-Grounded Pipeline: A Methodology for AI Agent Reliability

This document consolidates the M005–M008 development arc into a self-contained methodology narrative. A reader unfamiliar with the project should understand the problem, approach, key decisions, results, and limitations without referencing internal GSD planning artifacts.

---

## Background

Large language models conflate training-data recall with observation. When an agent states "`actions/checkout@v4` is the latest version," it speaks with confidence about something it absorbed during training — but training data is historical, not current. The actual latest version is `v6`. The agent cannot distinguish between what it knows from training and what it has verified in the current session.

This conflation causes real harm:

1. **Broken builds** when version numbers, API signatures, or CLI flags from training are wrong
2. **Silent failures** when config schemas or magic numbers don't match the current codebase
3. **Planning invalidation** when external tool behavior assumptions are outdated

The core insight: training-data recall is a source of concepts and hypotheses, not facts. Every recalled claim needs a verification path before it becomes actionable. This principle, documented as K001 in the knowledge register, drove the design of the evidence-grounded pipeline.

---

## Hypothesis

The hypothesis for M005–M008 was:

> **Structural enforcement of evidence discipline reduces hallucination-related failures more effectively than behavioral instructions alone.**

The counter-hypothesis: agents could simply be instructed to "verify claims before acting." The pipeline design tested whether embedding evidence discipline into the workflow structure — templates, artifacts, and control loops — outperforms relying on agent judgment.

The result: behavioral instructions are ignorable. Structural changes are architectural. This is [ARL Principle 1: Structure Over Instruction](https://github.com/bitflight-devops/stateless-agent-methodology), from the [Stateless Agent Methodology (SAM)](https://github.com/bitflight-devops/stateless-agent-methodology).

---

## Method

The evidence-grounded pipeline was developed across four milestones, each building on the previous:

### M005-8pv12q: Unknowns Inventory

The first milestone established the vocabulary and artifacts:

**Evidence Classification.** Every claim an agent makes is classified by its evidence basis:
- `observed` — directly verified this session (file read, command output)
- `training-data` — recalled from model training (requires verification)
- `inferred` — logical deduction from other evidence
- `assumption` — stated without support
- `unknown` — explicitly flagged as uncertain

**Resolution Strategies.** Each unresolved claim gets a typed resolution path:
- `check-docs`, `read-code`, `experiment`, `ask-user`, `fetch-reference`, `search`

**Pipeline Integration.** The unknowns inventory flows through all four GSD phases:
- **Research** → produces the inventory with classifications
- **Plan** → converts unresolved items into concrete verification steps
- **Execute** → runs verification before acting on claims
- **Complete** → checks resolution status and reports N/M resolved

The key design decision (D055) was to classify claims, not tasks. An unknowns inventory might be empty (all claims verified) or long (many training-data claims to resolve). The pipeline scales naturally.

**Self-Classification Limitation.** M005-8pv12q acknowledged that self-classification shares the same blind spots that produce the claims (K003). An agent deciding which of its own claims came from training data is still subject to those blind spots. M006 was designed to address this structurally.

### M006-tbhsp8: Fact-Check Service Layer

The second milestone converted self-classification into independent verification:

**Architecture.** The fact-checker is an async service layer, not a blocking pipeline stage (D056). A coordinator agent spawns scout agents (running on cheaper models) to verify claims in parallel, writes durable annotation files, and notifies the orchestrator only when claims are REFUTED.

**Durable Artifacts.**
- Per-claim annotations stored under `.gsd/milestones/` by milestone and slice
- Aggregate control surface: the factcheck status artifact with currentCycle, maxCycles, overallStatus, planImpacting fields

**Planner Ingestion.** When claims are REFUTED, corrected values are injected into planner prompts:
- Slice-impact refutations → `plan-slice` prompt
- Milestone-impact refutations → `plan-milestone` prompt

The milestone-impact filtering (D061) prevents slice-level corrections from polluting milestone-level context.

**Bounded Reroute Loop.** The dispatcher inspects the factcheck status artifact before ordinary planning. Plan-impacting refutations trigger planner reinvocation. Cycles are bounded (default max 3), with explicit exhaustion behavior that stops with a clear blocker instead of infinite looping.

**Remaining Gap.** M006-tbhsp8 delivered the architecture and comprehensive tests, but the roadmap definition of done required live runtime confirmation through the full auto-mode path. This proof was not produced in M006 — it became the primary goal of M007-aos64t.

### M007-aos64t: Runtime Proof Loop

The third milestone closed the verification gap with a deterministic runtime harness:

**Synthetic Fixture.** A proof fixture centered on a known false claim: "The latest Node.js LTS version is 18.x" (actual: 22.x). The fixture manifest declares expected outcomes: one refutation, impact level, corrected value.

**Live Dispatch Proof.** Integration tests exercised the real dispatcher and prompt assembly:
- The factcheck status artifact with planImpacting=true → reroutes to `plan-slice`
- Planner prompt contains `## Fact-Check Evidence` section with REFUTED claim and corrected value `22.x`

**Durable Validation Report.** The final audit test writes `.gsd/milestones/M007-aos64t/M007-VALIDATION-REPORT.json`:

```json
{
  "schemaVersion": 1,
  "milestone": "M007-aos64t",
  "evidence": {
    "refutedCount": 1,
    "rerouteTarget": "plan-slice",
    "correctedValuePresent": true,
    "dispatchAction": {
      "action": "dispatch",
      "unitType": "plan-slice",
      "unitId": "M999-PROOF/S01"
    }
  },
  "result": "PASS"
}
```

The full proof suite (42 tests) was verified at closeout with `npx tsx --test src/resources/extensions/gsd/tests/factcheck-*.test.ts`.

**Test Execution Note.** GSD extension tests require `npx tsx --test` rather than `node --test` because Node's strip-types path doesn't handle transitive `.js` imports within `.ts` files (K007).

### M008: Experiment Harness

The fourth milestone built comparison and iteration infrastructure for measuring pipeline effectiveness:

**Comparison Runner.** The baseline/treatment comparison system enables controlled experiments:
- Feature flags control metrics extraction (`factCheckCoordination` enables fact-check metrics)
- `CompareReport` schema captures metrics per path with durations
- Schema validation with field-specific error messages for debugging

**Fidelity Rubric.** Subjective quality scoring on a 1-5 scale across four dimensions:
- Factual accuracy
- Completeness
- Coherence
- Conciseness

**Bounded Iteration.** `runExperimentLoop()` implements:
- Max 3 iterations by default
- Delta computation between consecutive reports
- Convergence detection when all deltas fall below threshold
- Explicit status: `bounded` (hit max), `converged` (below threshold), `non-converged`

The harness enables answering: "Does the fact-check pipeline actually improve planning quality?" with metrics rather than intuition.

---

## Fixtures

The M007-aos64t proof used a synthetic fixture designed for deterministic verification:

**M999-PROOF Fixture.** A synthetic milestone with a single slice (S01) containing verifiable claims:
- `C001`: "The latest Node.js LTS version is 18.x" — **REFUTED** with corrected value "22.x"
- `C002`, `C003`: Additional test claims for coverage

The fixture manifest (FACTCHECK-STATUS.json) declares `planImpacting: true` to trigger the reroute path. This enables controlled testing without external dependencies.

**Fixture Location:** `src/resources/extensions/gsd/tests/fixtures/factcheck-runtime/M999-PROOF/`

---

## Metrics

The M008 experiment harness provides structured measurement:

**Comparison Metrics.** The baseline/treatment comparison captures:
- Claim resolution count and rate
- Execution duration per phase
- Reroute cycle count

**Fidelity Rubric.** Human evaluation on a 1-5 scale across:
- Factual accuracy
- Completeness
- Coherence
- Conciseness

**Convergence Detection.** Iteration stops when:
- All metric deltas fall below threshold (converged)
- Max iterations reached (bounded)
- Explicit non-convergence declared

---

## Key Decisions

### D055: Evidence Classification Over Task Classification
Early approaches (standalone templates, constraint classification) labeled the problem instead of solving it. The unknowns inventory is the actual artifact that prevents hallucination: if you know what you don't know, you can resolve it before acting on it.

### D056: Async Service Layer, Not Blocking Stage
Blocking stages delay planning unnecessarily. Async verification lets planning start with whatever is verified so far. Scouts run on cheaper models. REFUTED claims trigger revision, not gates.

### D058: Separate Reroute Paths for Pre-Execution vs Execution Blockers
`plan-slice` / `plan-milestone` handle pre-execution fact-check corrections. `replan-slice` remains reserved for execution-discovered blockers. Overloading them would blur two distinct workflows.

### D061: Explicit Determinism for Runtime Control
Planner artifacts for control loops must name actors, observable triggers, decision conditions, state-changing outputs, feedback loops, and terminal states. Lower-end worker models need structure, not interpretation.

### D073: Fixture Manifest as Contract Boundary
The fixture manifest declares expected outcomes for direct assertion use. This enables deterministic fixture loading without interpreting code.

---

## Results

### Evidence Classification Works

The M005-8pv12q implementation proved that:
- Researchers can produce structured unknowns inventories
- Planners can convert unresolved items into verification steps
- Executors can follow evidence-check protocols
- Completers can report resolution status

The vocabulary (`observed`, `training-data`, `inferred`, `assumption`, `unknown`) is now embedded in all GSD pipeline phases.

### Fact-Check Loop Is Runtime-Proven

The M007-aos64t validation report proves the full correction loop:
- Research triggers fact-check coordination ✓
- Coordinator writes durable annotation artifacts ✓
- Dispatcher reroutes on plan-impacting refutations ✓
- Planner receives corrected evidence through prompt injection ✓
- All 42 proof-suite tests pass ✓

### Iterative Measurement Infrastructure Exists

The M008 comparison harness and experiment runner provide:
- Baseline vs treatment comparison with schema-validated reports
- Human fidelity rubrics for subjective quality assessment
- Bounded iteration with convergence detection

---

## Interpretation

### Structure Over Instruction Confirmed

The design evolution across M005–M008 validates [ARL Principle 1](https://github.com/bitflight-devops/stateless-agent-methodology):

| Approach | Mechanism | Outcome |
|----------|-----------|---------|
| Standalone templates | Behavioral ("consider using this template") | Ignored |
| Constraint classification | Labeled the problem | Still behavioral |
| Unknowns inventory | Structural artifact in workflow | Reliable |

The unknowns inventory forces evidence discipline by making it impossible to proceed without acknowledging uncertainty. The fact-check loop enforces independent verification by making self-classification insufficient.

### The Self-Evaluation Limit Is Structural

[K003](https://github.com/bitflight-devops/stateless-agent-methodology) captures [ARL Principle 3](https://github.com/bitflight-devops/stateless-agent-methodology): AI cannot reliably self-evaluate. An agent classifying its own claims shares the blind spots that produced them. The fact-check coordinator on a separate model instance (haiku) provides the independent verification that self-classification cannot.

### Async Service Layer Is the Right Architecture

Blocking verification would serialize research and planning. The async model (D056) enables:
- Parallel claim verification by scouts
- Planning with whatever evidence is available
- Revision only when REFUTED claims actually change planning inputs

This matches the [HOOTL (Hardware-Out-of-the-Loop)](https://github.com/bitflight-devops/stateless-agent-methodology) principle: verification is a service, not a gate.

---

## Limitations

### No Live Production Deployment Evidence

All runtime proof comes from synthetic fixtures and integration tests. The pipeline has not been validated against real-world GSD sessions with actual user projects. M008's experiment harness enables this validation, but the experiments have not been run.

### Human Fidelity Rubrics Are Subjective

The 4-dimension 1-5 scoring system (D077) provides structure, but scoring remains human judgment. Inter-rater reliability has not been measured.

### Fact-Check Coverage Is Claim-Scoping-Dependent

The coordinator extracts "verifiable unresolved claims" from research output. If a researcher fails to surface a training-data claim (the self-classification problem from K003), it won't be fact-checked. The structure reduces but does not eliminate this risk.

### Test Execution Requires tsx

GSD extension tests cannot run with `node --test` due to transitive `.js` imports within `.ts` files (K007). This is a toolchain dependency that may affect future contributors.

---

## Reproducibility

To independently verify the proof chain described in this document, see the reproducibility kit:

- `docs/reproducibility/README.md` — Step-by-step instructions to reproduce the M007-aos64t proof
- `docs/reproducibility/artifact-manifest.md` — Complete inventory of proof artifacts with paths and descriptions

The kit documents environment prerequisites (Node ≥22.5, tsx test runner), fixture locations, and expected PASS outcomes from the validation report.

---

## Artifact Reference

All durable artifacts referenced in this document:

| Artifact | Path | Purpose |
|----------|------|---------|
| M005 Summary | `.gsd/milestones/M005-8pv12q/M005-8pv12q-SUMMARY.md` | Unknowns inventory design outcomes |
| M006 Summary | `.gsd/milestones/M006-tbhsp8/M006-tbhsp8-SUMMARY.md` | Fact-check infrastructure outcomes |
| M007 Summary | `.gsd/milestones/M007-aos64t/M007-aos64t-SUMMARY.md` | Runtime proof loop outcomes |
| M007 Validation Report | `.gsd/milestones/M007-aos64t/M007-VALIDATION-REPORT.json` | Machine-readable proof artifact |
| M008 Summary | `.gsd/milestones/M008/M008-SUMMARY.md` | Experiment harness outcomes |
| Knowledge Register | `.gsd/KNOWLEDGE.md` | K001–K008 design rationale |
| Decisions Register | `.gsd/DECISIONS.md` | D055–D058 architectural decisions |

---

## Source Attribution

Key concepts referenced in this methodology:

- **SAM (Stateless Agent Methodology)** — https://github.com/bitflight-devops/stateless-agent-methodology
- **ARL (Agent Reliability Layer)** — https://github.com/bitflight-devops/stateless-agent-methodology
- **HOOTL (Hardware-Out-of-the-Loop)** — https://github.com/bitflight-devops/stateless-agent-methodology
- **hallucination-detector** — https://github.com/bitflight-devops/hallucination-detector
- **claude_skills** — https://github.com/Jamie-BitFlight/claude_skills

Per K005, these terms are not generally known and require proper attribution with links.
d require proper attribution with links.
with links.
d require proper attribution with links.
