import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ─── Imports ──────────────────────────────────────────────────────────
const workspaceIndex = await import(
  "../../resources/extensions/gsd/workspace-index.ts"
);
const filesRoute = await import("../../../web/app/api/files/route.ts");

// Re-import status helpers from the web-side module
const workspaceStatus = await import("../../../web/lib/workspace-status.ts");

// ─── Helpers ──────────────────────────────────────────────────────────
function makeGsdFixture(): { root: string; gsdDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "gsd-state-surfaces-"));
  const gsdDir = join(root, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  return {
    root,
    gsdDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ─── Group 1: Workspace index — risk/depends/demo fields ─────────────
test("indexWorkspace extracts risk, depends, and demo from roadmap", async (t) => {
  const { root, gsdDir, cleanup } = makeGsdFixture();

  t.after(() => { cleanup(); });

  const milestoneDir = join(gsdDir, "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Test Milestone",
      "",
      "## Slices",
      "- [ ] **S01: Feature slice** `risk:high` `depends:[S00]`",
      "  > After this: users can see the dashboard",
    ].join("\n"),
  );

  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    [
      "# S01: Feature slice",
      "",
      "**Goal:** Build the feature",
      "**Demo:** Dashboard renders",
      "",
      "## Tasks",
      "- [ ] **T01: Build thing** `est:30m`",
      "  Do the work.",
    ].join("\n"),
  );

  writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01: Build thing\n\n## Steps\n- do it\n");

  const index = await workspaceIndex.indexWorkspace(root);

  assert.equal(index.milestones.length, 1);
  assert.equal(index.milestones[0].id, "M001");

  const slice = index.milestones[0].slices[0];
  assert.equal(slice.id, "S01");
  assert.equal(slice.risk, "high");
  assert.deepEqual(slice.depends, ["S00"]);
  assert.equal(slice.demo, "users can see the dashboard");
  assert.equal(slice.done, false);
  assert.equal(slice.tasks.length, 1);
  assert.equal(slice.tasks[0].id, "T01");
  assert.equal(slice.tasks[0].done, false);
});

test("indexWorkspace handles slices without risk/depends/demo", async (t) => {
  const { root, gsdDir, cleanup } = makeGsdFixture();

  t.after(() => { cleanup(); });

  const milestoneDir = join(gsdDir, "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  mkdirSync(join(sliceDir, "tasks"), { recursive: true });

  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    "# M001: Minimal\n\n## Slices\n- [x] **S01: Done slice**\n",
  );

  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    "# S01: Done slice\n\n**Goal:** Done\n\n## Tasks\n",
  );

  const index = await workspaceIndex.indexWorkspace(root);

  const slice = index.milestones[0].slices[0];
  // Parser defaults risk to "low" when not specified, demo to "" when no blockquote
  assert.equal(slice.risk, "low");
  assert.deepEqual(slice.depends, []);
  assert.equal(slice.demo, "");
  assert.equal(slice.done, true);
});

// ─── Group 2: Shared status helpers ──────────────────────────────────
test("getMilestoneStatus returns correct statuses", () => {
  const { getMilestoneStatus } = workspaceStatus;

  // All slices done → done
  const doneMilestone = {
    id: "M001",
    title: "Done",
    slices: [
      { id: "S01", title: "S01", done: true, tasks: [] },
      { id: "S02", title: "S02", done: true, tasks: [] },
    ],
  };
  assert.equal(getMilestoneStatus(doneMilestone, {}), "done");

  // Active milestone with some done slices → in-progress
  const activeMilestone = {
    id: "M001",
    title: "Active",
    slices: [
      { id: "S01", title: "S01", done: true, tasks: [] },
      { id: "S02", title: "S02", done: false, tasks: [] },
    ],
  };
  assert.equal(getMilestoneStatus(activeMilestone, { milestoneId: "M001" }), "in-progress");

  // Not active, no done slices → pending
  const pendingMilestone = {
    id: "M002",
    title: "Pending",
    slices: [
      { id: "S01", title: "S01", done: false, tasks: [] },
    ],
  };
  assert.equal(getMilestoneStatus(pendingMilestone, { milestoneId: "M001" }), "pending");
});

