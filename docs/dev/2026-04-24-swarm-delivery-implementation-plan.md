# Swarm Delivery Implementation Plan for UOK Hardening

**Status:** In progress  
**Date:** 2026-04-24  
**Source spec:** https://raw.githubusercontent.com/jeremymcs/gsd-2/2540b00211c61daa0574bd3419afec5ceef36ba4/docs/dev/specs/2026-04-24-swarm-delivery-plan-uok.md  
**Related:** `docs/dev/ADR-009-orchestration-kernel-refactor.md`, `docs/dev/ADR-009-IMPLEMENTATION-PLAN.md`, `docs/dev/proposals/rfc-gitops-branching-strategy.md`

## Objective

Turn the swarm delivery spec into an executable hardening plan for the current UOK baseline. ADR-009 already marks the Unified Orchestration Kernel as implemented and default-on, so this plan does not reopen the whole migration. It focuses on the remaining operational guarantees needed for parallel lane delivery:

1. One scheduler contract and explainable dispatch decisions.
2. Explicit, replayable state transitions.
3. Deterministic single-writer coordination.
4. UOK release proof packs and emergency fallback discipline.
5. GitHub routines that let lanes move quickly without lowering safety.

## Non-Goals

- Replacing the current UOK modules with a new architecture.
- Rewriting CLI, web, MCP, or package entrypoints.
- Changing model/provider auth or compliance behavior outside the policy gate.
- Enforcing organization-level GitHub branch protection through this repository's own `.github/` files. GitHub routines in this plan belong to GSD's product code and generated workflow surfaces.

## Current Baseline

The repo already has the main UOK spine:

- `src/resources/extensions/gsd/uok/contracts.ts` - turn, gate, audit, graph contracts.
- `src/resources/extensions/gsd/uok/kernel.ts` - UOK entrypoint and emergency legacy fallback routing.
- `src/resources/extensions/gsd/uok/gate-runner.ts` - unified gate runner and retry matrix.
- `src/resources/extensions/gsd/uok/execution-graph.ts` - shared graph scheduler primitives.
- `src/resources/extensions/gsd/uok/gitops.ts` - turn git transaction projection.
- `src/resources/extensions/gsd/uok/audit.ts` - append-only audit envelope.
- `src/resources/extensions/gsd/uok/plan-v2.ts` - compile-to-unit-graph path.
- `src/resources/extensions/github-sync/*` - product-owned GitHub issue, PR, milestone, and generated routine surface.

The swarm work should harden the edges around these modules, add missing source-of-truth artifacts, and prove the behavior with targeted tests and release reports.

## Execution Progress

- 2026-04-24: Landed the contract-freeze foundation:
  - dispatch reason/envelope contract and formatter
  - execution graph snapshot helper
  - checked-in state transition matrix and validation tests
  - UOK writer token and monotonic sequence helper
  - turn observer writer-sequence wiring for audit/gitops metadata
  - parity report helper
  - GitHub Sync swarm PR body and release checklist routine scaffolding

## Delivery Topology

Use one hub branch and five lane branches:

| Role | Branch | Primary ownership |
| --- | --- | --- |
| Hub integrator | `integration/uok-swarm` | merge arbitration, final proof pack, release candidate |
| Workflow lane | `lane/workflow-engine` | scheduler contract, execution graph plumbing, dispatch explainability |
| State lane | `lane/state-machine` | transition matrix, guards, replay and crash recovery |
| Writer lane | `lane/single-writer` | write token, write adapter, sequence continuity |
| UOK lane | `lane/uok-control-planes` | flags, fallback controls, parity report, control plane boundaries |
| GitHub lane | `lane/github-routines` | generated labels, PR body routines, check summaries, release checklist |

Only the hub merges lane PRs into `integration/uok-swarm`. Lane PRs target the integration branch, not `main`.

## Global Guardrails

- Contract-first: each lane lands typed contracts, source artifacts, and tests before broad implementation rewires.
- Fail-closed: ambiguous dispatch, transition, write, or parity state stops in a blocked/manual-attention path.
- Traceable by default: every dispatch and write must include `traceId`, `turnId`, `unitType`, `unitId`, timestamp, source commit when available, and a reason code.
- Single writer of record: only the hub merges integration state. Runtime writes flow through one adapter or explicitly documented compatibility shim.
- Small PRs: lane work should land in slices that can be reviewed independently.

## Phase 0: Integration Setup

**Goal:** Create the shared branch, baseline checks, and lane ownership before feature work starts.

### Tasks

1. Create `integration/uok-swarm` from current `main`.
2. Open five tracking issues, one per lane, each linking this plan and the source spec.
3. Confirm CI on the integration branch runs the same required checks as `main`.
4. Add temporary labels:
   - `lane/workflow`
   - `lane/state`
   - `lane/writer`
   - `lane/uok`
   - `lane/github`
   - `uok-swarm`
