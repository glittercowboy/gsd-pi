import test from "node:test";
import assert from "node:assert/strict";
import {
  WorktreeResolver,
  type WorktreeResolverDeps,
  type NotifyCtx,
} from "../worktree-resolver.js";
import { AutoSession } from "../auto/session.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Track calls to mock deps for assertion. */
interface CallLog {
  fn: string;
  args: unknown[];
}

function makeSession(
  overrides?: Partial<{ basePath: string; originalBasePath: string }>,
): AutoSession {
  const s = new AutoSession();
  s.basePath = overrides?.basePath ?? "/project";
  s.originalBasePath = overrides?.originalBasePath ?? "/project";
  return s;
}

function makeDeps(
  overrides?: Partial<WorktreeResolverDeps>,
): WorktreeResolverDeps & { calls: CallLog[] } {
  const calls: CallLog[] = [];

  const deps: WorktreeResolverDeps & { calls: CallLog[] } = {
    calls,
    isInAutoWorktree: (basePath: string) => {
      calls.push({ fn: "isInAutoWorktree", args: [basePath] });
      return false;
    },
    shouldUseWorktreeIsolation: () => {
      calls.push({ fn: "shouldUseWorktreeIsolation", args: [] });
      return true;
    },
    getIsolationMode: () => {
      calls.push({ fn: "getIsolationMode", args: [] });
      return "worktree";
    },
    mergeMilestoneToMain: (
      basePath: string,
      milestoneId: string,
      roadmapContent: string,
    ) => {
      calls.push({
        fn: "mergeMilestoneToMain",
        args: [basePath, milestoneId, roadmapContent],
      });
      return { pushed: false, codeFilesChanged: true };
    },
    syncWorktreeStateBack: (
      mainBasePath: string,
      worktreePath: string,
      milestoneId: string,
    ) => {
      calls.push({
        fn: "syncWorktreeStateBack",
        args: [mainBasePath, worktreePath, milestoneId],
      });
      return { synced: [] };
    },
    teardownAutoWorktree: (
      basePath: string,
      milestoneId: string,
      opts?: { preserveBranch?: boolean },
    ) => {
      calls.push({
        fn: "teardownAutoWorktree",
        args: [basePath, milestoneId, opts],
      });
    },
    createAutoWorktree: (basePath: string, milestoneId: string) => {
      calls.push({ fn: "createAutoWorktree", args: [basePath, milestoneId] });
      return `/project/.gsd/worktrees/${milestoneId}`;
    },
    enterAutoWorktree: (basePath: string, milestoneId: string) => {
      calls.push({ fn: "enterAutoWorktree", args: [basePath, milestoneId] });
      return `/project/.gsd/worktrees/${milestoneId}`;
    },
    getAutoWorktreePath: (basePath: string, milestoneId: string) => {
      calls.push({ fn: "getAutoWorktreePath", args: [basePath, milestoneId] });
      return null;
    },
    autoCommitCurrentBranch: (
      basePath: string,
      reason: string,
      milestoneId: string,
    ) => {
      calls.push({
        fn: "autoCommitCurrentBranch",
        args: [basePath, reason, milestoneId],
      });
    },
    getCurrentBranch: (basePath: string) => {
      calls.push({ fn: "getCurrentBranch", args: [basePath] });
      return "main";
    },
    autoWorktreeBranch: (milestoneId: string) => {
      calls.push({ fn: "autoWorktreeBranch", args: [milestoneId] });
      return `milestone/${milestoneId}`;
    },
    resolveMilestoneFile: (
      basePath: string,
      milestoneId: string,
      fileType: string,
    ) => {
      calls.push({
        fn: "resolveMilestoneFile",
        args: [basePath, milestoneId, fileType],
      });
      return `/project/.gsd/milestones/${milestoneId}/${milestoneId}-ROADMAP.md`;
    },
    readFileSync: (path: string, _encoding: string) => {
      calls.push({ fn: "readFileSync", args: [path] });
      return "# Roadmap\n- [x] S01: Slice one\n";
    },
    GitServiceImpl: class MockGitServiceImpl {
      basePath: string;
      gitConfig: unknown;
      constructor(basePath: string, gitConfig: unknown) {
        calls.push({ fn: "GitServiceImpl", args: [basePath, gitConfig] });
        this.basePath = basePath;
        this.gitConfig = gitConfig;
      }
    } as unknown as WorktreeResolverDeps["GitServiceImpl"],
    loadEffectiveGSDPreferences: () => {
      calls.push({ fn: "loadEffectiveGSDPreferences", args: [] });
      return { preferences: { git: {} } };
    },
    invalidateAllCaches: () => {
      calls.push({ fn: "invalidateAllCaches", args: [] });
    },
    captureIntegrationBranch: (
      basePath: string,
      mid: string | undefined,
    ) => {
      calls.push({
        fn: "captureIntegrationBranch",
        args: [basePath, mid],
      });
    },
    enterBranchModeForMilestone: (basePath: string, milestoneId: string) => {
      calls.push({ fn: "enterBranchModeForMilestone", args: [basePath, milestoneId] });
    },
    ...overrides,
  };

  // Re-apply overrides that add the call tracking
  if (overrides) {
    for (const [key, val] of Object.entries(overrides)) {
      if (key !== "calls") {
        (deps as unknown as Record<string, unknown>)[key] = val;
      }
    }
  }

  return deps;
}