test("getSliceStatus returns correct statuses", () => {
  const { getSliceStatus } = workspaceStatus;

  // Done slice
  assert.equal(
    getSliceStatus("M001", { id: "S01", title: "S01", done: true, tasks: [] }, { milestoneId: "M001", sliceId: "S01" }),
    "done",
  );

  // Active slice
  assert.equal(
    getSliceStatus("M001", { id: "S01", title: "S01", done: false, tasks: [] }, { milestoneId: "M001", sliceId: "S01" }),
    "in-progress",
  );

  // Pending slice (different milestone active)
  assert.equal(
    getSliceStatus("M002", { id: "S01", title: "S01", done: false, tasks: [] }, { milestoneId: "M001", sliceId: "S01" }),
    "pending",
  );
});

test("getTaskStatus returns correct statuses", () => {
  const { getTaskStatus } = workspaceStatus;
  const active = { milestoneId: "M001", sliceId: "S01", taskId: "T01" };

  // Done task
  assert.equal(
    getTaskStatus("M001", "S01", { id: "T01", title: "T01", done: true }, active),
    "done",
  );

  // Active task
  assert.equal(
    getTaskStatus("M001", "S01", { id: "T01", title: "T01", done: false }, active),
    "in-progress",
  );

  // Pending task (different task active)
  assert.equal(
    getTaskStatus("M001", "S01", { id: "T02", title: "T02", done: false }, active),
    "pending",
  );
});

// ─── Group 3: Files API — tree listing ───────────────────────────────
test("files API returns tree listing of .gsd/ directory", async (t) => {
  const { root, gsdDir, cleanup } = makeGsdFixture();
  const origEnv = process.env.GSD_WEB_PROJECT_CWD;

  t.after(() => {
    process.env.GSD_WEB_PROJECT_CWD = origEnv;
    cleanup();
  });

  process.env.GSD_WEB_PROJECT_CWD = root;

  // Create some files
  writeFileSync(join(gsdDir, "STATE.md"), "# State\nactive");
  writeFileSync(join(gsdDir, "PROJECT.md"), "# Project");
  const msDir = join(gsdDir, "milestones", "M001");
  mkdirSync(msDir, { recursive: true });
  writeFileSync(join(msDir, "M001-ROADMAP.md"), "# Roadmap");

  const request = new Request("http://localhost:3000/api/files");
  const response = await filesRoute.GET(request);
  assert.equal(response.status, 200);

  const data = await response.json();
  assert.ok(Array.isArray(data.tree));
  assert.ok(data.tree.length > 0);

  // Should have files at root level
  const names = data.tree.map((n: { name: string }) => n.name);
  assert.ok(names.includes("STATE.md"), `Expected STATE.md in tree, got: ${names}`);
  assert.ok(names.includes("PROJECT.md"), `Expected PROJECT.md in tree, got: ${names}`);
  assert.ok(names.includes("milestones"), `Expected milestones in tree, got: ${names}`);

  // milestones should be a directory with children
  const milestones = data.tree.find((n: { name: string }) => n.name === "milestones");
  assert.equal(milestones.type, "directory");
  assert.ok(Array.isArray(milestones.children));
  assert.ok(milestones.children.length > 0);
});

// ─── Group 4: Files API — file content ───────────────────────────────
test("files API returns file content for valid path", async (t) => {
  const { root, gsdDir, cleanup } = makeGsdFixture();
  const origEnv = process.env.GSD_WEB_PROJECT_CWD;

  t.after(() => {
    process.env.GSD_WEB_PROJECT_CWD = origEnv;
    cleanup();
  });

  process.env.GSD_WEB_PROJECT_CWD = root;

  const fileContent = "# State\n\nCurrent milestone: M001";
  writeFileSync(join(gsdDir, "STATE.md"), fileContent);

  const request = new Request("http://localhost:3000/api/files?path=STATE.md");
  const response = await filesRoute.GET(request);
  assert.equal(response.status, 200);

  const data = await response.json();
  assert.equal(data.content, fileContent);
});