5. Add an integration status comment template for daily hub updates:
   - lane branch
   - latest commit
   - changed contracts
   - test evidence
   - blockers

### Exit Criteria

- All lane issues exist.
- All lanes know their write scopes.
- The hub can produce a daily integration status without manual archaeology.

### Verification

- `git fetch origin`
- `git branch --contains origin/integration/uok-swarm`
- GitHub label list includes the lane labels.
- CI is green or failures are documented with owners.

## Phase 1: Contract Freeze

**Goal:** Freeze the shared contracts that all lanes will depend on.

### 1A. Workflow Engine Contract

Primary files:

- `src/resources/extensions/gsd/uok/contracts.ts`
- `src/resources/extensions/gsd/uok/execution-graph.ts`
- `src/resources/extensions/gsd/workflow-engine.ts`
- `src/resources/extensions/gsd/engine-types.ts`
- `src/resources/extensions/gsd/auto/loop.ts`

Deliverables:

- Add a normalized dispatch envelope that covers `unit`, `hook`, `subagent`, `team-worker`, `verification`, `reprocess`, and `refine`.
- Add dispatch reason codes:
  - `policy`
  - `state`
  - `recovery`
  - `manual`
  - `dependency`
  - `conflict`
  - `retry`
- Add a query-facing explanation object so `/gsd query` can answer why a unit ran or why it is blocked.

Tests:

- Extend `src/resources/extensions/gsd/tests/uok-contracts.test.ts`.
- Extend `src/resources/extensions/gsd/tests/uok-execution-graph.test.ts`.
- Add or extend a query/explainability test near `src/resources/extensions/gsd/tests/active-milestone-id-guard.test.ts` or `src/resources/extensions/gsd/tests/dev-engine-wrapper.test.ts`.

### 1B. State Transition Matrix

Primary files:

- `src/resources/extensions/gsd/state.ts`
- `src/resources/extensions/gsd/auto/phases.ts`
- `src/resources/extensions/gsd/tools/*.ts`
- new source artifact under `src/resources/extensions/gsd/state-transition-matrix.*`

Deliverables:

- Add a checked-in transition matrix with:
  - `from`
  - `event`
  - `guard`
  - `to`
  - `onFail`
  - `reasonCode`
- Add a validator that fails if hot-path transitions are not represented in the matrix.
- Map known recovery paths into explicit events instead of hidden side effects.

Tests:

- Extend `src/resources/extensions/gsd/tests/state-machine-full-walkthrough.test.ts`.
- Extend `src/resources/extensions/gsd/tests/state-derivation-parity.test.ts`.
- Add a matrix coverage test.

### 1C. Single Writer Contract

Primary files:

- `src/resources/extensions/gsd/uok/contracts.ts`
- `src/resources/extensions/gsd/uok/audit.ts`
- `src/resources/extensions/gsd/uok/gitops.ts`
- `src/resources/extensions/gsd/bootstrap/write-gate.ts`
- `src/resources/extensions/gsd/sync-lock.ts`
- `src/resources/extensions/gsd/atomic-write.ts`

Deliverables:

- Define `WriterToken`, `WriteSequence`, and `WriteRecord`.
- Define one active writer token per turn.
- Define monotonic per-turn sequence ids used by state, audit, and gitops writes.
- Document which legacy writes remain outside the adapter and why.

Tests:

- Extend `src/resources/extensions/gsd/tests/write-gate.test.ts`.
- Extend `src/resources/extensions/gsd/tests/uok-audit-unified.test.ts`.
- Extend `src/resources/extensions/gsd/tests/uok-gitops-turn-action.test.ts`.
- Add a concurrent write rejection or deterministic queue test.

### Phase 1 Exit Criteria

- Contracts compile.
- Matrix and writer contracts are checked in.
- No lane needs to invent its own dispatch, transition, or write metadata shape.

### Verification

- `npm run typecheck:extensions`
- Targeted UOK and state tests:
  - `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/uok-contracts.test.ts src/resources/extensions/gsd/tests/uok-execution-graph.test.ts src/resources/extensions/gsd/tests/state-machine-full-walkthrough.test.ts src/resources/extensions/gsd/tests/write-gate.test.ts`

## Phase 2: Lane Implementation

**Goal:** Implement lane-owned behavior behind stable contracts.

### Lane A: Workflow Engine

Implement:

- `resolveDispatch` returns the normalized dispatch envelope.
- Execution graph snapshots are persisted before and after each dispatched unit.
- Dispatch explanation is exposed through the existing query/status surface.
- Recovery dispatch uses reason code `recovery` and includes the prior failed turn id.

Done criteria:

