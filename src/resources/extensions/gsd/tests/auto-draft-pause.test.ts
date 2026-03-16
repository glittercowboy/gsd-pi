import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describeNextUnit } from "../auto.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

// ─── Test describeNextUnit with 'needs-discussion' phase ──────────────────

const ndState = {
  phase: "needs-discussion" as const,
  activeMilestone: { id: "M007", title: "Future Milestone" },
  activeSlice: undefined,
  activeTask: undefined,
  milestoneRegistry: [],
  nextAction: "",
};

const ndResult = describeNextUnit(ndState as any);
assert(
  ndResult.label !== "Continue",
  `needs-discussion label should not be default "Continue", got: "${ndResult.label}"`,
);
assert(
  ndResult.label.toLowerCase().includes("draft") || ndResult.label.toLowerCase().includes("discuss"),
  `needs-discussion label should mention "draft" or "discuss", got: "${ndResult.label}"`,
);
assert(
  ndResult.description.toLowerCase().includes("discussion") || ndResult.description.toLowerCase().includes("draft"),
  `needs-discussion description should mention "discussion" or "draft", got: "${ndResult.description}"`,
);

// ─── Backward compatibility: pre-planning still works ──────────────────────

const ppState = {
  phase: "pre-planning" as const,
  activeMilestone: { id: "M001", title: "Test" },
  activeSlice: undefined,
  activeTask: undefined,
  milestoneRegistry: [],
  nextAction: "",
};

const ppResult = describeNextUnit(ppState as any);
assert(
  ppResult.label === "Research & plan milestone",
  `pre-planning label should be "Research & plan milestone", got: "${ppResult.label}"`,
);

// ─── Backward compatibility: executing still works ──────────────────────────

const exState = {
  phase: "executing" as const,
  activeMilestone: { id: "M001", title: "Test" },
  activeSlice: { id: "S01", title: "Test Slice" },
  activeTask: { id: "T01", title: "Test Task" },
  milestoneRegistry: [],
  nextAction: "",
};

const exResult = describeNextUnit(exState as any);
assert(
  exResult.label.includes("T01"),
  `executing label should include task ID, got: "${exResult.label}"`,
);

// ─── Static verification: needs-discussion in dispatch table ──────────────

const dashboardSource = readFileSync(
  join(import.meta.dirname, "..", "auto-dashboard.ts"),
  "utf-8",
);

// Check describeNextUnit has the case (in auto-dashboard.ts)
const hasDescribeCase = dashboardSource.includes('case "needs-discussion"');
assert(hasDescribeCase, "auto-dashboard.ts describeNextUnit should have 'needs-discussion' case");

// Dispatch logic moved to auto-dispatch.ts — verify the rule exists there
const dispatchSource = readFileSync(
  join(import.meta.dirname, "..", "auto-dispatch.ts"),
  "utf-8",
);

// Check dispatch table has a needs-discussion rule
const hasDispatchRule = dispatchSource.includes('"needs-discussion"');
assert(hasDispatchRule, "auto-dispatch.ts should have 'needs-discussion' rule");

// Check the rule returns a stop action
const ruleIdx = dispatchSource.indexOf('"needs-discussion"');
const nextChunk = dispatchSource.slice(ruleIdx, ruleIdx + 600);
assert(
  nextChunk.includes('"stop"') || nextChunk.includes("action: \"stop\""),
  "needs-discussion dispatch rule should return stop action",
);

// Check notification includes /gsd guidance
assert(
  nextChunk.includes("/gsd"),
  "needs-discussion notification should tell user to run /gsd",
);

// ─── Results ──────────────────────────────────────────────────────────────

console.log(`\nauto-draft-pause: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