test("files API returns content for nested files", async (t) => {
  const { root, gsdDir, cleanup } = makeGsdFixture();
  const origEnv = process.env.GSD_WEB_PROJECT_CWD;

  t.after(() => {
    process.env.GSD_WEB_PROJECT_CWD = origEnv;
    cleanup();
  });

  process.env.GSD_WEB_PROJECT_CWD = root;

  const msDir = join(gsdDir, "milestones", "M001");
  mkdirSync(msDir, { recursive: true });
  writeFileSync(join(msDir, "M001-ROADMAP.md"), "# Roadmap content");

  const request = new Request(
    "http://localhost:3000/api/files?path=milestones/M001/M001-ROADMAP.md",
  );
  const response = await filesRoute.GET(request);
  assert.equal(response.status, 200);

  const data = await response.json();
  assert.equal(data.content, "# Roadmap content");
});

// ─── Group 5: Files API — security: path traversal rejection ─────────
test("files API rejects path traversal with ../", async (t) => {
  const { root, cleanup } = makeGsdFixture();
  const origEnv = process.env.GSD_WEB_PROJECT_CWD;

  t.after(() => {
    process.env.GSD_WEB_PROJECT_CWD = origEnv;
    cleanup();
  });

  process.env.GSD_WEB_PROJECT_CWD = root;

  const request = new Request(
    "http://localhost:3000/api/files?path=../etc/passwd",
  );
  const response = await filesRoute.GET(request);
  assert.equal(response.status, 400);

  const data = await response.json();
  assert.ok(data.error, "Expected error message in response");
});

test("files API rejects absolute paths", async (t) => {
  const { root, cleanup } = makeGsdFixture();
  const origEnv = process.env.GSD_WEB_PROJECT_CWD;

  t.after(() => {
    process.env.GSD_WEB_PROJECT_CWD = origEnv;
    cleanup();
  });

  process.env.GSD_WEB_PROJECT_CWD = root;

  const request = new Request(
    "http://localhost:3000/api/files?path=/etc/passwd",
  );
  const response = await filesRoute.GET(request);
  assert.equal(response.status, 400);

  const data = await response.json();
  assert.ok(data.error);
});

test("files API returns 404 for missing files", async (t) => {
  const { root, cleanup } = makeGsdFixture();
  const origEnv = process.env.GSD_WEB_PROJECT_CWD;

  t.after(() => {
    process.env.GSD_WEB_PROJECT_CWD = origEnv;
    cleanup();
  });

  process.env.GSD_WEB_PROJECT_CWD = root;

  const request = new Request(
    "http://localhost:3000/api/files?path=nonexistent.md",
  );
  const response = await filesRoute.GET(request);
  assert.equal(response.status, 404);

  const data = await response.json();
  assert.ok(data.error);
});

test("files API returns empty tree when .gsd/ does not exist", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-state-surfaces-empty-"));
  const origEnv = process.env.GSD_WEB_PROJECT_CWD;

  t.after(() => {
    process.env.GSD_WEB_PROJECT_CWD = origEnv;
    rmSync(root, { recursive: true, force: true });
  });

  process.env.GSD_WEB_PROJECT_CWD = root;

  const request = new Request("http://localhost:3000/api/files");
  const response = await filesRoute.GET(request);
  assert.equal(response.status, 200);

  const data = await response.json();
  assert.deepEqual(data.tree, []);
});

// ─── Group 6: Mock-free invariant — no static mock data ──────────────

const VIEW_FILES = [
  "web/components/gsd/dashboard.tsx",
  "web/components/gsd/roadmap.tsx",
  "web/components/gsd/activity-view.tsx",
  "web/components/gsd/files-view.tsx",
  "web/components/gsd/dual-terminal.tsx",
];