- One contract function chooses the scheduler path.
- Every execution kind has unit coverage.
- Query output can explain "why this unit ran now" and "why this unit is blocked."

Suggested tests:

- `src/resources/extensions/gsd/tests/custom-workflow-engine.test.ts`
- `src/resources/extensions/gsd/tests/workflow-dispatch.test.ts`
- `src/resources/extensions/gsd/tests/uok-execution-graph.test.ts`
- `src/resources/extensions/gsd/tests/dispatch-missing-task-plans.test.ts`

### Lane B: State Machine

Implement:

- Transition matrix is used by hot-path completion and recovery tools.
- Repeated `query`, `next`, interrupted `auto`, and crash recovery are idempotent.
- Hidden transition side effects are either removed or wrapped in explicit matrix events.
- Failed guards route to blocked/reassess/manual-attention states, never implicit success.

Done criteria:

- No known hot-path transition is missing from the matrix.
- Replay suite proves deterministic state for seeded scenarios.
- Crash recovery resumes from disk and DB truth without double-dispatching.

Suggested tests:

- `src/resources/extensions/gsd/tests/state-machine-full-walkthrough.test.ts`
- `src/resources/extensions/gsd/tests/crash-recovery.test.ts`
- `src/resources/extensions/gsd/tests/derive-state-db-disk-reconcile.test.ts`
- `src/resources/extensions/gsd/tests/recovery-attempts-reset.test.ts`

### Lane C: Single Writer

Implement:

- Runtime writes enter through a single write adapter when UOK is enabled.
- Active writer token is acquired at turn start and released at closeout.
- Concurrent write attempts are rejected or queued deterministically.
- Audit and gitops records include the same monotonic sequence id.
- Restart recovery continues the sequence without overwriting prior records.

Done criteria:

- Audit log can reconstruct exact write order.
- State, audit, and gitops writes are correlated by sequence id.
- Stale or superseded turn writes are dropped with an auditable reason.

Suggested tests:

- `src/resources/extensions/gsd/tests/write-gate.test.ts`
- `src/resources/extensions/gsd/tests/stale-lockfile-recovery.test.ts`
- `src/resources/extensions/gsd/tests/uok-audit-unified.test.ts`
- `src/resources/extensions/gsd/tests/uok-gitops-wiring.test.ts`

### Lane D: UOK Control Planes

Implement:

- Confirm default-on UOK flags match release intent.
- Restrict legacy fallback to emergency controls only.
- Add a parity replay pack for planning, dispatch, gitops, and audit events.
- Generate a parity report artifact for integration/release candidate branches.
- Harden typed boundaries between gate, model, gitops, audit, execution graph, and plan v2 planes.

Done criteria:

- UOK path remains default in stable builds.
- Legacy path is only reachable through explicit emergency controls.
- Parity report is generated for release candidates and blocks release on critical mismatch.

Suggested tests:

- `src/resources/extensions/gsd/tests/uok-flags.test.ts`
- `src/resources/extensions/gsd/tests/uok-kernel-path.test.ts`
- `src/resources/extensions/gsd/tests/uok-model-policy.test.ts`
- `src/resources/extensions/gsd/tests/uok-plan-v2-wiring.test.ts`

### Lane E: GitHub Routines

Implement:

- Add lane labels to the GitHub Sync routine contract and document their use.
- Add generated PR body sections through `src/resources/extensions/github-sync/templates.ts`:
  - impact area
  - transition risks
  - rollback plan
  - test evidence
  - lane label
- Add lane-aware check summary fields for generated integration PR/status bodies.
- Add a generated release checklist issue body for UOK swarm cutover validation.
- Add generated branch protection instructions for `integration/uok-swarm` and release branches.

Done criteria:

- Lane PRs have clear required evidence.
- Integration PR has a machine-generated or checklist-generated summary of lane deltas.
- Required checks and reviewer expectations are documented and enforceable.

Suggested tests:

- Existing CI workflow syntax checks through GitHub.
- Local validation where possible:
  - `npm run typecheck:extensions`
  - `node scripts/pr-risk-check.mjs --json < /tmp/changed-files.txt`

### Phase 2 Exit Criteria

- All lane branches have passing targeted tests.
- All lane PRs include transition risks, rollback plan, and test evidence.
- Hub integration branch contains no unresolved contract drift.

## Phase 3: Integration Hardening

**Goal:** Prove the lanes work together before release candidate cut.

### Tasks

1. Hub merges one lane PR at a time into `integration/uok-swarm`.
2. After each merge, run targeted tests for the touched lane.
3. After all lanes merge, run:
   - `npm run typecheck:extensions`
   - `npm run test:unit`
   - `npm run test:integration`
