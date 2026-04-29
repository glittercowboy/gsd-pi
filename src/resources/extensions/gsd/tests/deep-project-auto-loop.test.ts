import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { runPreDispatch } from "../auto/phases.ts";
import { AutoSession } from "../auto/session.ts";
import { resolveUnitSupervisionTimeouts } from "../auto-timers.ts";
import { bootstrapAutoSession } from "../auto-start.ts";
import { postUnitPreVerification } from "../auto-post-unit.ts";
import { resolveDispatch, setResearchProjectPromptBuilderForTest } from "../auto-dispatch.ts";
import { resolveExpectedArtifactPath, verifyExpectedArtifact, writeBlockerPlaceholder } from "../auto-recovery.ts";
import { finalizeProjectResearchTimeout } from "../project-research-policy.ts";
import { resetRegistry } from "../rule-registry.ts";
import { approvalGateIdForUnit, isAwaitingUserInput, isExplicitApprovalResponse, shouldPauseForUserApprovalQuestion } from "../user-input-boundary.ts";
import {
  clearPendingAutoStart,
  checkDeepProjectSetupAfterTurn,
  clearPendingDeepProjectSetup,
  showSmartEntry,
  startDeepProjectSetupForeground,
} from "../guided-flow.ts";
import type { GSDPreferences } from "../preferences.ts";
import type { GSDState } from "../types.ts";

function makeBase(): string {
  const base = join(tmpdir(), `gsd-deep-project-loop-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
  return base;
}

function makeCommandBase(): string {
  const base = join(tmpdir(), `gsd-deep-project-command-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  writeFileSync(join(base, "package.json"), '{"name":"gsd-command-test"}\n');
  return base;
}

function makeEmptyState(): GSDState {
  return {
    phase: "pre-planning",
    activeMilestone: null,
    activeSlice: null,
    activeTask: null,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
  };
}

function makeNeedsDiscussionState(): GSDState {
  return {
    ...makeEmptyState(),
    phase: "needs-discussion",
    activeMilestone: { id: "M001", title: "Old light-mode milestone" },
    registry: [{ id: "M001", title: "Old light-mode milestone", status: "active" }],
  };
}

function makeExecutingState(): GSDState {
  return {
    ...makeEmptyState(),
    phase: "executing",
    activeMilestone: { id: "M001", title: "Core App" },
    activeSlice: { id: "S01", title: "Storage layer" },
    activeTask: { id: "T01", title: "Build storage contract" },
    registry: [{ id: "M001", title: "Core App", status: "active" }],
  };
}

function makePlanningState(): GSDState {
  return {
    ...makeEmptyState(),
    phase: "planning",
    activeMilestone: { id: "M001", title: "Core App" },
    activeSlice: { id: "S01", title: "Storage layer" },
    registry: [{ id: "M001", title: "Core App", status: "active" }],
  };
}

function writeCapturedDeepPrefs(base: string): void {
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    "---\nplanning_depth: deep\nworkflow_prefs_captured: true\n---\n",
  );
}

function writeValidProjectAndRequirements(base: string): void {
  const validProject = readFileSync(
    new URL("../schemas/__fixtures__/valid-project.md", import.meta.url),
    "utf-8",
  );
  const validRequirements = readFileSync(
    new URL("../schemas/__fixtures__/valid-requirements.md", import.meta.url),
    "utf-8",
  );
  writeFileSync(join(base, ".gsd", "PROJECT.md"), validProject);
  writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), validRequirements);
}

function makeRepo(): string {
  const base = makeBase();
  execFileSync("git", ["init"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: base });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: base });
  writeFileSync(join(base, "README.md"), "# test\n");
  execFileSync("git", ["add", "-A"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: base, stdio: "ignore" });
  return base;
}

function makeCtx(sessionId = "test-session") {
  const model = { provider: "claude-code", id: "claude-sonnet-4-6", contextWindow: 128000 };
  return {
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
    },
    model,
    modelRegistry: {
      getAvailable: () => [model],
      isProviderRequestReady: () => true,
      getProviderAuthMode: () => "oauth",
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => null,
      getEntries: () => [],
    },
  };
}

function makePi(messages: unknown[]) {
  let activeTools = [
    "ask_user_questions",
    "mcp__gsd-workflow__ask_user_questions",
    "read",
    "write",
    "edit",
    "bash",
    "gsd_summary_save",
  ];
  return {
    sendMessage: (message: unknown) => {
      messages.push(message);
    },
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => {
      activeTools = tools;
    },
    setModel: async () => true,
    emitAdjustToolSet: async () => null,
    events: { emit: () => {} },
  };
}