// Patterns that indicate hardcoded mock data arrays
const MOCK_DATA_PATTERNS = [
  /const\s+\w+Data\s*=\s*\[/,            // const roadmapData = [, const activityLog = [, etc.
  /const\s+activityLog\s*=/,              // const activityLog = ...
  /const\s+recentActivity\s*=\s*\[/,      // const recentActivity = [...]
  /const\s+currentSliceTasks\s*=\s*\[/,   // const currentSliceTasks = [...]
  /const\s+modelUsage\s*=\s*\[/,          // const modelUsage = [...]
  /const\s+gsdFiles\s*=\s*\[/,            // const gsdFiles = [...]
  /AutoModeState.*idle.*working/,          // old enum-style mock state
  /Lorem\s+ipsum/i,                        // lorem placeholder text
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z["'](?:.*,\s*$)/m,  // hardcoded ISO timestamps in array literals
];

const webRoot = resolve(import.meta.dirname, "../../../web");

test("view components contain no static mock data arrays", () => {
  for (const filePath of VIEW_FILES) {
    const fullPath = resolve(import.meta.dirname, "../../..", filePath);
    const source = readFileSync(fullPath, "utf-8");
    for (const pattern of MOCK_DATA_PATTERNS) {
      const match = source.match(pattern);
      assert.equal(
        match,
        null,
        `${filePath} contains mock data pattern: ${pattern} — matched: "${match?.[0]}"`,
      );
    }
  }
});

test("view components read from real data sources (store or API)", () => {
  // Views that derive state from the workspace store
  const STORE_VIEWS = [
    "web/components/gsd/dashboard.tsx",
    "web/components/gsd/roadmap.tsx",
    "web/components/gsd/activity-view.tsx",
    "web/components/gsd/terminal.tsx",
  ];

  // FilesView fetches from /api/files (real endpoint), not the workspace store — that's correct
  const API_VIEWS = [
    { path: "web/components/gsd/files-view.tsx", apiPattern: "/api/files" },
  ];

  for (const filePath of STORE_VIEWS) {
    const fullPath = resolve(import.meta.dirname, "../../..", filePath);
    const source = readFileSync(fullPath, "utf-8");
    assert.ok(
      source.includes("gsd-workspace-store"),
      `${filePath} does not import from gsd-workspace-store — store-backed views must read real store state`,
    );
  }

  for (const { path: filePath, apiPattern } of API_VIEWS) {
    const fullPath = resolve(import.meta.dirname, "../../..", filePath);
    const source = readFileSync(fullPath, "utf-8");
    assert.ok(
      source.includes(apiPattern),
      `${filePath} does not reference ${apiPattern} — API-backed views must fetch from real endpoints`,
    );
  }
});

// Session card (with activeToolExecution and streamingAssistantText) was removed
// from the dashboard. Live signals are visible in the terminal/power mode instead.

test("status bar consumes statusTexts from store", () => {
  const statusBarPath = resolve(import.meta.dirname, "../../../web/components/gsd/status-bar.tsx");
  const source = readFileSync(statusBarPath, "utf-8");

  assert.ok(
    source.includes("statusTexts"),
    "status-bar.tsx must reference statusTexts for extension status display",
  );
  assert.ok(
    source.includes("titleOverride"),
    "status-bar.tsx must reference titleOverride so the shell title override is visible outside the header",
  );
});

test("browser shell renders title overrides, widgets, and editor prefills from store-backed state", () => {
  const storePath = resolve(import.meta.dirname, "../../../web/lib/gsd-workspace-store.tsx");
  const appShellPath = resolve(import.meta.dirname, "../../../web/components/gsd/app-shell.tsx");
  const statusBarPath = resolve(import.meta.dirname, "../../../web/components/gsd/status-bar.tsx");
  const terminalPath = resolve(import.meta.dirname, "../../../web/components/gsd/terminal.tsx");

  const storeSource = readFileSync(storePath, "utf-8");
  const appShellSource = readFileSync(appShellPath, "utf-8");
  const statusBarSource = readFileSync(statusBarPath, "utf-8");
  const terminalSource = readFileSync(terminalPath, "utf-8");

  assert.match(appShellSource, /data-testid="workspace-title-override"/, "app-shell.tsx must render an inspectable title-override marker in the header");
  assert.match(appShellSource, /document\.title = titleOverride \?/, "app-shell.tsx must project the override into browser chrome");
  assert.match(statusBarSource, /data-testid="status-bar-title-override"/, "status-bar.tsx must keep the active title override browser-visible in the shell footer");

  assert.match(terminalSource, /terminal-widgets-above-editor/, "terminal.tsx must render above-editor widgets with a stable marker");
  assert.match(terminalSource, /terminal-widgets-below-editor/, "terminal.tsx must render below-editor widgets with a stable marker");
  assert.match(terminalSource, /data-testid="terminal-widget"/, "terminal.tsx must render inspectable widget entries");
  assert.match(terminalSource, /MAX_VISIBLE_WIDGET_LINES = 6/, "terminal.tsx must bound widget rendering so extension widgets cannot grow without limit");
  assert.match(terminalSource, /widget\.placement \?\? "aboveEditor"/, "terminal.tsx must preserve the existing default above-editor placement semantics");

  assert.match(storeSource, /consumeEditorTextBuffer = \(\): string \| null =>/, "gsd-workspace-store.tsx must expose a consume-once editor prefill action");
  assert.match(terminalSource, /consumeEditorTextBuffer/, "terminal.tsx must consume editor prefill state instead of replaying it forever");
  assert.match(terminalSource, /setInput\(buffer\)/, "terminal.tsx must visibly prefill the command input from editorTextBuffer");
});

test("terminal consumes activeToolExecution from store", () => {
  const terminalPath = resolve(import.meta.dirname, "../../../web/components/gsd/terminal.tsx");
  const source = readFileSync(terminalPath, "utf-8");

  assert.ok(
    source.includes("activeToolExecution"),
    "terminal.tsx must reference activeToolExecution for tool execution display",
  );
});

test("live browser panels consume live selectors and expose inspectable freshness markers", () => {
  const contractPath = resolve(import.meta.dirname, "../../../web/lib/command-surface-contract.ts")
  const storePath = resolve(import.meta.dirname, "../../../web/lib/gsd-workspace-store.tsx")
  const dashboardPath = resolve(import.meta.dirname, "../../../web/components/gsd/dashboard.tsx")
  const sidebarPath = resolve(import.meta.dirname, "../../../web/components/gsd/sidebar.tsx")
  const roadmapPath = resolve(import.meta.dirname, "../../../web/components/gsd/roadmap.tsx")
  const statusBarPath = resolve(import.meta.dirname, "../../../web/components/gsd/status-bar.tsx")

  const contractSource = readFileSync(contractPath, "utf-8")
  const storeSource = readFileSync(storePath, "utf-8")
  const dashboardSource = readFileSync(dashboardPath, "utf-8")
  const sidebarSource = readFileSync(sidebarPath, "utf-8")
  const roadmapSource = readFileSync(roadmapPath, "utf-8")
  const statusBarSource = readFileSync(statusBarPath, "utf-8")

  assert.match(contractSource, /export interface WorkspaceRecoverySummary/, "command-surface-contract.ts must expose a shared recovery summary shape for live panels")
  assert.match(storeSource, /live_state_invalidation/, "gsd-workspace-store.tsx must handle typed live_state_invalidation events")
  assert.match(storeSource, /\/api\/live-state/, "gsd-workspace-store.tsx must use the narrow live-state route for targeted refreshes")
  assert.match(storeSource, /softBootRefreshCount/, "gsd-workspace-store.tsx must expose a soft boot refresh counter for observability")
  assert.match(storeSource, /targetedRefreshCount/, "gsd-workspace-store.tsx must expose a targeted refresh counter for observability")
  assert.match(storeSource, /getLiveWorkspaceIndex/, "gsd-workspace-store.tsx must expose a live workspace selector")
  assert.match(storeSource, /getLiveAutoDashboard/, "gsd-workspace-store.tsx must expose a live auto selector")
  assert.match(storeSource, /getLiveResumableSessions/, "gsd-workspace-store.tsx must expose a live resumable-sessions selector")

  assert.match(dashboardSource, /getLiveWorkspaceIndex/, "dashboard.tsx must derive roadmap state from the live workspace selector")
  assert.match(dashboardSource, /getLiveAutoDashboard/, "dashboard.tsx must derive auto metrics from the live auto selector")
  assert.match(dashboardSource, /data-testid="dashboard-current-unit"/, "dashboard.tsx must expose a current-unit marker")

  assert.match(sidebarSource, /getLiveWorkspaceIndex/, "sidebar.tsx must derive explorer state from the live workspace selector")
  assert.match(sidebarSource, /data-testid="sidebar-validation-count"/, "sidebar.tsx must expose a validation-count marker")
  assert.match(sidebarSource, /data-testid="sidebar-recovery-summary-entrypoint"/, "sidebar.tsx must expose a recovery-summary entrypoint")

  assert.match(roadmapSource, /getLiveWorkspaceIndex/, "roadmap.tsx must derive milestones from live workspace state")
  assert.match(roadmapSource, /data-testid="roadmap-workspace-freshness"/, "roadmap.tsx must expose workspace freshness")

  assert.match(statusBarSource, /getLiveWorkspaceIndex/, "status-bar.tsx must derive the unit label from live workspace state")
  assert.match(statusBarSource, /getLiveAutoDashboard/, "status-bar.tsx must derive current-unit metrics from live auto state")
  assert.match(statusBarSource, /data-testid="status-bar-retry-compaction"/, "status-bar.tsx must expose retry\/compaction freshness state")
})

test("workflow action surfaces route new-milestone CTAs through the shared command path", () => {
  const dashboardPath = resolve(import.meta.dirname, "../../../web/components/gsd/dashboard.tsx")
  const sidebarPath = resolve(import.meta.dirname, "../../../web/components/gsd/sidebar.tsx")
  const chatPath = resolve(import.meta.dirname, "../../../web/components/gsd/chat-mode.tsx")

  const dashboardSource = readFileSync(dashboardPath, "utf-8")
  const sidebarSource = readFileSync(sidebarPath, "utf-8")
  const chatSource = readFileSync(chatPath, "utf-8")

  assert.match(dashboardSource, /executeWorkflowActionInPowerMode/, "dashboard.tsx must use the shared power-mode workflow executor")
  assert.match(sidebarSource, /executeWorkflowActionInPowerMode/, "sidebar.tsx must use the shared power-mode workflow executor")
  assert.match(dashboardSource, /handleWorkflowAction\(workflowAction\.primary\.command\)/, "dashboard.tsx must route the primary CTA through the shared workflow executor")
  assert.match(sidebarSource, /handleCommand\(workflowAction\.primary\.command\)/, "sidebar.tsx must route the primary CTA through the shared workflow executor")
  assert.match(chatSource, /buildPromptCommand\(workflowAction\.primary\.command, bridge\)/, "chat-mode.tsx must send the new-milestone CTA through the same command path as other chat CTAs")

  assert.doesNotMatch(dashboardSource, /NewMilestoneDialog/, "dashboard.tsx must not import or render the deprecated new-milestone dialog")
  assert.doesNotMatch(sidebarSource, /NewMilestoneDialog/, "sidebar.tsx must not import or render the deprecated new-milestone dialog")
  assert.doesNotMatch(chatSource, /NewMilestoneDialog/, "chat-mode.tsx must not import or render the deprecated new-milestone dialog")
  assert.doesNotMatch(chatSource, /buildPromptCommand\("\/gsd auto", bridge\)/, "chat-mode.tsx must not hardcode a special /gsd auto path for new-milestone CTA dispatch")
})

test("sidebar Git affordance opens a real git-summary surface with visible repo/not-repo/error states", () => {
  const contractPath = resolve(import.meta.dirname, "../../../web/lib/command-surface-contract.ts");
  const storePath = resolve(import.meta.dirname, "../../../web/lib/gsd-workspace-store.tsx");
  const surfacePath = resolve(import.meta.dirname, "../../../web/components/gsd/command-surface.tsx");
  const sidebarPath = resolve(import.meta.dirname, "../../../web/components/gsd/sidebar.tsx");

  const contractSource = readFileSync(contractPath, "utf-8");
  const storeSource = readFileSync(storePath, "utf-8");
  const surfaceSource = readFileSync(surfacePath, "utf-8");
  const sidebarSource = readFileSync(sidebarPath, "utf-8");

  assert.match(contractSource, /gitSummary:/, "command-surface-contract.ts must retain git-summary state on the shared surface");
  assert.match(contractSource, /load_git_summary/, "command-surface-contract.ts must model git-summary loading as an explicit action");

  assert.match(storeSource, /loadGitSummary/, "gsd-workspace-store.tsx must expose loadGitSummary so the Git surface is not inert");
  assert.match(storeSource, /\/api\/git/, "gsd-workspace-store.tsx must fetch the current-project git route for the Git surface");

  assert.match(surfaceSource, /data-testid="command-surface-git-summary"/, "command-surface.tsx must render a git-summary panel");
  assert.match(surfaceSource, /data-testid="command-surface-git-not-repo"/, "command-surface.tsx must keep not-a-repo state browser-visible");
  assert.match(surfaceSource, /data-testid="command-surface-git-error"/, "command-surface.tsx must keep git load errors browser-visible");
  assert.match(sidebarSource, /data-testid="sidebar-git-button"/, "sidebar.tsx must expose the Git affordance by a stable test id");
  assert.match(sidebarSource, /openCommandSurface\("git", \{ source: "sidebar" \}\)/, "sidebar.tsx must open the shared git surface when the Git button is clicked");
});

test("recovery diagnostics surface stays on a dedicated route with explicit stale and action state", () => {
  const contractPath = resolve(import.meta.dirname, "../../../web/lib/command-surface-contract.ts");
  const storePath = resolve(import.meta.dirname, "../../../web/lib/gsd-workspace-store.tsx");
  const surfacePath = resolve(import.meta.dirname, "../../../web/components/gsd/command-surface.tsx");
  const dashboardPath = resolve(import.meta.dirname, "../../../web/components/gsd/dashboard.tsx");
  const sidebarPath = resolve(import.meta.dirname, "../../../web/components/gsd/sidebar.tsx");

  const contractSource = readFileSync(contractPath, "utf-8");
  const storeSource = readFileSync(storePath, "utf-8");
  const surfaceSource = readFileSync(surfacePath, "utf-8");
  const dashboardSource = readFileSync(dashboardPath, "utf-8");
  const sidebarSource = readFileSync(sidebarPath, "utf-8");

  assert.match(contractSource, /export interface WorkspaceRecoveryDiagnostics/, "command-surface-contract.ts must expose a typed recovery diagnostics payload");
  assert.match(contractSource, /export interface CommandSurfaceRecoveryState/, "command-surface-contract.ts must expose explicit recovery load state");
  assert.match(contractSource, /load_recovery_diagnostics/, "command-surface-contract.ts must model recovery loading as an explicit action");

  assert.match(storeSource, /loadRecoveryDiagnostics = async/, "gsd-workspace-store.tsx must expose a recovery diagnostics loader");
  assert.match(storeSource, /\/api\/recovery/, "gsd-workspace-store.tsx must call the dedicated recovery route");
  assert.match(storeSource, /markRecoveryStateInvalidated/, "gsd-workspace-store.tsx must keep recovery diagnostics stale state inspectable after invalidation");

  assert.match(surfaceSource, /data-testid="command-surface-recovery"/, "command-surface.tsx must render a recovery diagnostics panel");
  assert.match(surfaceSource, /data-testid="command-surface-recovery-state"/, "command-surface.tsx must expose a recovery load-state marker");
  assert.match(surfaceSource, /data-testid="command-surface-recovery-error"/, "command-surface.tsx must keep recovery route failures browser-visible");
  assert.match(surfaceSource, /data-testid="command-surface-recovery-last-failure"/, "command-surface.tsx must expose structured bridge failure metadata");
  assert.match(surfaceSource, /data-testid={`command-surface-recovery-action-\$\{action.id\}`}/, "command-surface.tsx must expose stable action wiring for recovery controls");

  assert.match(sidebarSource, /setCommandSurfaceSection\("recovery"\)/, "sidebar.tsx must route the recovery entrypoint into the dedicated recovery section");
});