function makeNotifyCtx(): NotifyCtx & {
  messages: Array<{ msg: string; level?: string }>;
} {
  const messages: Array<{ msg: string; level?: string }> = [];
  return {
    messages,
    notify: (msg: string, level?: "info" | "warning" | "error" | "success") => {
      messages.push({ msg, level });
    },
  };
}

function findCalls(calls: CallLog[], fn: string): CallLog[] {
  return calls.filter((c) => c.fn === fn);
}

// ─── Getter Tests ────────────────────────────────────────────────────────────

test("workPath returns s.basePath", () => {
  const s = makeSession({ basePath: "/project/.gsd/worktrees/M001" });
  const resolver = new WorktreeResolver(s, makeDeps());
  assert.equal(resolver.workPath, "/project/.gsd/worktrees/M001");
});

test("projectRoot returns originalBasePath when set", () => {
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  const resolver = new WorktreeResolver(s, makeDeps());
  assert.equal(resolver.projectRoot, "/project");
});

test("projectRoot falls back to basePath when originalBasePath is empty", () => {
  const s = makeSession({ basePath: "/project", originalBasePath: "" });
  const resolver = new WorktreeResolver(s, makeDeps());
  assert.equal(resolver.projectRoot, "/project");
});

test("lockPath returns originalBasePath when set (same as lockBase)", () => {
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  const resolver = new WorktreeResolver(s, makeDeps());
  assert.equal(resolver.lockPath, "/project");
});

test("lockPath falls back to basePath when originalBasePath is empty", () => {
  const s = makeSession({ basePath: "/project", originalBasePath: "" });
  const resolver = new WorktreeResolver(s, makeDeps());
  assert.equal(resolver.lockPath, "/project");
});

// ─── enterMilestone Tests ────────────────────────────────────────────────────