async function runNewProjectCommand(base: string, command: string): Promise<unknown[]> {
  const previousCwd = process.cwd();
  const previousGsdHome = process.env.GSD_HOME;
  const previousWorkflowPath = process.env.GSD_WORKFLOW_PATH;
  const previousProjectRoot = process.env.GSD_PROJECT_ROOT;
  const workflowPath = join(base, "GSD-WORKFLOW.md");
  writeFileSync(workflowPath, "# Test Workflow\n");

  try {
    process.env.GSD_HOME = join(base, ".test-gsd-home");
    process.env.GSD_WORKFLOW_PATH = workflowPath;
    delete process.env.GSD_PROJECT_ROOT;
    process.chdir(base);

    const messages: unknown[] = [];
    const { handleWorkflowCommand } = await import("../commands/handlers/workflow.ts");
    await handleWorkflowCommand(command, makeCtx(`command-${randomUUID()}`) as any, makePi(messages) as any);
    return messages;
  } finally {
    process.chdir(previousCwd);
    if (previousGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    if (previousWorkflowPath === undefined) delete process.env.GSD_WORKFLOW_PATH;
    else process.env.GSD_WORKFLOW_PATH = previousWorkflowPath;
    if (previousProjectRoot === undefined) delete process.env.GSD_PROJECT_ROOT;
    else process.env.GSD_PROJECT_ROOT = previousProjectRoot;

    try {
      const { closeDatabase } = await import("../gsd-db.ts");
      closeDatabase();
    } catch {}
  }
}

test("deep project setup: bootstrap can start auto-mode without an active milestone", async () => {
  const base = makeRepo();
  try {
    const s = new AutoSession();
    const ready = await bootstrapAutoSession(
      s,
      makeCtx() as any,
      {
        getThinkingLevel: () => "medium",
        getActiveTools: () => ["ask_user_questions", "read", "write", "edit", "bash"],
        events: { emit: () => {} },
      } as any,
      base,
      false,
      false,
      {
        shouldUseWorktreeIsolation: () => false,
        registerSigtermHandler: () => {},
        lockBase: () => base,
        buildResolver: () => ({}) as any,
      },
      {
        classification: "none",
        lock: null,
        pausedSession: null,
        state: null,
        recovery: null,
        recoveryPrompt: null,
        recoveryToolCallCount: 0,
        artifactSatisfied: false,
        hasResumableDiskState: false,
        isBootstrapCrash: false,
      },
    );

    assert.equal(ready, true);
    assert.equal(s.active, true);
    assert.equal(s.currentMilestoneId, null);
  } finally {
    try {
      const { closeDatabase } = await import("../gsd-db.ts");
      closeDatabase();
    } catch {}
    rmSync(base, { recursive: true, force: true });
  }
});

test("deep project setup: pre-dispatch can run before the first milestone exists", async () => {
  const base = makeBase();
  try {
    const s = new AutoSession();
    s.basePath = base;
    s.originalBasePath = base;
    s.resourceVersionOnStart = "test";

    let stopped = false;
    const deps = {
      checkResourcesStale: () => null,
      invalidateAllCaches: () => {},
      preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
      syncProjectRootToWorktree: () => {},
      deriveState: async () => makeEmptyState(),
      syncCmuxSidebar: () => {},
      stopAuto: async () => { stopped = true; },
      pauseAuto: async () => {},
      setActiveMilestoneId: () => {},
    } as any;

    let seq = 0;
    const result = await runPreDispatch(
      {
        ctx: makeCtx() as any,
        pi: {} as any,
        s,
        deps,
        prefs: { planning_depth: "deep" } as GSDPreferences,
        iteration: 1,
        flowId: "test-flow",
        nextSeq: () => ++seq,
      },
      { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 },
    );

    assert.equal(stopped, false);
    assert.equal(result.action, "next");
    if (result.action === "next") {
      assert.equal(result.data.mid, "PROJECT");
      assert.equal(result.data.midTitle, "Project setup");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("deep project setup: pre-dispatch takes precedence over an existing draft milestone", async () => {
  const base = makeBase();
  try {
    const s = new AutoSession();
    s.basePath = base;
    s.originalBasePath = base;
    s.resourceVersionOnStart = "test";

    const deps = {
      checkResourcesStale: () => null,
      invalidateAllCaches: () => {},
      preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
      syncProjectRootToWorktree: () => {},
      deriveState: async () => makeNeedsDiscussionState(),
      syncCmuxSidebar: () => {},
      stopAuto: async () => {},
      pauseAuto: async () => {},
      setActiveMilestoneId: () => { throw new Error("must not activate milestone before deep project setup"); },
    } as any;

    let seq = 0;
    const result = await runPreDispatch(
      {
        ctx: makeCtx() as any,
        pi: {} as any,
        s,
        deps,
        prefs: { planning_depth: "deep" } as GSDPreferences,
        iteration: 1,
        flowId: "test-flow",
        nextSeq: () => ++seq,
      },
      { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 },
    );

    assert.equal(result.action, "next");
    if (result.action === "next") {
      assert.equal(result.data.mid, "PROJECT");
      assert.equal(s.currentMilestoneId, null);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("deep project setup: pending setup bypasses plan-v2 execution gate", async () => {
  const base = makeBase();
  try {
    const s = new AutoSession();
    s.basePath = base;
    s.originalBasePath = base;
    s.resourceVersionOnStart = "test";

    let paused = false;
    const deps = {
      checkResourcesStale: () => null,
      invalidateAllCaches: () => {},
      preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
      syncProjectRootToWorktree: () => {},
      deriveState: async () => makeExecutingState(),
      syncCmuxSidebar: () => {},
      stopAuto: async () => {},
      pauseAuto: async () => { paused = true; },
      setActiveMilestoneId: () => { throw new Error("must not activate milestone before deep project setup"); },
    } as any;

    let seq = 0;
    const result = await runPreDispatch(
      {
        ctx: makeCtx() as any,
        pi: {} as any,
        s,
        deps,
        prefs: { planning_depth: "deep", uok: { plan_v2: { enabled: true } } } as GSDPreferences,
        iteration: 1,
        flowId: "test-flow",
        nextSeq: () => ++seq,
      },
      { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 },
    );

    assert.equal(paused, false);
    assert.equal(result.action, "next");
    if (result.action === "next") {
      assert.equal(result.data.mid, "PROJECT");
      assert.equal(result.data.state.phase, "pre-planning");
      assert.equal(result.data.state.activeMilestone, null);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("deep project setup: pre-dispatch does not rewrite execution state to PROJECT", async () => {
  const base = makeBase();
  try {
    writeCapturedDeepPrefs(base);
    writeValidProjectAndRequirements(base);
    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(join(base, ".gsd", "runtime", "research-decision.json"), JSON.stringify({ decision: "skip" }));

    const s = new AutoSession();
    s.basePath = base;
    s.originalBasePath = base;
    s.resourceVersionOnStart = "test";

    let activeMilestoneId: string | null = null;
    const deps = {
      checkResourcesStale: () => null,
      invalidateAllCaches: () => {},
      preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
      syncProjectRootToWorktree: () => {},
      deriveState: async () => makeExecutingState(),
      syncCmuxSidebar: () => {},
      stopAuto: async () => {},
      pauseAuto: async () => {},
      setActiveMilestoneId: (_base: string, mid: string) => { activeMilestoneId = mid; },
      reconcileMergeState: () => "clean",
    } as any;

    let seq = 0;
    const result = await runPreDispatch(
      {
        ctx: makeCtx() as any,
        pi: {} as any,
        s,
        deps,
        prefs: { planning_depth: "deep", uok: { plan_v2: { enabled: false } } } as GSDPreferences,
        iteration: 1,
        flowId: "test-flow",
        nextSeq: () => ++seq,
      },
      { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 },
    );

    assert.equal(result.action, "next");
    if (result.action === "next") {
      assert.equal(result.data.mid, "M001");
      assert.equal(result.data.midTitle, "Core App");
      assert.equal(s.currentMilestoneId, "M001");
      assert.equal(activeMilestoneId, "M001");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("deep project setup: pending project research cannot dispatch PROJECT/S01", async (t) => {
  const base = makeBase();
  const restorePromptBuilder = setResearchProjectPromptBuilderForTest(async () => "research prompt");
  t.after(restorePromptBuilder);

  try {
    writeCapturedDeepPrefs(base);
    writeValidProjectAndRequirements(base);
    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "runtime", "research-decision.json"),
      JSON.stringify({ decision: "research", source: "research-decision" }),
    );

    const s = new AutoSession();
    s.basePath = base;
    s.originalBasePath = base;
    s.resourceVersionOnStart = "test";

    const deps = {
      checkResourcesStale: () => null,
      invalidateAllCaches: () => {},
      preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
      syncProjectRootToWorktree: () => {},
      deriveState: async () => makePlanningState(),
      syncCmuxSidebar: () => {},
      stopAuto: async () => {},
      pauseAuto: async () => {},
      setActiveMilestoneId: () => { throw new Error("must not activate milestone while project research is pending"); },
    } as any;

    let seq = 0;
    const result = await runPreDispatch(
      {
        ctx: makeCtx() as any,
        pi: {} as any,
        s,
        deps,
        prefs: { planning_depth: "deep" } as GSDPreferences,
        iteration: 1,
        flowId: "test-flow",
        nextSeq: () => ++seq,
      },
      { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 },
    );

    assert.equal(result.action, "next");
    if (result.action !== "next") return;

    assert.equal(result.data.mid, "PROJECT");
    assert.equal(result.data.state.phase, "pre-planning");
    assert.equal(result.data.state.activeSlice, null);
    assert.equal(result.data.state.activeTask, null);

    resetRegistry();
    const dispatch = await resolveDispatch({
      basePath: base,
      mid: result.data.mid,
      midTitle: result.data.midTitle,
      state: result.data.state,
      prefs: { planning_depth: "deep" } as GSDPreferences,
      structuredQuestionsAvailable: "false",
    });

    assert.equal(dispatch.action, "dispatch");
    if (dispatch.action === "dispatch") {
      assert.equal(dispatch.unitType, "research-project");
      assert.equal(dispatch.unitId, "RESEARCH-PROJECT");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("deep project setup: new-project command only writes planning_depth with --deep", async () => {
  const lightBase = makeCommandBase();
  const deepBase = makeCommandBase();
  try {
    const lightMessages = await runNewProjectCommand(lightBase, "new-project");
    const lightPrefsPath = join(lightBase, ".gsd", "PREFERENCES.md");
    if (existsSync(lightPrefsPath)) {
      assert.doesNotMatch(
        readFileSync(lightPrefsPath, "utf-8"),
        /planning_depth\s*:/,
        "plain /gsd new-project must not persist planning_depth",
      );
    }
    assert.equal(lightMessages.length, 1, "plain new-project should still dispatch the normal first milestone discussion");

    const deepMessages = await runNewProjectCommand(deepBase, "new-project --deep");
    const deepPrefs = readFileSync(join(deepBase, ".gsd", "PREFERENCES.md"), "utf-8");
    assert.match(deepPrefs, /planning_depth:\s*deep/);
    assert.match(deepPrefs, /workflow_prefs_captured:\s*true/);
    assert.equal(deepMessages.length, 1, "deep new-project should dispatch the foreground project setup interview");
    assert.match(String((deepMessages[0] as any).content), /Foreground Deep Setup Question Policy/);
  } finally {
    clearPendingAutoStart(lightBase);
    clearPendingDeepProjectSetup(deepBase);
    rmSync(lightBase, { recursive: true, force: true });
    rmSync(deepBase, { recursive: true, force: true });
  }
});

test("deep project setup: new-project asks interview stages in foreground", async () => {
  const base = makeBase();
  const previousWorkflowPath = process.env.GSD_WORKFLOW_PATH;
  process.env.GSD_WORKFLOW_PATH = join(base, "GSD-WORKFLOW.md");
  writeFileSync(process.env.GSD_WORKFLOW_PATH, "# Test Workflow\n");

  try {
    const messages: any[] = [];
    const ctx = makeCtx() as any;
    const pi = makePi(messages) as any;

    await startDeepProjectSetupForeground(ctx, pi, base, false);

    assert.equal(messages.length, 1);
    assert.match(
      messages[0].content,
      /What do you want to build\?/,
      "deep setup should ask the project question in the foreground conversation",
    );
    assert.match(
      messages[0].content,
      /Structured questions available:\s*false/,
      "foreground deep setup should force plain-chat questions even when question tools are active",
    );
    assert.match(
      messages[0].content,
      /Do NOT call `ask_user_questions`/,
      "foreground deep setup should explicitly forbid the cancellable question tool path",
    );

    const stillWaiting = await checkDeepProjectSetupAfterTurn(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "What do you want to build?" }],
          },
        ],
      },
      ctx,
    );
    assert.equal(stillWaiting, false);
    assert.equal(messages.length, 1, "question turns without artifacts must not redispatch or auto-pause");

    const validProject = readFileSync(
      new URL("../schemas/__fixtures__/valid-project.md", import.meta.url),
      "utf-8",
    );
    writeFileSync(join(base, ".gsd", "PROJECT.md"), validProject);

    const advanced = await checkDeepProjectSetupAfterTurn(
      { messages: [{ role: "assistant", content: "Project captured." }] },
      ctx,
    );

    assert.equal(advanced, true);
    assert.equal(messages.length, 2);
    assert.match(
      messages[1].content,
      /REQUIREMENTS\.md/,
      "after PROJECT.md exists, deep setup should foreground the requirements interview",
    );
    assert.match(
      messages[1].content,
      /Structured questions available:\s*false/,
      "requirements foreground setup should also force plain-chat questions",
    );
  } finally {
    clearPendingDeepProjectSetup(base);
    if (previousWorkflowPath === undefined) {
      delete process.env.GSD_WORKFLOW_PATH;
    } else {
      process.env.GSD_WORKFLOW_PATH = previousWorkflowPath;
    }
    rmSync(base, { recursive: true, force: true });
  }
});

test("deep project setup: unrelated agent_end sessions do not advance pending setup", async () => {
  const base = makeBase();
  const otherBase = makeBase();
  const previousWorkflowPath = process.env.GSD_WORKFLOW_PATH;
  process.env.GSD_WORKFLOW_PATH = join(base, "GSD-WORKFLOW.md");
  writeFileSync(process.env.GSD_WORKFLOW_PATH, "# Test Workflow\n");

  try {
    const messages: any[] = [];
    const deepCtx = makeCtx("deep-session") as any;
    const otherCtx = makeCtx("other-session") as any;
    const pi = makePi(messages) as any;

    await startDeepProjectSetupForeground(deepCtx, pi, base, false);
    assert.equal(messages.length, 1);

    const validProject = readFileSync(
      new URL("../schemas/__fixtures__/valid-project.md", import.meta.url),
      "utf-8",
    );
    writeFileSync(join(base, ".gsd", "PROJECT.md"), validProject);

    const ignored = await checkDeepProjectSetupAfterTurn(
      { messages: [{ role: "assistant", content: "Unrelated light workflow completed." }] },
      otherCtx,
      otherBase,
    );
    assert.equal(ignored, false);
    assert.equal(messages.length, 1, "unrelated session must not consume or advance pending deep setup");

    const advanced = await checkDeepProjectSetupAfterTurn(
      { messages: [{ role: "assistant", content: "Project captured." }] },
      deepCtx,
      base,
    );
    assert.equal(advanced, true);
    assert.equal(messages.length, 2, "owning session should still advance pending deep setup");
  } finally {
    clearPendingDeepProjectSetup(base);
    if (previousWorkflowPath === undefined) {
      delete process.env.GSD_WORKFLOW_PATH;
    } else {
      process.env.GSD_WORKFLOW_PATH = previousWorkflowPath;
    }
    rmSync(base, { recursive: true, force: true });
    rmSync(otherBase, { recursive: true, force: true });
  }
});

test("deep project setup: same project advances when agent_end session id changes", async () => {
  const base = makeBase();
  const previousWorkflowPath = process.env.GSD_WORKFLOW_PATH;
  process.env.GSD_WORKFLOW_PATH = join(base, "GSD-WORKFLOW.md");
  writeFileSync(process.env.GSD_WORKFLOW_PATH, "# Test Workflow\n");

  try {
    const messages: any[] = [];
    const startCtx = makeCtx("start-session") as any;
    const finishCtx = makeCtx("finish-session") as any;
    const pi = makePi(messages) as any;

    await startDeepProjectSetupForeground(startCtx, pi, base, false);
    assert.equal(messages.length, 1);

    const validProject = readFileSync(
      new URL("../schemas/__fixtures__/valid-project.md", import.meta.url),
      "utf-8",
    );
    writeFileSync(join(base, ".gsd", "PROJECT.md"), validProject);

    const advanced = await checkDeepProjectSetupAfterTurn(
      { messages: [{ role: "assistant", content: "Project captured." }] },
      finishCtx,
      base,
    );
    assert.equal(advanced, true);
    assert.equal(messages.length, 2, "same project should advance even if the agent_end session id changed");
  } finally {
    clearPendingDeepProjectSetup(base);
    if (previousWorkflowPath === undefined) {
      delete process.env.GSD_WORKFLOW_PATH;
    } else {
      process.env.GSD_WORKFLOW_PATH = previousWorkflowPath;
    }
    rmSync(base, { recursive: true, force: true });
  }
});

test("deep project setup: foreground dispatcher does not probe research-project rule", () => {
  const source = readFileSync(new URL("../guided-flow.ts", import.meta.url), "utf-8");
  const match = source.match(/const FOREGROUND_DEEP_SETUP_RULE_NAMES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(match, "foreground deep setup rule allowlist should be present");
  assert.doesNotMatch(
    match![1]!,
    /research-project/,
    "foreground setup must not evaluate research-project because that rule claims the inflight marker",
  );
  assert.match(source, /research-project have dispatch-time side effects/);
});

test("deep project setup: project-level units verify their real artifacts", () => {
  const base = makeBase();
  try {
    assert.equal(verifyExpectedArtifact("workflow-preferences", "WORKFLOW-PREFS", base), false);
    writeFileSync(
      join(base, ".gsd", "PREFERENCES.md"),
      "---\nplanning_depth: deep\nworkflow_prefs_captured: true\n---\n",
    );
    assert.equal(verifyExpectedArtifact("workflow-preferences", "WORKFLOW-PREFS", base), true);

    const validProject = readFileSync(
      new URL("../schemas/__fixtures__/valid-project.md", import.meta.url),
      "utf-8",
    );
    writeFileSync(join(base, ".gsd", "PROJECT.md"), validProject);
    assert.equal(verifyExpectedArtifact("discuss-project", "PROJECT", base), true);
    writeFileSync(join(base, ".gsd", "PROJECT.md"), "# Project\n");
    assert.equal(verifyExpectedArtifact("discuss-project", "PROJECT", base), false);

    const validRequirements = readFileSync(
      new URL("../schemas/__fixtures__/valid-requirements.md", import.meta.url),
      "utf-8",
    );
    writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), validRequirements);
    assert.equal(verifyExpectedArtifact("discuss-requirements", "REQUIREMENTS", base), true);

    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(join(base, ".gsd", "runtime", "research-decision.json"), '{"decision":"maybe"}\n');
    assert.equal(verifyExpectedArtifact("research-decision", "RESEARCH-DECISION", base), false);
    writeFileSync(join(base, ".gsd", "runtime", "research-decision.json"), '{"decision":"skip"}\n');
    assert.equal(verifyExpectedArtifact("research-decision", "RESEARCH-DECISION", base), true);

    const researchDir = join(base, ".gsd", "research");
    mkdirSync(researchDir, { recursive: true });
    writeFileSync(join(researchDir, "STACK.md"), "# Stack\n");
    writeFileSync(join(researchDir, "FEATURES.md"), "# Features\n");
    writeFileSync(join(researchDir, "ARCHITECTURE.md"), "# Architecture\n");
    assert.equal(verifyExpectedArtifact("research-project", "PROJECT-RESEARCH", base), false);
    writeFileSync(join(researchDir, "PITFALLS-BLOCKER.md"), "# Blocked\n");
    assert.equal(verifyExpectedArtifact("research-project", "PROJECT-RESEARCH", base), true);

    for (const name of ["STACK.md", "FEATURES.md", "ARCHITECTURE.md"]) {
      rmSync(join(researchDir, name), { force: true });
    }
    for (const name of ["STACK", "FEATURES", "ARCHITECTURE"]) {
      writeFileSync(join(researchDir, `${name}-BLOCKER.md`), "# Blocked\n");
    }
    assert.equal(verifyExpectedArtifact("research-project", "PROJECT-RESEARCH", base), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("deep project setup: research-project blocker placeholder is a file, not the research directory", () => {
  const base = makeBase();
  try {
    const expectedPath = resolveExpectedArtifactPath("research-project", "PROJECT-RESEARCH", base);
    assert.equal(expectedPath, join(base, ".gsd", "research", "PROJECT-RESEARCH-BLOCKER.md"));

    mkdirSync(join(base, ".gsd", "research"), { recursive: true });
    const diagnosis = writeBlockerPlaceholder(
      "research-project",
      "PROJECT-RESEARCH",
      base,
      "test recovery",
    );

    assert.match(diagnosis ?? "", /research/i);
    assert.equal(existsSync(join(base, ".gsd", "research", "PROJECT-RESEARCH-BLOCKER.md")), true);
    assert.match(
      readFileSync(join(base, ".gsd", "research", "PROJECT-RESEARCH-BLOCKER.md"), "utf-8"),
      /fail-closed/,
    );
    assert.equal(
      verifyExpectedArtifact("research-project", "PROJECT-RESEARCH", base),
      false,
      "project research blocker placeholders must not satisfy the research gate",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("deep project setup: research-project partial output writes dimension blockers instead of retrying", async () => {
  const base = makeBase();
  try {
    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "research-project", id: "RESEARCH-PROJECT", startedAt: Date.now() };

    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(join(base, ".gsd", "runtime", "research-project-inflight"), "{}\n");
    mkdirSync(join(base, ".gsd", "research"), { recursive: true });
    writeFileSync(join(base, ".gsd", "research", "STACK.md"), "# Stack\n");

    const notifications: string[] = [];
    const result = await postUnitPreVerification(
      {
        s,
        ctx: { ui: { notify: (message: string) => notifications.push(message) } } as any,
        pi: {} as any,
        buildSnapshotOpts: () => ({}) as any,
        lockBase: () => base,
        stopAuto: async () => {},
        pauseAuto: async () => {},
        updateProgressWidget: () => {},
      },
      { skipSettleDelay: true, skipWorktreeSync: true },
    );

    assert.equal(result, "continue");
    assert.equal(existsSync(join(base, ".gsd", "runtime", "research-project-inflight")), false);
    for (const name of ["FEATURES", "ARCHITECTURE", "PITFALLS"]) {
      assert.equal(existsSync(join(base, ".gsd", "research", `${name}-BLOCKER.md`)), true);
    }
    assert.equal(verifyExpectedArtifact("research-project", "RESEARCH-PROJECT", base), true);
    assert.equal(s.pendingVerificationRetry, null);
    assert.equal(s.verificationRetryCount.size, 0);
    assert.ok(
      notifications.some((message) => message.includes("without rerunning all scouts")),
      "should notify that partial research was finalized without another full fan-out",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("deep project setup: research-project empty output writes global blocker without retrying", async () => {
  const base = makeBase();
  try {
    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "research-project", id: "RESEARCH-PROJECT", startedAt: Date.now() };

    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(join(base, ".gsd", "runtime", "research-project-inflight"), "{}\n");

    const notifications: string[] = [];
    const result = await postUnitPreVerification(
      {
        s,
        ctx: { ui: { notify: (message: string) => notifications.push(message) } } as any,
        pi: {} as any,
        buildSnapshotOpts: () => ({}) as any,
        lockBase: () => base,
        stopAuto: async () => {},
        pauseAuto: async () => {},
        updateProgressWidget: () => {},
      },
      { skipSettleDelay: true, skipWorktreeSync: true },
    );

    assert.equal(result, "continue");
    assert.equal(existsSync(join(base, ".gsd", "runtime", "research-project-inflight")), false);
    assert.equal(existsSync(join(base, ".gsd", "research", "PROJECT-RESEARCH-BLOCKER.md")), true);
    assert.equal(verifyExpectedArtifact("research-project", "RESEARCH-PROJECT", base), false);
    assert.equal(s.pendingVerificationRetry, null);
    assert.equal(s.verificationRetryCount.size, 0);
    assert.ok(
      notifications.some((message) => message.includes("PROJECT-RESEARCH-BLOCKER.md")),
      "should notify that project research is fail-closed",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("deep project setup: project research timeout finalizer removes stale marker", () => {
  const base = makeBase();
  try {
    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(join(base, ".gsd", "runtime", "research-project-inflight"), "{}\n");

    const outcome = finalizeProjectResearchTimeout(base, "test hard timeout");

    assert.equal(outcome.kind, "global-blocker");
    assert.equal(existsSync(join(base, ".gsd", "runtime", "research-project-inflight")), false);
    assert.equal(existsSync(join(base, ".gsd", "research", "PROJECT-RESEARCH-BLOCKER.md")), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("deep project setup: research-project supervision timeout is capped narrowly", () => {
  const defaults = {
    soft_timeout_minutes: 20,
    idle_timeout_minutes: 10,
    hard_timeout_minutes: 30,
  };

  assert.deepEqual(
    resolveUnitSupervisionTimeouts("research-project", defaults, 1),
    {
      softTimeoutMs: 3 * 60 * 1000,
      idleTimeoutMs: 10 * 60 * 1000,
      hardTimeoutMs: 5 * 60 * 1000,
    },
  );

  assert.deepEqual(
    resolveUnitSupervisionTimeouts("research-project", {
      soft_timeout_minutes: 2,
      idle_timeout_minutes: 10,
      hard_timeout_minutes: 4,
    }, 1),
    {
      softTimeoutMs: 2 * 60 * 1000,
      idleTimeoutMs: 10 * 60 * 1000,
      hardTimeoutMs: 4 * 60 * 1000,
    },
  );

  assert.deepEqual(
    resolveUnitSupervisionTimeouts("plan-slice", defaults, 2),
    {
      softTimeoutMs: 40 * 60 * 1000,
      idleTimeoutMs: 10 * 60 * 1000,
      hardTimeoutMs: 60 * 60 * 1000,
    },
  );
});

test("deep project setup: empty legacy pseudo-milestone dirs do not block first real milestone", async () => {
  const base = makeBase();
  const previousWorkflowPath = process.env.GSD_WORKFLOW_PATH;
  const workflowPath = join(base, "GSD-WORKFLOW.md");
  try {
    writeFileSync(workflowPath, "# Test Workflow\n");
    process.env.GSD_WORKFLOW_PATH = workflowPath;

    const validProject = readFileSync(
      new URL("../schemas/__fixtures__/valid-project.md", import.meta.url),
      "utf-8",
    );
    const validRequirements = readFileSync(
      new URL("../schemas/__fixtures__/valid-requirements.md", import.meta.url),
      "utf-8",
    );
    writeFileSync(
      join(base, ".gsd", "PREFERENCES.md"),
      "---\nplanning_depth: deep\nworkflow_prefs_captured: true\n---\n",
    );
    writeFileSync(join(base, ".gsd", "PROJECT.md"), validProject);
    writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), validRequirements);
    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(join(base, ".gsd", "runtime", "research-decision.json"), '{"decision":"skip"}\n');

    for (const legacy of ["PROJECT", "RESEARCH-PROJECT", "WORKFLOW-PREFS"]) {
      mkdirSync(join(base, ".gsd", "milestones", legacy), { recursive: true });
    }

    const messages: unknown[] = [];
    await showSmartEntry(makeCtx(`legacy-${randomUUID()}`) as any, makePi(messages) as any, base);

    assert.equal(messages.length, 1, "first real milestone discussion should dispatch");
    assert.equal(existsSync(join(base, ".gsd", "milestones", "PROJECT")), false);
    assert.equal(existsSync(join(base, ".gsd", "milestones", "RESEARCH-PROJECT")), false);
    assert.equal(existsSync(join(base, ".gsd", "milestones", "WORKFLOW-PREFS")), false);
  } finally {
    if (previousWorkflowPath === undefined) delete process.env.GSD_WORKFLOW_PATH;
    else process.env.GSD_WORKFLOW_PATH = previousWorkflowPath;
    clearPendingAutoStart(base);
    try {
      const { closeDatabase } = await import("../gsd-db.ts");
      closeDatabase();
    } catch {}
    rmSync(base, { recursive: true, force: true });
  }
});

test("deep project setup: project question pauses instead of artifact-retrying", async () => {
  const base = makeBase();
  try {
    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "discuss-project", id: "PROJECT", startedAt: Date.now() };

    let pauseCalled = false;
    const notifications: string[] = [];
    const result = await postUnitPreVerification(
      {
        s,
        ctx: { ui: { notify: (message: string) => notifications.push(message) } } as any,
        pi: {} as any,
        buildSnapshotOpts: () => ({}) as any,
        lockBase: () => base,
        stopAuto: async () => {},
        pauseAuto: async () => { pauseCalled = true; },
        updateProgressWidget: () => {},
      },
      {
        skipSettleDelay: true,
        skipWorktreeSync: true,
        agentEndMessages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "What do you want to build?\n\nOptions:\n1. New app\n2. Existing app" },
            ],
          },
        ],
      },
    );

    assert.equal(result, "dispatched");
    assert.equal(pauseCalled, true);
    assert.equal(s.pendingVerificationRetry, null);
    assert.equal(s.verificationRetryCount.size, 0);
    assert.ok(
      notifications.some((message) => message.includes("waiting for your input")),
      "should notify that the project unit is waiting for user input",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("deep project setup: remote question failure is treated as waiting for user input", () => {
  assert.equal(
    isAwaitingUserInput([
      {
        role: "toolResult",
        content: "Remote questions failed (discord): Discord API HTTP 401",
      },
    ]),
    true,
  );
});

test("deep project setup: plain-text approval wait is treated as waiting for user input", () => {
  assert.equal(
    isAwaitingUserInput([
      {
        role: "assistant",
        content: "Good, PROJECT.md confirms localStorage for persistence. Requirements look solid. Waiting for your confirmation before writing.",
      },
    ]),
    true,
  );
});

test("deep project setup: opening interview question does not trigger approval abort", () => {
  const messages = [
    {
      role: "assistant",
      content: "What do you want to build?",
    },
  ];

  assert.equal(isAwaitingUserInput(messages), true);
  assert.equal(shouldPauseForUserApprovalQuestion("discuss-project", messages), false);
});

test("deep project setup: grounding interview question with requirements context does not trigger approval abort", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        "I will use this to draft requirements.",
        "Grounding question: is this purely local/offline, or do you want tasks to persist across browser sessions/devices (local storage vs. a backend)?",
      ].join("\n"),
    },
  ];

  assert.equal(isAwaitingUserInput(messages), true);
  assert.equal(shouldPauseForUserApprovalQuestion("discuss-project", messages), false);
});

test("deep project setup: persistence and anti-goals interview prompt does not trigger approval abort", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        "Greenfield, personal, plain HTML/CSS/JS, core value is create and check off tasks.",
        "",
        "A couple more:",
        "",
        "1. Persistence? Should tasks survive a page refresh (localStorage), or is it fine if they reset on reload?",
        "2. Anti-goals - what would you explicitly not want? (e.g., no user accounts, no backend, no categories/tags, no due dates - or something else)",
      ].join("\n"),
    },
  ];

  assert.equal(isAwaitingUserInput(messages), true);
  assert.equal(shouldPauseForUserApprovalQuestion("discuss-project", messages), false);
});

test("deep project setup: discovery questions before writing PROJECT do not trigger approval abort", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        "Good. Greenfield HTML/CSS/JS to-do app, personal use, core feature is create and check off tasks.",
        "",
        "Two more questions before I write PROJECT.md:",
        "",
        "1. Any persistence? Should tasks survive a page refresh - localStorage, or is in-memory fine for now?",
        "2. Rough milestone shape? Is M001 \"basic create/complete list that works in a browser,\" or do you have a v2 in mind (e.g., edit/delete, due dates, categories)?",
      ].join("\n"),
    },
  ];

  assert.equal(isAwaitingUserInput(messages), true);
  assert.equal(shouldPauseForUserApprovalQuestion("discuss-project", messages), false);
});

test("deep project setup: discovery question mentioning write intent does not trigger approval abort", () => {
  const messages = [
    {
      role: "assistant",
      content: "Before I write PROJECT, any persistence?",
    },
  ];

  assert.equal(isAwaitingUserInput(messages), true);
  assert.equal(shouldPauseForUserApprovalQuestion("discuss-project", messages), false);
});

test("deep project setup: scope discovery question mentioning add does not trigger approval abort", () => {
  const messages = [
    {
      role: "assistant",
      content: "Should the basic milestone add delete support, or keep delete for a later v2?",
    },
  ];

  assert.equal(isAwaitingUserInput(messages), true);
  assert.equal(shouldPauseForUserApprovalQuestion("discuss-project", messages), false);
});

test("deep project setup: requirements preview question from screenshot is treated as waiting", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        "Proposed requirements:",
        "",
        "| ID | Title | Class | Status | Owner | Source |",
        "| --- | --- | --- | --- | --- | --- |",
        "| R001 | User can add a task | primary-user-loop | active | M001/none yet | user |",
        "",
        "Does this look right? Anything to add, remove, or reclassify?",
      ].join("\n"),
    },
  ];

  assert.equal(isAwaitingUserInput(messages), true);
  assert.equal(shouldPauseForUserApprovalQuestion("discuss-requirements", messages), true);
});

test("deep project setup: research decision question triggers approval boundary pause", () => {
  assert.equal(
    shouldPauseForUserApprovalQuestion("research-decision", [
      {
        role: "assistant",
        content: "Run domain research now? (y/n)",
      },
    ]),
    true,
  );
});

test("deep project setup: plain-text approval questions map to write-gate ids", () => {
  assert.equal(approvalGateIdForUnit("discuss-project", "PROJECT"), "depth_verification_project_confirm");
  assert.equal(approvalGateIdForUnit("discuss-requirements", "REQUIREMENTS"), "depth_verification_requirements_confirm");
  assert.equal(approvalGateIdForUnit("discuss-milestone", "M001"), "depth_verification_M001_confirm");
  assert.equal(approvalGateIdForUnit("research-decision", "RESEARCH-DECISION"), "depth_verification_research_decision_confirm");
});

test("deep project setup: plain-text approval gate clears only on explicit approval", () => {
  assert.equal(isExplicitApprovalResponse("yes, looks good"), true);
  assert.equal(isExplicitApprovalResponse("go ahead and write it"), true);
  assert.equal(isExplicitApprovalResponse("yes, add delete support first"), false);
  assert.equal(isExplicitApprovalResponse("not quite, remove the due date"), false);
  assert.equal(isExplicitApprovalResponse("research", "depth_verification_research_decision_confirm"), true);
});

test("deep project setup: discuss-milestone question failure pauses instead of artifact-retrying", async () => {
  const base = makeBase();
  try {
    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "discuss-milestone", id: "PROJECT", startedAt: Date.now() };

    let pauseCalled = false;
    const notifications: string[] = [];
    const result = await postUnitPreVerification(
      {
        s,
        ctx: { ui: { notify: (message: string) => notifications.push(message) } } as any,
        pi: {} as any,
        buildSnapshotOpts: () => ({}) as any,
        lockBase: () => base,
        stopAuto: async () => {},
        pauseAuto: async () => { pauseCalled = true; },
        updateProgressWidget: () => {},
      },
      {
        skipSettleDelay: true,
        skipWorktreeSync: true,
        agentEndMessages: [
          {
            role: "toolResult",
            content: "Remote questions failed (discord): Discord API HTTP 401",
          },
        ],
      },
    );

    assert.equal(result, "dispatched");
    assert.equal(pauseCalled, true);
    assert.equal(s.pendingVerificationRetry, null);
    assert.equal(s.verificationRetryCount.size, 0);
    assert.ok(
      notifications.some((message) => message.includes("waiting for your input")),
      "should notify that the discuss unit is waiting for user input",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("deep project setup: approval wait wins over deterministic write-gate placeholder", async () => {
  const base = makeBase();
  try {
    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "discuss-requirements", id: "REQUIREMENTS", startedAt: Date.now() };
    s.lastToolInvocationError = "gsd_summary_save: Error saving artifact: root_artifact_write_blocked";
    s.verificationRetryCount.set("discuss-requirements:REQUIREMENTS", 2);

    let pauseCalled = false;
    const notifications: string[] = [];
    const result = await postUnitPreVerification(
      {
        s,
        ctx: { ui: { notify: (message: string) => notifications.push(message) } } as any,
        pi: {} as any,
        buildSnapshotOpts: () => ({}) as any,
        lockBase: () => base,
        stopAuto: async () => {},
        pauseAuto: async () => { pauseCalled = true; },
        updateProgressWidget: () => {},
      },
      {
        skipSettleDelay: true,
        skipWorktreeSync: true,
        agentEndMessages: [
          {
            role: "assistant",
            content: "Requirements look solid. Waiting for your confirmation before writing.",
          },
        ],
      },
    );

    assert.equal(result, "dispatched");
    assert.equal(pauseCalled, true);
    assert.equal(s.lastToolInvocationError, null);
    assert.equal(existsSync(join(base, ".gsd", "REQUIREMENTS.md")), false);
    assert.ok(
      notifications.some((message) => message.includes("waiting for your input")),
      "should pause on the user wait instead of writing a blocker placeholder",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