4. Generate UOK parity report for:
   - normal dispatch
   - blocked dispatch
   - recovery dispatch
   - gitops closeout
   - audit reconstruction
5. Run one rollback drill:
   - enable emergency legacy fallback
   - confirm dispatch path label changes to `legacy-fallback`
   - disable fallback
   - confirm UOK resumes as default

### Exit Criteria

- Full integration suite passes or failures are owned with a release-blocking decision.
- Parity report has no critical mismatches.
- Rollback drill completes within the agreed SLO.
- Integration branch has a release candidate summary.

## Phase 4: Release Candidate

**Goal:** Prepare a safe cutover from integration to the normal release path.

### Tasks

1. Create a release candidate PR from `integration/uok-swarm`.
2. Attach:
   - lane summary table
   - changed contracts
   - transition matrix diff
   - writer sequence proof
   - parity report
   - rollback drill evidence
3. Require maintainer review for:
   - `src/resources/extensions/gsd/uok/**`
   - `src/resources/extensions/gsd/state*`
   - `src/resources/extensions/gsd/auto/**`
   - `src/resources/extensions/github-sync/**`
4. Confirm docs explain emergency fallback:
   - preference flag
   - environment variable
   - expected audit/parity signal

### Exit Criteria

- Release candidate PR is approved.
- CI and required checks pass.
- No unresolved P0/P1 risks remain.

## Phase 5: Post-Merge Monitoring

**Goal:** Catch regressions caused by real-world dispatch volume and team workflow use.

### Monitoring Signals

- Dispatches without reason codes.
- Transition attempts not covered by the matrix.
- Duplicate writer sequence ids.
- Audit/gitops sequence gaps.
- Parity mismatches.
- PR cycle time per lane.
- Emergency fallback invocations.

### Follow-Up Windows

- 24 hours after merge: review first production/dogfood parity and audit signals.
- 72 hours after merge: review open regression issues and PR lead time.
- One release cycle after merge: decide whether any compatibility shims can be removed.

## Risk Register

| Risk | Detection | Mitigation |
| --- | --- | --- |
| Hidden state transition remains | matrix coverage test or replay mismatch | block merge until transition is modeled or explicitly exempted |
| Dual writer race | duplicate or out-of-order sequence id | writer token plus queue/reject policy |
| Dispatch contract drift | typecheck or envelope fixture failure | contract-first PR order and hub arbitration |
| UOK/legacy drift | parity report mismatch | block release unless mismatch is documented non-critical |
| GitHub routine bottleneck | PR lead time over 24h | smaller lane PRs and targeted required checks |
| Emergency fallback overuse | fallback audit events | require issue link and postmortem for each fallback use |

## Definition of Done

- Scheduler path is chosen from one typed contract.
- State transition matrix is checked in and covered by tests.
- Single writer token and sequence records correlate state, audit, and gitops writes.
- UOK is default-on, with legacy fallback emergency-only.
- Parity report is generated for release candidate branches.
- GitHub Sync lane labels, PR evidence body routines, and release checklist body routines are in place.
- Full integration verification passes or has explicit, owned release-blocking exceptions.

## Hub Command Routine

```bash
git fetch origin

# Review and test a lane branch.
git checkout lane/<name>
npm run typecheck:extensions
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test <lane-targeted-tests>

# Merge to integration branch. Hub only.
git checkout integration/uok-swarm
git merge --no-ff lane/<name>
npm run typecheck:extensions
npm run test:unit

# Publish integration status.
git push origin integration/uok-swarm
```

## Minimum Targeted Test Pack by Lane

```bash
# Workflow engine lane
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/uok-contracts.test.ts \
  src/resources/extensions/gsd/tests/uok-execution-graph.test.ts \
  src/resources/extensions/gsd/tests/custom-workflow-engine.test.ts \
  src/resources/extensions/gsd/tests/workflow-dispatch.test.ts

# State machine lane
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/state-machine-full-walkthrough.test.ts \
  src/resources/extensions/gsd/tests/state-derivation-parity.test.ts \
  src/resources/extensions/gsd/tests/crash-recovery.test.ts \
  src/resources/extensions/gsd/tests/derive-state-db-disk-reconcile.test.ts

# Single writer lane
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/write-gate.test.ts \
  src/resources/extensions/gsd/tests/stale-lockfile-recovery.test.ts \
  src/resources/extensions/gsd/tests/uok-audit-unified.test.ts \
  src/resources/extensions/gsd/tests/uok-gitops-turn-action.test.ts

# UOK control planes lane
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/uok-flags.test.ts \
  src/resources/extensions/gsd/tests/uok-kernel-path.test.ts \
  src/resources/extensions/gsd/tests/uok-model-policy.test.ts \
  src/resources/extensions/gsd/tests/uok-plan-v2-wiring.test.ts
```