test("enterMilestone creates new worktree when none exists", () => {
  const s = makeSession();
  const deps = makeDeps({
    getAutoWorktreePath: () => null,
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.enterMilestone("M001", ctx);

  assert.equal(s.basePath, "/project/.gsd/worktrees/M001");
  assert.equal(findCalls(deps.calls, "createAutoWorktree").length, 1);
  assert.equal(findCalls(deps.calls, "enterAutoWorktree").length, 0);
  assert.equal(findCalls(deps.calls, "GitServiceImpl").length, 1);
  assert.ok(
    ctx.messages.some(
      (m) => m.level === "info" && m.msg.includes("Entered worktree"),
    ),
  );
});

test("enterMilestone enters existing worktree instead of creating", () => {
  const s = makeSession();
  const deps = makeDeps({
    getAutoWorktreePath: () => "/project/.gsd/worktrees/M001",
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.enterMilestone("M001", ctx);

  assert.equal(s.basePath, "/project/.gsd/worktrees/M001");
  assert.equal(findCalls(deps.calls, "enterAutoWorktree").length, 1);
  assert.equal(findCalls(deps.calls, "createAutoWorktree").length, 0);
});

test("enterMilestone is no-op when isolation mode is none", () => {
  const s = makeSession();
  const deps = makeDeps({
    getIsolationMode: () => "none",
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.enterMilestone("M001", ctx);

  assert.equal(s.basePath, "/project"); // unchanged
  assert.equal(findCalls(deps.calls, "createAutoWorktree").length, 0);
  assert.equal(findCalls(deps.calls, "enterAutoWorktree").length, 0);
  assert.equal(findCalls(deps.calls, "enterBranchModeForMilestone").length, 0);
});

test("enterMilestone does NOT update basePath on creation failure", () => {
  const s = makeSession();
  const deps = makeDeps({
    getAutoWorktreePath: () => null,
    createAutoWorktree: () => {
      throw new Error("disk full");
    },
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.enterMilestone("M001", ctx);

  assert.equal(s.basePath, "/project"); // unchanged — error recovery
  assert.ok(
    ctx.messages.some(
      (m) => m.level === "warning" && m.msg.includes("disk full"),
    ),
  );
});

test("enterMilestone uses originalBasePath as base for worktree ops", () => {
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  let createdFrom = "";
  const deps = makeDeps({
    getAutoWorktreePath: () => null,
    createAutoWorktree: (basePath: string, _mid: string) => {
      createdFrom = basePath;
      return "/project/.gsd/worktrees/M002";
    },
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.enterMilestone("M002", ctx);

  assert.equal(createdFrom, "/project"); // uses originalBasePath, not current basePath
});

// ─── enterMilestone Tests (branch mode) ──────────────────────────────────────

test("enterMilestone in branch mode calls enterBranchModeForMilestone and rebuilds GitService", () => {
  const s = makeSession();
  const deps = makeDeps({
    getIsolationMode: () => "branch",
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.enterMilestone("M001", ctx);

  // Branch mode: no worktree created, basePath unchanged
  assert.equal(s.basePath, "/project");
  assert.equal(findCalls(deps.calls, "enterBranchModeForMilestone").length, 1);
  assert.equal(findCalls(deps.calls, "createAutoWorktree").length, 0);
  assert.equal(findCalls(deps.calls, "enterAutoWorktree").length, 0);
  assert.equal(findCalls(deps.calls, "GitServiceImpl").length, 1);
  assert.ok(ctx.messages.some((m) => m.level === "info" && m.msg.includes("milestone/M001")));
});

test("enterMilestone in branch mode uses originalBasePath as base", () => {
  const s = makeSession({ basePath: "/project", originalBasePath: "/project" });
  let calledWith = "";
  const deps = makeDeps({
    getIsolationMode: () => "branch",
    enterBranchModeForMilestone: (basePath: string, _mid: string) => {
      calledWith = basePath;
    },
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.enterMilestone("M001", ctx);

  assert.equal(calledWith, "/project");
});

test("enterMilestone in branch mode degrades isolation on failure", () => {
  const s = makeSession();
  const deps = makeDeps({
    getIsolationMode: () => "branch",
    enterBranchModeForMilestone: () => {
      throw new Error("checkout failed");
    },
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.enterMilestone("M001", ctx);

  assert.equal(s.basePath, "/project"); // unchanged
  assert.ok(s.isolationDegraded);
  assert.ok(ctx.messages.some((m) => m.level === "warning" && m.msg.includes("checkout failed")));
});

test("enterMilestone branch mode is skipped when isolationDegraded", () => {
  const s = makeSession();
  s.isolationDegraded = true;
  const deps = makeDeps({
    getIsolationMode: () => "branch",
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.enterMilestone("M001", ctx);

  assert.equal(findCalls(deps.calls, "enterBranchModeForMilestone").length, 0);
  assert.equal(findCalls(deps.calls, "createAutoWorktree").length, 0);
});

// ─── exitMilestone Tests ─────────────────────────────────────────────────────

test("exitMilestone commits, tears down, and resets basePath", () => {
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  const deps = makeDeps({
    isInAutoWorktree: () => true,
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.exitMilestone("M001", ctx);

  assert.equal(s.basePath, "/project"); // reset to originalBasePath
  assert.equal(findCalls(deps.calls, "autoCommitCurrentBranch").length, 1);
  assert.equal(findCalls(deps.calls, "teardownAutoWorktree").length, 1);
  assert.equal(findCalls(deps.calls, "GitServiceImpl").length, 1); // rebuilt
  assert.equal(findCalls(deps.calls, "invalidateAllCaches").length, 1);
});

test("exitMilestone is no-op when not in worktree", () => {
  const s = makeSession();
  const deps = makeDeps({
    isInAutoWorktree: () => false,
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.exitMilestone("M001", ctx);

  assert.equal(s.basePath, "/project"); // unchanged
  assert.equal(findCalls(deps.calls, "autoCommitCurrentBranch").length, 0);
  assert.equal(findCalls(deps.calls, "teardownAutoWorktree").length, 0);
});

test("exitMilestone passes preserveBranch option", () => {
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  let preserveOpts: unknown = null;
  const deps = makeDeps({
    isInAutoWorktree: () => true,
    teardownAutoWorktree: (
      _basePath: string,
      _mid: string,
      opts?: { preserveBranch?: boolean },
    ) => {
      preserveOpts = opts;
    },
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.exitMilestone("M001", ctx, { preserveBranch: true });

  assert.deepEqual(preserveOpts, { preserveBranch: true });
});

test("exitMilestone still resets basePath even if auto-commit fails", () => {
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  const deps = makeDeps({
    isInAutoWorktree: () => true,
    autoCommitCurrentBranch: () => {
      throw new Error("commit error");
    },
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.exitMilestone("M001", ctx);

  // Should still complete: reset basePath, rebuild git service
  assert.equal(s.basePath, "/project");
  assert.equal(findCalls(deps.calls, "GitServiceImpl").length, 1);
});

// ─── mergeAndExit Tests (worktree mode) ──────────────────────────────────────

test("mergeAndExit in worktree mode reads roadmap and merges", () => {
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  const deps = makeDeps({
    isInAutoWorktree: () => true,
    getIsolationMode: () => "worktree",
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  assert.equal(findCalls(deps.calls, "syncWorktreeStateBack").length, 1);
  assert.equal(findCalls(deps.calls, "resolveMilestoneFile").length, 1);
  assert.equal(findCalls(deps.calls, "readFileSync").length, 1);
  assert.equal(findCalls(deps.calls, "mergeMilestoneToMain").length, 1);
  assert.equal(s.basePath, "/project"); // restored
  assert.ok(ctx.messages.some((m) => m.msg.includes("merged to main")));
});

test("mergeAndExit in worktree mode shows pushed status", () => {
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  const deps = makeDeps({
    isInAutoWorktree: () => true,
    getIsolationMode: () => "worktree",
    mergeMilestoneToMain: () => ({ pushed: true, codeFilesChanged: true }),
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  assert.ok(ctx.messages.some((m) => m.msg.includes("Pushed to remote")));
});

test("mergeAndExit falls back to teardown with preserveBranch when roadmap is missing (#1573)", () => {
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  const deps = makeDeps({
    isInAutoWorktree: () => true,
    getIsolationMode: () => "worktree",
    resolveMilestoneFile: () => null,
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  const teardownCalls = findCalls(deps.calls, "teardownAutoWorktree");
  assert.equal(teardownCalls.length, 1);
  // Branch must be preserved so commits are not orphaned (#1573)
  assert.deepEqual(teardownCalls[0].args[2], { preserveBranch: true });
  assert.equal(findCalls(deps.calls, "mergeMilestoneToMain").length, 0);
  assert.equal(s.basePath, "/project"); // restored
  assert.ok(ctx.messages.some((m) => m.msg.includes("branch preserved")));
});

test("mergeAndExit resolves roadmap from worktree when missing at project root (#1573)", () => {
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  // resolveMilestoneFile returns null for project root, returns path for worktree
  const deps = makeDeps({
    isInAutoWorktree: () => true,
    getIsolationMode: () => "worktree",
    resolveMilestoneFile: (basePath: string) => {
      if (basePath === "/project") return null; // missing at project root
      if (basePath === "/project/.gsd/worktrees/M001") {
        return "/project/.gsd/worktrees/M001/.gsd/milestones/M001/M001-ROADMAP.md";
      }
      return null;
    },
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  // Should have called mergeMilestoneToMain, not bare teardown
  assert.equal(findCalls(deps.calls, "mergeMilestoneToMain").length, 1);
  // #2945 Bug 3: secondary teardown is now called after merge for cleanup
  assert.equal(findCalls(deps.calls, "teardownAutoWorktree").length, 1);
  assert.equal(s.basePath, "/project"); // restored
  assert.ok(ctx.messages.some((m) => m.msg.includes("merged to main")));
});

test("mergeAndExit in worktree mode restores to project root on merge failure", () => {
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  const deps = makeDeps({
    isInAutoWorktree: () => true,
    getIsolationMode: () => "worktree",
    mergeMilestoneToMain: () => {
      throw new Error("conflict in main");
    },
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  assert.equal(s.basePath, "/project"); // error recovery — restored
  assert.ok(
    ctx.messages.some(
      (m) => m.level === "warning" && m.msg.includes("conflict in main"),
    ),
  );
  assert.equal(findCalls(deps.calls, "GitServiceImpl").length, 1); // rebuilt after recovery
});

test("mergeAndExit failure message tells user worktree and branch are preserved (#1668)", () => {
  // Regression test: before the fix, the failure message was a bare
  // "Milestone merge failed: <reason>" with no recovery guidance. Users were
  // left confused about whether their code had been deleted. The new message
  // explicitly states that the worktree and branch are preserved and what to do.
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  const deps = makeDeps({
    isInAutoWorktree: () => true,
    getIsolationMode: () => "worktree",
    mergeMilestoneToMain: () => {
      throw new Error("pathspec 'main' did not match any file(s) known to git");
    },
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  const warning = ctx.messages.find((m) => m.level === "warning");
  assert.ok(warning, "a warning message is emitted");
  // Must contain the original error
  assert.ok(warning!.msg.includes("pathspec 'main' did not match"), "warning includes the original error");
  // Must tell the user their work is safe
  assert.ok(
    warning!.msg.includes("preserved"),
    "warning tells user the worktree and branch are preserved",
  );
  // Must suggest a recovery action
  assert.ok(
    warning!.msg.includes("retry") || warning!.msg.includes("manually"),
    "warning suggests a recovery action",
  );
});

test("mergeAndExit failure message references /gsd dispatch complete-milestone, not /complete-milestone (#1891)", () => {
  // Regression test: the failure notification previously told users to
  // "retry /complete-milestone" — a command that does not exist. The correct
  // recovery command is "/gsd dispatch complete-milestone".
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  const deps = makeDeps({
    isInAutoWorktree: () => true,
    getIsolationMode: () => "worktree",
    mergeMilestoneToMain: () => {
      throw new Error("dirty working tree");
    },
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  const warning = ctx.messages.find((m) => m.level === "warning");
  assert.ok(warning, "a warning message is emitted");
  // Must reference the correct dispatch command
  assert.ok(
    warning!.msg.includes("/gsd dispatch complete-milestone"),
    "warning references /gsd dispatch complete-milestone, not bare /complete-milestone",
  );
  // Must NOT contain the bare (incorrect) command without the dispatch prefix
  assert.ok(
    !warning!.msg.match(/retry\s+\/complete-milestone(?!\S)/),
    "warning must not reference the non-existent /complete-milestone command",
  );
});

// ─── mergeAndExit Tests (branch mode) ────────────────────────────────────────

test("mergeAndExit in branch mode merges when on milestone branch", () => {
  const s = makeSession({ basePath: "/project", originalBasePath: "/project" });
  const deps = makeDeps({
    isInAutoWorktree: () => false,
    getIsolationMode: () => "branch",
    getCurrentBranch: () => "milestone/M001",
    autoWorktreeBranch: () => "milestone/M001",
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  assert.equal(findCalls(deps.calls, "mergeMilestoneToMain").length, 1);
  assert.ok(ctx.messages.some((m) => m.msg.includes("branch mode")));
});

test("mergeAndExit in branch mode skips when not on milestone branch", () => {
  const s = makeSession({ basePath: "/project", originalBasePath: "/project" });
  const deps = makeDeps({
    isInAutoWorktree: () => false,
    getIsolationMode: () => "branch",
    getCurrentBranch: () => "main",
    autoWorktreeBranch: () => "milestone/M001",
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  assert.equal(findCalls(deps.calls, "mergeMilestoneToMain").length, 0);
  assert.equal(ctx.messages.length, 0);
});

test("mergeAndExit in branch mode handles merge failure gracefully", () => {
  const s = makeSession({ basePath: "/project", originalBasePath: "/project" });
  const deps = makeDeps({
    isInAutoWorktree: () => false,
    getIsolationMode: () => "branch",
    getCurrentBranch: () => "milestone/M001",
    autoWorktreeBranch: () => "milestone/M001",
    mergeMilestoneToMain: () => {
      throw new Error("branch merge conflict");
    },
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  assert.ok(
    ctx.messages.some(
      (m) => m.level === "warning" && m.msg.includes("branch merge conflict"),
    ),
  );
});

test("mergeAndExit in branch mode skips when no roadmap", () => {
  const s = makeSession({ basePath: "/project", originalBasePath: "/project" });
  const deps = makeDeps({
    isInAutoWorktree: () => false,
    getIsolationMode: () => "branch",
    getCurrentBranch: () => "milestone/M001",
    autoWorktreeBranch: () => "milestone/M001",
    resolveMilestoneFile: () => null,
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  assert.equal(findCalls(deps.calls, "mergeMilestoneToMain").length, 0);
});

test("mergeAndExit in branch mode rebuilds GitService after merge", () => {
  const s = makeSession({ basePath: "/project", originalBasePath: "/project" });
  const deps = makeDeps({
    isInAutoWorktree: () => false,
    getIsolationMode: () => "branch",
    getCurrentBranch: () => "milestone/M001",
    autoWorktreeBranch: () => "milestone/M001",
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  assert.equal(findCalls(deps.calls, "GitServiceImpl").length, 1);
});

// ─── mergeAndExit Tests (none mode) ──────────────────────────────────────────

test("mergeAndExit in none mode is a no-op", () => {
  const s = makeSession();
  const deps = makeDeps({
    getIsolationMode: () => "none",
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  assert.equal(findCalls(deps.calls, "mergeMilestoneToMain").length, 0);
  assert.equal(findCalls(deps.calls, "teardownAutoWorktree").length, 0);
  assert.equal(ctx.messages.length, 0);
});

// ─── #1906 — metadata-only merge warning ────────────────────────────────────

test("mergeAndExit warns when merge contains no code changes (#1906)", () => {
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  const deps = makeDeps({
    isInAutoWorktree: () => true,
    getIsolationMode: () => "worktree",
    mergeMilestoneToMain: () => ({ pushed: false, codeFilesChanged: false }),
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  assert.ok(
    ctx.messages.some((m) => m.msg.includes("NO code changes") && m.level === "warning"),
    "must emit warning when only .gsd/ metadata was merged",
  );
  assert.ok(
    !ctx.messages.some((m) => m.msg.includes("merged to main") && m.level === "info"),
    "must NOT emit success-style info notification for metadata-only merge",
  );
});

test("mergeAndExit emits info when merge contains code changes (#1906)", () => {
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  const deps = makeDeps({
    isInAutoWorktree: () => true,
    getIsolationMode: () => "worktree",
    mergeMilestoneToMain: () => ({ pushed: false, codeFilesChanged: true }),
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  assert.ok(
    ctx.messages.some((m) => m.msg.includes("merged to main") && m.level === "info"),
    "must emit info notification when code files were merged",
  );
  assert.ok(
    !ctx.messages.some((m) => m.msg.includes("NO code changes")),
    "must NOT emit metadata-only warning when code files were merged",
  );
});

test("mergeAndExit branch mode warns when merge contains no code changes (#1906)", () => {
  const s = makeSession({
    basePath: "/project",
    originalBasePath: "/project",
  });
  const deps = makeDeps({
    isInAutoWorktree: () => false,
    getIsolationMode: () => "branch",
    getCurrentBranch: () => "milestone/M001",
    autoWorktreeBranch: () => "milestone/M001",
    mergeMilestoneToMain: () => ({ pushed: false, codeFilesChanged: false }),
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  assert.ok(
    ctx.messages.some((m) => m.msg.includes("NO code changes") && m.level === "warning"),
    "branch mode must emit warning when only .gsd/ metadata was merged",
  );
});

// ─── mergeAndEnterNext Tests ─────────────────────────────────────────────────

test("mergeAndEnterNext calls mergeAndExit then enterMilestone", () => {
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  const callOrder: string[] = [];
  const deps = makeDeps({
    isInAutoWorktree: () => true,
    getIsolationMode: () => "worktree",
    shouldUseWorktreeIsolation: () => true,
    mergeMilestoneToMain: (
      basePath: string,
      milestoneId: string,
      _roadmap: string,
    ) => {
      callOrder.push(`merge:${milestoneId}`);
      return { pushed: false, codeFilesChanged: true };
    },
    getAutoWorktreePath: () => null,
    createAutoWorktree: (basePath: string, milestoneId: string) => {
      callOrder.push(`create:${milestoneId}`);
      return `/project/.gsd/worktrees/${milestoneId}`;
    },
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndEnterNext("M001", "M002", ctx);

  assert.deepEqual(callOrder, ["merge:M001", "create:M002"]);
  assert.equal(s.basePath, "/project/.gsd/worktrees/M002");
});

test("mergeAndEnterNext enters next milestone even if merge fails", () => {
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  const deps = makeDeps({
    isInAutoWorktree: (basePath: string) => basePath.includes("worktrees"),
    getIsolationMode: () => "worktree",
    shouldUseWorktreeIsolation: () => true,
    mergeMilestoneToMain: () => {
      throw new Error("merge failed");
    },
    getAutoWorktreePath: () => null,
    createAutoWorktree: (_basePath: string, milestoneId: string) => {
      return `/project/.gsd/worktrees/${milestoneId}`;
    },
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndEnterNext("M001", "M002", ctx);

  // Merge failed but enter should still happen
  assert.equal(s.basePath, "/project/.gsd/worktrees/M002");
  assert.ok(
    ctx.messages.some(
      (m) => m.level === "warning" && m.msg.includes("merge failed"),
    ),
  );
  assert.ok(
    ctx.messages.some(
      (m) => m.level === "info" && m.msg.includes("Entered worktree"),
    ),
  );
});

// ─── GitService Rebuild Atomicity ────────────────────────────────────────────

test("GitService is rebuilt with the NEW basePath after enterMilestone", () => {
  const s = makeSession();
  let gitServiceBasePath = "";
  const deps = makeDeps({
    getAutoWorktreePath: () => null,
    GitServiceImpl: class {
      constructor(basePath: string, _config: unknown) {
        gitServiceBasePath = basePath;
      }
    } as unknown as WorktreeResolverDeps["GitServiceImpl"],
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.enterMilestone("M001", ctx);

  assert.equal(gitServiceBasePath, "/project/.gsd/worktrees/M001"); // new path, not old
});

test("GitService is rebuilt with originalBasePath after exitMilestone", () => {
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  let gitServiceBasePath = "";
  const deps = makeDeps({
    isInAutoWorktree: () => true,
    GitServiceImpl: class {
      constructor(basePath: string, _config: unknown) {
        gitServiceBasePath = basePath;
      }
    } as unknown as WorktreeResolverDeps["GitServiceImpl"],
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.exitMilestone("M001", ctx);

  assert.equal(gitServiceBasePath, "/project"); // project root, not worktree
});

// ─── Isolation Degradation Tests (#2483) ──────────────────────────────────

test("enterMilestone sets isolationDegraded when worktree creation throws (#2483)", () => {
  const s = makeSession();
  const deps = makeDeps({
    getAutoWorktreePath: () => null,
    createAutoWorktree: () => {
      throw new Error("empty repo");
    },
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.enterMilestone("M001", ctx);

  assert.equal(s.isolationDegraded, true);
  assert.equal(s.basePath, "/project"); // unchanged — error recovery
});

test("enterMilestone is no-op when isolationDegraded is true (#2483)", () => {
  const s = makeSession();
  s.isolationDegraded = true;
  const deps = makeDeps();
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.enterMilestone("M001", ctx);

  assert.equal(s.basePath, "/project"); // unchanged
  assert.equal(findCalls(deps.calls, "createAutoWorktree").length, 0);
  assert.equal(findCalls(deps.calls, "enterAutoWorktree").length, 0);
  assert.equal(findCalls(deps.calls, "shouldUseWorktreeIsolation").length, 0);
});

test("mergeAndExit is no-op when isolationDegraded is true (#2483)", () => {
  const s = makeSession({
    basePath: "/project",
    originalBasePath: "/project",
  });
  s.isolationDegraded = true;
  const deps = makeDeps({
    getIsolationMode: () => "worktree",
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  assert.equal(findCalls(deps.calls, "mergeMilestoneToMain").length, 0);
  assert.equal(findCalls(deps.calls, "teardownAutoWorktree").length, 0);
  assert.equal(findCalls(deps.calls, "getIsolationMode").length, 0);
  assert.ok(
    ctx.messages.some(
      (m) => m.level === "info" && m.msg.includes("isolation was degraded"),
    ),
  );
});

test("isolationDegraded is reset by session.reset() (#2483)", () => {
  const s = new AutoSession();
  s.isolationDegraded = true;

  s.reset();

  assert.equal(s.isolationDegraded, false);
});

// ─── #2625 — Default isolation mode change must not orphan worktree commits ──

test("mergeAndExit still merges when mode is 'none' but session is in a worktree (#2625)", () => {
  // Scenario: user upgraded from a version where default was "worktree" to one
  // where default is "none". They have an active worktree with committed work.
  // mergeAndExit must detect the active worktree and merge regardless of config.
  const s = makeSession({
    basePath: "/project/.gsd/worktrees/M001",
    originalBasePath: "/project",
  });
  const deps = makeDeps({
    isInAutoWorktree: () => true,
    getIsolationMode: () => "none", // config says "none" — but we ARE in a worktree
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  // Must still merge — not skip silently
  assert.equal(findCalls(deps.calls, "mergeMilestoneToMain").length, 1,
    "must call mergeMilestoneToMain even when isolation mode is 'none' but we are in a worktree");
  assert.equal(s.basePath, "/project", "basePath must be restored to project root");
  assert.ok(ctx.messages.some((m) => m.msg.includes("merged to main")),
    "must notify about the merge");
});

test("mergeAndExit in none mode remains a no-op when NOT in a worktree (#2625)", () => {
  // When mode is "none" and we are genuinely not in a worktree, it should still be a no-op.
  const s = makeSession({
    basePath: "/project",
    originalBasePath: "/project",
  });
  const deps = makeDeps({
    isInAutoWorktree: () => false,
    getIsolationMode: () => "none",
  });
  const ctx = makeNotifyCtx();
  const resolver = new WorktreeResolver(s, deps);

  resolver.mergeAndExit("M001", ctx);

  assert.equal(findCalls(deps.calls, "mergeMilestoneToMain").length, 0,
    "must NOT merge when not in a worktree and mode is none");
});
