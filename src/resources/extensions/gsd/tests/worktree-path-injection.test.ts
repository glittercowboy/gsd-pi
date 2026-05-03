import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ownsGsdHome = process.env.GSD_HOME_TEST_OVERRIDE === undefined;
const previousGsdHome = process.env.GSD_HOME;
const synthesizedGsdHome = join(tmpdir(), `gsd-test-home-${process.pid}-${Date.now()}`);
process.env.GSD_HOME = process.env.GSD_HOME_TEST_OVERRIDE
  ?? synthesizedGsdHome;

after(() => {
  if (ownsGsdHome) {
    rmSync(synthesizedGsdHome, { recursive: true, force: true });
  }
  if (previousGsdHome === undefined) {
    delete process.env.GSD_HOME;
  } else {
    process.env.GSD_HOME = previousGsdHome;
  }
});

const { dispatchDirectPhase } = await import("../auto-direct-dispatch.ts");
const {
  buildDiscussMilestonePrompt,
  buildParallelResearchSlicesPrompt,
  buildRewriteDocsPrompt,
} = await import("../auto-prompts.ts");
const { invalidateStateCache } = await import("../state.ts");
const { resolveAgentEnd, _resetPendingResolve } = await import("../auto/resolve.ts");
const { runUnit } = await import("../auto/run-unit.ts");

function writeMilestone(base: string, mid = "M001", title = "Worktree Path Injection"): void {
  const milestoneDir = join(base, ".gsd", "milestones", mid);
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, `${mid}-CONTEXT.md`),
    `# ${mid}: ${title}\n\nContext.\n`,
    "utf-8",
  );
  writeFileSync(
    join(milestoneDir, `${mid}-ROADMAP.md`),
    [
      `# ${mid}: ${title}`,
      "",
      "## Slices",
      "",
      "- [ ] **S01: First slice** `risk:low` `depends:[]`",
      "",
    ].join("\n"),
    "utf-8",
  );
}

function makeLiveMilestoneWorktree(base: string, mid = "M001"): string {
  const worktreeRoot = join(base, ".gsd", "worktrees", mid);
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(
    join(worktreeRoot, ".git"),
    `gitdir: ${join(base, ".git", "worktrees", mid)}\n`,
    "utf-8",
  );
  writeMilestone(worktreeRoot, mid);
  return worktreeRoot;
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const rawTimeout = process.env.READABLE_WAIT_TIMEOUT_MS;
  const parsedTimeout = rawTimeout === undefined ? NaN : Number.parseInt(rawTimeout, 10);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 1000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (condition()) return;
  assert.fail(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

test("runUnit changes cwd to basePath before creating a new session", async (t) => {
  _resetPendingResolve();

  const originalCwd = process.cwd();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rununit-base-")));
  const drifted = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rununit-drift-")));
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
    rmSync(drifted, { recursive: true, force: true });
  });

  process.chdir(drifted);

  let cwdAtNewSession: string | undefined;
  const session = {
    active: true,
    basePath: base,
    verbose: false,
    cmdCtx: {
      newSession: () => {
        cwdAtNewSession = process.cwd();
        return Promise.resolve({ cancelled: false });
      },
    },
  } as any;
  const pi = {
    calls: [] as unknown[],
    sendMessage(...args: unknown[]) {
      this.calls.push(args);
    },
  } as any;
  const ctx = { ui: { notify: () => {} }, model: { id: "test-model" } } as any;

  const resultPromise = runUnit(ctx, pi, session, "task", "T01", "prompt");
  await waitFor(() => pi.calls.length === 1, "runUnit dispatch");
  resolveAgentEnd({ messages: [{ role: "assistant" }] });

  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.equal(cwdAtNewSession, base);
});

test("runUnit cancels before creating a session when basePath chdir fails", async (t) => {
  _resetPendingResolve();

  const originalCwd = process.cwd();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rununit-missing-base-")));
  const drifted = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rununit-missing-drift-")));
  rmSync(base, { recursive: true, force: true });
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(drifted, { recursive: true, force: true });
  });

  process.chdir(drifted);

  let newSessionCalled = false;
  const session = {
    active: true,
    basePath: base,
    verbose: false,
    cmdCtx: {
      newSession: () => {
        newSessionCalled = true;
        return Promise.resolve({ cancelled: false });
      },
    },
  } as any;
  const pi = {
    calls: [] as unknown[],
    sendMessage(...args: unknown[]) {
      this.calls.push(args);
    },
  } as any;
  const ctx = { ui: { notify: () => {} }, model: { id: "test-model" } } as any;

  const result = await runUnit(ctx, pi, session, "task", "T01", "prompt");

  assert.equal(result.status, "cancelled");
  assert.equal(result.errorContext?.category, "session-failed");
  assert.equal(result.errorContext?.isTransient, true);
  assert.match(result.errorContext?.message ?? "", /Failed to chdir to basePath before newSession/);
  assert.ok(result.errorContext?.message.includes(base), "error should include the failed basePath");
  assert.equal(newSessionCalled, false, "newSession must not run after chdir failure");
  assert.equal(pi.calls.length, 0, "unit must not dispatch after chdir failure");
});

test("direct dispatch redirects to the canonical milestone worktree before newSession", async (t) => {
  invalidateStateCache();

  const originalCwd = process.cwd();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-direct-base-")));
  const drifted = realpathSync(mkdtempSync(join(tmpdir(), "gsd-direct-drift-")));
  writeMilestone(base);
  const worktreeRoot = makeLiveMilestoneWorktree(base);

  t.after(() => {
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
    rmSync(drifted, { recursive: true, force: true });
    invalidateStateCache();
  });

  process.chdir(drifted);

  let cwdAtNewSession: string | undefined;
  let sentPrompt: string | undefined;
  const ctx = {
    ui: { notify: () => {} },
    newSession: async () => {
      cwdAtNewSession = process.cwd();
      return { cancelled: false };
    },
  } as any;
  const pi = {
    sendMessage(message: { content: string }) {
      sentPrompt = message.content;
    },
  } as any;

  await dispatchDirectPhase(ctx, pi, "research-milestone", base);

  assert.equal(cwdAtNewSession, worktreeRoot);
  assert.equal(process.cwd(), drifted);
  assert.ok(sentPrompt?.includes(worktreeRoot), "prompt should name the canonical worktree root");
});

test("worktree-aware prompt builders include the explicit working directory", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-prompt-base-")));
  writeMilestone(base);
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const prompts = await Promise.all([
    buildDiscussMilestonePrompt("M001", "Worktree Path Injection", base),
    buildParallelResearchSlicesPrompt(
      "M001",
      "Worktree Path Injection",
      [{ id: "S01", title: "First slice" }],
      base,
    ),
    buildRewriteDocsPrompt(
      "M001",
      "Worktree Path Injection",
      null,
      base,
      [{ change: "Refresh docs", timestamp: "2026-04-27T00:00:00.000Z", appliedAt: "test" }] as any,
    ),
  ]);

  assert.ok(prompts[0].includes("## Context Mode"), "discuss-milestone should include standalone Context Mode guidance");
  assert.ok(prompts[0].includes("interview lane"), "discuss-milestone should render the interview lane");

  for (const prompt of prompts) {
    assert.match(prompt, /working directory/i);
    assert.ok(prompt.includes(base), "prompt should include the provided working directory");
  }
});
